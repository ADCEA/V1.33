const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const Database = require('better-sqlite3');

// En local, la base vit dans ./data. En hébergement, DATA_DIR doit pointer
// vers le disque persistant (ex. /var/data sur Render) pour que les données
// survivent aux redémarrages et redéploiements du serveur.
const DATA_DIR = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : path.join(__dirname, '..', 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const DB_PATH = path.join(DATA_DIR, 'database.sqlite');
const db = new Database(DB_PATH);

db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
db.exec(schema);

// ---------- migrations légères ----------
// schema.sql utilise CREATE TABLE IF NOT EXISTS : une base déjà créée avant
// l'ajout d'une colonne ne la reçoit pas automatiquement. On complète ici
// au démarrage, sans jamais toucher aux données existantes.
const orderItemsColumns = db.prepare(`PRAGMA table_info(order_items)`).all().map(c => c.name);
if (!orderItemsColumns.includes('delivered_qty')) {
  db.exec(`ALTER TABLE order_items ADD COLUMN delivered_qty INTEGER;`);
  // Pour les commandes déjà existantes, on considère que ce qui a été
  // commandé est ce qui a été livré tant que l'admin n'a rien ajusté.
  db.exec(`UPDATE order_items SET delivered_qty = qty WHERE delivered_qty IS NULL;`);
}
if (!orderItemsColumns.includes('production_stage')) {
  db.exec(`ALTER TABLE order_items ADD COLUMN production_stage TEXT DEFAULT 'tri';`);
  // Les lignes déjà existantes reprennent l'étape actuelle de leur commande
  // parente comme point de départ, plutôt que de repartir toutes à "Tri".
  // Pas de "WHERE production_stage IS NULL" ici : l'ALTER TABLE avec
  // DEFAULT vient de remplir toutes les lignes existantes avec 'tri',
  // elles ne sont donc plus NULL — ce filtre ne matcherait jamais rien.
  db.exec(`
    UPDATE order_items
    SET production_stage = COALESCE(
      (SELECT o.production_stage FROM orders o WHERE o.id = order_items.order_id),
      'tri'
    );
  `);
}
db.exec(`CREATE INDEX IF NOT EXISTS idx_items_production ON order_items(production_stage);`);

// Migration structurelle : SQLite ne permet pas de modifier une
// contrainte CHECK existante (ALTER TABLE ne le permet pas) — il faut
// recréer la table à l'identique avec la nouvelle contrainte, copier les
// données, puis basculer. On ne le fait QUE si l'ancienne contrainte (sans
// "en_stock") est encore en place, détecté via le SQL réel de la table.
const orderItemsSchemaSql = db.prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='order_items'`).get()?.sql || '';
if (orderItemsSchemaSql && !orderItemsSchemaSql.includes('en_stock')) {
  db.exec(`
    CREATE TABLE order_items_new (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      order_id          INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
      service_id        TEXT NOT NULL,
      name              TEXT NOT NULL,
      code              TEXT NOT NULL,
      price             REAL NOT NULL,
      qty               INTEGER NOT NULL CHECK (qty > 0),
      delivered_qty     INTEGER,
      production_stage  TEXT DEFAULT 'tri'
                        CHECK (production_stage IN ('tri','lavage','sechage','repassage','pliage','en_stock'))
    );
    INSERT INTO order_items_new SELECT * FROM order_items;
    DROP TABLE order_items;
    ALTER TABLE order_items_new RENAME TO order_items;
    CREATE INDEX IF NOT EXISTS idx_items_order ON order_items(order_id);
    CREATE INDEX IF NOT EXISTS idx_items_production ON order_items(production_stage);
  `);
}

const orderItemsColumnsForSageCode = db.prepare(`PRAGMA table_info(order_items)`).all().map(c => c.name);
if (orderItemsColumnsForSageCode.length > 0 && !orderItemsColumnsForSageCode.includes('sage_code')) {
  db.exec(`ALTER TABLE order_items ADD COLUMN sage_code TEXT;`);
  // Lignes déjà existantes : on retrouve le code Sage en repartant du
  // catalogue actuel via service_id — best-effort (si l'article a depuis
  // été supprimé du catalogue, la ligne reste à NULL, sans bloquer quoi
  // que ce soit d'autre).
  db.exec(`
    UPDATE order_items
    SET sage_code = (SELECT sage_code FROM articles WHERE articles.id = order_items.service_id)
    WHERE sage_code IS NULL;
  `);
}


const roomTypesColumns = db.prepare(`PRAGMA table_info(room_types)`).all().map(c => c.name);
if (roomTypesColumns.length > 0 && !roomTypesColumns.includes('client_id')) {
  db.exec(`ALTER TABLE room_types ADD COLUMN client_id INTEGER REFERENCES clients(id) ON DELETE CASCADE;`);
  // Les types de chambre créés avant cette mise à jour n'étaient rattachés
  // à aucun hôtel — ils restent avec client_id NULL et n'apparaîtront donc
  // plus dans l'interface tant qu'ils ne sont pas réassignés à un hôtel.
}
if (roomTypesColumns.length > 0) {
  db.exec(`CREATE INDEX IF NOT EXISTS idx_room_types_client ON room_types(client_id);`);
}

const ordersColumns = db.prepare(`PRAGMA table_info(orders)`).all().map(c => c.name);
if (!ordersColumns.includes('production_stage')) {
  db.exec(`ALTER TABLE orders ADD COLUMN production_stage TEXT DEFAULT 'tri';`);
  db.exec(`UPDATE orders SET production_stage = 'tri' WHERE production_stage IS NULL;`);
}
if (!ordersColumns.includes('driver_id')) {
  db.exec(`ALTER TABLE orders ADD COLUMN driver_id INTEGER REFERENCES drivers(id) ON DELETE SET NULL;`);
}
if (!ordersColumns.includes('delivery_sequence')) {
  db.exec(`ALTER TABLE orders ADD COLUMN delivery_sequence INTEGER;`);
}
db.exec(`CREATE INDEX IF NOT EXISTS idx_orders_production ON orders(production_stage);`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_orders_driver ON orders(driver_id);`);

