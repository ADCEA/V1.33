# Blanchisserie Cézanne — backend

API + base de données SQLite pour l'application Blanchisserie Cézanne.
Remplace le stockage temporaire de la version précédente (dans l'artefact
Claude) par un vrai serveur Node.js/Express et une base de données SQLite
persistante sur disque.

## Ce qui change par rapport à la version précédente

| | Version artefact (précédente) | Cette version (backend réel) |
|---|---|---|
| Stockage | `window.storage` du navigateur, lié à la conversation Claude | Fichier SQLite sur disque (`data/database.sqlite`) |
| Mots de passe / codes | Hachés en SHA-256 côté navigateur | Hachés en bcrypt côté serveur |
| Session client / admin | Perdue au rechargement de la page | Persiste via cookie de session (30 jours) |
| Bon de livraison | Ouvre votre messagerie (mailto) | Peut être envoyé réellement par email via SMTP (avec repli sur mailto si non configuré) |
| Accès aux données | Uniquement depuis le navigateur ayant créé la commande | Accessible depuis n'importe quel navigateur pointant vers le serveur |

## Prérequis

- Node.js 18 ou supérieur
- npm

## Installation

```bash
cd blanchisserie-backend
npm install
cp .env.example .env
```

Ouvrez `.env` et renseignez au minimum `SESSION_SECRET` (n'importe quelle
chaîne longue et aléatoire). La partie SMTP est optionnelle — voir plus bas.

```bash
npm start
```

Le serveur démarre sur `http://localhost:3000` (ou le port défini dans
`.env`). Ouvrez cette adresse dans votre navigateur : c'est l'application
complète (accueil, commande, suivi, espace personnel, administration).

> **Note sur cet environnement (Claude) :** je n'ai pas pu exécuter
> `npm install` ni démarrer le serveur moi-même ici, car cet outil n'a pas
> d'accès réseau. Le code a été écrit et relu avec soin (syntaxe vérifiée
> fichier par fichier), mais testez-le chez vous avec `npm install && npm start`
> avant toute mise en production.

## Premier lancement

- **Espace client** : inscription libre depuis l'onglet « Mon espace ».
- **Administration** : la première visite de l'onglet « Administration »
  demande de définir un mot de passe (6 caractères minimum). Ce mot de passe
  est ensuite haché et stocké en base — il n'y a pas de mot de passe par défaut.

## Base de données

- Moteur : **SQLite**, via [better-sqlite3](https://github.com/WiseLibs/better-sqlite3).
- Fichier : `data/database.sqlite`, créé automatiquement au premier démarrage.
- Schéma : défini dans [`src/schema.sql`](src/schema.sql), appliqué
  automatiquement par `src/db.js` à chaque démarrage.

### Tables

- **clients** — comptes de l'espace personnel (email, coordonnées, code d'accès haché).
- **orders** — une ligne par commande (ticket, client associé ou invité, statut, dates, notes).
- **order_items** — les articles d'une commande (catégorie de linge, quantité), liés à `orders` par `order_id`.
- **admin** — une seule ligne (mot de passe haché + email de réception des bons de livraison).
- **order_seq** — compteur utilisé pour générer les numéros de ticket (`CZ-AAMMJJ-XXXX`).

### Consulter la base directement

