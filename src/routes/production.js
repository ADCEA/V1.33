const express = require('express');
const db = require('../db');
const { requireAdmin } = require('../middleware/auth');

const router = express.Router();
router.use(requireAdmin);

const STAGES = ['tri', 'lavage', 'sechage', 'repassage', 'pliage', 'en_stock'];

const { serializeOrder } = require('../utils/serializeOrder');

const itemsStmt = db.prepare('SELECT service_id as id, name, code, price, qty, delivered_qty as deliveredQty FROM order_items WHERE order_id = ?');

// GET /api/admin/production/orders — commandes complètes "en traitement",
// nécessaire pour ouvrir l'aperçu détaillé au clic sur une étiquette
// (le kanban lui-même s'appuie sur /items, pas sur cette liste).
router.get('/orders', (req, res) => {
  const rows = db.prepare(`SELECT * FROM orders WHERE status = 'traitement' ORDER BY created_at ASC`).all();
  res.json({ orders: rows.map(o => serializeOrder(o, itemsStmt.all(o.id))) });
});

// GET /api/admin/production/items — chaque LIGNE D'ARTICLE (pas chaque
// commande) des commandes "en traitement", avec son étape de production
// propre. C'est la donnée qui alimente les étiquettes déplaçables du
// kanban Production — une étiquette par article, pas par commande.
router.get('/items', (req, res) => {
  const rows = db.prepare(`
    SELECT
      oi.id, oi.order_id as orderId, oi.name, oi.code, oi.qty,
      oi.production_stage as productionStage,
      o.ticket, o.societe, o.livraison_prevue as livraisonPrevue
    FROM order_items oi
    JOIN orders o ON o.id = oi.order_id
    WHERE o.status = 'traitement'
    ORDER BY o.created_at ASC, oi.id ASC
  `).all();
  res.json({ items: rows });
});

// PATCH /api/admin/production/items/:itemId/stage — déplacer UNE ligne
// d'article d'une étape à une autre (glisser-déposer indépendant du
// reste de sa commande).
router.patch('/items/:itemId/stage', (req, res) => {
  const { stage } = req.body || {};
  if (!STAGES.includes(stage)) {
    return res.status(400).json({ error: 'Étape de production invalide.' });
  }
  const itemId = Number(req.params.itemId);
  const item = db.prepare('SELECT * FROM order_items WHERE id = ?').get(itemId);
  if (!item) return res.status(404).json({ error: 'Article introuvable.' });

  db.prepare('UPDATE order_items SET production_stage = ? WHERE id = ?').run(stage, itemId);
  res.json({ ok: true });
});

// GET /api/admin/production/totals — quantités totales par article, tous
// clients confondus, pour les commandes "Reçue" + "En traitement" (stock
// à préparer). Une commande "Prête" ne compte plus : elle a déjà été
// sortie du stock, ce n'est plus une quantité à préparer.
router.get('/totals', (req, res) => {
  const rows = db.prepare(`
    SELECT oi.code, oi.name, SUM(oi.qty) as totalQty, COUNT(DISTINCT oi.order_id) as orderCount
    FROM order_items oi
    JOIN orders o ON o.id = oi.order_id
    WHERE o.status IN ('recue', 'traitement')
    GROUP BY oi.code, oi.name
    ORDER BY totalQty DESC
  `).all();
  res.json({ totals: rows });
});

module.exports = router;
