const express = require('express');
const db = require('../db');
const { getDailyWeather } = require('../utils/weather');
const { geocodeAddress } = require('../utils/geocode');
const { buildDeliveryNotePdf } = require('../utils/pdf');

const router = express.Router();

// Conseils de conduite génériques, affichés dans le portail livreur.
// Statiques et volontairement courts — un rappel utile, pas un pavé
// réglementaire que personne ne lira.
const SAFETY_TIPS = [
  'Vérifiez l\'arrimage du chargement avant de démarrer.',
  'Téléphone en mode conduite, jamais en main.',
  'Adaptez votre vitesse à la charge transportée — un chariot plein allonge la distance de freinage.',
  'Pause recommandée toutes les 2 heures de conduite.',
  'Vérifiez vos angles morts avant chaque manœuvre, chargement chargé réduit la visibilité arrière.',
];

// GET /api/driver-portal/:token — pas de requireAdmin ici : l'accès se
// fait uniquement via la possession du jeton personnel du chauffeur
// (lien à usage interne, pas indexé, pas de données sensibles exposées
// au-delà de ce que le chauffeur a besoin de voir pour sa tournée).
router.get('/:token', async (req, res) => {
  const driver = db.prepare('SELECT * FROM drivers WHERE access_token = ?').get(req.params.token);
  if (!driver) return res.status(404).json({ error: 'Lien invalide ou expiré.' });

  const orders = db.prepare(`
    SELECT * FROM orders WHERE driver_id = ? AND status = 'prete' ORDER BY delivery_sequence ASC, created_at ASC
  `).all(driver.id);

  const itemsStmt = db.prepare('SELECT name, qty FROM order_items WHERE order_id = ?');
  const stops = orders.map(o => ({
    orderId: o.id,
    ticket: o.ticket,
    societe: o.societe,
    adresse: o.adresse,
    tel: o.tel,
    sequence: o.delivery_sequence,
    distanceFromPrevKm: o.distance_from_prev_km,
    items: itemsStmt.all(o.id),
    mapsUrl: `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(o.adresse)}`,
    deliveryNoteUrl: `/api/driver-portal/${req.params.token}/orders/${o.id}/delivery-note.pdf`,
  }));

  // Résumé de la tournée : distance cumulée (depuis le dépôt jusqu'au
  // dernier arrêt) et durée estimée = temps de conduite (distance /
  // vitesse moyenne) + un forfait fixe par arrêt (stationnement, portage,
  // remise du linge...). Absent si la tournée n'a jamais été optimisée
  // (distances jamais calculées) — on ne veut pas afficher un temps basé
  // sur des données inexistantes.
  const { avg_speed_kmh: avgSpeedKmh, minutes_per_stop: minutesPerStop } =
    db.prepare('SELECT avg_speed_kmh, minutes_per_stop FROM admin WHERE id = 1').get() || { avg_speed_kmh: 40, minutes_per_stop: 20 };
  const hasDistances = stops.length > 0 && stops.every(s => s.distanceFromPrevKm != null);
  let routeSummary = null;
  if (hasDistances) {
    const totalDistanceKm = stops.reduce((sum, s) => sum + s.distanceFromPrevKm, 0);
    const drivingMinutes = (totalDistanceKm / avgSpeedKmh) * 60;
    const stopsMinutes = stops.length * minutesPerStop;
    routeSummary = {
      totalDistanceKm: Math.round(totalDistanceKm * 10) / 10,
      estimatedMinutes: Math.round(drivingMinutes + stopsMinutes),
      drivingMinutes: Math.round(drivingMinutes),
      stopsMinutes: Math.round(stopsMinutes),
    };
  }

  // Météo du jour, sur la base du dépôt (approximation raisonnable pour
  // une tournée locale) — best-effort : une erreur ici n'empêche jamais
  // d'afficher la tournée elle-même.
  let weather = null;
  try {
    const admin = db.prepare('SELECT depot_address, depot_lat, depot_lng FROM admin WHERE id = 1').get();
    let { depot_lat: lat, depot_lng: lng } = admin || {};
    if ((lat == null || lng == null) && admin?.depot_address) {
      const coords = await geocodeAddress(admin.depot_address);
      if (coords) {
        lat = coords.lat; lng = coords.lng;
        db.prepare('UPDATE admin SET depot_lat = ?, depot_lng = ? WHERE id = 1').run(lat, lng);
      }
    }
    if (lat != null && lng != null) weather = await getDailyWeather(lat, lng);
  } catch (err) {
    weather = null;
  }

  res.json({
    driverName: driver.name,
    vehicle: driver.vehicle,
    date: new Date().toISOString().slice(0, 10),
    stops,
    weather,
    safetyTips: SAFETY_TIPS,
    routeSummary,
  });
});

// GET /api/driver-portal/:token/orders/:orderId/delivery-note.pdf — sert
// le bon de livraison en PDF pour un arrêt de CE chauffeur uniquement
// (vérifié via driver_id, pas seulement via le numéro de commande) —
// utile sur place, pour montrer ou laisser le bon au client.
router.get('/:token/orders/:orderId/delivery-note.pdf', async (req, res) => {
  const driver = db.prepare('SELECT * FROM drivers WHERE access_token = ?').get(req.params.token);
  if (!driver) return res.status(404).json({ error: 'Lien invalide ou expiré.' });

  const order = db.prepare('SELECT * FROM orders WHERE id = ? AND driver_id = ?').get(Number(req.params.orderId), driver.id);
  if (!order) return res.status(404).json({ error: 'Commande introuvable pour ce chauffeur.' });

  const items = db.prepare('SELECT service_id as id, name, code, price, qty, delivered_qty as deliveredQty FROM order_items WHERE order_id = ?').all(order.id);

  try {
    const pdfBuffer = await buildDeliveryNotePdf({ ...order, items });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="bon-livraison-${order.ticket}.pdf"`);
    res.send(pdfBuffer);
  } catch (err) {
    console.error('Échec génération BL portail livreur :', err.message);
    res.status(500).json({ error: 'Erreur de génération du bon de livraison.' });
  }
});

// POST /api/driver-portal/:token/orders/:orderId/comment — le chauffeur
// laisse un message sur une commande (info client, absence, remarque...),
// dans le même fil de discussion que l'équipe de production. L'auteur
// est automatiquement le nom du chauffeur, pas de saisie supplémentaire.
router.post('/:token/orders/:orderId/comment', (req, res) => {
  const driver = db.prepare('SELECT * FROM drivers WHERE access_token = ?').get(req.params.token);
  if (!driver) return res.status(404).json({ error: 'Lien invalide ou expiré.' });

  const order = db.prepare('SELECT id FROM orders WHERE id = ? AND driver_id = ?').get(Number(req.params.orderId), driver.id);
  if (!order) return res.status(404).json({ error: 'Commande introuvable pour ce chauffeur.' });

  const { text } = req.body || {};
  if (!text || !text.trim()) return res.status(400).json({ error: 'Le message ne peut pas être vide.' });

  db.prepare('INSERT INTO order_comments (order_id, author, text) VALUES (?, ?, ?)')
    .run(order.id, `${driver.name} (livreur)`, text.trim());
  res.status(201).json({ ok: true });
});

module.exports = router;
