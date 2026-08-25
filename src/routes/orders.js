const express = require('express');
const db = require('../db');
const { getServicesByIdForClient } = require('../services');
const { serializeOrder } = require('../utils/serializeOrder');
const { sendWhatsAppNotification } = require('../utils/whatsapp');

const router = express.Router();

function nextTicket(now) {
  const row = db.prepare('SELECT value FROM order_seq WHERE id = 1').get();
  const seq = row.value + 1;
  db.prepare('UPDATE order_seq SET value = ? WHERE id = 1').run(seq);

  const yy = String(now.getFullYear()).slice(2);
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  const dd = String(now.getDate()).padStart(2, '0');
  return `CZ-${yy}${mm}${dd}-${String(seq).padStart(4, '0')}`;
}

// POST /api/orders — créer une commande (client connecté ou invité)
router.post('/', (req, res) => {
  const { items, livraisonPrevue, notes, client } = req.body || {};
  const { societe, contact, tel, adresse } = client || {};

  if (!societe || !contact || !tel || !adresse) {
    return res.status(400).json({ error: 'Merci de renseigner société, contact, téléphone et adresse.' });
  }
  if (!Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: 'Merci de sélectionner au moins un article.' });
  }

  const clientId = req.session.clientId || null;
  const servicesById = getServicesByIdForClient(clientId);
  const resolved = [];
  for (const it of items) {
    const svc = servicesById[it.id];
    const qty = parseInt(it.qty, 10);
    if (!svc) return res.status(400).json({ error: `Article inconnu : ${it.id}` });
    if (!Number.isInteger(qty) || qty <= 0) {
      return res.status(400).json({ error: `Quantité invalide pour ${svc.name}.` });
    }
    resolved.push({ ...svc, qty, deliveredQty: qty });
  }

  const now = new Date();

  const insertOrder = db.prepare(`
    INSERT INTO orders (ticket, client_id, societe, contact, tel, adresse, livraison_prevue, notes, status, created_at)
    VALUES (@ticket, @clientId, @societe, @contact, @tel, @adresse, @livraisonPrevue, @notes, 'recue', @createdAt)
  `);
  const insertItem = db.prepare(`
    INSERT INTO order_items (order_id, service_id, name, code, sage_code, price, qty, delivered_qty)
    VALUES (@orderId, @id, @name, @code, @sageCode, @price, @qty, @qty)
  `);

  const createOrder = db.transaction(() => {
    const ticket = nextTicket(now);
    const info = insertOrder.run({
      ticket,
      clientId,
      societe, contact, tel, adresse,
      livraisonPrevue: livraisonPrevue || null,
      notes: notes || null,
      createdAt: now.toISOString(),
    });
    const orderId = info.lastInsertRowid;
    for (const it of resolved) {
      insertItem.run({ orderId, id: it.id, name: it.name, code: it.code, sageCode: it.sageCode, price: it.price, qty: it.qty });
    }
    return { orderId, ticket };
  });

  const { orderId, ticket } = createOrder();
  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);

  // Notification best-effort : une erreur ici ne doit jamais empêcher
  // la commande d'être créée avec succès pour le client.
  const itemsSummary = resolved.map(i => `${i.name} x${i.qty}`).join(', ');
  sendWhatsAppNotification(`Nouvelle commande ${ticket} — ${societe} (${contact}) — ${itemsSummary}`)
    .catch(err => console.error('Notification WhatsApp échouée :', err.message));

  res.status(201).json({ order: serializeOrder(order, resolved), ticket });
});

// GET /api/orders/track/:ticket — suivi public par numéro de ticket
router.get('/track/:ticket', (req, res) => {
  const order = db.prepare('SELECT * FROM orders WHERE ticket = ?').get(req.params.ticket.trim().toUpperCase());
  if (!order) return res.status(404).json({ error: 'Aucune commande trouvée pour ce numéro.' });
  const items = db.prepare('SELECT service_id as id, name, code, price, qty, delivered_qty as deliveredQty FROM order_items WHERE order_id = ?').all(order.id);
  res.json({ order: serializeOrder(order, items) });
});

module.exports = router;
