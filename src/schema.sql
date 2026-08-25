-- Schéma de la base Blanchisserie Cézanne (SQLite)
-- Appliqué automatiquement au démarrage du serveur (voir src/db.js).
-- Vous pouvez modifier ce fichier pour faire évoluer la structure ;
-- les CREATE TABLE / INDEX utilisent IF NOT EXISTS, donc les tables
-- déjà créées ne seront pas touchées (voir note migrations dans le README).

CREATE TABLE IF NOT EXISTS clients (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  email         TEXT NOT NULL UNIQUE,
  societe       TEXT NOT NULL,
  contact       TEXT NOT NULL,
  tel           TEXT NOT NULL,
  adresse       TEXT NOT NULL,
  code_hash     TEXT NOT NULL,
  -- Intégration API (voir api_tokens) : URL à notifier automatiquement
  -- quand une commande de cet hôtel passe au statut "livrée", avec les
  -- quantités définitivement livrées. webhook_secret est envoyé en en-tête
  -- de chaque appel, pour que le logiciel du client puisse vérifier que
  -- l'appel vient bien de nous.
  webhook_url     TEXT,
  webhook_secret  TEXT,
  -- Correspondance avec la fiche res.partner créée côté Odoo, pour ne
  -- jamais recréer de doublon à chaque facture poussée. NULL tant que ce
  -- client n'a pas encore été synchronisé.
  odoo_partner_id INTEGER,
  -- Niveau de détail des lignes sur la facture Odoo générée pour cet
  -- hôtel : 'detail' = une ligne par article et par BL (le plus précis,
  -- pour les clients qui contrôlent ligne à ligne) ; 'per_bl' = une
  -- ligne agrégée par BL (le plus courant) ; 'aggregated' = une ligne
  -- par article sur tout le mois (pour les petits clients / contrats
  -- forfait). Réglable depuis la fiche client, comme la stratégie de
  -- conditionnement.
  invoice_detail_level TEXT NOT NULL DEFAULT 'detail'
                       CHECK (invoice_detail_level IN ('detail','per_bl','aggregated')),
  -- Informations légales/facturation — remplissables par le client
  -- lui-même depuis son espace (voir /api/clients/me/billing), pour
  -- éviter d'avoir à les collecter un par un par téléphone. Transmises à
  -- Odoo lors de la synchronisation du partenaire (vat, siret).
  -- adresse_facturation est distincte de `adresse` (qui reste l'adresse
  -- de collecte du linge) : un siège social facturé peut différer du
  -- lieu de collecte — vide = on retombe sur `adresse` pour la facture.
  siret               TEXT,
  tva_number          TEXT,
  adresse_facturation TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Types de camions réels, avec leurs cotes intérieures utiles — utilisés
-- en Logistique pour vérifier que le volume assigné à un chauffeur tient
-- réellement dans son véhicule. Gérable depuis Gestion des articles.
CREATE TABLE IF NOT EXISTS truck_types (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  name              TEXT NOT NULL,
  length_cm         REAL NOT NULL,
  width_cm          REAL NOT NULL,
  height_cm         REAL NOT NULL,
  -- Kilométrage actuel (relevé au compteur), mis à jour manuellement
  -- depuis l'onglet Garage — sert de référence pour planifier l'entretien.
  current_mileage_km REAL,
  created_at        TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Historique d'entretien par véhicule (Garage). Type libre (vidange,
-- contrôle technique, pneus...) plutôt qu'une liste figée, pour rester
-- adapté à tout type d'intervention sans limiter l'usage.
CREATE TABLE IF NOT EXISTS truck_maintenance (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  truck_type_id  INTEGER NOT NULL REFERENCES truck_types(id) ON DELETE CASCADE,
  date           TEXT NOT NULL,
  type           TEXT NOT NULL,
  mileage_km     REAL,
  cost           REAL,
  notes          TEXT,
  created_at     TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_maintenance_truck ON truck_maintenance(truck_type_id);

-- Réponses au questionnaire de satisfaction (NPS — Net Promoter Score).
-- Un hôtel peut répondre au plus une fois par mois civil (contrôlé côté
-- application, pas ici) ; le calcul du NPS mensuel se fait à la volée à
-- partir de created_at, pas besoin de colonne "mois" dédiée.
CREATE TABLE IF NOT EXISTS nps_responses (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id   INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  score       INTEGER NOT NULL CHECK (score BETWEEN 0 AND 10),
  comment     TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_nps_client ON nps_responses(client_id);
CREATE INDEX IF NOT EXISTS idx_nps_created ON nps_responses(created_at);

-- Jetons d'API pour les intégrations B2B (un logiciel client génère ses
-- propres commandes automatiquement). Chaque jeton est rattaché à UN
-- hôtel précis — la commande créée via ce jeton lui est automatiquement
-- attribuée, sans avoir à retransmettre ses coordonnées à chaque appel.
CREATE TABLE IF NOT EXISTS api_tokens (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id     INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  token         TEXT NOT NULL UNIQUE,
  label         TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  last_used_at  TEXT
);

CREATE INDEX IF NOT EXISTS idx_api_tokens_client ON api_tokens(client_id);

-- Tarifs négociés par hôtel, article par article. Une ligne n'existe que
-- si le prix DIFFÈRE du catalogue (pas de duplication systématique) —
-- sans ligne ici pour un article donné, le prix catalogue s'applique.
-- date_fin NULL = tarif actuellement actif. Historisé (pas remplacé) pour
-- pouvoir refacturer un mois passé au prix qui était réellement en
-- vigueur à ce moment-là, même après une augmentation tarifaire.
CREATE TABLE IF NOT EXISTS client_prices (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id   INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  article_id  TEXT NOT NULL REFERENCES articles(id) ON DELETE CASCADE,
  price       REAL NOT NULL,
  date_debut  TEXT NOT NULL,
  date_fin    TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_client_prices_lookup ON client_prices(client_id, article_id, date_debut);

-- Suivi des factures poussées vers Odoo — une ligne par facture
-- mensuelle générée pour un client. odoo_move_id permet de retrouver la
-- facture côté Odoo (statut, PDF une fois validée) sans avoir à la
-- recréer. period_start/period_end délimitent les commandes livrées
-- couvertes par cette facture, pour ne jamais en facturer une deux fois.
CREATE TABLE IF NOT EXISTS invoices (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id      INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  odoo_move_id   INTEGER,
  period_start   TEXT NOT NULL,
  period_end     TEXT NOT NULL,
  status         TEXT NOT NULL DEFAULT 'draft_pending'
                 CHECK (status IN ('draft_pending','draft_created','posted','pdf_retrieved','error','cancelled')),
  odoo_number    TEXT,
  -- Montant HT total, recopié depuis Odoo une fois la facture générée —
  -- affichage rapide côté admin sans avoir à réinterroger Odoo à chaque
  -- consultation. Source de vérité du montant réel = Odoo, ce champ n'est
  -- qu'un cache pratique.
  total_ht       REAL,
  pdf_path       TEXT,
  last_error     TEXT,
  created_at     TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at     TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Table de jonction : quelles commandes (BL) sont couvertes par quelle
-- facture. Une commande ne doit apparaître que sur UNE facture — c'est
-- cette table qui l'empêche, pas une simple plage de dates.
CREATE TABLE IF NOT EXISTS invoice_orders (
  invoice_id  INTEGER NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  order_id    INTEGER NOT NULL UNIQUE REFERENCES orders(id) ON DELETE CASCADE,
  PRIMARY KEY (invoice_id, order_id)
);

CREATE INDEX IF NOT EXISTS idx_invoices_client ON invoices(client_id);
CREATE INDEX IF NOT EXISTS idx_invoice_orders_order ON invoice_orders(order_id);

CREATE TABLE IF NOT EXISTS drivers (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  name           TEXT NOT NULL,
  vehicle        TEXT,
  -- Véhicule réel rattaché (facultatif) — sert à comparer le volume à
  -- transporter à la capacité réelle du camion utilisé par ce chauffeur.
  truck_type_id  INTEGER REFERENCES truck_types(id) ON DELETE SET NULL,
  -- Jeton unique donnant accès à son portail personnel (lien à partager,
  -- pas de mot de passe) — voir /tournee.html et src/routes/driverPortal.js.
  access_token   TEXT UNIQUE,
  created_at     TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS orders (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  ticket             TEXT NOT NULL UNIQUE,
  client_id          INTEGER REFERENCES clients(id) ON DELETE SET NULL,
  societe            TEXT NOT NULL,
  contact            TEXT NOT NULL,
  tel                TEXT NOT NULL,
  adresse            TEXT NOT NULL,
  collecte_date      TEXT,
  -- Date à laquelle le linge doit être rendu au client (distincte de la
  -- date de collecte, qui concerne l'arrivée du linge sale). Facultative,
  -- modifiable à tout moment depuis le détail de la commande — sert de
  -- base aux filtres "date de livraison prévue" en Production et
  -- Préparation de commande.
  livraison_prevue   TEXT,
  notes              TEXT,
  status             TEXT NOT NULL DEFAULT 'recue'
                     CHECK (status IN ('recue','traitement','prete','livree')),
  -- Sous-étape de production, uniquement significative pendant "traitement".
  -- Voir espace Production dans l'admin.
  production_stage   TEXT DEFAULT 'tri'
                     CHECK (production_stage IN ('tri','lavage','sechage','repassage','pliage')),
  -- Assignation à un chauffeur pour la tournée de livraison, une fois
  -- la commande "prête". delivery_sequence = ordre des arrêts dans la tournée.
  driver_id          INTEGER REFERENCES drivers(id) ON DELETE SET NULL,
  delivery_sequence  INTEGER,
  -- Distance (km) depuis l'arrêt précédent de la tournée, calculée lors
  -- de la dernière optimisation de tournée — cumulée dans les
  -- statistiques ("kilomètres parcourus").
  distance_from_prev_km REAL,
  -- Coordonnées géocodées de `adresse`, en cache pour l'optimisation de
  -- tournée (évite de re-géocoder la même adresse à chaque calcul).
  lat                REAL,
  lng                REAL,
  created_at         TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS order_items (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id          INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  service_id        TEXT NOT NULL,
  name              TEXT NOT NULL,
  code              TEXT NOT NULL,
  -- Code Sage figé au moment de la commande (comme name/code/price) —
  -- c'est CE code, pas `code`, qui doit correspondre à ce qui apparaît
  -- sur les factures. Utilisé notamment par le webhook de livraison
  -- envoyé aux logiciels clients intégrés via API.
  sage_code         TEXT,
  price             REAL NOT NULL,
  qty               INTEGER NOT NULL CHECK (qty > 0),
  delivered_qty     INTEGER,
  -- Étape de production PROPRE à cette ligne d'article (pas à la commande
  -- entière) — chaque article avance à son propre rythme dans l'atelier.
  -- "en_stock" = traité et rangé, prêt à être utilisé pour n'importe
  -- quelle commande (cohérent avec le fonctionnement sur stock propre).
  -- Voir espace Production dans l'admin.
  production_stage  TEXT DEFAULT 'tri'
                    CHECK (production_stage IN ('tri','lavage','sechage','repassage','pliage','en_stock'))
  -- qty = quantité commandée par le client (fixe une fois la commande créée).
  -- delivered_qty = quantité réellement préparée/livrée, ajustable par l'admin
  -- pendant le statut "traitement". Vaut qty par défaut tant que rien n'a changé.
);

CREATE TABLE IF NOT EXISTS admin (
  id                    INTEGER PRIMARY KEY CHECK (id = 1),
  password_hash         TEXT NOT NULL,
  delivery_email        TEXT,
  -- Capacité utilisée en Logistique pour vérifier la charge d'un camion.
  truck_capacity_kg     REAL DEFAULT 1200,
  -- Poids d'un chariot vide (kg) — s'ajoute au poids du linge transporté,
  -- puisque les chariots eux-mêmes montent dans le camion.
  cart_weight_kg        REAL DEFAULT 20,
  -- Poids MAXIMUM de linge qu'un chariot peut contenir (kg), au-delà du
  -- volume — un chariot peut être plein en volume et dangereux à
  -- manipuler bien avant, ou l'inverse (linge lourd, peu volumineux).
  -- Utilisé par l'algorithme de répartition en Logistique.
  max_cart_weight_kg    REAL DEFAULT 120,
  -- Stratégie de répartition en cas d'arbitrage entre deux objectifs qui
  -- peuvent s'opposer : regrouper chaque référence dans le moins de
  -- chariots possible (1 = défaut) ou équilibrer le poids le plus
  -- uniformément possible entre les chariots (0). Les limites de poids et
  -- volume par chariot restent, elles, TOUJOURS respectées quel que soit
  -- ce réglage — ce n'est qu'un critère de choix quand plusieurs
  -- répartitions sont également valides.
  prioritize_grouping   INTEGER DEFAULT 1,
  -- Point de départ des tournées de livraison (votre blanchisserie).
  -- Géocodé à la demande (lat/lng mis en cache une fois calculés, pour
  -- ne pas re-solliciter le service de géocodage à chaque tournée).
  depot_address         TEXT DEFAULT '35 rue Théodore Aubanel, 84200 Carpentras, France',
  depot_lat             REAL,
  depot_lng             REAL,
  -- Utilisés dans le portail livreur pour estimer la durée d'une tournée :
  -- temps de conduite = distance / vitesse moyenne, plus un temps fixe
  -- par arrêt (stationnement, portage, remise du linge...).
  avg_speed_kmh         REAL DEFAULT 40,
  minutes_per_stop      REAL DEFAULT 20,
  -- Configuration Odoo pour la facturation. odoo_tax_id = id du
  -- account.tax à appliquer sur chaque ligne de facture (ex. TVA 20%) —
  -- Odoo ne le déduit jamais automatiquement par API (les onchange ne se
  -- déclenchent pas), il doit être transmis explicitement à chaque ligne.
  -- odoo_journal_id est optionnel : NULL = Odoo choisit le journal de
  -- vente par défaut.
  odoo_tax_id           INTEGER,
  odoo_journal_id       INTEGER
);

-- Types de chariots réels, avec leurs dimensions — utilisés en Logistique
-- pour recommander une combinaison de chariots selon le volume à
-- transporter (le plus grand gabarit d'abord, puis le plus petit pour
-- le reste). Gérable depuis Administration → Gestion des articles.
CREATE TABLE IF NOT EXISTS cart_types (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT NOT NULL,
  length_cm   REAL NOT NULL,
  width_cm    REAL NOT NULL,
  height_cm   REAL NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS order_seq (
  id     INTEGER PRIMARY KEY CHECK (id = 1),
  value  INTEGER NOT NULL DEFAULT 0
);

-- Règles de génération automatique de commande à partir du planning hôtel
-- (voir src/utils/autoOrderRules.js). Une ligne par type de chambre,
-- rattachée à UN hôtel précis (client_id) — indispensable dès qu'on gère
-- plusieurs établissements, chacun avec ses propres types de chambre et
-- ses propres quantités de linge.
--   departure_items    JSON [{serviceId, qty}]   — linge fourni au départ (checkout)
--   recouche_items     JSON [{serviceId, qty}]   — linge changé en cours de séjour (peut être NULL)
--   recouche_frequency INTEGER                   — tous les combien de jours (NULL = jamais)
--   monthly_overrides  JSON {"7": {...}, "12": {...}} — exceptions par mois (1-12),
--                       mêmes champs que ci-dessus, ne remplace que ce qui est précisé
CREATE TABLE IF NOT EXISTS room_types (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id           INTEGER REFERENCES clients(id) ON DELETE CASCADE,
  name                TEXT NOT NULL,
  departure_items     TEXT NOT NULL DEFAULT '[]',
  recouche_items      TEXT DEFAULT '[]',
  recouche_frequency  INTEGER,
  monthly_overrides   TEXT NOT NULL DEFAULT '{}',
  created_at          TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Hôtels supplémentaires associés à une commande/ordre de lavage, en plus
-- du client principal (orders.client_id/societe) — utile quand un lot de
-- lavage mélange le linge de plusieurs établissements.
CREATE TABLE IF NOT EXISTS order_extra_clients (
  order_id   INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  client_id  INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  PRIMARY KEY (order_id, client_id)
);

-- Fil de discussion libre par commande, pour que l'équipe de production
-- puisse se laisser des messages (plusieurs entrées horodatées, pas un
-- champ unique qu'on écrase).
CREATE TABLE IF NOT EXISTS order_comments (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id    INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  author      TEXT,
  text        TEXT NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Catalogue d'articles, gérable depuis Administration → Gestion des
-- articles. Remplace l'ancien catalogue figé dans src/services.js — au
-- premier démarrage, cette table est peuplée automatiquement avec les
-- mêmes articles qu'avant (voir migration dans src/db.js), donc rien ne
-- change pour l'existant tant que vous n'éditez rien.
CREATE TABLE IF NOT EXISTS articles (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  code       TEXT NOT NULL,
  sage_code  TEXT NOT NULL,
  -- Correspondance avec le product.product créé côté Odoo (type
  -- "service"). NULL tant que cet article n'a pas encore été synchronisé.
  odoo_product_id  INTEGER,
  price      REAL NOT NULL DEFAULT 0,
  category   TEXT NOT NULL DEFAULT 'lit',
  -- weight_g = poids d'une unité en grammes, volume_l = volume d'une
  -- unité en litres. Utilisés en Logistique pour recommander le nombre
  -- de chariots (volume) et vérifier la charge d'un camion (poids).
  weight_g   REAL NOT NULL DEFAULT 0,
  volume_l   REAL NOT NULL DEFAULT 0,
  -- Dimensions réelles à plat, dépliées (cm) — taille du produit lui-même
  -- (ex. drap 240×300), pas son encombrement une fois plié/rangé.
  width_cm         REAL NOT NULL DEFAULT 0,
  length_cm        REAL NOT NULL DEFAULT 0,
  -- Dimensions une fois plié, tel que rangé/transporté (cm) — utilisées
  -- pour les calculs de chargement en Logistique. Champ admin uniquement,
  -- jamais montré côté client. folded_height_cm = épaisseur d'une unité
  -- pliée (empilable) ; les trois ensemble donnent le vrai volume utilisé
  -- pour le conditionnement (remplace volume_l dans ces calculs).
  folded_width_cm  REAL NOT NULL DEFAULT 0,
  folded_length_cm REAL NOT NULL DEFAULT 0,
  folded_height_cm REAL NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Attribution des articles aux hôtels : si un hôtel n'a AUCUNE ligne ici,
-- il voit tout le catalogue (comportement par défaut, rétrocompatible).
-- Dès qu'au moins une ligne existe pour un client_id, seuls ces
-- articles-là lui sont proposés à la commande.
CREATE TABLE IF NOT EXISTS client_articles (
  client_id   INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  article_id  TEXT NOT NULL REFERENCES articles(id) ON DELETE CASCADE,
  PRIMARY KEY (client_id, article_id)
);

CREATE INDEX IF NOT EXISTS idx_client_articles_client ON client_articles(client_id);

CREATE INDEX IF NOT EXISTS idx_orders_client ON orders(client_id);
CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);
CREATE INDEX IF NOT EXISTS idx_items_order   ON order_items(order_id);
CREATE INDEX IF NOT EXISTS idx_extra_clients_order ON order_extra_clients(order_id);
CREATE INDEX IF NOT EXISTS idx_comments_order ON order_comments(order_id);
-- Les index sur room_types(client_id), orders(production_stage) et
-- orders(driver_id) sont créés dans db.js, APRÈS les migrations ALTER
-- TABLE qui ajoutent ces colonnes aux bases déjà existantes — les créer
-- ici casserait le démarrage sur une base où la table existe déjà sans
-- ces colonnes (CREATE TABLE IF NOT EXISTS ne les ajoute pas rétroactivement).