// Premier peuplement du catalogue d'articles, uniquement si la table est
// vide (nouvelle table créée par schema.sql) — reprend exactement le
// catalogue qui était figé dans src/services.js, pour que rien ne change
// pour les commandes déjà passées (mêmes id, donc mêmes service_id).
// Poids (g), volume (L) et dimensions (cm) sont des ESTIMATIONS de
// départ (tailles standard courantes en hôtellerie), à corriger depuis
// Administration → Gestion des articles une fois mesurées réellement.
const articleCount = db.prepare(`SELECT COUNT(*) as n FROM articles`).get().n;
if (articleCount === 0) {
  const seedArticles = [
    { id: 'b_dp1', name: 'Drap plat 1 pers.', code: 'DP1', sageCode: 'B-DP1', price: 1.416, category: 'lit', weightG: 300, volumeL: 1.5, widthCm: 180, lengthCm: 290, foldedWidthCm: 35, foldedLengthCm: 25, foldedHeightCm: 3 },
    { id: 'b_dp2', name: 'Drap plat 2 pers.', code: 'DP2', sageCode: 'B-DP2', price: 1.188, category: 'lit', weightG: 400, volumeL: 2.0, widthCm: 240, lengthCm: 300, foldedWidthCm: 40, foldedLengthCm: 30, foldedHeightCm: 4 },
    { id: 'bb_hc1', name: 'Housse de couette 1 pers.', code: 'HC1', sageCode: 'BB-HC1', price: 3.228, category: 'lit', weightG: 500, volumeL: 2.5, widthCm: 140, lengthCm: 200, foldedWidthCm: 35, foldedLengthCm: 30, foldedHeightCm: 5 },
    { id: 'b_hc2', name: 'Housse de couette 2 pers.', code: 'HC2', sageCode: 'B-HC2', price: 2.880, category: 'lit', weightG: 700, volumeL: 3.5, widthCm: 240, lengthCm: 220, foldedWidthCm: 40, foldedLengthCm: 35, foldedHeightCm: 6 },
    { id: 'b_hc3', name: 'Housse de couette 2 pers. (bleu)', code: 'HC3', sageCode: 'B-HC3', price: 2.880, category: 'lit', weightG: 700, volumeL: 3.5, widthCm: 240, lengthCm: 220, foldedWidthCm: 40, foldedLengthCm: 35, foldedHeightCm: 6 },
    { id: 'b_taie', name: 'Taie', code: 'TAIE', sageCode: 'B-Taie', price: 0.396, category: 'lit', weightG: 100, volumeL: 0.5, widthCm: 50, lengthCm: 70, foldedWidthCm: 35, foldedLengthCm: 25, foldedHeightCm: 2 },
    { id: 'art0003', name: 'Couverture', code: 'CV', sageCode: 'ART0003', price: 9.000, category: 'lit', weightG: 1200, volumeL: 4.0, widthCm: 180, lengthCm: 240, foldedWidthCm: 40, foldedLengthCm: 35, foldedHeightCm: 6 },
    { id: 'b_gs', name: 'Drap de bain', code: 'GS', sageCode: 'B-GS', price: 0.720, category: 'toilette', weightG: 400, volumeL: 1.5, widthCm: 70, lengthCm: 140, foldedWidthCm: 35, foldedLengthCm: 25, foldedHeightCm: 4 },
    { id: 'b_xl_gs', name: 'Grand drap de bain (SPA)', code: 'XLGS', sageCode: 'B-XL-GS', price: 0.900, category: 'toilette', weightG: 500, volumeL: 2.0, widthCm: 100, lengthCm: 150, foldedWidthCm: 40, foldedLengthCm: 30, foldedHeightCm: 5 },
    { id: 'b_ps', name: 'Serviette de toilette', code: 'PS', sageCode: 'B-PS', price: 0.480, category: 'toilette', weightG: 200, volumeL: 0.8, widthCm: 50, lengthCm: 90, foldedWidthCm: 25, foldedLengthCm: 20, foldedHeightCm: 3 },
    { id: 'b_tapis', name: 'Tapis de bain', code: 'TAPIS', sageCode: 'B-TAPIS', price: 0.480, category: 'toilette', weightG: 300, volumeL: 1.0, widthCm: 50, lengthCm: 70, foldedWidthCm: 30, foldedLengthCm: 25, foldedHeightCm: 3 },
    { id: 'g_pei', name: 'Peignoir', code: 'PEI', sageCode: 'G-PEI', price: 1.800, category: 'toilette', weightG: 600, volumeL: 2.5, widthCm: 60, lengthCm: 120, foldedWidthCm: 35, foldedLengthCm: 30, foldedHeightCm: 6 },
    { id: 'art0004', name: 'Bain de soleil', code: 'BS', sageCode: 'ART0004', price: 6.600, category: 'toilette', weightG: 800, volumeL: 3.0, widthCm: 80, lengthCm: 200, foldedWidthCm: 35, foldedLengthCm: 30, foldedHeightCm: 5 },
    { id: 'b_tablier', name: 'Tablier', code: 'TABLIER', sageCode: 'B-TABLIER', price: 1.500, category: 'service', weightG: 200, volumeL: 0.5, widthCm: 70, lengthCm: 90, foldedWidthCm: 25, foldedLengthCm: 20, foldedHeightCm: 2 },
    { id: 'b_tor', name: 'Torchon', code: 'TOR', sageCode: 'B-TOR', price: 0.420, category: 'service', weightG: 80, volumeL: 0.2, widthCm: 40, lengthCm: 60, foldedWidthCm: 20, foldedLengthCm: 15, foldedHeightCm: 1.5 },
  ];
  const insertArticle = db.prepare(`
    INSERT INTO articles (id, name, code, sage_code, price, category, weight_g, volume_l, width_cm, length_cm, folded_width_cm, folded_length_cm, folded_height_cm)
    VALUES (@id, @name, @code, @sageCode, @price, @category, @weightG, @volumeL, @widthCm, @lengthCm, @foldedWidthCm, @foldedLengthCm, @foldedHeightCm)
  `);
  const seedAll = db.transaction(() => { for (const a of seedArticles) insertArticle.run(a); });
  seedAll();
}

