const express = require('express');
const db = require('../db');
const { requireAdmin } = require('../middleware/auth');

const router = express.Router();
router.use(requireAdmin);

// GET /api/admin/garage/trucks — liste des véhicules avec leur
// kilométrage actuel, pour l'écran Garage.
router.get('/trucks', (req, res) => {
  const rows = db.prepare(`
    SELECT id, name, length_cm as lengthCm, width_cm as widthCm, height_cm as heightCm, current_mileage_km as currentMileageKm
    FROM truck_types ORDER BY name
  `).all();
  res.json({ trucks: rows });
});

// PUT /api/admin/garage/trucks/:id/mileage — met à jour le relevé
// kilométrique d'un véhicule (saisie manuelle, au compteur).
router.put('/trucks/:id/mileage', (req, res) => {
  const id = Number(req.params.id);
  const truck = db.prepare('SELECT id FROM truck_types WHERE id = ?').get(id);
  if (!truck) return res.status(404).json({ error: 'Véhicule introuvable.' });

  const mileage = parseFloat(req.body?.mileageKm);
  if (!Number.isFinite(mileage) || mileage < 0) return res.status(400).json({ error: 'Kilométrage invalide.' });

  db.prepare('UPDATE truck_types SET current_mileage_km = ? WHERE id = ?').run(mileage, id);
  res.json({ ok: true });
});

// GET /api/admin/garage/trucks/:id/maintenance — historique d'entretien
// d'un véhicule, du plus récent au plus ancien.
router.get('/trucks/:id/maintenance', (req, res) => {
  const rows = db.prepare(`
    SELECT id, date, type, mileage_km as mileageKm, cost, notes
    FROM truck_maintenance WHERE truck_type_id = ? ORDER BY date DESC, id DESC
  `).all(Number(req.params.id));
  res.json({ maintenance: rows });
});

// POST /api/admin/garage/trucks/:id/maintenance — ajoute une entrée
// d'entretien (vidange, contrôle technique, pneus, etc. — type libre).
router.post('/trucks/:id/maintenance', (req, res) => {
  const truckId = Number(req.params.id);
  const truck = db.prepare('SELECT id FROM truck_types WHERE id = ?').get(truckId);
  if (!truck) return res.status(404).json({ error: 'Véhicule introuvable.' });

  const { date, type, mileageKm, cost, notes } = req.body || {};
  if (!date) return res.status(400).json({ error: 'La date est requise.' });
  if (!type || !type.trim()) return res.status(400).json({ error: "Le type d'entretien est requis." });

  const mileageNum = mileageKm !== undefined && mileageKm !== '' ? parseFloat(mileageKm) : null;
  const costNum = cost !== undefined && cost !== '' ? parseFloat(cost) : null;
  if (mileageNum !== null && (!Number.isFinite(mileageNum) || mileageNum < 0)) {
    return res.status(400).json({ error: 'Kilométrage invalide.' });
  }
  if (costNum !== null && (!Number.isFinite(costNum) || costNum < 0)) {
    return res.status(400).json({ error: 'Coût invalide.' });
  }

  const info = db.prepare(`
    INSERT INTO truck_maintenance (truck_type_id, date, type, mileage_km, cost, notes)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(truckId, date, type.trim(), mileageNum, costNum, (notes || '').trim() || null);

  // Si ce relevé est plus récent que le kilométrage actuel enregistré,
  // on le reprend comme nouveau kilométrage de référence.
  if (mileageNum !== null) {
    const current = db.prepare('SELECT current_mileage_km as km FROM truck_types WHERE id = ?').get(truckId);
    if (!current.km || mileageNum > current.km) {
      db.prepare('UPDATE truck_types SET current_mileage_km = ? WHERE id = ?').run(mileageNum, truckId);
    }
  }

  const row = db.prepare('SELECT id, date, type, mileage_km as mileageKm, cost, notes FROM truck_maintenance WHERE id = ?').get(info.lastInsertRowid);
  res.status(201).json({ entry: row });
});

// DELETE /api/admin/garage/maintenance/:id
router.delete('/maintenance/:id', (req, res) => {
  db.prepare('DELETE FROM truck_maintenance WHERE id = ?').run(Number(req.params.id));
  res.json({ ok: true });
});

module.exports = router;
