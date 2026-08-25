const express = require('express');
const db = require('../db');
const { requireApiToken } = require('../middleware/auth');
const { getServicesForClient } = require('../services');
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

// GET /api/v1/articles — catalogue accessible à l'hôtel authentifié par
// ce jeton. Si des articles lui ont été spécifiquement attribués
// (Administration → Gestion des articles → Attribution par hôtel), seuls
// ceux-là sont renvoyés ; sinon, le catalogue complet par défaut. Le
// logiciel client doit utiliser CETTE liste pour construire ses
// commandes — un code hors de cette liste sera refusé à la création
// (voir POST /orders ci-dessous).
router.get('/articles', requireApiToken, (req, res) => {
  const articles = getServicesForClient(req.apiClient.id);
  res.json({
    articles: articles.map(a => ({ sageCode: a.sageCode, name: a.name, category: a.category })),
  });
});

// POST /api/v1/orders — création automatique d'une commande par un
// logiciel tiers, authentifié par jeton (Authorization: Bearer <jeton>).
// L'hôtel est déduit du jeton, pas besoin de le transmettre. Seuls les
// articles présents dans le catalogue RESTREINT de cet hôtel (voir GET
// /articles) sont acceptés — un code valide ailleurs dans le catalogue
// général mais non attribué à cet hôtel est refusé.
//
// body attendu :
// {
//   "livraisonPrevue": "2026-09-15",   // optionnel, format AAAA-MM-JJ
//   "notes": "...",                     // optionnel
//   "items": [
//     { "sageCode": "B-DP2", "qty": 20 },
//     { "sageCode": "B-HC2", "qty": 15 }
//   ]
// }
router.post('/orders', requireApiToken, (req, res) => {
  const client = req.apiClient;
  const { livraisonPrevue, notes, items } = req.body || {};

  if (!Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: "Le champ 'items' est requis et doit contenir au moins un article." });
  }
  if (livraisonPrevue && !/^\d{4}-\d{2}-\d{2}$/.test(livraisonPrevue)) {
    return res.status(400).json({ error: "Le champ 'livraisonPrevue' doit être au format AAAA-MM-JJ." });
  }

  const allowedBySageCode = Object.fromEntries(
    getServicesForClient(client.id).map(a => [a.sageCode.toUpperCase(), a])
  );
  const resolved = [];
  for (const it of items) {
    const svc = allowedBySageCode[String(it.sageCode || '').toUpperCase()];
    if (!svc) {
      return res.status(400).json({ error: `Code article "${it.sageCode}" inconnu ou non disponible pour ce compte. Consultez GET /api/v1/articles pour la liste des codes autorisés.` });
    }
    const qty = parseInt(it.qty, 10);
    if (!Number.isInteger(qty) || qty <= 0) {
      return res.status(400).json({ error: `Quantité invalide pour l'article "${it.sageCode}".` });
    }
    resolved.push({ ...svc, qty });
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
      clientId: client.id,
      societe: client.societe, contact: client.contact, tel: client.tel, adresse: client.adresse,
      livraisonPrevue: livraisonPrevue || null,
      notes: notes || 'Commande créée automatiquement via API.',
      createdAt: now.toISOString(),
    });
    const orderId = info.lastInsertRowid;
    for (const it of resolved) {
      insertItem.run({ orderId, id: it.id, name: it.name, code: it.code, sageCode: it.sageCode, price: it.price, qty: it.qty });
    }
    return { orderId, ticket };
  });

  const { ticket } = createOrder();

  const itemsSummary = resolved.map(it => `${it.name} x${it.qty}`).join(', ');
  sendWhatsAppNotification(`Nouvelle commande (API) ${ticket} — ${client.societe} — ${itemsSummary}`)
    .catch(err => console.error('Notification WhatsApp échouée :', err.message));

  res.status(201).json({
    ticket,
    status: 'recue',
    societe: client.societe,
    livraisonPrevue: livraisonPrevue || null,
    items: resolved.map(it => ({ sageCode: it.sageCode, name: it.name, qty: it.qty })),
    createdAt: now.toISOString(),
  });
});

// GET /api/v1/orders/:ticket — statut d'une commande déjà créée via
// l'API, pour que le logiciel client puisse vérifier son avancement.
router.get('/orders/:ticket', requireApiToken, (req, res) => {
  const client = req.apiClient;
  const order = db.prepare('SELECT * FROM orders WHERE ticket = ? AND client_id = ?').get(req.params.ticket, client.id);
  if (!order) return res.status(404).json({ error: 'Commande introuvable pour cet hôtel.' });

  const items = db.prepare('SELECT sage_code as sageCode, name, qty, delivered_qty as deliveredQty FROM order_items WHERE order_id = ?').all(order.id);
  res.json({
    ticket: order.ticket,
    status: order.status,
    livraisonPrevue: order.livraison_prevue,
    items,
    createdAt: order.created_at,
  });
});

module.exports = router;
