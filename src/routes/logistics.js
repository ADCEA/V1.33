const express = require('express');
const crypto = require('crypto');
const db = require('../db');
const { requireAdmin } = require('../middleware/auth');
const { serializeOrder } = require('../utils/serializeOrder');
const { geocodeAddress, sleep, nearestNeighborRoute } = require('../utils/geocode');
const { buildPreparationSlipPdf } = require('../utils/pdf');

const router = express.Router();
router.use(requireAdmin);

const itemsStmt = db.prepare('SELECT service_id as id, name, code, price, qty, delivered_qty as deliveredQty FROM order_items WHERE order_id = ?');

// ---------- chauffeurs ----------

// GET /api/admin/logistics/drivers
router.get('/drivers', (req, res) => {
  const rows = db.prepare('SELECT * FROM drivers ORDER BY name').all();
  res.json({ drivers: rows });
});

// POST /api/admin/logistics/drivers
router.post('/drivers', (req, res) => {
  const { name, vehicle, truckTypeId } = req.body || {};
  if (!name || !name.trim()) return res.status(400).json({ error: 'Le nom du chauffeur est requis.' });
  const accessToken = crypto.randomBytes(20).toString('hex');
  const info = db.prepare('INSERT INTO drivers (name, vehicle, truck_type_id, access_token) VALUES (?, ?, ?, ?)')
    .run(name.trim(), (vehicle || '').trim() || null, truckTypeId || null, accessToken);
  const row = db.prepare('SELECT * FROM drivers WHERE id = ?').get(info.lastInsertRowid);
  res.status(201).json({ driver: row });
});

// DELETE /api/admin/logistics/drivers/:id — les commandes assignées repassent "non assignées"
router.delete('/drivers/:id', (req, res) => {
  const id = Number(req.params.id);
  db.prepare('DELETE FROM drivers WHERE id = ?').run(id); // ON DELETE SET NULL sur orders.driver_id
  res.json({ ok: true });
});

// ---------- commandes à organiser (prêtes ou en cours d'anticipation) ----------

// GET /api/admin/logistics/orders — toutes les commandes non livrées
// (reçue, en traitement, prête), pour anticiper l'organisation des
// tournées avant même que tout soit prêt. Le frontend les distingue
// visuellement (rouge = pas encore prête, vert = prête à partir).
router.get('/orders', (req, res) => {
  const rows = db.prepare(`
    SELECT * FROM orders
    WHERE status IN ('recue', 'traitement', 'prete')
    ORDER BY delivery_sequence ASC, created_at ASC
  `).all();
  res.json({ orders: rows.map(o => serializeOrder(o, itemsStmt.all(o.id))) });
});

// PATCH /api/admin/logistics/orders/:id — assigner à un chauffeur et/ou
// définir son rang dans la tournée (glisser-déposer).
// body: { driverId: number|null, deliverySequence: number|null }
router.patch('/orders/:id', (req, res) => {
  const orderId = Number(req.params.id);
  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
  if (!order) return res.status(404).json({ error: 'Commande introuvable.' });

  const { driverId, deliverySequence } = req.body || {};
  db.prepare('UPDATE orders SET driver_id = ?, delivery_sequence = ? WHERE id = ?').run(
    driverId ?? null,
    deliverySequence ?? null,
    orderId
  );
  const updated = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
  res.json({ order: serializeOrder(updated, itemsStmt.all(orderId)) });
});

// Recommandation gloutonne : le plus grand chariot d'abord (pour
// minimiser le nombre total), puis les plus petits pour le reste —
// approche simple, pas une optimisation exacte du "bin packing".
function recommendCarts(totalVolumeL, cartTypes) {
  if (totalVolumeL <= 0 || cartTypes.length === 0) return [];
  let remaining = totalVolumeL;
  const recommendation = [];
  // cartTypes attendu trié du plus grand volume au plus petit.
  for (const ct of cartTypes) {
    const count = Math.floor(remaining / ct.volumeL);
    if (count > 0) {
      recommendation.push({ name: ct.name, count });
      remaining -= count * ct.volumeL;
    }
  }
  if (remaining > 0.01) {
    const smallest = cartTypes[cartTypes.length - 1];
    const existing = recommendation.find(r => r.name === smallest.name);
    if (existing) existing.count += 1;
    else recommendation.push({ name: smallest.name, count: 1 });
  }
  return recommendation;
}

