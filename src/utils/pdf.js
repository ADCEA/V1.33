const PDFDocument = require('pdfkit');
const { STATUS_LABELS, formatDateFr } = require('./deliveryNote');

// Palette limitée à l'essentiel pour l'impression : le document reste
// lisible et sobre en noir/gris sur une imprimante N&B, avec une seule
// touche de couleur (fine ligne d'accent) pour la charte quand imprimé
// en couleur ou consulté à l'écran.
const INK = '#16324F';    // texte principal — quasi noir
const GRAY = '#64798D';   // texte secondaire
const LINE = '#B9C4CE';   // filets — assez foncé pour rester visible en N&B
const ACCENT = '#1D91FF'; // unique touche de couleur (filet + nom de la marque)
const RUST = '#E0574B';   // alerte (articles ne rentrant dans aucun chariot)

/**
 * Génère le PDF du bon de livraison et résout avec un Buffer.
 * `order` doit contenir : ticket, status, societe, contact, tel, adresse,
 * livraison_prevue, notes, items ([{name, qty, deliveredQty}]).
 */
function buildDeliveryNotePdf(order) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 50 });
    const chunks = [];
    doc.on('data', c => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const pageWidth = doc.page.width;
    const marginX = 50;
    let hasAdjustedItem = false;

    // ---------- en-tête (texte + un seul filet de couleur, pas de fond plein) ----------
    doc.fillColor(ACCENT).font('Helvetica-Bold').fontSize(18)
      .text('BLANCHISSERIE CÉZANNE', marginX, 45);
    doc.font('Helvetica').fontSize(9.5).fillColor(GRAY)
      .text('Du linge propre, livré dans les temps.', marginX, 68);

    doc.save().strokeColor(ACCENT).lineWidth(1.5)
      .moveTo(marginX, 92).lineTo(pageWidth - marginX, 92).stroke().restore();

    let y = 116;

    // ---------- ticket ----------
    doc.font('Helvetica').fontSize(9.5).fillColor(GRAY)
      .text('BON DE LIVRAISON', marginX, y, { characterSpacing: 1 });
    y += 16;
    doc.font('Helvetica-Bold').fontSize(22).fillColor(INK)
      .text(order.ticket, marginX, y);
    y += 32;

    // Statut : cadre à contour, pas de fond plein — imprimable sans encre couleur.
    const statusLabel = (STATUS_LABELS[order.status] || order.status).toUpperCase();
    const badgeWidth = doc.widthOfString(statusLabel) + 22;
    doc.save().strokeColor(INK).lineWidth(1)
      .roundedRect(marginX, y, badgeWidth, 19, 9).stroke().restore();
    doc.font('Helvetica-Bold').fontSize(8.5).fillColor(INK)
      .text(statusLabel, marginX, y + 5.5, { width: badgeWidth, align: 'center' });
    y += 38;

    // ---------- ligne pointillée ----------
    function dashedLine(atY) {
      doc.save().strokeColor(LINE).lineWidth(0.75).dash(2, { space: 2 })
        .moveTo(marginX, atY).lineTo(pageWidth - marginX, atY).stroke().undash().restore();
    }
    dashedLine(y);
    y += 20;

    // ---------- client ----------
    doc.font('Helvetica-Bold').fontSize(8.5).fillColor(GRAY)
      .text('CLIENT', marginX, y, { characterSpacing: 1 });
    y += 14;
    doc.font('Helvetica-Bold').fontSize(11.5).fillColor(INK)
      .text(`${order.societe} — ${order.contact}`, marginX, y);
    y += 16;
    doc.font('Helvetica').fontSize(9.5).fillColor(GRAY)
      .text(order.adresse, marginX, y);
    y += 13;
    doc.text(`Tél : ${order.tel}`, marginX, y);
    y += 13;
    doc.text(`Livraison prévue : ${formatDateFr(order.livraison_prevue)}`, marginX, y);
    y += 28;

    dashedLine(y);
    y += 20;

    // ---------- articles ----------
    doc.font('Helvetica-Bold').fontSize(8.5).fillColor(GRAY)
      .text('ARTICLES', marginX, y, { characterSpacing: 1 });
    y += 20;

    const colArticle = marginX;
    const colCommande = pageWidth - marginX - 180;
    const colLivre = pageWidth - marginX - 80;

    doc.font('Helvetica-Bold').fontSize(8.5).fillColor(GRAY);
    doc.text('Article', colArticle, y);
    doc.text('Commandé', colCommande, y, { width: 80, align: 'right' });
    doc.text('Livré', colLivre, y, { width: 80, align: 'right' });
    y += 13;
    doc.save().strokeColor(INK).lineWidth(1)
      .moveTo(marginX, y).lineTo(pageWidth - marginX, y).stroke().restore();
    y += 10;

    order.items.forEach(item => {
      const delivered = item.deliveredQty ?? item.qty;
      const diff = delivered !== item.qty;
      if (diff) hasAdjustedItem = true;
      doc.font('Helvetica').fontSize(10).fillColor(INK)
        .text(item.name, colArticle, y, { width: colCommande - colArticle - 10 });
      doc.fillColor(GRAY).text(String(item.qty), colCommande, y, { width: 80, align: 'right' });
      // Une quantité ajustée se distingue par le gras + un astérisque,
      // pas par la couleur seule — reste lisible imprimé en N&B.
      doc.font(diff ? 'Helvetica-Bold' : 'Helvetica').fillColor(INK)
        .text(diff ? `${delivered} *` : String(delivered), colLivre, y, { width: 80, align: 'right' });
      y += 19;
    });

    if (hasAdjustedItem) {
      y += 4;
      doc.font('Helvetica-Oblique').fontSize(8).fillColor(GRAY)
        .text('* quantité livrée différente de la quantité commandée', marginX, y);
      y += 14;
    }

    y += 8;
    if (order.notes) {
      doc.save().strokeColor(LINE).lineWidth(0.75)
        .moveTo(marginX, y).lineTo(pageWidth - marginX, y).stroke().restore();
      y += 16;
      doc.font('Helvetica-Bold').fontSize(8.5).fillColor(GRAY)
        .text('NOTES', marginX, y, { characterSpacing: 1 });
      y += 14;
      doc.font('Helvetica').fontSize(9.5).fillColor(INK)
        .text(order.notes, marginX, y, { width: pageWidth - marginX * 2 });
    }

    // ---------- pied de page ----------
    doc.font('Helvetica').fontSize(7.5).fillColor(GRAY)
      .text(`Généré le ${new Date().toLocaleDateString('fr-FR')} — Blanchisserie Cézanne`,
        marginX, doc.page.height - 50);

    doc.end();
  });
}

