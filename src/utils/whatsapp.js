/**
 * Notification WhatsApp (Meta Cloud API) à chaque nouvelle commande.
 * Voir README.md pour la configuration complète côté Meta.
 *
 * Sans WHATSAPP_TOKEN / WHATSAPP_PHONE_NUMBER_ID / WHATSAPP_TO_NUMBER dans
 * .env, cette fonction ne fait rien silencieusement (fonctionnalité
 * optionnelle, comme l'email).
 */

function isConfigured() {
  return Boolean(
    process.env.WHATSAPP_TOKEN &&
    process.env.WHATSAPP_PHONE_NUMBER_ID &&
    process.env.WHATSAPP_TO_NUMBER
  );
}

/**
 * Envoie une notification WhatsApp.
 * `bodyText` n'est utilisé que si un template personnalisé (avec une
 * variable {{1}}) est configuré via WHATSAPP_TEMPLATE_NAME. Par défaut,
 * le template "hello_world" de Meta est utilisé — il ne nécessite aucune
 * validation mais son contenu est fixe (pas de détails de commande dedans).
 * Voir le README pour créer votre propre template avec le texte inclus.
 */
async function sendWhatsAppNotification(bodyText) {
  if (!isConfigured()) {
    return { sent: false, reason: 'not_configured' };
  }

  const templateName = process.env.WHATSAPP_TEMPLATE_NAME || 'hello_world';
  const isCustomTemplate = templateName !== 'hello_world';

  const payload = {
    messaging_product: 'whatsapp',
    to: process.env.WHATSAPP_TO_NUMBER,
    type: 'template',
    template: isCustomTemplate
      ? {
          name: templateName,
          language: { code: process.env.WHATSAPP_TEMPLATE_LANG || 'fr' },
          components: [{ type: 'body', parameters: [{ type: 'text', text: bodyText }] }],
        }
      : {
          // Template par défaut fourni par Meta, aucune approbation requise,
          // mais texte fixe en anglais ("Hello World").
          name: 'hello_world',
          language: { code: 'en_US' },
        },
  };

  const url = `https://graph.facebook.com/v21.0/${process.env.WHATSAPP_PHONE_NUMBER_ID}/messages`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.WHATSAPP_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`WhatsApp API a répondu ${res.status} : ${errText}`);
  }
  return { sent: true };
}

module.exports = { sendWhatsAppNotification, isConfigured };
