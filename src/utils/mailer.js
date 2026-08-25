const nodemailer = require('nodemailer');

function isConfigured() {
  return Boolean(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS);
}

let transporter = null;
function getTransporter() {
  if (!isConfigured()) return null;
  if (!transporter) {
    transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: Number(process.env.SMTP_PORT || 587),
      secure: process.env.SMTP_SECURE === 'true',
      auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS,
      },
    });
  }
  return transporter;
}

/**
 * Envoie un email si le SMTP est configuré (.env).
 * Retourne { sent: true } en cas de succès,
 * ou { sent: false, reason: '...' } si le SMTP n'est pas configuré.
 * Laisse remonter l'erreur si l'envoi échoue réellement (ex. identifiants invalides).
 *
 * `html` est optionnel (sinon email en texte brut). `attachments` suit le
 * format nodemailer : [{ filename, content: Buffer, contentType }].
 */
async function sendMail({ to, subject, text, html, attachments }) {
  const t = getTransporter();
  if (!t) {
    return { sent: false, reason: 'smtp_not_configured' };
  }
  await t.sendMail({
    from: process.env.SMTP_FROM || process.env.SMTP_USER,
    to,
    subject,
    text,
    ...(html ? { html } : {}),
    ...(attachments ? { attachments } : {}),
  });
  return { sent: true };
}

module.exports = { sendMail, isConfigured };
