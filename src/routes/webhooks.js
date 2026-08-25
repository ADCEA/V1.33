const express = require('express');
const crypto = require('crypto');
const multer = require('multer');
const db = require('../db');
const { parseOrderEmail } = require('../utils/parseOrderEmail');
const { serializeOrder } = require('../utils/serializeOrder');
const { sendWhatsAppNotification } = require('../utils/whatsapp');
const { sendMail, isConfigured: smtpConfigured } = require('../utils/mailer');

const router = express.Router();
const upload = multer(); // Mailgun envoie le mail en multipart/form-data

function verifyMailgunSignature(timestamp, token, signature) {
  const signingKey = process.env.MAILGUN_SIGNING_KEY;
  if (!signingKey) return false;
  const expected = crypto
    .createHmac('sha256', signingKey)
    .update(timestamp.concat(token))
    .digest('hex');
  try {
    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
  } catch {
    return false; // longueurs différentes = signature invalide
  }
}

function nextTicket(now) {
  const row = db.prepare('SELECT value FROM order_seq WHERE id = 1').get();
  const seq = row.value + 1;
  db.prepare('UPDATE order_seq SET value = ? WHERE id = 1').run(seq);
  const yy = String(now.getFullYear()).slice(2);
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  const dd = String(now.getDate()).padStart(2, '0');
  return `CZ-${yy}${mm}${dd}-${String(seq).padStart(4, '0')}`;
}

// Extrait l'adresse email pure d'un champ "From" du type
// '"Hôtel Le Galambre" <contact@legalambre.fr>' → 'contact@legalambre.fr'
function extractEmailAddress(fromField) {
  if (!fromField) return null;
  const match = fromField.match(/<([^>]+)>/);
  const email = (match ? match[1] : fromField).trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : null;
}

function notifyUnhandled(text) {
  sendWhatsAppNotification(text).catch(() => {});
  if (smtpConfigured()) {
    const admin = db.prepare('SELECT delivery_email FROM admin WHERE id = 1').get();
    if (admin?.delivery_email) {
      sendMail({ to: admin.delivery_email, subject: 'Email de commande non traité automatiquement', text }).catch(() => {});
    }
  }
}

const insertOrder = db.prepare(`
  INSERT INTO orders (ticket, client_id, societe, contact, tel, adresse, livraison_prevue, notes, status, created_at)
  VALUES (@ticket, @clientId, @societe, @contact, @tel, @adresse, @livraisonPrevue, @notes, 'recue', @createdAt)
`);
const insertItem = db.prepare(`
  INSERT INTO order_items (order_id, service_id, name, code, sage_code, price, qty, delivered_qty)
  VALUES (@orderId, @id, @name, @code, @sageCode, @price, @qty, @qty)
`);

// POST /api/webhooks/inbound-email — appelé par Mailgun à chaque email reçu
router.post('/inbound-email', upload.any(), async (req, res) => {
  const { timestamp, token, signature, ['body-plain']: bodyPlain, ['stripped-text']: strippedText, from, subject } = req.body || {};

  if (!process.env.MAILGUN_SIGNING_KEY) {
    console.error('MAILGUN_SIGNING_KEY absent — email entrant ignoré par sécurité.');
    return res.status(200).send('ignored');
  }
  if (!verifyMailgunSignature(timestamp, token, signature)) {
    console.error('Signature Mailgun invalide — email entrant rejeté.');
    return res.status(401).send('invalid signature');
  }

  // Toujours répondre 200 rapidement à Mailgun, le reste se fait en best-effort.
  res.status(200).send('ok');

  const text = strippedText || bodyPlain || '';
  const senderEmail = extractEmailAddress(from);

  // L'hôtel est identifié par l'adresse d'expédition, qui doit correspondre
  // à un compte client déjà enregistré (voir "Mon espace") — on ne fait
  // plus confiance à des champs société/adresse tapés dans le corps du mail,
  // ce format réel n'en contient d'ailleurs pas.
  const client = senderEmail ? db.prepare('SELECT * FROM clients WHERE email = ?').get(senderEmail) : null;

  if (!client) {
    const msg = `Email de commande reçu de ${senderEmail || from || 'expéditeur inconnu'} (sujet : ${subject || '—'}) mais cet expéditeur ne correspond à aucun compte client enregistré — commande non créée automatiquement.\n\nDébut du message :\n${text.slice(0, 400)}`;
    console.error(msg);
    notifyUnhandled(msg);
    return;
  }

  const result = parseOrderEmail(text);
  if (!result.ok) {
    const msg = `Email de commande reçu de ${client.societe} (${senderEmail}) mais non compris automatiquement.\nErreurs : ${result.errors.join(', ')}\n\nDébut du message :\n${text.slice(0, 400)}`;
    console.error(msg);
    notifyUnhandled(msg);
    return;
  }

  const now = new Date();
  const createdTickets = [];

  const createOrders = db.transaction(() => {
    for (const building of result.buildings) {
      const ticket = nextTicket(now);
      const roomsNote = building.rooms.length ? `Chambres : ${building.rooms.join(', ')}. ` : '';
      const notes = `${building.label ? building.label + '. ' : ''}${roomsNote}Commande créée automatiquement depuis un email.`.trim();

      const info = insertOrder.run({
        ticket,
        clientId: client.id,
        societe: client.societe, contact: client.contact, tel: client.tel, adresse: client.adresse,
        livraisonPrevue: result.livraisonPrevue,
        notes,
        createdAt: now.toISOString(),
      });
      const orderId = info.lastInsertRowid;
      for (const it of building.items) insertItem.run({ orderId, ...it });
      createdTickets.push({ ticket, label: building.label, itemCount: building.items.length });
    }
  });
  createOrders();

  const summary = createdTickets.map(t => `${t.ticket}${t.label ? ' (' + t.label + ')' : ''} — ${t.itemCount} article(s)`).join('\n');
  sendWhatsAppNotification(`${createdTickets.length} commande(s) créée(s) par email pour ${client.societe} :\n${summary}`)
    .catch(err => console.error('Notification WhatsApp échouée :', err.message));

  console.log(`${createdTickets.length} commande(s) créée(s) depuis un email pour ${client.societe} :`, createdTickets.map(t => t.ticket).join(', '));
});

module.exports = router;
