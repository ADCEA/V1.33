// Météo du jour via Open-Meteo (open-meteo.com) — gratuit, sans clé
// d'API, usage non-commercial. Sert à donner au livreur un aperçu des
// conditions de conduite du jour et à signaler les conditions à risque.

const FORECAST_URL = 'https://api.open-meteo.com/v1/forecast';

// Table de correspondance des codes météo WMO (norme utilisée par
// Open-Meteo) vers un libellé français lisible.
const WEATHER_CODE_LABELS = {
  0: 'Ciel dégagé', 1: 'Plutôt dégagé', 2: 'Partiellement nuageux', 3: 'Couvert',
  45: 'Brouillard', 48: 'Brouillard givrant',
  51: 'Bruine légère', 53: 'Bruine', 55: 'Bruine forte',
  56: 'Bruine verglaçante', 57: 'Bruine verglaçante forte',
  61: 'Pluie légère', 63: 'Pluie', 65: 'Pluie forte',
  66: 'Pluie verglaçante', 67: 'Pluie verglaçante forte',
  71: 'Neige légère', 73: 'Neige', 75: 'Neige forte', 77: 'Neige en grains',
  80: 'Averses légères', 81: 'Averses', 82: 'Averses violentes',
  85: 'Averses de neige', 86: 'Averses de neige fortes',
  95: 'Orage', 96: 'Orage avec grêle', 99: 'Orage violent avec grêle',
};

// Codes et seuils considérés comme des conditions de conduite à risque.
const SNOW_ICE_CODES = new Set([56, 57, 66, 67, 71, 73, 75, 77, 85, 86]);
const STORM_CODES = new Set([95, 96, 99]);
const FOG_CODES = new Set([45, 48]);

function weatherLabel(code) {
  return WEATHER_CODE_LABELS[code] || 'Conditions variables';
}

/**
 * Récupère la météo du jour pour un point donné. Retourne un résumé
 * prêt à afficher, avec une liste de dangers détectés (vide si RAS).
 */
async function getDailyWeather(lat, lng) {
  const params = new URLSearchParams({
    latitude: lat,
    longitude: lng,
    current: 'temperature_2m,precipitation,weather_code,wind_speed_10m',
    daily: 'weather_code,temperature_2m_max,temperature_2m_min,precipitation_sum,wind_speed_10m_max',
    timezone: 'auto',
    forecast_days: '1',
  });
  const res = await fetch(`${FORECAST_URL}?${params}`);
  if (!res.ok) throw new Error(`Météo indisponible (${res.status})`);
  const data = await res.json();

  const code = data.daily?.weather_code?.[0] ?? data.current?.weather_code;
  const tempMax = data.daily?.temperature_2m_max?.[0];
  const tempMin = data.daily?.temperature_2m_min?.[0];
  const precipitationSum = data.daily?.precipitation_sum?.[0] ?? 0;
  const windMax = data.daily?.wind_speed_10m_max?.[0] ?? 0;

  const dangers = [];
  if (SNOW_ICE_CODES.has(code)) dangers.push('Neige ou verglas annoncé — routes potentiellement glissantes.');
  if (STORM_CODES.has(code)) dangers.push('Orage annoncé — visibilité réduite, prudence en cas de grêle.');
  if (FOG_CODES.has(code)) dangers.push('Brouillard annoncé — visibilité réduite, augmentez les distances de sécurité.');
  if (precipitationSum >= 10) dangers.push(`Fortes précipitations attendues (${precipitationSum.toFixed(0)} mm) — risque d'aquaplaning.`);
  if (windMax >= 50) dangers.push(`Vent fort attendu (jusqu'à ${Math.round(windMax)} km/h) — prudence avec un véhicule chargé.`);
  if (tempMin != null && tempMin <= 1 && tempMin >= -10) dangers.push(`Températures proches de 0°C (min. ${tempMin.toFixed(0)}°C) — risque de verglas matinal.`);

  return {
    conditionLabel: weatherLabel(code),
    tempMax: tempMax != null ? Math.round(tempMax) : null,
    tempMin: tempMin != null ? Math.round(tempMin) : null,
    precipitationMm: Math.round(precipitationSum * 10) / 10,
    windMaxKmh: Math.round(windMax),
    dangers,
  };
}

module.exports = { getDailyWeather };
