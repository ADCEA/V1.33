// Catalogue d'articles — désormais géré en base de données (table
// `articles`), modifiable depuis Administration → Gestion des articles.
//
// IMPORTANT : ce sont des FONCTIONS, pas des valeurs figées. Comme le
// catalogue peut changer à tout moment depuis l'admin, chaque fichier qui
// en a besoin doit appeler getServices()/getServicesById()/etc. au moment
// de l'utiliser (dans le corps d'une route), PAS une fois pour toutes en
// haut du fichier avec un `const { X } = require(...)` — sinon la valeur
// resterait celle du démarrage du serveur.
//
// "category" sert uniquement à regrouper l'affichage côté frontend.

const db = require('./db');

const CATEGORIES = [
  { id: 'lit', label: 'Linge de lit' },
  { id: 'toilette', label: 'Linge de toilette' },
  { id: 'service', label: 'Entretien & service' },
];

function getServices() {
  return db.prepare('SELECT id, name, code, sage_code as sageCode, price, category FROM articles ORDER BY category, name').all();
}

function getServicesById() {
  return Object.fromEntries(getServices().map(s => [s.id, s]));
}

function getServicesBySageCode() {
  return Object.fromEntries(getServices().map(s => [s.sageCode.toUpperCase(), s]));
}

// Catalogue filtré pour UN client précis : s'il a des articles attribués
// (table client_articles), il ne voit que ceux-là ; sinon, tout le
// catalogue par défaut (comportement rétrocompatible).
function getServicesForClient(clientId, date) {
  const base = (() => {
    if (!clientId) return getServices();
    const hasAssignment = db.prepare('SELECT 1 FROM client_articles WHERE client_id = ? LIMIT 1').get(clientId);
    if (!hasAssignment) return getServices();
    return db.prepare(`
      SELECT a.id, a.name, a.code, a.sage_code as sageCode, a.price, a.category
      FROM articles a
      JOIN client_articles ca ON ca.article_id = a.id
      WHERE ca.client_id = ?
      ORDER BY a.category, a.name
    `).all(clientId);
  })();
  return clientId ? applyClientPricing(base, clientId, date) : base;
}

// Résout le prix RÉELLEMENT applicable à un article pour un client donné,
// à une date donnée (aujourd'hui par défaut) : tarif négocié actif à
// cette date s'il existe, sinon prix catalogue. C'est cette fonction qui
// doit être utilisée PARTOUT où un prix est appliqué à une commande —
// jamais le prix catalogue en direct pour un client identifié.
function resolveClientPrice(clientId, articleId, date) {
  const d = date || new Date().toISOString().slice(0, 10);
  if (clientId) {
    const override = db.prepare(`
      SELECT price FROM client_prices
      WHERE client_id = ? AND article_id = ?
        AND date_debut <= ?
        AND (date_fin IS NULL OR date_fin >= ?)
      ORDER BY date_debut DESC LIMIT 1
    `).get(clientId, articleId, d, d);
    if (override) return override.price;
  }
  const catalog = db.prepare('SELECT price FROM articles WHERE id = ?').get(articleId);
  return catalog ? catalog.price : null;
}

// Applique resolveClientPrice() à une liste d'articles (remplace .price
// par le tarif réellement applicable à ce client) — utilisé par
// getServicesForClient() pour que tous ses appelants existants reçoivent
// automatiquement les bons prix sans avoir à être modifiés un par un.
function applyClientPricing(list, clientId, date) {
  return list.map(a => ({ ...a, price: resolveClientPrice(clientId, a.id, date) ?? a.price }));
}

// Variante de getServicesById() avec tarification client appliquée —
// pour les routes qui reçoivent un clientId mais avaient jusqu'ici besoin
// d'un accès par id (création manuelle, génération automatique).
function getServicesByIdForClient(clientId, date) {
  return Object.fromEntries(getServicesForClient(clientId, date).map(s => [s.id, s]));
}

module.exports = {
  getServices, getServicesById, getServicesBySageCode, getServicesForClient,
  getServicesByIdForClient, resolveClientPrice, CATEGORIES,
};
