const db = require('../db');

function requireClient(req, res, next) {
  if (!req.session.clientId) {
    return res.status(401).json({ error: 'Non connecté.' });
  }
  next();
}

function requireAdmin(req, res, next) {
  if (!req.session.isAdmin) {
    return res.status(401).json({ error: "Accès administration non autorisé." });
  }
  next();
}

// Authentification par jeton (Authorization: Bearer <token>), pour les
// intégrations B2B (un logiciel client crée ses commandes via API). Le
// jeton identifie directement l'hôtel — attaché sur req.apiClient, pas
// besoin de session ni de renvoyer les coordonnées à chaque appel.
// Regex insensible à la casse sur "Bearer" (certains clients HTTP envoient
// "bearer" en minuscule) et tolérante à plusieurs espaces après le mot-clé
// — un .startsWith('Bearer ') strict aurait rejeté ces variantes en
// silence, avec exactement le symptôme "jeton manquant" alors qu'un jeton
// est bien envoyé.
function requireApiToken(req, res, next) {
  const authHeader = req.headers.authorization || '';
  const match = authHeader.match(/^Bearer\s+(.+)$/i);
  const token = match ? match[1].trim() : null;
  if (!token) {
    return res.status(401).json({ error: "Jeton manquant. Envoyez l'en-tête Authorization: Bearer <votre_jeton>." });
  }
  const row = db.prepare('SELECT * FROM api_tokens WHERE token = ?').get(token);
  if (!row) {
    return res.status(401).json({ error: 'Jeton invalide.' });
  }
  const client = db.prepare('SELECT * FROM clients WHERE id = ?').get(row.client_id);
  if (!client) {
    return res.status(401).json({ error: 'Jeton valide mais hôtel associé introuvable.' });
  }
  db.prepare('UPDATE api_tokens SET last_used_at = ? WHERE id = ?').run(new Date().toISOString(), row.id);
  req.apiClient = client;
  next();
}

module.exports = { requireClient, requireAdmin, requireApiToken };
