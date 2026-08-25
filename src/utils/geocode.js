// Géocodage d'adresses via Nominatim (OpenStreetMap) — gratuit, sans clé
// d'API. Respecte la politique d'usage équitable du service public :
// - un User-Agent identifiant l'application (obligatoire)
// - au plus 1 requête par seconde (voir `sleep` dans geocodeMany)
// Documentation : https://operations.osmfoundation.org/policies/nominatim/

const NOMINATIM_URL = 'https://nominatim.openstreetmap.org/search';
const USER_AGENT = 'BlanchisserieCezanne/1.0 (application de gestion de blanchisserie)';

/**
 * Géocode une adresse. Retourne { lat, lng } ou null si introuvable.
 */
async function geocodeAddress(address) {
  if (!address || !address.trim()) return null;
  const url = `${NOMINATIM_URL}?q=${encodeURIComponent(address)}&format=json&limit=1&countrycodes=fr`;
  const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT } });
  if (!res.ok) throw new Error(`Géocodage échoué (${res.status}) pour : ${address}`);
  const data = await res.json();
  if (!Array.isArray(data) || data.length === 0) return null;
  return { lat: parseFloat(data[0].lat), lng: parseFloat(data[0].lon) };
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Distance à vol d'oiseau entre deux points (km) — formule de haversine.
 * Pas la distance routière réelle, mais une bonne approximation pour
 * ordonner des arrêts proches les uns des autres.
 */
function haversineKm(lat1, lng1, lat2, lng2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/**
 * Ordonne une liste d'arrêts par plus proche voisin, en partant d'un
 * point de départ donné (le dépôt). Heuristique simple (pas une
 * résolution exacte du "voyageur de commerce"), mais largement
 * suffisante pour une poignée d'arrêts et bien plus utile qu'un ordre
 * arbitraire.
 * `stops` = [{ id, lat, lng, ... }] — tout champ supplémentaire est conservé.
 */
function nearestNeighborRoute(depot, stops) {
  const remaining = [...stops];
  const route = [];
  let current = depot;
  while (remaining.length > 0) {
    let nearestIdx = 0;
    let nearestDist = Infinity;
    remaining.forEach((s, i) => {
      const d = haversineKm(current.lat, current.lng, s.lat, s.lng);
      if (d < nearestDist) { nearestDist = d; nearestIdx = i; }
    });
    const next = remaining.splice(nearestIdx, 1)[0];
    route.push({ ...next, distanceFromPrevKm: Math.round(nearestDist * 10) / 10 });
    current = next;
  }
  return route;
}

module.exports = { geocodeAddress, sleep, haversineKm, nearestNeighborRoute };