/**
 * Génère le PDF du bon de préparation (plan de conditionnement) et
 * résout avec un Buffer. `order` doit contenir : ticket, societe.
 * `plan` est le résultat de packItems : { carts: [{name, usedL, capacityL,
 * usedKg, maxWeightKg, items:[{name, code, qty}]}], unpacked: [...] }.
 * Chaque article est précédé d'une case à cocher — pensé pour être
 * imprimé et coché à la main pendant le conditionnement.
 */
function buildPreparationSlipPdf(order, plan) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 50, bufferPages: true });
    const chunks = [];
    doc.on('data', c => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const pageWidth = doc.page.width;
    const pageHeight = doc.page.height;
    const marginX = 50;
    const bottomLimit = pageHeight - 60;

    function ensureSpace(needed) {
      if (doc.y + needed > bottomLimit) doc.addPage();
    }

    function dashedLine(atY) {
      doc.save().strokeColor(LINE).lineWidth(0.75).dash(2, { space: 2 })
        .moveTo(marginX, atY).lineTo(pageWidth - marginX, atY).stroke().undash().restore();
    }

    // ---------- en-tête ----------
    doc.fillColor(ACCENT).font('Helvetica-Bold').fontSize(18)
      .text('BLANCHISSERIE CÉZANNE', marginX, 45);
    doc.font('Helvetica').fontSize(9.5).fillColor(GRAY)
      .text('Du linge propre, livré dans les temps.', marginX, 68);
    doc.save().strokeColor(ACCENT).lineWidth(1.5)
      .moveTo(marginX, 92).lineTo(pageWidth - marginX, 92).stroke().restore();

    let y = 116;
    doc.font('Helvetica').fontSize(9.5).fillColor(GRAY)
      .text('BON DE PRÉPARATION — CONDITIONNEMENT', marginX, y, { characterSpacing: 1 });
    y += 16;
    doc.font('Helvetica-Bold').fontSize(22).fillColor(INK)
      .text(order.ticket, marginX, y);
    y += 30;
    doc.font('Helvetica-Bold').fontSize(11.5).fillColor(INK)
      .text(order.societe, marginX, y);
    y += 24;
    doc.y = y;

    // ---------- un bloc par chariot ----------
    plan.carts.forEach((cart, idx) => {
      ensureSpace(70);
      y = doc.y;
      dashedLine(y);
      y += 18;

      doc.font('Helvetica-Bold').fontSize(13).fillColor(INK)
        .text(cart.name, marginX, y);
      const summary = `${cart.usedL} / ${cart.capacityL} L   ·   ${cart.usedKg} / ${cart.maxWeightKg} kg`;
      doc.font('Helvetica').fontSize(9.5).fillColor(GRAY)
        .text(summary, marginX, y + 2, { width: pageWidth - marginX * 2, align: 'right' });
      y += 22;
      doc.font('Helvetica-Oblique').fontSize(8).fillColor(GRAY)
        .text('Ordre de chargement — le plus lourd d\'abord, au fond du chariot :', marginX, y);
      y += 16;
      doc.y = y;

      cart.items.forEach((item, itemIdx) => {
        ensureSpace(24);
        y = doc.y;
        // case à cocher
        doc.save().strokeColor(INK).lineWidth(1)
          .rect(marginX, y + 1, 11, 11).stroke().restore();
        const labelWidth = pageWidth - marginX * 2 - 20 - 50;
        doc.font('Helvetica').fontSize(10.5).fillColor(INK)
          .text(item.name, marginX + 20, y, { continued: true, width: labelWidth })
          .font('Helvetica-Bold').text(`   × ${item.qty}`, { continued: false });
        if (itemIdx === 0) {
          doc.font('Helvetica-Oblique').fontSize(8).fillColor(GRAY)
            .text('(fond)', pageWidth - marginX - 50, y + 1, { width: 50, align: 'right' });
        }
        doc.y = y + 19;
      });
      y = doc.y + 6;
      doc.y = y;
    });

    // ---------- articles non placés, s'il y en a ----------
    if (plan.unpacked && plan.unpacked.length > 0) {
      ensureSpace(60);
      y = doc.y + 10;
      doc.save().strokeColor(RUST).lineWidth(1)
        .roundedRect(marginX, y, pageWidth - marginX * 2, 20 + plan.unpacked.length * 16, 4).stroke().restore();
      y += 12;
      doc.font('Helvetica-Bold').fontSize(9.5).fillColor(RUST)
        .text('⚠ NE RENTRE DANS AUCUN CHARIOT CI-DESSUS :', marginX + 12, y);
      y += 16;
      plan.unpacked.forEach(item => {
        doc.font('Helvetica').fontSize(9.5).fillColor(RUST)
          .text(`${item.name} × ${item.qty}`, marginX + 12, y);
        y += 15;
      });
      doc.y = y;
    }

    // ---------- pied de page (chaque page) ----------
    const range = doc.bufferedPageRange();
    for (let i = 0; i < range.count; i += 1) {
      doc.switchToPage(range.start + i);
      doc.font('Helvetica').fontSize(7.5).fillColor(GRAY)
        .text(`Généré le ${new Date().toLocaleDateString('fr-FR')} — Blanchisserie Cézanne — page ${i + 1}/${range.count}`,
          marginX, pageHeight - 40);
    }

    doc.end();
  });
}