// Répartition qui évite de disperser inutilement une même référence
// entre plusieurs chariots, tout en respectant TOUJOURS les limites de
// volume et de poids par chariot (non négociables, quel que soit
// `prioritizeGrouping`). Pour chaque article (le plus lourd d'abord — ce
// sont eux qui pèsent le plus sur l'équilibre, mieux vaut les répartir
// tant que tous les chariots sont encore vides) :
//   1. Si un chariot peut accueillir TOUTE la quantité restante d'un
//      coup, on la met entièrement dedans. Le choix du chariot, quand
//      plusieurs le peuvent, dépend de `prioritizeGrouping` :
//        - true (par défaut) : le PLUS chargé des deux — ça consolide
//          dans les chariots déjà entamés plutôt que d'en ouvrir un
//          nouveau sans nécessité.
//        - false : le MOINS chargé — répartit le poids le plus
//          uniformément possible entre tous les chariots choisis, quitte
//          à disperser un peu plus les références.
//   2. Sinon, la dispersion est de toute façon inévitable : on remplit
//      alors le chariot qui peut en accueillir LE PLUS d'un coup (pas
//      unité par unité), pour toucher le moins de chariots possible, puis
//      on continue avec le reste sur les chariots suivants.
function packItems(items, cartInstances, maxWeightKg, prioritizeGrouping = true) {
  const carts = cartInstances.map(c => ({ name: c.name, capacityL: c.capacityL, maxWeightKg, usedL: 0, usedKg: 0, counts: {} }));
  const itemsByCode = Object.fromEntries(items.map(i => [i.code, i]));
  const remainingItems = [...items].sort((a, b) => b.unitWeightKg - a.unitWeightKg);

  for (const item of remainingItems) {
    let remainingQty = item.qty;
    while (remainingQty > 0) {
      const capacities = carts.map(cart => {
        const maxByVolume = item.unitVolumeL > 0 ? Math.floor((cart.capacityL - cart.usedL) / item.unitVolumeL) : Infinity;
        const maxByWeight = item.unitWeightKg > 0 ? Math.floor((cart.maxWeightKg - cart.usedKg) / item.unitWeightKg) : Infinity;
        return { cart, canHold: Math.max(0, Math.min(maxByVolume, maxByWeight)) };
      }).filter(c => c.canHold > 0);

      if (capacities.length === 0) break; // plus aucun chariot ne peut accueillir cet article

      const canHoldAll = capacities.filter(c => c.canHold >= remainingQty);
      let chosen;
      if (canHoldAll.length > 0) {
        chosen = prioritizeGrouping
          ? canHoldAll.reduce((a, b) => (b.cart.usedKg > a.cart.usedKg ? b : a)) // le plus chargé : consolide
          : canHoldAll.reduce((a, b) => (b.cart.usedKg < a.cart.usedKg ? b : a)); // le moins chargé : équilibre
      } else {
        chosen = capacities.reduce((a, b) => {
          if (b.canHold > a.canHold) return b;
          if (b.canHold === a.canHold && b.cart.usedKg < a.cart.usedKg) return b;
          return a;
        });
      }

      const qtyToPlace = Math.min(remainingQty, chosen.canHold);
      chosen.cart.counts[item.code] = (chosen.cart.counts[item.code] || 0) + qtyToPlace;
      chosen.cart.usedL += qtyToPlace * item.unitVolumeL;
      chosen.cart.usedKg += qtyToPlace * item.unitWeightKg;
      remainingQty -= qtyToPlace;
    }
    item.placedQty = item.qty - remainingQty;
  }

  const finalCarts = carts.map(cart => {
    // Trié du plus lourd au plus léger : c'est l'ordre de chargement dans
    // le chariot (le plus lourd en premier, donc au fond/en bas, les plus
    // légers ensuite par-dessus) — pas qu'un tri d'affichage arbitraire.
    const cartItems = Object.entries(cart.counts)
      .map(([code, qty]) => ({ name: itemsByCode[code].name, code, qty, unitWeightKg: itemsByCode[code].unitWeightKg }))
      .sort((a, b) => b.unitWeightKg - a.unitWeightKg)
      .map(({ name, code, qty }) => ({ name, code, qty }));
    return {
      name: cart.name,
      capacityL: cart.capacityL,
      maxWeightKg: cart.maxWeightKg,
      usedL: Math.round(cart.usedL * 10) / 10,
      usedKg: Math.round(cart.usedKg * 10) / 10,
      remainingL: Math.round((cart.capacityL - cart.usedL) * 10) / 10,
      items: cartItems,
    };
  });

  const unpacked = remainingItems
    .filter(i => i.placedQty < i.qty)
    .map(i => ({ name: i.name, code: i.code, qty: i.qty - i.placedQty }));

  return { carts: finalCarts, unpacked };
}