Pour inspecter ou modifier les données à la main, utilisez par exemple
[DB Browser for SQLite](https://sqlitebrowser.org/) (interface graphique)
ou la ligne de commande `sqlite3 data/database.sqlite` si elle est installée
sur votre machine.

### Modifier le schéma

`src/schema.sql` utilise `CREATE TABLE IF NOT EXISTS` : si vous modifiez ce
fichier après une première exécution, les tables déjà créées **ne seront
pas modifiées automatiquement** (SQLite ne fait pas de migration implicite).
Deux options :

1. **En développement**, le plus simple est de supprimer `data/database.sqlite`
   (perte des données) et de relancer `npm start` pour repartir d'un schéma propre.
2. **En production**, écrivez une migration explicite (`ALTER TABLE ...`)
   dans un script à part et exécutez-la une fois avant de redémarrer le serveur.

## Aperçu de l'API

Toutes les routes sont préfixées par `/api`. Les sessions client et
administration sont gérées par cookie (`credentials: 'same-origin'` côté
frontend).

| Méthode | Route | Description |
|---|---|---|
| GET | `/api/services` | Catalogue des catégories de linge |
| POST | `/api/clients/register` | Créer un compte client |
| POST | `/api/clients/login` | Connexion client |
| POST | `/api/clients/logout` | Déconnexion client |
| GET | `/api/clients/me` | Session client courante |
| GET | `/api/clients/orders` | Historique du client connecté |
| POST | `/api/orders` | Créer une commande (invité ou client connecté) |
| GET | `/api/orders/track/:ticket` | Suivi public par numéro de ticket |
| GET | `/api/admin/status` | Admin déjà configuré ? session déverrouillée ? |
| POST | `/api/admin/setup` | Définir le mot de passe (une seule fois) |
| POST | `/api/admin/login` / `/logout` | Connexion / déconnexion admin |
| GET | `/api/admin/orders` | Toutes les commandes |
| PATCH | `/api/admin/orders/:id/status` | Faire avancer le statut |
| PATCH | `/api/admin/orders/:id/items` | Modifier les quantités (commande en traitement) |
| GET/PUT | `/api/admin/settings` | Email de réception des bons de livraison |
| POST | `/api/admin/orders/:id/delivery-note` | Générer / envoyer le bon de livraison |

## Organisation de l'espace admin

L'administration est organisée en six sous-onglets :

- **Production** — kanban à 5 étapes (Tri → Lavage → Séchage → Repassage →
  Pliage/emballage) pour les commandes actuellement "en traitement".
  Glisser-déposer une étiquette d'une étape à l'autre.
- **Préparation de commande** — le kanban historique par statut (Reçue → En
  traitement → Prête → Livrée), inchangé.
- **Logistique livraison** — gérez vos chauffeurs (nom + véhicule optionnel),
  puis glissez les commandes "prêtes" vers le chauffeur qui les livrera.
  Une colonne "Non assigné" regroupe celles pas encore prises en charge.
- **Statistiques** — vue d'ensemble : commandes totales, articles traités,
  activité des 30 derniers jours, répartition par statut, top hôtels et
  articles les plus commandés.
- **Historique des livraisons** et **Commandes automatiques** — inchangés,
  voir plus bas.

Cliquer sur une étiquette (Production, Logistique, kanban principal) ouvre
toujours le même aperçu détaillé de la commande, avec édition des quantités
livrées si elle est "en traitement".

## Commandes automatiques (planning hôtel)

Dans Administration → « Commandes automatiques », commencez par **choisir un
hôtel** dans la liste déroulante (chaque hôtel correspond à un compte client
enregistré dans « Mon espace » — un établissement doit donc créer son compte
avant d'apparaître ici). Les types de chambre, le simulateur et les
commandes générées sont **entièrement propres à l'hôtel sélectionné** : deux
établissements peuvent avoir une chambre nommée « Double » avec des
quantités de linge complètement différentes, sans jamais se mélanger.

Une fois un hôtel choisi, vous définissez ses **types de chambre** avec deux règles :

- **Linge de départ** : ce qui part systématiquement quand une chambre fait
  son checkout (draps, housse de couette, taies...).
- **Linge de recouche** : ce qui est changé pendant le séjour (serviettes,
  drap de bain...), avec une fréquence en jours.

Chaque type de chambre peut avoir des **exceptions par mois** (ex. recouche
tous les 2 jours en juillet-août au lieu de 3) — un mois non renseigné suit
la règle par défaut.

En dessous, un simulateur calcule le linge nécessaire pour un ensemble de
séjours de cet hôtel (type de chambre + date d'arrivée + date de départ), et
peut créer la commande correspondante en un clic — les coordonnées
(société, contact, adresse) sont reprises automatiquement depuis le compte
de l'hôtel, pas besoin de les ressaisir à chaque commande.

**Amenitiz (PMS hôtelier)** : le connecteur qui alimenterait automatiquement
la liste des séjours depuis le planning Amenitiz n'est pas encore branché —
il nécessite un accès API côté Amenitiz (à demander à leur support), et
devra probablement gérer un identifiant de propriété Amenitiz par hôtel
(champ à ajouter sur la fiche client). Le moteur de calcul
(`src/utils/autoOrderRules.js`) est déjà prêt à recevoir ces données ; il
suffira d'ajouter une route qui interroge l'API Amenitiz
et transforme ses réservations en `stays` au même format que le simulateur.

## Envoi réel des bons de livraison par email

Sans configuration SMTP dans `.env`, le bouton « Générer le bon de livraison »
renvoie le texte du bon avec un lien de repli qui ouvre votre messagerie
(comme dans la version précédente).

Pour un envoi automatique réel, renseignez dans `.env` :

```
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=vous@gmail.com
SMTP_PASS=un-mot-de-passe-d-application
SMTP_FROM="Blanchisserie Cézanne <vous@gmail.com>"
```

Avec Gmail, utilisez un [mot de passe d'application](https://myaccount.google.com/apppasswords)
plutôt que votre mot de passe habituel. N'importe quel autre fournisseur
SMTP (OVH, Infomaniak, Resend, SendGrid en mode SMTP...) fonctionne de la
même façon.

## Déploiement (hébergement en continu)

Cette application (un processus Node.js + un fichier SQLite) convient bien à
un hébergeur avec **disque persistant**. **Render** est recommandé : simple,
documentation à jour, disque persistant géré, domaine personnalisé et HTTPS
gratuit inclus.

Coût indicatif chez Render (vérifié août 2026, sujet à changement — voir
[render.com/pricing](https://render.com/pricing)) : espace de travail Hobby
gratuit + service web « Starter » à 7 $/mois (toujours actif, sans mise en
veille) + disque persistant à 0,25 $/Go/mois → environ **7 à 8 $/mois** au
total pour ce projet. Le plan gratuit existe mais se met en veille après 15
minutes d'inactivité (mauvaise expérience pour un client qui commande), et
ne permet pas d'attacher de disque persistant — à éviter pour un usage réel.

### Étapes résumées

1. Poussez ce projet sur un dépôt GitHub.
2. Sur [render.com](https://render.com), créez un **Web Service** relié à ce dépôt.
   - Build command : `npm install`
   - Start command : `npm start`
3. Dans les réglages du service, ajoutez un **disque persistant** (Disks),
   par exemple monté sur `/var/data`.
4. Ajoutez les variables d'environnement du service (voir `.env.example`) :
   - `SESSION_SECRET` — une chaîne aléatoire longue
   - `DATA_DIR` — le chemin du disque monté, ex. `/var/data`
   - les variables `SMTP_*` si vous voulez l'envoi réel des bons de livraison
5. Une fois le service en ligne, allez dans **Settings → Custom Domains**,
   ajoutez votre (sous-)domaine, puis créez l'enregistrement DNS demandé
   (CNAME pour un sous-domaine type `commande.votredomaine.fr` — c'est
   l'option la plus simple ; A/ALIAS pour un domaine racine) chez votre
   registrar. Render délivre automatiquement le certificat HTTPS une fois
   la vérification DNS passée.

En VPS classique (Hetzner, OVH, DigitalOcean...), le disque est persistant
par défaut : `DATA_DIR` peut rester vide, mais il faut alors gérer soi-même
Node, un gestionnaire de process (pm2 ou systemd), et un reverse proxy
(nginx/Caddy) pour le HTTPS — plus de travail, mais aucun abonnement mensuel
de plateforme.

En production, quel que soit l'hébergeur, pensez à :
- définir un `SESSION_SECRET` long et aléatoire, différent de celui utilisé en local ;
- si vous êtes derrière un reverse proxy, ajouter `app.set('trust proxy', 1)`
  ainsi que `cookie: { secure: true }` dans `src/server.js` pour que les
  cookies de session fonctionnent correctement en HTTPS.
