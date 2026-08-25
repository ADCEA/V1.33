const express = require('express');
const db = require('../db');
const { requireAdmin } = require('../middleware/auth');
const { computeStayLinen } = require('../utils/autoOrderRules');
const { serializeOrder } = require('../utils/serializeOrder');
const { getServicesById } = require('../services');

const router = express.Router();
router.use(requireAdmin);

function serializeRoomType(row) {
  return {
    id: row.id,
    clientId: row.client_id,
    name: row.name,
    departureItems: JSON.parse(row.departure_items || '[]'),
    recoucheItems: JSON.parse(row.recouche_items || '[]'),
    recoucheFrequency: row.recouche_frequency,
    monthlyOverrides: JSON.parse(row.monthly_overrides || '{}'),
  };
}

function requireClientId(req, res) {
  const clientId = Number(req.query.clientId || req.body?.clientId);
  if (!clientId) {
    res.status(400).json({ error: "clientId requis — choisissez d'abord un hôtel." });
    return null;
  }
  const client = db.prepare('SELECT id FROM clients WHERE id = ?').get(clientId);
  if (!client) {
    res.status(404).json({ error: 'Hôtel introuvable.' });
    return null;
  }
  return clientId;
}

// GET /api/admin/room-types?clientId=123 — types de chambre d'UN hôtel
router.get('/', (req, res) => {
  const clientId = requireClientId(req, res);
  if (!clientId) return;
  const rows = db.prepare('SELECT * FROM room_types WHERE client_id = ? ORDER BY name').all(clientId);
  res.json({ roomTypes: rows.map(serializeRoomType) });
});

// POST /api/admin/room-types
router.post('/', (req, res) => {
  const clientId = requireClientId(req, res);
  if (!clientId) return;
  const { name, departureItems, recoucheItems, recoucheFrequency, monthlyOverrides } = req.body || {};
  if (!name || !name.trim()) return res.status(400).json({ error: 'Le nom du type de chambre est requis.' });

  const info = db.prepare(`
    INSERT INTO room_types (client_id, name, departure_items, recouche_items, recouche_frequency, monthly_overrides)
    VALUES (@clientId, @name, @departureItems, @recoucheItems, @recoucheFrequency, @monthlyOverrides)
  `).run({
    clientId,
    name: name.trim(),
    departureItems: JSON.stringify(departureItems || []),
    recoucheItems: JSON.stringify(recoucheItems || []),
    recoucheFrequency: recoucheFrequency || null,
    monthlyOverrides: JSON.stringify(monthlyOverrides || {}),
  });

  const row = db.prepare('SELECT * FROM room_types WHERE id = ?').get(info.lastInsertRowid);
  res.status(201).json({ roomType: serializeRoomType(row) });
});

// PUT /api/admin/room-types/:id
router.put('/:id', (req, res) => {
  const id = Number(req.params.id);
  const existing = db.prepare('SELECT * FROM room_types WHERE id = ?').get(id);
  if (!existing) return res.status(404).json({ error: 'Type de chambre introuvable.' });

  const { name, departureItems, recoucheItems, recoucheFrequency, monthlyOverrides } = req.body || {};
  db.prepare(`
    UPDATE room_types
    SET name = @name, departure_items = @departureItems, recouche_items = @recoucheItems,
        recouche_frequency = @recoucheFrequency, monthly_overrides = @monthlyOverrides
    WHERE id = @id
  `).run({
    id,
    name: (name ?? existing.name).trim(),
    departureItems: JSON.stringify(departureItems ?? JSON.parse(existing.departure_items)),
    recoucheItems: JSON.stringify(recoucheItems ?? JSON.parse(existing.recouche_items || '[]')),
    recoucheFrequency: recoucheFrequency !== undefined ? recoucheFrequency : existing.recouche_frequency,
    monthlyOverrides: JSON.stringify(monthlyOverrides ?? JSON.parse(existing.monthly_overrides || '{}')),
  });

  const row = db.prepare('SELECT * FROM room_types WHERE id = ?').get(id);
  res.json({ roomType: serializeRoomType(row) });
});

// DELETE /api/admin/room-types/:id
router.delete('/:id', (req, res) => {
  db.prepare('DELETE FROM room_types WHERE id = ?').run(Number(req.params.id));
  res.json({ ok: true });
});