// Calcule le plan de conditionnement d'une commande — logique partagée
// entre la route JSON (aperçu à l'écran) et la route PDF (bon de
// préparation imprimable), pour ne jamais avoir deux calculs qui
// pourraient diverger. Retourne { error } si quelque chose ne va pas,
// { order, plan } sinon.
function computePackingPlan(orderId, cartSelection) {
  if (!orderId) return { error: 'Commande manquante.' };
  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(Number(orderId));
  if (!order) return { error: 'Commande introuvable.' };
  if (!Array.isArray(cartSelection) || cartSelection.length === 0) {
    return { error: 'Choisissez au moins un chariot.' };
  }

  const cartTypesById = Object.fromEntries(db.prepare('SELECT * FROM cart_types').all().map(c => [c.id, c]));
  const cartInstances = [];
  for (const sel of cartSelection) {
    const ct = cartTypesById[sel.cartTypeId];
    if (!ct) return { error: `Type de chariot introuvable : ${sel.cartTypeId}` };
    const count = parseInt(sel.count, 10) || 0;
    const volumeL = (ct.length_cm * ct.width_cm * ct.height_cm) / 1000;
    for (let i = 0; i < count; i += 1) {
      cartInstances.push({ name: `${ct.name} #${i + 1}`, capacityL: volumeL });
    }
  }
  if (cartInstances.length === 0) {
    return { error: 'Choisissez au moins un chariot (quantité > 0).' };
  }

  const settings = db.prepare('SELECT max_cart_weight_kg as w, prioritize_grouping as pg FROM admin WHERE id = 1').get() || {};
  const maxCartWeightKg = settings.w || 120;
  const prioritizeGrouping = settings.pg !== 0; // SQLite renvoie 0/1 ; tout sauf 0 = actif (défaut)

  // Opère uniquement sur les articles de CETTE commande — le
  // conditionnement se pense commande par commande, pas sur un pool
  // global mélangeant plusieurs hôtels.
  const rows = db.prepare(`
    SELECT oi.name, oi.code, SUM(oi.qty) as qty,
           (a.folded_width_cm * a.folded_length_cm * a.folded_height_cm) / 1000.0 as unitVolumeL,
           a.weight_g / 1000.0 as unitWeightKg
    FROM order_items oi
    LEFT JOIN articles a ON a.id = oi.service_id
    WHERE oi.order_id = ?
    GROUP BY oi.code, oi.name
    ORDER BY unitVolumeL DESC
  `).all(Number(orderId));

  const items = rows.map(r => ({ name: r.name, code: r.code, qty: r.qty, unitVolumeL: r.unitVolumeL || 0, unitWeightKg: r.unitWeightKg || 0 }));
  const plan = packItems(items, cartInstances, maxCartWeightKg, prioritizeGrouping);
  return { order, plan };
}

// POST /api/admin/logistics/pack — le chef d'atelier choisit quels
// chariots il utilise (type + quantité), le serveur répartit les
// articles d'une commande dedans et renvoie un aperçu du chargement.
// body: { orderId, cartSelection: [{ cartTypeId, count }] }
router.post('/pack', (req, res) => {
  const { orderId, cartSelection } = req.body || {};
  const { error, plan } = computePackingPlan(orderId, cartSelection);
  if (error) {
    const status = error === 'Commande introuvable.' ? 404 : 400;
    return res.status(status).json({ error });
  }
  res.json(plan);
});