/**
 * Génère l'annexe détaillée BL par BL d'une facture, et résout avec un
 * Buffer. Sert à joindre le détail complet (article par article, quel
 * que soit le niveau de résumé choisi sur la facture Odoo elle-même —
 * "une ligne par BL" ou "agrégé" restent lisibles pour vous, mais cette
 * annexe donne au client de quoi vérifier ligne à ligne).
 * `invoiceRef` : texte d'en-tête (ex. numéro de facture Odoo).
 * `orders` : [{ ticket, livraisonPrevue, items: [{name, qty, deliveredQty, price}] }]
 */
function buildInvoiceAnnexPdf(invoiceRef, societe, orders) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 50, bufferPages: true });
    const chunks = [];
    doc.on('data', c => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const pageWidth = doc.page.width;
    const pageHeight = doc.page.height;
    const marginX = 50;
    const bottomLimit = pageHeight - 60;

    function ensureSpace(needed) {
      if (doc.y + needed > bottomLimit) doc.addPage();
    }

    // ---------- en-tête ----------
    doc.fillColor(ACCENT).font('Helvetica-Bold').fontSize(18)
      .text('BLANCHISSERIE CÉZANNE', marginX, 45);
    doc.font('Helvetica').fontSize(9.5).fillColor(GRAY)
      .text('Annexe détaillée — bons de livraison inclus dans la facture', marginX, 68);
    doc.save().strokeColor(ACCENT).lineWidth(1.5)
      .moveTo(marginX, 92).lineTo(pageWidth - marginX, 92).stroke().restore();

    let y = 116;
    doc.font('Helvetica-Bold').fontSize(15).fillColor(INK).text(invoiceRef, marginX, y);
    y += 20;
    doc.font('Helvetica').fontSize(10.5).fillColor(GRAY).text(societe, marginX, y);
    y += 26;
    doc.y = y;

    let grandTotal = 0;

    orders.forEach(order => {
      ensureSpace(60);
      y = doc.y;
      doc.save().strokeColor(LINE).lineWidth(0.75)
        .moveTo(marginX, y).lineTo(pageWidth - marginX, y).stroke().restore();
      y += 14;
      doc.font('Helvetica-Bold').fontSize(11.5).fillColor(INK)
        .text(`BL ${order.ticket}`, marginX, y, { continued: true })
        .font('Helvetica').fontSize(9.5).fillColor(GRAY)
        .text(`  —  livré le ${formatDateFr(order.livraisonPrevue)}`);
      y += 20;
      doc.y = y;

      order.items.forEach(it => {
        ensureSpace(16);
        y = doc.y;
        const qty = it.deliveredQty ?? it.qty;
        if (qty <= 0) return;
        const subtotal = qty * it.price;
        grandTotal += subtotal;
        doc.font('Helvetica').fontSize(9.5).fillColor(INK)
          .text(it.name, marginX + 10, y, { width: 260, continued: false });
        doc.text(`${qty} ×`, marginX + 280, y, { width: 40, align: 'right' });
        doc.text(`${it.price.toFixed(3)} €`, marginX + 325, y, { width: 60, align: 'right' });
        doc.font('Helvetica-Bold').text(`${subtotal.toFixed(2)} €`, marginX + 400, y, { width: 95, align: 'right' });
        doc.y = y + 15;
      });
      doc.y += 8;
    });

    // ---------- total ----------
    ensureSpace(40);
    y = doc.y + 6;
    doc.save().strokeColor(INK).lineWidth(1)
      .moveTo(marginX + 300, y).lineTo(pageWidth - marginX, y).stroke().restore();
    y += 10;
    doc.font('Helvetica-Bold').fontSize(11).fillColor(INK)
      .text('Total HT (annexe)', marginX + 300, y, { width: 100, continued: false });
    doc.text(`${grandTotal.toFixed(2)} €`, marginX + 400, y, { width: 95, align: 'right' });

    // ---------- pied de page ----------
    const range = doc.bufferedPageRange();
    for (let i = 0; i < range.count; i += 1) {
      doc.switchToPage(range.start + i);
      doc.font('Helvetica').fontSize(7.5).fillColor(GRAY)
        .text(`Annexe — ${invoiceRef} — page ${i + 1}/${range.count}`, marginX, pageHeight - 40);
    }

    doc.end();
  });
}

