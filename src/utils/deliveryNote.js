function formatDateFr(iso) {
  if (!iso) return 'à confirmer';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString('fr-FR');
}

const STATUS_LABELS = {
  recue: 'Reçue',
  traitement: 'En traitement',
  prete: 'Prête',
  livree: 'Livrée',
};

function buildDeliveryNoteText(order) {
  const lines = order.items.map(i => {
    const delivered = i.deliveredQty ?? i.qty;
    return delivered !== i.qty
      ? `- ${i.name} × ${delivered} (commandé : ${i.qty})`
      : `- ${i.name} × ${i.qty}`;
  }).join('\n');
  return [
    'BON DE LIVRAISON',
    'Blanchisserie Cézanne',
    '',
    `Ticket : ${order.ticket}`,
    `Client : ${order.societe} — ${order.contact}`,
    `Téléphone : ${order.tel}`,
    `Adresse : ${order.adresse}`,
    `Date de livraison prévue : ${formatDateFr(order.livraison_prevue)}`,
    `Statut : ${STATUS_LABELS[order.status] || order.status}`,
    '',
    'Articles :',
    lines,
    '',
    order.notes ? `Notes : ${order.notes}` : '',
    '',
    `Généré le ${new Date().toLocaleDateString('fr-FR')}`,
  ].filter(Boolean).join('\n');
}

// Échappe le HTML pour éviter qu'un nom de client contenant des caractères
// spéciaux ne casse la mise en page de l'email.
function esc(str) {
  return String(str ?? '').replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

/**
 * Email HTML aux couleurs du site (bleu de marque), avec un tableau
 * commandé/livré. Pensé pour accompagner le PDF joint (voir utils/pdf.js) :
 * l'email donne l'essentiel en un coup d'œil, le PDF est le document
 * complet à conserver ou imprimer.
 */
function buildDeliveryNoteHtml(order) {
  const rows = order.items.map(i => {
    const delivered = i.deliveredQty ?? i.qty;
    const diff = delivered !== i.qty;
    return `
      <tr>
        <td style="padding:8px 0;border-bottom:1px solid #DEE6EE;color:#16324F;font-size:13px;">${esc(i.name)}</td>
        <td style="padding:8px 0;border-bottom:1px solid #DEE6EE;color:#64798D;font-size:13px;text-align:right;">${i.qty}</td>
        <td style="padding:8px 0;border-bottom:1px solid #DEE6EE;font-size:13px;text-align:right;font-weight:${diff ? '700' : '400'};color:${diff ? '#0F6FCB' : '#16324F'};">${delivered}</td>
      </tr>`;
  }).join('');

  return `
<div style="font-family:Helvetica,Arial,sans-serif;max-width:520px;margin:0 auto;background:#F5F8FC;padding:24px 12px;">
  <div style="background:linear-gradient(135deg,#0F6FCB,#16324F);padding:26px 28px;border-radius:10px 10px 0 0;">
    <h1 style="color:#ffffff;font-size:19px;margin:0;letter-spacing:0.02em;">Blanchisserie Cézanne</h1>
    <p style="color:#AFC0CF;margin:6px 0 0;font-size:12.5px;">Du linge propre, livré dans les temps.</p>
  </div>
  <div style="background:#ffffff;border:1px solid #DEE6EE;border-top:none;border-radius:0 0 10px 10px;padding:28px;">
    <p style="font-size:11px;color:#64798D;text-transform:uppercase;letter-spacing:0.06em;margin:0 0 6px;">Bon de livraison</p>
    <p style="font-size:26px;font-weight:700;color:#16324F;margin:0 0 6px;font-family:'Courier New',monospace;">${esc(order.ticket)}</p>
    <span style="display:inline-block;background:#16324F;color:#fff;font-size:10.5px;text-transform:uppercase;letter-spacing:0.04em;padding:4px 12px;border-radius:20px;margin-bottom:20px;">${esc(STATUS_LABELS[order.status] || order.status)}</span>

    <table style="width:100%;border-top:2px dashed #DEE6EE;padding-top:16px;margin-top:6px;border-collapse:collapse;">
      <tr><td style="padding-top:16px;font-size:14px;color:#16324F;"><b>${esc(order.societe)}</b> — ${esc(order.contact)}</td></tr>
      <tr><td style="font-size:12.5px;color:#64798D;padding-top:4px;">${esc(order.adresse)}</td></tr>
      <tr><td style="font-size:12.5px;color:#64798D;padding-top:2px;">Tél : ${esc(order.tel)} · Livraison prévue : ${esc(formatDateFr(order.livraison_prevue))}</td></tr>
    </table>

    <table style="width:100%;border-collapse:collapse;margin-top:22px;">
      <thead>
        <tr>
          <th style="text-align:left;font-size:10.5px;color:#64798D;text-transform:uppercase;letter-spacing:0.04em;padding-bottom:8px;border-bottom:1px solid #DEE6EE;">Article</th>
          <th style="text-align:right;font-size:10.5px;color:#64798D;text-transform:uppercase;letter-spacing:0.04em;padding-bottom:8px;border-bottom:1px solid #DEE6EE;">Commandé</th>
          <th style="text-align:right;font-size:10.5px;color:#64798D;text-transform:uppercase;letter-spacing:0.04em;padding-bottom:8px;border-bottom:1px solid #DEE6EE;">Livré</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>

    ${order.notes ? `<p style="font-size:12px;color:#64798D;margin-top:18px;padding-top:14px;border-top:1px dashed #DEE6EE;">Notes : ${esc(order.notes)}</p>` : ''}

    <p style="font-size:11.5px;color:#AFC0CF;margin-top:26px;margin-bottom:0;">📎 Le PDF complet de ce bon de livraison est joint à cet email.</p>
  </div>
  <p style="text-align:center;font-size:10.5px;color:#AFC0CF;margin-top:16px;">Blanchisserie Cézanne</p>
</div>`;
}

module.exports = { buildDeliveryNoteText, buildDeliveryNoteHtml, STATUS_LABELS, formatDateFr };