// POST /api/admin/logistics/pack/pdf — même calcul que /pack, mais
// renvoie un bon de préparation imprimable (PDF) avec cases à cocher,
// plutôt qu'un aperçu JSON pour l'écran.
router.post('/pack/pdf', async (req, res) => {
  const { orderId, cartSelection } = req.body || {};
  const { error, order, plan } = computePackingPlan(orderId, cartSelection);
  if (error) {
    const status = error === 'Commande introuvable.' ? 404 : 400;
    return res.status(status).json({ error });
  }
  try {
    const pdfBuffer = await buildPreparationSlipPdf(order, plan);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="bon-preparation-${order.ticket}.pdf"`);
    res.send(pdfBuffer);
  } catch (err) {
    res.status(500).json({ error: 'Erreur de génération du bon de préparation.' });
  }
});

// GET /api/admin/logistics/loads — poids et volume total par chauffeur,
// à partir des commandes "prête" uniquement (les autres ne sont pas
// encore physiquement chargeables). Sert à recommander une combinaison
// de chariots (volume), à vérifier la charge par rapport à la capacité
// du camion (poids), et si un camion réel est rattaché au chauffeur, à
// vérifier que le volume tient réellement dedans.
router.get('/loads', (req, res) => {
  const settings = db.prepare('SELECT truck_capacity_kg as truckCapacityKg, cart_weight_kg as cartWeightKg FROM admin WHERE id = 1').get()
    || { truckCapacityKg: 1200, cartWeightKg: 20 };
  const cartTypesRaw = db.prepare('SELECT * FROM cart_types ORDER BY length_cm * width_cm * height_cm DESC').all();
  const cartTypes = cartTypesRaw.map(ct => ({
    name: ct.name,
    volumeL: (ct.length_cm * ct.width_cm * ct.height_cm) / 1000,
  }));
  const truckVolumeByDriver = Object.fromEntries(
    db.prepare(`
      SELECT d.id as driverId, t.name as truckName, t.length_cm * t.width_cm * t.height_cm / 1000.0 as truckVolumeL
      FROM drivers d JOIN truck_types t ON t.id = d.truck_type_id
    `).all().map(r => [r.driverId, r])
  );

  const rows = db.prepare(`
    SELECT
      o.driver_id as driverId,
      SUM(oi.qty * a.weight_g) / 1000.0 as linenWeightKg,
      SUM(oi.qty * a.folded_width_cm * a.folded_length_cm * a.folded_height_cm) / 1000.0 as totalVolumeL
    FROM orders o
    JOIN order_items oi ON oi.order_id = o.id
    LEFT JOIN articles a ON a.id = oi.service_id
    WHERE o.status = 'prete'
    GROUP BY o.driver_id
  `).all();

  const loads = rows.map(r => {
    const carts = recommendCarts(r.totalVolumeL || 0, cartTypes);
    const cartCount = carts.reduce((sum, c) => sum + c.count, 0);
    const linenWeightKg = r.linenWeightKg || 0;
    // Poids total réellement chargé sur le camion = linge + chariots vides
    // qui le transportent (les chariots eux-mêmes montent dans le camion).
    const totalWeightKg = linenWeightKg + cartCount * settings.cartWeightKg;
    const totalVolumeL = Math.round((r.totalVolumeL || 0) * 10) / 10;
    const truck = truckVolumeByDriver[r.driverId];

    return {
      driverId: r.driverId,
      linenWeightKg: Math.round(linenWeightKg * 10) / 10,
      cartsWeightKg: Math.round(cartCount * settings.cartWeightKg * 10) / 10,
      totalWeightKg: Math.round(totalWeightKg * 10) / 10,
      totalVolumeL,
      carts,
      overCapacity: totalWeightKg > settings.truckCapacityKg,
      truckName: truck?.truckName || null,
      truckVolumeL: truck ? Math.round(truck.truckVolumeL * 10) / 10 : null,
      overTruckVolume: truck ? totalVolumeL > truck.truckVolumeL : false,
    };
  });

  res.json({ loads, settings });
});

// ---------- adresse de départ (dépôt) ----------

// GET /api/admin/logistics/depot
router.get('/depot', (req, res) => {
  const row = db.prepare('SELECT depot_address as address, depot_lat as lat, depot_lng as lng FROM admin WHERE id = 1').get();
  res.json(row || { address: null, lat: null, lng: null });
});

// PUT /api/admin/logistics/depot — change l'adresse ; efface les
// coordonnées en cache pour forcer un nouveau géocodage au prochain calcul.
router.put('/depot', (req, res) => {
  const { address } = req.body || {};
  if (!address || !address.trim()) return res.status(400).json({ error: "L'adresse est requise." });
  db.prepare('UPDATE admin SET depot_address = ?, depot_lat = NULL, depot_lng = NULL WHERE id = 1').run(address.trim());
  res.json({ ok: true });
});

// ---------- optimisation de tournée ----------

// S'assure que le dépôt a des coordonnées ; le géocode et les met en
// cache sinon. Lève une erreur claire si l'adresse est introuvable.
async function ensureDepotCoords() {
  const admin = db.prepare('SELECT depot_address, depot_lat, depot_lng FROM admin WHERE id = 1').get();
  if (!admin?.depot_address) {
    throw new Error("Aucune adresse de dépôt configurée — renseignez-la d'abord.");
  }
  if (admin.depot_lat != null && admin.depot_lng != null) {
    return { lat: admin.depot_lat, lng: admin.depot_lng };
  }
  const coords = await geocodeAddress(admin.depot_address);
  if (!coords) throw new Error(`Adresse de dépôt introuvable : ${admin.depot_address}`);
  db.prepare('UPDATE admin SET depot_lat = ?, depot_lng = ? WHERE id = 1').run(coords.lat, coords.lng);
  return coords;
}

// S'assure que chaque commande de la liste a des coordonnées, en
// géocodant celles qui n'en ont pas encore (avec une pause entre chaque
// appel, pour respecter la limite d'usage de Nominatim). Retourne la
// liste avec lat/lng renseignés ; celles introuvables sont écartées et
// listées à part.
async function ensureOrdersCoords(orders) {
  const geocoded = [];
  const failed = [];
  for (const order of orders) {
    if (order.lat != null && order.lng != null) {
      geocoded.push(order);
      continue;
    }
    try {
      const coords = await geocodeAddress(order.adresse);
      if (!coords) { failed.push(order); continue; }
      db.prepare('UPDATE orders SET lat = ?, lng = ? WHERE id = ?').run(coords.lat, coords.lng, order.id);
      geocoded.push({ ...order, lat: coords.lat, lng: coords.lng });
      await sleep(1100); // respecte la limite ~1 req/s de Nominatim
    } catch (err) {
      failed.push(order);
    }
  }
  return { geocoded, failed };
}

// POST /api/admin/logistics/optimize-route — calcule l'ordre de passage
// optimisé (plus proche voisin, à vol d'oiseau) pour les commandes
// "prêtes" d'un chauffeur, en partant du dépôt. Écrit le résultat dans
// orders.delivery_sequence.
// body: { driverId }
router.post('/optimize-route', async (req, res) => {
  const { driverId } = req.body || {};
  try {
    const depot = await ensureDepotCoords();

    const driverFilter = driverId ? 'driver_id = ?' : 'driver_id IS NULL';
    const params = driverId ? [driverId] : [];
    const orders = db.prepare(`SELECT * FROM orders WHERE status = 'prete' AND ${driverFilter}`).all(...params);

    if (orders.length === 0) {
      return res.json({ route: [], failed: [] });
    }

    const { geocoded, failed } = await ensureOrdersCoords(orders);
    const route = nearestNeighborRoute(depot, geocoded);

    const updateSeq = db.prepare('UPDATE orders SET delivery_sequence = ?, distance_from_prev_km = ? WHERE id = ?');
    const applySequence = db.transaction(() => {
      route.forEach((stop, i) => updateSeq.run(i + 1, stop.distanceFromPrevKm, stop.id));
    });
    applySequence();

    res.json({
      route: route.map(s => ({ orderId: s.id, ticket: s.ticket, societe: s.societe, adresse: s.adresse, distanceFromPrevKm: s.distanceFromPrevKm, sequence: route.indexOf(s) + 1 })),
      failed: failed.map(o => ({ orderId: o.id, ticket: o.ticket, adresse: o.adresse })),
    });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

module.exports = router;