/**
 * Génère la page de synthèse globale (quantités livrées totales par
 * article, tous BL confondus) qui ouvre le PDF consolidé — avant même la
 * facture Odoo elle-même. `aggregated` est le résultat de
 * aggregateByArticle() (voir invoiceBuilder.js) : [{ name, price, qty }].
 */
function buildInvoiceSummaryPdf(invoiceRef, societe, periodStart, periodEnd, orderCount, aggregated) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 50, bufferPages: true });
    const chunks = [];
    doc.on('data', c => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const pageWidth = doc.page.width;
    const pageHeight = doc.page.height;
    const marginX = 50;
    const bottomLimit = pageHeight - 60;

    function ensureSpace(needed) {
      if (doc.y + needed > bottomLimit) doc.addPage();
    }

    // ---------- en-tête ----------
    doc.fillColor(ACCENT).font('Helvetica-Bold').fontSize(18)
      .text('BLANCHISSERIE CÉZANNE', marginX, 45);
    doc.font('Helvetica').fontSize(9.5).fillColor(GRAY)
      .text('Récapitulatif — quantités livrées sur la période', marginX, 68);
    doc.save().strokeColor(ACCENT).lineWidth(1.5)
      .moveTo(marginX, 92).lineTo(pageWidth - marginX, 92).stroke().restore();

    let y = 116;
    doc.font('Helvetica-Bold').fontSize(15).fillColor(INK).text(invoiceRef, marginX, y);
    y += 20;
    doc.font('Helvetica').fontSize(10.5).fillColor(GRAY).text(societe, marginX, y);
    y += 16;
    doc.text(`Période du ${formatDateFr(periodStart)} au ${formatDateFr(periodEnd)} — ${orderCount} bon(s) de livraison`, marginX, y);
    y += 26;
    doc.y = y;

    // ---------- en-tête de tableau ----------
    ensureSpace(30);
    y = doc.y;
    doc.font('Helvetica-Bold').fontSize(9.5).fillColor(GRAY)
      .text('ARTICLE', marginX, y, { width: 220 })
      .text('QUANTITÉ LIVRÉE', marginX + 230, y, { width: 90, align: 'right' })
      .text('PRIX UNIT.', marginX + 330, y, { width: 70, align: 'right' })
      .text('SOUS-TOTAL', marginX + 410, y, { width: 85, align: 'right' });
    y += 14;
    doc.save().strokeColor(INK).lineWidth(1)
      .moveTo(marginX, y).lineTo(pageWidth - marginX, y).stroke().restore();
    y += 8;
    doc.y = y;

    let grandTotal = 0;
    let grandQty = 0;

    aggregated.forEach(g => {
      ensureSpace(18);
      y = doc.y;
      const subtotal = g.qty * g.price;
      grandTotal += subtotal;
      grandQty += g.qty;
      doc.font('Helvetica').fontSize(10).fillColor(INK)
        .text(g.name, marginX, y, { width: 220 })
        .text(String(g.qty), marginX + 230, y, { width: 90, align: 'right' })
        .text(`${g.price.toFixed(3)} €`, marginX + 330, y, { width: 70, align: 'right' })
        .font('Helvetica-Bold')
        .text(`${subtotal.toFixed(2)} €`, marginX + 410, y, { width: 85, align: 'right' });
      doc.y = y + 17;
    });

    // ---------- totaux ----------
    ensureSpace(50);
    y = doc.y + 8;
    doc.save().strokeColor(INK).lineWidth(1)
      .moveTo(marginX + 230, y).lineTo(pageWidth - marginX, y).stroke().restore();
    y += 10;
    doc.font('Helvetica-Bold').fontSize(10.5).fillColor(INK)
      .text('Total pièces livrées', marginX, y, { width: 220 })
      .text(String(grandQty), marginX + 230, y, { width: 90, align: 'right' });
    y += 18;
    doc.fontSize(11.5)
      .text('Total HT', marginX, y, { width: 220 })
      .text(`${grandTotal.toFixed(2)} €`, marginX + 410, y, { width: 85, align: 'right' });

    // ---------- pied de page ----------
    const range = doc.bufferedPageRange();
    for (let i = 0; i < range.count; i += 1) {
      doc.switchToPage(range.start + i);
      doc.font('Helvetica').fontSize(7.5).fillColor(GRAY)
        .text(`Récapitulatif — ${invoiceRef} — page ${i + 1}/${range.count}`, marginX, pageHeight - 40);
    }

    doc.end();
  });
}

module.exports = { buildDeliveryNotePdf, buildPreparationSlipPdf, buildInvoiceAnnexPdf, buildInvoiceSummaryPdf };
