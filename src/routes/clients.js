const express = require('express');
const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');
const db = require('../db');
const { requireClient } = require('../middleware/auth');
const { serializeOrder } = require('../utils/serializeOrder');

const router = express.Router();

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function publicClient(row) {
  if (!row) return null;
  const { id, email, societe, contact, tel, adresse, siret, tva_number, adresse_facturation, created_at } = row;
  return {
    id, email, societe, contact, tel, adresse,
    siret, tvaNumber: tva_number, adresseFacturation: adresse_facturation,
    createdAt: created_at,
  };
}

// POST /api/clients/register
router.post('/register', (req, res) => {
  const { societe, contact, tel, adresse, email, code } = req.body || {};

  if (!societe || !contact || !tel || !adresse || !email) {
    return res.status(400).json({ error: 'Merci de remplir tous les champs.' });
  }
  if (!EMAIL_RE.test(email)) {
    return res.status(400).json({ error: 'Adresse email invalide.' });
  }
  if (!/^\d{4,8}$/.test(code || '')) {
    return res.status(400).json({ error: "Le code d'accès doit contenir entre 4 et 8 chiffres." });
  }

  const existing = db.prepare('SELECT id FROM clients WHERE email = ?').get(email.toLowerCase());
  if (existing) {
    return res.status(409).json({ error: 'Un compte existe déjà avec cet email.' });
  }

  const codeHash = bcrypt.hashSync(code, 10);
  const info = db.prepare(`
    INSERT INTO clients (email, societe, contact, tel, adresse, code_hash)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(email.toLowerCase(), societe, contact, tel, adresse, codeHash);

  const client = db.prepare('SELECT * FROM clients WHERE id = ?').get(info.lastInsertRowid);
  req.session.clientId = client.id;
  res.status(201).json({ client: publicClient(client) });
});

// POST /api/clients/login
router.post('/login', (req, res) => {
  const { email, code } = req.body || {};
  if (!email || !code) {
    return res.status(400).json({ error: 'Merci de renseigner votre email et votre code.' });
  }
  const client = db.prepare('SELECT * FROM clients WHERE email = ?').get(email.toLowerCase());
  if (!client || !bcrypt.compareSync(code, client.code_hash)) {
    return res.status(401).json({ error: "Email ou code d'accès incorrect." });
  }
  req.session.clientId = client.id;
  res.json({ client: publicClient(client) });
});

// POST /api/clients/logout
router.post('/logout', (req, res) => {
  delete req.session.clientId;
  res.json({ ok: true });
});

// GET /api/clients/me
router.get('/me', (req, res) => {
  if (!req.session.clientId) return res.json({ client: null });
  const client = db.prepare('SELECT * FROM clients WHERE id = ?').get(req.session.clientId);
  if (!client) {
    delete req.session.clientId;
    return res.json({ client: null });
  }
  res.json({ client: publicClient(client) });
});

// PUT /api/clients/me/billing — le client renseigne lui-même ses
// informations légales/facturation (SIRET, TVA, adresse de facturation
// si différente de l'adresse de collecte). Tous les champs sont
// optionnels et peuvent être complétés progressivement.
router.put('/me/billing', requireClient, (req, res) => {
  const { siret, tvaNumber, adresseFacturation } = req.body || {};
  if (siret && !/^\d{14}$/.test(siret.replace(/\s/g, ''))) {
    return res.status(400).json({ error: 'Le SIRET doit comporter exactement 14 chiffres.' });
  }
  db.prepare('UPDATE clients SET siret = ?, tva_number = ?, adresse_facturation = ? WHERE id = ?')
    .run(siret ? siret.replace(/\s/g, '') : null, tvaNumber || null, adresseFacturation || null, req.session.clientId);
  const client = db.prepare('SELECT * FROM clients WHERE id = ?').get(req.session.clientId);
  res.json({ client: publicClient(client) });
});

// GET /api/clients/orders — historique du client connecté
router.get('/orders', requireClient, (req, res) => {
  const orders = db.prepare(`
    SELECT * FROM orders WHERE client_id = ? ORDER BY created_at DESC
  `).all(req.session.clientId);

  const itemsStmt = db.prepare('SELECT service_id as id, name, code, price, qty, delivered_qty as deliveredQty FROM order_items WHERE order_id = ?');
  const serialized = orders.map(o => serializeOrder(o, itemsStmt.all(o.id)));
  res.json({ orders: serialized });
});

// GET /api/clients/invoices — factures du client connecté dont le PDF est
// déjà disponible (une facture encore en brouillon côté Odoo n'a rien à
// montrer, elle reste invisible ici tant qu'elle n'en est pas là).
router.get('/invoices', requireClient, (req, res) => {
  const invoices = db.prepare(`
    SELECT id, odoo_number as odooNumber, total_ht as totalHt,
           period_start as periodStart, period_end as periodEnd, created_at as createdAt
    FROM invoices
    WHERE client_id = ? AND pdf_path IS NOT NULL
    ORDER BY period_start DESC
  `).all(req.session.clientId);
  res.json({ invoices });
});

// GET /api/clients/invoices/:id/pdf — télécharge le PDF d'UNE facture,
// après vérification stricte qu'elle appartient bien au client connecté
// (jamais l'id seul : un client ne doit jamais pouvoir deviner l'id d'une
// facture d'un autre hôtel pour la consulter).
router.get('/invoices/:id/pdf', requireClient, (req, res) => {
  const invoice = db.prepare('SELECT * FROM invoices WHERE id = ? AND client_id = ?').get(Number(req.params.id), req.session.clientId);
  if (!invoice || !invoice.pdf_path) return res.status(404).json({ error: 'Facture introuvable.' });
  if (!fs.existsSync(invoice.pdf_path)) return res.status(404).json({ error: 'Fichier PDF introuvable sur le serveur.' });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="${path.basename(invoice.pdf_path)}"`);
  fs.createReadStream(invoice.pdf_path).pipe(res);
});

// ---------- questionnaire de satisfaction (NPS) ----------

// GET /api/clients/nps/status — indique si le client connecté a déjà
// répondu ce mois-ci civil, pour savoir s'il faut lui proposer le
// questionnaire (au plus une fois par mois, pas à chaque connexion).
router.get('/nps/status', requireClient, (req, res) => {
  const row = db.prepare(`
    SELECT 1 FROM nps_responses
    WHERE client_id = ? AND strftime('%Y-%m', created_at) = strftime('%Y-%m', 'now')
    LIMIT 1
  `).get(req.session.clientId);
  res.json({ alreadyResponded: !!row });
});

// POST /api/clients/nps — enregistre la réponse du mois. N'empêche pas
// une deuxième soumission côté serveur (l'interface ne la propose plus
// une fois répondu, mais mieux vaut ne pas bloquer si jamais) — le calcul
// admin utilisera de toute façon la plus récente par mois et par client.
router.post('/nps', requireClient, (req, res) => {
  const { score, comment } = req.body || {};
  const scoreNum = parseInt(score, 10);
  if (!Number.isInteger(scoreNum) || scoreNum < 0 || scoreNum > 10) {
    return res.status(400).json({ error: 'Note invalide (0 à 10 attendu).' });
  }
  db.prepare('INSERT INTO nps_responses (client_id, score, comment) VALUES (?, ?, ?)')
    .run(req.session.clientId, scoreNum, (comment || '').trim() || null);
  res.status(201).json({ ok: true });
});

module.exports = router;
