const express = require('express');
const db = require('../db');
const { requireAdmin } = require('../middleware/auth');
const { CATEGORIES } = require('../services');

const router = express.Router();
router.use(requireAdmin);

function slugify(text) {
  return text.toString().trim().toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '') // retire les accents
    .replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}

const ARTICLE_SELECT = 'SELECT id, name, code, sage_code as sageCode, price, category, weight_g as weightG, volume_l as volumeL, width_cm as widthCm, length_cm as lengthCm, folded_width_cm as foldedWidthCm, folded_length_cm as foldedLengthCm, folded_height_cm as foldedHeightCm FROM articles';

// GET /api/admin/articles — catalogue complet, pour l'écran de gestion.
router.get('/', (req, res) => {
  const rows = db.prepare(`${ARTICLE_SELECT} ORDER BY category, name`).all();
  res.json({ articles: rows, categories: CATEGORIES });
});

// POST /api/admin/articles — créer un nouvel article.
router.post('/', (req, res) => {
  const { name, code, sageCode, price, category, weightG, volumeL, widthCm, lengthCm, foldedWidthCm, foldedLengthCm, foldedHeightCm } = req.body || {};
  if (!name || !name.trim()) return res.status(400).json({ error: "Le nom de l'article est requis." });
  if (!code || !code.trim()) return res.status(400).json({ error: 'Le code (badge) est requis.' });
  if (!sageCode || !sageCode.trim()) return res.status(400).json({ error: 'Le code Sage est requis.' });
  const priceNum = parseFloat(price);
  if (!Number.isFinite(priceNum) || priceNum < 0) return res.status(400).json({ error: 'Prix invalide.' });
  if (!CATEGORIES.some(c => c.id === category)) return res.status(400).json({ error: 'Catégorie invalide.' });
  const weightNum = weightG !== undefined ? parseFloat(weightG) : 0;
  const volumeNum = volumeL !== undefined ? parseFloat(volumeL) : 0;
  const widthNum = widthCm !== undefined ? parseFloat(widthCm) : 0;
  const lengthNum = lengthCm !== undefined ? parseFloat(lengthCm) : 0;
  const foldedWidthNum = foldedWidthCm !== undefined ? parseFloat(foldedWidthCm) : 0;
  const foldedLengthNum = foldedLengthCm !== undefined ? parseFloat(foldedLengthCm) : 0;
  const foldedHeightNum = foldedHeightCm !== undefined ? parseFloat(foldedHeightCm) : 0;
  if (!Number.isFinite(weightNum) || weightNum < 0) return res.status(400).json({ error: 'Poids invalide.' });
  if (!Number.isFinite(volumeNum) || volumeNum < 0) return res.status(400).json({ error: 'Volume invalide.' });
  if (!Number.isFinite(widthNum) || widthNum < 0) return res.status(400).json({ error: 'Largeur invalide.' });
  if (!Number.isFinite(lengthNum) || lengthNum < 0) return res.status(400).json({ error: 'Longueur invalide.' });
  if (!Number.isFinite(foldedWidthNum) || foldedWidthNum < 0) return res.status(400).json({ error: 'Largeur pliée invalide.' });
  if (!Number.isFinite(foldedLengthNum) || foldedLengthNum < 0) return res.status(400).json({ error: 'Longueur pliée invalide.' });
  if (!Number.isFinite(foldedHeightNum) || foldedHeightNum < 0) return res.status(400).json({ error: 'Épaisseur pliée invalide.' });

  let id = slugify(name);
  if (!id) return res.status(400).json({ error: 'Nom invalide pour générer un identifiant.' });
  // Garantit un id unique si un article du même nom existe déjà.
  let suffix = 2;
  const exists = id0 => db.prepare('SELECT 1 FROM articles WHERE id = ?').get(id0);
  while (exists(id)) { id = `${slugify(name)}_${suffix}`; suffix += 1; }

  db.prepare(`
    INSERT INTO articles (id, name, code, sage_code, price, category, weight_g, volume_l, width_cm, length_cm, folded_width_cm, folded_length_cm, folded_height_cm)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, name.trim(), code.trim(), sageCode.trim(), priceNum, category, weightNum, volumeNum, widthNum, lengthNum, foldedWidthNum, foldedLengthNum, foldedHeightNum);

  const row = db.prepare(`${ARTICLE_SELECT} WHERE id = ?`).get(id);
  res.status(201).json({ article: row });
});

// PUT /api/admin/articles/:id — modifier un article existant.
router.put('/:id', (req, res) => {
  const id = req.params.id;
  const existing = db.prepare('SELECT * FROM articles WHERE id = ?').get(id);
  if (!existing) return res.status(404).json({ error: 'Article introuvable.' });

  const { name, code, sageCode, price, category, weightG, volumeL, widthCm, lengthCm, foldedWidthCm, foldedLengthCm, foldedHeightCm } = req.body || {};
  const priceNum = price !== undefined ? parseFloat(price) : existing.price;
  if (!Number.isFinite(priceNum) || priceNum < 0) return res.status(400).json({ error: 'Prix invalide.' });
  if (category !== undefined && !CATEGORIES.some(c => c.id === category)) {
    return res.status(400).json({ error: 'Catégorie invalide.' });
  }
  const weightNum = weightG !== undefined ? parseFloat(weightG) : existing.weight_g;
  const volumeNum = volumeL !== undefined ? parseFloat(volumeL) : existing.volume_l;
  const widthNum = widthCm !== undefined ? parseFloat(widthCm) : existing.width_cm;
  const lengthNum = lengthCm !== undefined ? parseFloat(lengthCm) : existing.length_cm;
  const foldedWidthNum = foldedWidthCm !== undefined ? parseFloat(foldedWidthCm) : existing.folded_width_cm;
  const foldedLengthNum = foldedLengthCm !== undefined ? parseFloat(foldedLengthCm) : existing.folded_length_cm;
  const foldedHeightNum = foldedHeightCm !== undefined ? parseFloat(foldedHeightCm) : existing.folded_height_cm;
  if (!Number.isFinite(weightNum) || weightNum < 0) return res.status(400).json({ error: 'Poids invalide.' });
  if (!Number.isFinite(volumeNum) || volumeNum < 0) return res.status(400).json({ error: 'Volume invalide.' });
  if (!Number.isFinite(widthNum) || widthNum < 0) return res.status(400).json({ error: 'Largeur invalide.' });
  if (!Number.isFinite(lengthNum) || lengthNum < 0) return res.status(400).json({ error: 'Longueur invalide.' });
  if (!Number.isFinite(foldedWidthNum) || foldedWidthNum < 0) return res.status(400).json({ error: 'Largeur pliée invalide.' });
  if (!Number.isFinite(foldedLengthNum) || foldedLengthNum < 0) return res.status(400).json({ error: 'Longueur pliée invalide.' });
  if (!Number.isFinite(foldedHeightNum) || foldedHeightNum < 0) return res.status(400).json({ error: 'Épaisseur pliée invalide.' });

  db.prepare(`
    UPDATE articles SET name = ?, code = ?, sage_code = ?, price = ?, category = ?, weight_g = ?, volume_l = ?, width_cm = ?, length_cm = ?, folded_width_cm = ?, folded_length_cm = ?, folded_height_cm = ? WHERE id = ?
  `).run(
    (name ?? existing.name).trim(),
    (code ?? existing.code).trim(),
    (sageCode ?? existing.sage_code).trim(),
    priceNum,
    category ?? existing.category,
    weightNum,
    volumeNum,
    widthNum,
    lengthNum,
    foldedWidthNum,
    foldedLengthNum,
    foldedHeightNum,
    id
  );

  const row = db.prepare(`${ARTICLE_SELECT} WHERE id = ?`).get(id);
  res.json({ article: row });
});

// DELETE /api/admin/articles/:id — retirer un article du catalogue.
// Les commandes déjà passées ne sont pas affectées : order_items garde
// sa propre copie (nom, code, prix) indépendamment de cette suppression.
router.delete('/:id', (req, res) => {
  db.prepare('DELETE FROM articles WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// ---------- attribution des articles par hôtel ----------

// GET /api/admin/articles/client/:clientId — articles actuellement
// attribués à cet hôtel (liste vide = catalogue complet par défaut).
router.get('/client/:clientId', (req, res) => {
  const rows = db.prepare(`
    SELECT article_id as articleId FROM client_articles WHERE client_id = ?
  `).all(Number(req.params.clientId));
  res.json({ articleIds: rows.map(r => r.articleId) });
});

// PUT /api/admin/articles/client/:clientId — définit la liste complète
// des articles attribués (remplace, ne cumule pas). Liste vide = retour
// au comportement par défaut (catalogue complet visible).
router.put('/client/:clientId', (req, res) => {
  const clientId = Number(req.params.clientId);
  const client = db.prepare('SELECT id FROM clients WHERE id = ?').get(clientId);
  if (!client) return res.status(404).json({ error: 'Hôtel introuvable.' });

  const { articleIds } = req.body || {};
  if (!Array.isArray(articleIds)) return res.status(400).json({ error: 'articleIds doit être une liste.' });

  const setAssignment = db.transaction(() => {
    db.prepare('DELETE FROM client_articles WHERE client_id = ?').run(clientId);
    const insert = db.prepare('INSERT OR IGNORE INTO client_articles (client_id, article_id) VALUES (?, ?)');
    for (const articleId of articleIds) insert.run(clientId, articleId);
  });
  setAssignment();
  res.json({ ok: true });
});

// ---------- capacité camion + poids chariot (réglages simples) ----------

// GET /api/admin/articles/logistics-settings
router.get('/logistics-settings', (req, res) => {
  const row = db.prepare('SELECT truck_capacity_kg as truckCapacityKg, cart_weight_kg as cartWeightKg, avg_speed_kmh as avgSpeedKmh, minutes_per_stop as minutesPerStop, max_cart_weight_kg as maxCartWeightKg, prioritize_grouping as prioritizeGrouping FROM admin WHERE id = 1').get();
  res.json(row || { truckCapacityKg: 1200, cartWeightKg: 20, avgSpeedKmh: 40, minutesPerStop: 20, maxCartWeightKg: 120, prioritizeGrouping: 1 });
});

// PUT /api/admin/articles/logistics-settings
router.put('/logistics-settings', (req, res) => {
  const { truckCapacityKg, cartWeightKg, avgSpeedKmh, minutesPerStop, maxCartWeightKg, prioritizeGrouping } = req.body || {};
  const truck = parseFloat(truckCapacityKg);
  const cartWeight = parseFloat(cartWeightKg);
  const avgSpeed = parseFloat(avgSpeedKmh);
  const perStop = parseFloat(minutesPerStop);
  const maxCartWeight = parseFloat(maxCartWeightKg);
  if (!Number.isFinite(truck) || truck <= 0) return res.status(400).json({ error: 'Capacité de camion invalide.' });
  if (!Number.isFinite(cartWeight) || cartWeight < 0) return res.status(400).json({ error: 'Poids de chariot invalide.' });
  if (!Number.isFinite(avgSpeed) || avgSpeed <= 0) return res.status(400).json({ error: 'Vitesse moyenne invalide.' });
  if (!Number.isFinite(perStop) || perStop < 0) return res.status(400).json({ error: 'Temps par arrêt invalide.' });
  if (!Number.isFinite(maxCartWeight) || maxCartWeight <= 0) return res.status(400).json({ error: 'Poids maximum par chariot invalide.' });
  db.prepare('UPDATE admin SET truck_capacity_kg = ?, cart_weight_kg = ?, avg_speed_kmh = ?, minutes_per_stop = ?, max_cart_weight_kg = ?, prioritize_grouping = ? WHERE id = 1')
    .run(truck, cartWeight, avgSpeed, perStop, maxCartWeight, prioritizeGrouping ? 1 : 0);
  res.json({ ok: true });
});

// ---------- types de chariots ----------

function serializeCartType(row) {
  return {
    id: row.id,
    name: row.name,
    lengthCm: row.length_cm,
    widthCm: row.width_cm,
    heightCm: row.height_cm,
    volumeL: Math.round((row.length_cm * row.width_cm * row.height_cm / 1000) * 10) / 10,
  };
}

// GET /api/admin/articles/cart-types
router.get('/cart-types', (req, res) => {
  const rows = db.prepare('SELECT * FROM cart_types ORDER BY length_cm * width_cm * height_cm DESC').all();
  res.json({ cartTypes: rows.map(serializeCartType) });
});

// POST /api/admin/articles/cart-types
router.post('/cart-types', (req, res) => {
  const { name, lengthCm, widthCm, heightCm } = req.body || {};
  if (!name || !name.trim()) return res.status(400).json({ error: 'Le nom du chariot est requis.' });
  const l = parseFloat(lengthCm), w = parseFloat(widthCm), h = parseFloat(heightCm);
  if (![l, w, h].every(n => Number.isFinite(n) && n > 0)) {
    return res.status(400).json({ error: 'Longueur, largeur et hauteur doivent être des nombres positifs (en cm).' });
  }
  const info = db.prepare('INSERT INTO cart_types (name, length_cm, width_cm, height_cm) VALUES (?, ?, ?, ?)').run(name.trim(), l, w, h);
  const row = db.prepare('SELECT * FROM cart_types WHERE id = ?').get(info.lastInsertRowid);
  res.status(201).json({ cartType: serializeCartType(row) });
});

// DELETE /api/admin/articles/cart-types/:id
router.delete('/cart-types/:id', (req, res) => {
  db.prepare('DELETE FROM cart_types WHERE id = ?').run(Number(req.params.id));
  res.json({ ok: true });
});

// ---------- types de camions ----------

function serializeTruckType(row) {
  return {
    id: row.id,
    name: row.name,
    lengthCm: row.length_cm,
    widthCm: row.width_cm,
    heightCm: row.height_cm,
    volumeL: Math.round((row.length_cm * row.width_cm * row.height_cm / 1000) * 10) / 10,
  };
}

// GET /api/admin/articles/truck-types
router.get('/truck-types', (req, res) => {
  const rows = db.prepare('SELECT * FROM truck_types ORDER BY length_cm * width_cm * height_cm DESC').all();
  res.json({ truckTypes: rows.map(serializeTruckType) });
});

// POST /api/admin/articles/truck-types
router.post('/truck-types', (req, res) => {
  const { name, lengthCm, widthCm, heightCm } = req.body || {};
  if (!name || !name.trim()) return res.status(400).json({ error: 'Le nom du véhicule est requis.' });
  const l = parseFloat(lengthCm), w = parseFloat(widthCm), h = parseFloat(heightCm);
  if (![l, w, h].every(n => Number.isFinite(n) && n > 0)) {
    return res.status(400).json({ error: 'Longueur, largeur et hauteur doivent être des nombres positifs (en cm).' });
  }
  const info = db.prepare('INSERT INTO truck_types (name, length_cm, width_cm, height_cm) VALUES (?, ?, ?, ?)').run(name.trim(), l, w, h);
  const row = db.prepare('SELECT * FROM truck_types WHERE id = ?').get(info.lastInsertRowid);
  res.status(201).json({ truckType: serializeTruckType(row) });
});

// DELETE /api/admin/articles/truck-types/:id
router.delete('/truck-types/:id', (req, res) => {
  db.prepare('DELETE FROM truck_types WHERE id = ?').run(Number(req.params.id));
  res.json({ ok: true });
});

module.exports = router;
