const { formatDateFr } = require('./deliveryNote');

// Regroupe les quantités livrées par (référence, prix) sur un ensemble de
// commandes — jamais juste par référence seule, pour ne pas mélanger deux
// tarifs différents dans un seul total si un prix a changé en cours de
// période. Retourne un tableau [{ name, sageCode, price, productId, qty }],
// trié par ordre alphabétique de désignation pour un affichage stable.
// Réutilisé à la fois par le niveau de facturation "aggregated" et par la
// page de synthèse en tête du PDF consolidé (mêmes chiffres, un seul
// endroit où corriger si la logique doit un jour évoluer).
function aggregateByArticle(orders) {
  const groups = new Map();
  for (const order of orders) {
    for (const it of order.items) {
      const qty = it.deliveredQty ?? it.qty;
      if (qty <= 0) continue;
      const key = `${it.sageCode}::${it.price}`;
      if (!groups.has(key)) groups.set(key, { name: it.name, sageCode: it.sageCode, price: it.price, productId: it.odooProductId, qty: 0 });
      groups.get(key).qty += qty;
    }
  }
  return [...groups.values()].sort((a, b) => a.name.localeCompare(b.name));
}

// Construit les lignes de facture à partir d'un ensemble de commandes
// livrées, selon le niveau de détail choisi pour ce client :
//   - 'detail'     : une ligne par article ET par BL, groupée sous un
//                    en-tête de section par BL (le plus précis).
//   - 'per_bl'     : une seule ligne par BL, montant total de la
//                    livraison — utilise le produit générique fourni,
//                    puisqu'aucun article précis ne s'y prête.
//   - 'aggregated' : une ligne par (article, prix) sur l'ensemble de la
//                    période — regroupé par prix et pas seulement par
//                    article, pour rester exact si un tarif a changé en
//                    cours de période plutôt que de mélanger deux prix
//                    différents dans une seule ligne.
//
// `orders` : [{ ticket, livraisonPrevue, items: [{ name, sageCode, qty,
//   deliveredQty, price, odooProductId }] }]
// `genericProductId` : id Odoo du produit générique, requis uniquement
// pour le niveau 'per_bl'.
function buildInvoiceLines(orders, detailLevel, genericProductId) {
  const lines = [];

  if (detailLevel === 'per_bl') {
    for (const order of orders) {
      const total = order.items.reduce((sum, it) => sum + (it.deliveredQty ?? it.qty) * it.price, 0);
      lines.push({
        isSection: false,
        productId: genericProductId,
        name: `BL ${order.ticket} — livré le ${formatDateFr(order.livraisonPrevue)}`,
        quantity: 1,
        priceUnit: Math.round(total * 1000) / 1000,
      });
    }
    return lines;
  }

  if (detailLevel === 'aggregated') {
    for (const g of aggregateByArticle(orders)) {
      lines.push({ isSection: false, productId: g.productId, name: g.name, quantity: g.qty, priceUnit: g.price });
    }
    return lines;
  }

  // 'detail' (par défaut) : un en-tête de section par BL, puis une ligne
  // par article distinct à l'intérieur de ce BL.
  for (const order of orders) {
    lines.push({ isSection: true, name: `BL ${order.ticket} — livré le ${formatDateFr(order.livraisonPrevue)}` });
    for (const it of order.items) {
      const qty = it.deliveredQty ?? it.qty;
      if (qty <= 0) continue;
      lines.push({ isSection: false, productId: it.odooProductId, name: it.name, quantity: qty, priceUnit: it.price });
    }
  }
  return lines;
}

module.exports = { buildInvoiceLines, aggregateByArticle };