// Migration défensive : si la table articles existait déjà sans ces deux
// colonnes (créée avant leur ajout), on les rajoute avec une valeur à 0 —
// à corriger ensuite depuis l'admin, plutôt que de deviner une estimation.
const articlesColumns = db.prepare(`PRAGMA table_info(articles)`).all().map(c => c.name);
if (articlesColumns.length > 0 && !articlesColumns.includes('odoo_product_id')) {
  db.exec(`ALTER TABLE articles ADD COLUMN odoo_product_id INTEGER;`);
}
if (articlesColumns.length > 0 && !articlesColumns.includes('weight_g')) {
  db.exec(`ALTER TABLE articles ADD COLUMN weight_g REAL NOT NULL DEFAULT 0;`);
}
if (articlesColumns.length > 0 && !articlesColumns.includes('volume_l')) {
  db.exec(`ALTER TABLE articles ADD COLUMN volume_l REAL NOT NULL DEFAULT 0;`);
}
if (articlesColumns.length > 0 && !articlesColumns.includes('width_cm')) {
  db.exec(`ALTER TABLE articles ADD COLUMN width_cm REAL NOT NULL DEFAULT 0;`);
}
if (articlesColumns.length > 0 && !articlesColumns.includes('length_cm')) {
  db.exec(`ALTER TABLE articles ADD COLUMN length_cm REAL NOT NULL DEFAULT 0;`);
}
if (articlesColumns.length > 0 && !articlesColumns.includes('folded_width_cm')) {
  db.exec(`ALTER TABLE articles ADD COLUMN folded_width_cm REAL NOT NULL DEFAULT 0;`);
}
if (articlesColumns.length > 0 && !articlesColumns.includes('folded_length_cm')) {
  db.exec(`ALTER TABLE articles ADD COLUMN folded_length_cm REAL NOT NULL DEFAULT 0;`);
}
if (articlesColumns.length > 0 && !articlesColumns.includes('folded_height_cm')) {
  db.exec(`ALTER TABLE articles ADD COLUMN folded_height_cm REAL NOT NULL DEFAULT 0;`);
}