// Vérifie que tous les room_types référencés par `stays` appartiennent bien
// tous au même hôtel — on ne mélange jamais deux établissements dans un
// même calcul/une même commande.
function loadStaysRoomTypes(stays) {
  const ids = [...new Set(stays.map(s => s.roomTypeId))];
  if (ids.length === 0) return { error: 'Aucun séjour fourni.' };
  const placeholders = ids.map(() => '?').join(',');
  const rows = db.prepare(`SELECT * FROM room_types WHERE id IN (${placeholders})`).all(...ids);
  const byId = Object.fromEntries(rows.map(r => [r.id, r]));
  const clientIds = new Set(rows.map(r => r.client_id));
  if (clientIds.size > 1) {
    return { error: 'Les chambres sélectionnées appartiennent à plusieurs hôtels différents — une commande ne peut concerner qu\'un seul hôtel à la fois.' };
  }
  return { byId, clientId: rows[0]?.client_id };
}

// POST /api/admin/room-types/simulate
// body: { stays: [{ roomTypeId, checkinDate, checkoutDate }] }
router.post('/simulate', (req, res) => {
  const { stays } = req.body || {};
  if (!Array.isArray(stays) || stays.length === 0) {
    return res.status(400).json({ error: 'Merci de fournir au moins un séjour.' });
  }
  const { byId, error } = loadStaysRoomTypes(stays);
  if (error) return res.status(400).json({ error });

  const servicesById = getServicesById();
  const totals = {};
  for (const stay of stays) {
    const roomType = byId[stay.roomTypeId];
    if (!roomType) continue;
    const items = computeStayLinen(roomType, stay.checkinDate, stay.checkoutDate, servicesById);
    items.forEach(it => {
      if (!totals[it.id]) totals[it.id] = { ...it, qty: 0 };
      totals[it.id].qty += it.qty;
    });
  }
  res.json({ items: Object.values(totals) });
});

// POST /api/admin/room-types/generate-order
// body: { stays: [...], livraisonPrevue, notes }
// Le client (hôtel) est déduit des room_types utilisés — plus besoin de
// ressaisir société/contact/tel/adresse à chaque fois.
router.post('/generate-order', (req, res) => {
  const { stays, livraisonPrevue, notes } = req.body || {};
  if (!Array.isArray(stays) || stays.length === 0) {
    return res.status(400).json({ error: 'Merci de fournir au moins un séjour.' });
  }

  const { byId, clientId, error } = loadStaysRoomTypes(stays);
  if (error) return res.status(400).json({ error });

  const client = db.prepare('SELECT * FROM clients WHERE id = ?').get(clientId);
  if (!client) return res.status(404).json({ error: 'Hôtel introuvable pour ces chambres.' });

  const totals = {};
  const servicesById = getServicesById();
  for (const stay of stays) {
    const roomType = byId[stay.roomTypeId];
    if (!roomType) continue;
    const items = computeStayLinen(roomType, stay.checkinDate, stay.checkoutDate, servicesById);
    items.forEach(it => {
      if (!totals[it.id]) totals[it.id] = { ...it, qty: 0 };
      totals[it.id].qty += it.qty;
    });
  }
  const items = Object.values(totals);
  if (items.length === 0) {
    return res.status(400).json({ error: "Le calcul n'a produit aucun article — vérifiez les règles des types de chambre concernés." });
  }

  const now = new Date();
  const row = db.prepare('SELECT value FROM order_seq WHERE id = 1').get();
  const seq = row.value + 1;
  db.prepare('UPDATE order_seq SET value = ? WHERE id = 1').run(seq);
  const yy = String(now.getFullYear()).slice(2);
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  const dd = String(now.getDate()).padStart(2, '0');
  const ticket = `CZ-${yy}${mm}${dd}-${String(seq).padStart(4, '0')}`;

  const insertOrder = db.prepare(`
    INSERT INTO orders (ticket, client_id, societe, contact, tel, adresse, livraison_prevue, notes, status, created_at)
    VALUES (@ticket, @clientId, @societe, @contact, @tel, @adresse, @livraisonPrevue, @notes, 'recue', @createdAt)
  `);
  const insertItem = db.prepare(`
    INSERT INTO order_items (order_id, service_id, name, code, sage_code, price, qty, delivered_qty)
    VALUES (@orderId, @id, @name, @code, @sageCode, @price, @qty, @qty)
  `);

  const createOrder = db.transaction(() => {
    const info = insertOrder.run({
      ticket,
      clientId: client.id,
      societe: client.societe, contact: client.contact, tel: client.tel, adresse: client.adresse,
      livraisonPrevue: livraisonPrevue || null,
      notes: notes || `Commande générée automatiquement à partir du planning (${stays.length} chambre(s)).`,
      createdAt: now.toISOString(),
    });
    const orderId = info.lastInsertRowid;
    items.forEach(it => insertItem.run({ orderId, ...it }));
    return orderId;
  });

  const orderId = createOrder();
  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
  res.status(201).json({ order: serializeOrder(order, items), ticket });
});

module.exports = router;
