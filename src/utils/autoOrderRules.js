/**
 * Fusionne la règle par défaut d'un type de chambre avec l'éventuelle
 * exception du mois demandé. L'exception ne remplace que les champs
 * qu'elle précise — tout le reste retombe sur la règle par défaut.
 */
function effectiveRule(roomType, month) {
  const overrides = JSON.parse(roomType.monthly_overrides || '{}');
  const monthOverride = overrides[String(month)] || {};
  return {
    departureItems: monthOverride.departureItems ?? JSON.parse(roomType.departure_items || '[]'),
    recoucheItems: monthOverride.recoucheItems ?? JSON.parse(roomType.recouche_items || '[]'),
    recoucheFrequency: monthOverride.recoucheFrequency ?? roomType.recouche_frequency ?? null,
  };
}

/**
 * Calcule le linge nécessaire pour UN séjour (une chambre, une arrivée,
 * un départ), en tenant compte des recouches en cours de séjour.
 *
 * Le mois pris en compte pour les exceptions saisonnières est celui de
 * la date de DÉPART (c'est le jour où la commande part réellement).
 *
 * `servicesById` : catalogue à utiliser pour résoudre les articles —
 * à récupérer UNE FOIS par requête via getServicesById() côté appelant
 * (pas ici), pour éviter une requête base de données par séjour quand
 * plusieurs séjours sont traités en boucle (voir routes/roomTypes.js).
 *
 * Retourne un tableau [{ id, name, code, price, qty }] prêt à être
 * envoyé à la création de commande (même format que le panier client).
 */
function computeStayLinen(roomType, checkinDate, checkoutDate, servicesById) {
  const checkin = new Date(checkinDate);
  const checkout = new Date(checkoutDate);
  const nights = Math.max(1, Math.round((checkout - checkin) / (1000 * 60 * 60 * 24)));
  const month = checkout.getMonth() + 1; // 1-12

  const rule = effectiveRule(roomType, month);
  const totals = {}; // serviceId -> qty cumulée

  const addItems = (items, multiplier) => {
    (items || []).forEach(it => {
      totals[it.serviceId] = (totals[it.serviceId] || 0) + it.qty * multiplier;
    });
  };

  // Linge de départ : une fois, systématiquement.
  addItems(rule.departureItems, 1);

  // Recouches : une fois tous les N jours pendant le séjour, hors le
  // jour de départ (qui est déjà couvert par le linge de départ).
  if (rule.recoucheItems?.length && rule.recoucheFrequency > 0) {
    const recoucheCount = Math.floor((nights - 1) / rule.recoucheFrequency);
    if (recoucheCount > 0) addItems(rule.recoucheItems, recoucheCount);
  }

  return Object.entries(totals)
    .filter(([, qty]) => qty > 0)
    .map(([serviceId, qty]) => {
      const svc = servicesById[serviceId];
      return svc ? { id: svc.id, name: svc.name, code: svc.code, sageCode: svc.sageCode, price: svc.price, qty } : null;
    })
    .filter(Boolean);
}

/**
 * Additionne le linge nécessaire pour PLUSIEURS séjours du même jour de
 * départ (plusieurs chambres qui checkoutent le même jour) — c'est ce
 * qui donnera la commande groupée envoyée à la blanchisserie.
 * `stays` = [{ roomTypeId, checkinDate, checkoutDate }]
 */
function computeGroupedLinen(roomTypesById, stays, servicesById) {
  const totals = {};
  for (const stay of stays) {
    const roomType = roomTypesById[stay.roomTypeId];
    if (!roomType) continue;
    const items = computeStayLinen(roomType, stay.checkinDate, stay.checkoutDate, servicesById);
    items.forEach(it => {
      if (!totals[it.id]) totals[it.id] = { ...it, qty: 0 };
      totals[it.id].qty += it.qty;
    });
  }
  return Object.values(totals);
}

module.exports = { effectiveRule, computeStayLinen, computeGroupedLinen };