// Migration défensive pour la capacité de camion et le poids chariot.
const adminColumns = db.prepare(`PRAGMA table_info(admin)`).all().map(c => c.name);
if (adminColumns.length > 0 && !adminColumns.includes('truck_capacity_kg')) {
  db.exec(`ALTER TABLE admin ADD COLUMN truck_capacity_kg REAL DEFAULT 1200;`);
} else if (adminColumns.length > 0) {
  // Corrige la capacité si elle est encore à l'ancienne valeur par défaut
  // (1000, jamais confirmée par l'utilisateur) — la vraie valeur (1200)
  // est maintenant connue. Ne touche pas à une valeur déjà personnalisée.
  db.exec(`UPDATE admin SET truck_capacity_kg = 1200 WHERE id = 1 AND truck_capacity_kg = 1000;`);
}
if (adminColumns.length > 0 && !adminColumns.includes('cart_weight_kg')) {
  db.exec(`ALTER TABLE admin ADD COLUMN cart_weight_kg REAL DEFAULT 20;`);
}
if (adminColumns.length > 0 && !adminColumns.includes('max_cart_weight_kg')) {
  db.exec(`ALTER TABLE admin ADD COLUMN max_cart_weight_kg REAL DEFAULT 120;`);
}
if (adminColumns.length > 0 && !adminColumns.includes('prioritize_grouping')) {
  db.exec(`ALTER TABLE admin ADD COLUMN prioritize_grouping INTEGER DEFAULT 1;`);
}
if (adminColumns.length > 0 && !adminColumns.includes('odoo_tax_id')) {
  db.exec(`ALTER TABLE admin ADD COLUMN odoo_tax_id INTEGER;`);
  db.exec(`ALTER TABLE admin ADD COLUMN odoo_journal_id INTEGER;`);
}

const clientsColumns = db.prepare(`PRAGMA table_info(clients)`).all().map(c => c.name);
if (clientsColumns.length > 0 && !clientsColumns.includes('webhook_url')) {
  db.exec(`ALTER TABLE clients ADD COLUMN webhook_url TEXT;`);
  db.exec(`ALTER TABLE clients ADD COLUMN webhook_secret TEXT;`);
}
if (clientsColumns.length > 0 && !clientsColumns.includes('odoo_partner_id')) {
  db.exec(`ALTER TABLE clients ADD COLUMN odoo_partner_id INTEGER;`);
}
if (clientsColumns.length > 0 && !clientsColumns.includes('invoice_detail_level')) {
  db.exec(`ALTER TABLE clients ADD COLUMN invoice_detail_level TEXT NOT NULL DEFAULT 'detail' CHECK (invoice_detail_level IN ('detail','per_bl','aggregated'));`);
}
if (clientsColumns.length > 0 && !clientsColumns.includes('siret')) {
  db.exec(`ALTER TABLE clients ADD COLUMN siret TEXT;`);
  db.exec(`ALTER TABLE clients ADD COLUMN tva_number TEXT;`);
  db.exec(`ALTER TABLE clients ADD COLUMN adresse_facturation TEXT;`);
}

