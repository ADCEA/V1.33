const express = require('express');
const db = require('../db');
const { requireAdmin } = require('../middleware/auth');
const { answerBusinessQuestion } = require('../utils/aiAgent');

const router = express.Router();
router.use(requireAdmin);

// GET /api/admin/stats — vue d'ensemble globale de l'activité
router.get('/', (req, res) => {
  const totalOrders = db.prepare('SELECT COUNT(*) as n FROM orders').get().n;

  const byStatus = Object.fromEntries(
    db.prepare('SELECT status, COUNT(*) as n FROM orders GROUP BY status').all()
      .map(r => [r.status, r.n])
  );

  const topHotels = db.prepare(`
    SELECT societe, COUNT(*) as orderCount, SUM(oi.qty) as itemCount
    FROM orders o
    JOIN order_items oi ON oi.order_id = o.id
    GROUP BY o.societe
    ORDER BY orderCount DESC
    LIMIT 10
  `).all();

  const topArticles = db.prepare(`
    SELECT name, code, SUM(qty) as totalQty
    FROM order_items
    GROUP BY name, code
    ORDER BY totalQty DESC
    LIMIT 10
  `).all();

  const last30Days = db.prepare(`
    SELECT COUNT(*) as n FROM orders WHERE created_at >= datetime('now', '-30 days')
  `).get().n;

  const totalItems = db.prepare('SELECT SUM(qty) as n FROM order_items').get().n || 0;

  // Poids réellement livré, linge seul (hors poids des chariots qui le
  // transportent — voir Logistique pour le détail chariot par tournée).
  const deliveredWeightKg = db.prepare(`
    SELECT SUM(oi.qty * a.weight_g) / 1000.0 as kg
    FROM orders o
    JOIN order_items oi ON oi.order_id = o.id
    LEFT JOIN articles a ON a.id = oi.service_id
    WHERE o.status = 'livree'
  `).get().kg || 0;

  // Kilomètres cumulés sur les commandes livrées, tels que calculés lors
  // des optimisations de tournée successives (voir POST .../optimize-route).
  const totalDistanceKm = db.prepare(`
    SELECT SUM(distance_from_prev_km) as km FROM orders WHERE status = 'livree'
  `).get().km || 0;

  res.json({
    totalOrders,
    totalItems,
    last30Days,
    byStatus,
    topHotels,
    topArticles,
    deliveredWeightKg: Math.round(deliveredWeightKg * 10) / 10,
    totalDistanceKm: Math.round(totalDistanceKm * 10) / 10,
  });
});

// GET /api/admin/stats/nps — NPS calculé mois par mois (promoteurs 9-10,
// passifs 7-8, détracteurs 0-6). NPS = % promoteurs − % détracteurs,
// de -100 à +100. Un mois sans réponse n'apparaît simplement pas.
router.get('/nps', (req, res) => {
  const rows = db.prepare(`
    SELECT
      strftime('%Y-%m', created_at) as month,
      COUNT(*) as responses,
      SUM(CASE WHEN score >= 9 THEN 1 ELSE 0 END) as promoters,
      SUM(CASE WHEN score BETWEEN 7 AND 8 THEN 1 ELSE 0 END) as passives,
      SUM(CASE WHEN score <= 6 THEN 1 ELSE 0 END) as detractors
    FROM nps_responses
    GROUP BY month
    ORDER BY month DESC
    LIMIT 12
  `).all();

  const months = rows.map(r => ({
    month: r.month,
    responses: r.responses,
    promoters: r.promoters,
    passives: r.passives,
    detractors: r.detractors,
    nps: Math.round(((r.promoters / r.responses) - (r.detractors / r.responses)) * 100),
  }));

  const recentComments = db.prepare(`
    SELECT n.score, n.comment, n.created_at as createdAt, c.societe
    FROM nps_responses n JOIN clients c ON c.id = n.client_id
    WHERE n.comment IS NOT NULL AND n.comment != ''
    ORDER BY n.created_at DESC
    LIMIT 15
  `).all();

  res.json({ months, currentMonth: months[0] || null, recentComments });
});

// POST /api/admin/stats/ai-report — pose une question en langage naturel
// sur les données de l'entreprise ; l'agent interroge la base en lecture
// SEULE (voir utils/aiAgent.js) pour répondre avec de vrais chiffres.
router.post('/ai-report', async (req, res) => {
  const { question } = req.body || {};
  if (!question || !question.trim()) {
    return res.status(400).json({ error: 'Question manquante.' });
  }
  try {
    const answer = await answerBusinessQuestion(question.trim());
    res.json({ answer });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

module.exports = router;