const invoicesColumns = db.prepare(`PRAGMA table_info(invoices)`).all().map(c => c.name);
if (invoicesColumns.length > 0 && !invoicesColumns.includes('total_ht')) {
  db.exec(`ALTER TABLE invoices ADD COLUMN total_ht REAL;`);
}

// Même contrainte que pour order_items plus haut : SQLite ne permet pas
// de modifier un CHECK existant. Recrée la table invoices UNIQUEMENT si
// l'ancienne contrainte (sans 'cancelled') est encore active, pour
// pouvoir refléter une facture annulée dans Odoo — sans quoi les BL qui
// lui étaient rattachés resteraient bloqués pour toujours, impossibles à
// refacturer. Placée APRÈS la migration total_ht ci-dessus : cette
// colonne doit déjà exister avant que cette requête ne la lise.
const invoicesSchemaSql = db.prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='invoices'`).get()?.sql || '';
if (invoicesSchemaSql && !invoicesSchemaSql.includes('cancelled')) {
  db.exec(`
    CREATE TABLE invoices_new (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      client_id      INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
      odoo_move_id   INTEGER,
      period_start   TEXT NOT NULL,
      period_end     TEXT NOT NULL,
      status         TEXT NOT NULL DEFAULT 'draft_pending'
                     CHECK (status IN ('draft_pending','draft_created','posted','pdf_retrieved','error','cancelled')),
      odoo_number    TEXT,
      total_ht       REAL,
      pdf_path       TEXT,
      last_error     TEXT,
      created_at     TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at     TEXT NOT NULL DEFAULT (datetime('now'))
    );
    INSERT INTO invoices_new (id, client_id, odoo_move_id, period_start, period_end, status, odoo_number, total_ht, pdf_path, last_error, created_at, updated_at)
    SELECT id, client_id, odoo_move_id, period_start, period_end, status, odoo_number, total_ht, pdf_path, last_error, created_at, updated_at
    FROM invoices;
    DROP TABLE invoices;
    ALTER TABLE invoices_new RENAME TO invoices;
    CREATE INDEX IF NOT EXISTS idx_invoices_client ON invoices(client_id);
  `);
}
if (adminColumns.length > 0 && !adminColumns.includes('depot_address')) {
  db.exec(`ALTER TABLE admin ADD COLUMN depot_address TEXT DEFAULT '35 rue Théodore Aubanel, 84200 Carpentras, France';`);
  db.exec(`ALTER TABLE admin ADD COLUMN depot_lat REAL;`);
  db.exec(`ALTER TABLE admin ADD COLUMN depot_lng REAL;`);
} else if (adminColumns.length > 0) {
  // Correction pour les bases où la colonne existait déjà avec l'ancienne
  // valeur par défaut, sans code postal (source probable d'échecs de
  // géocodage) — ne touche qu'à cette valeur précise, jamais à une
  // adresse déjà personnalisée par l'utilisateur. On efface aussi le
  // lat/lng en cache pour forcer un nouveau géocodage avec l'adresse
  // corrigée au prochain calcul de tournée.
  db.exec(`
    UPDATE admin SET depot_address = '35 rue Théodore Aubanel, 84200 Carpentras, France', depot_lat = NULL, depot_lng = NULL
    WHERE id = 1 AND depot_address = '35 rue Théodore Aubanel, Carpentras, France';
  `);
}
if (adminColumns.length > 0 && !adminColumns.includes('avg_speed_kmh')) {
  db.exec(`ALTER TABLE admin ADD COLUMN avg_speed_kmh REAL DEFAULT 40;`);
}
if (adminColumns.length > 0 && !adminColumns.includes('minutes_per_stop')) {
  db.exec(`ALTER TABLE admin ADD COLUMN minutes_per_stop REAL DEFAULT 20;`);
}

const ordersGeoColumns = db.prepare(`PRAGMA table_info(orders)`).all().map(c => c.name);
if (!ordersGeoColumns.includes('lat')) {
  db.exec(`ALTER TABLE orders ADD COLUMN lat REAL;`);
  db.exec(`ALTER TABLE orders ADD COLUMN lng REAL;`);
}
if (!ordersGeoColumns.includes('distance_from_prev_km')) {
  db.exec(`ALTER TABLE orders ADD COLUMN distance_from_prev_km REAL;`);
}
if (!ordersGeoColumns.includes('livraison_prevue')) {
  db.exec(`ALTER TABLE orders ADD COLUMN livraison_prevue TEXT;`);
}
// L'ancien réglage cart_volume_l (un seul gabarit) est abandonné au profit
// de la table cart_types (plusieurs gabarits réels) — colonne laissée
// telle quelle si elle existe déjà sur une base existante, simplement
// plus utilisée, pour éviter toute manipulation destructrice de colonne.

// Premier peuplement des types de chariots réels, uniquement si la table
// est vide — vos deux gabarits réels (Cabri, ROLL), volumes calculés à
// partir de leurs dimensions (L × l × h). Modifiables ensuite depuis
// Administration → Gestion des articles.
const cartTypeCount = db.prepare(`SELECT COUNT(*) as n FROM cart_types`).get().n;
if (cartTypeCount === 0) {
  const insertCartType = db.prepare(`
    INSERT INTO cart_types (name, length_cm, width_cm, height_cm) VALUES (?, ?, ?, ?)
  `);
  const seedCarts = db.transaction(() => {
    insertCartType.run('Cabri', 50, 70, 180);
    insertCartType.run('ROLL', 90, 90, 180);
  });
  seedCarts();
}

// Premier peuplement des types de camions réels, uniquement si la table
// est vide — vos deux véhicules réels, cotes intérieures utiles (L × l × h)
// tirées de fiches techniques constructeur. Modifiables ensuite depuis
// Administration → Gestion des articles.
const truckTypeCount = db.prepare(`SELECT COUNT(*) as n FROM truck_types`).get().n;
if (truckTypeCount === 0) {
  const insertTruckType = db.prepare(`
    INSERT INTO truck_types (name, length_cm, width_cm, height_cm) VALUES (?, ?, ?, ?)
  `);
  const seedTrucks = db.transaction(() => {
    insertTruckType.run('Jumper H2L1', 267, 187, 193);
    insertTruckType.run('Master H2L2', 308, 176.5, 189);
  });
  seedTrucks();
}
const truckTypesColumns = db.prepare(`PRAGMA table_info(truck_types)`).all().map(c => c.name);
if (truckTypesColumns.length > 0 && !truckTypesColumns.includes('current_mileage_km')) {
  db.exec(`ALTER TABLE truck_types ADD COLUMN current_mileage_km REAL;`);
}

// Migration défensive : rattachement optionnel d'un chauffeur à un type
// de camion, absent sur les bases créées avant cet ajout.
const driversColumns = db.prepare(`PRAGMA table_info(drivers)`).all().map(c => c.name);
if (driversColumns.length > 0 && !driversColumns.includes('truck_type_id')) {
  db.exec(`ALTER TABLE drivers ADD COLUMN truck_type_id INTEGER REFERENCES truck_types(id) ON DELETE SET NULL;`);
}
if (driversColumns.length > 0 && !driversColumns.includes('access_token')) {
  db.exec(`ALTER TABLE drivers ADD COLUMN access_token TEXT;`);
}
// Génère un jeton pour tout chauffeur qui n'en a pas encore (nouvelle
// colonne, ou chauffeur créé avant que cette route ne le génère).
const driversWithoutToken = db.prepare(`SELECT id FROM drivers WHERE access_token IS NULL`).all();
if (driversWithoutToken.length > 0) {
  const setToken = db.prepare(`UPDATE drivers SET access_token = ? WHERE id = ?`);
  for (const d of driversWithoutToken) {
    setToken.run(crypto.randomBytes(20).toString('hex'), d.id);
  }
}

// Ligne unique pour le compteur de tickets, si absente
db.prepare(`INSERT OR IGNORE INTO order_seq (id, value) VALUES (1, 0)`).run();

module.exports = db;
// Attaché à l'export existant (pas de changement de forme, pour ne
// casser aucun des fichiers qui font déjà `const db = require('../db')`
// et utilisent directement db.prepare(...)) : `require('../db').DATA_DIR`
// ou `const { DATA_DIR } = require('../db')` fonctionnent tous les deux.
module.exports.DATA_DIR = DATA_DIR;
// Chemin du fichier — nécessaire pour ouvrir une seconde connexion en
// lecture seule (voir utils/aiAgent.js), sans jamais passer par cet
// export principal en écriture pour ces usages-là.
module.exports.DB_PATH = DB_PATH;
