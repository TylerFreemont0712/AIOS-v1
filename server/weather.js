// Weather for the Home dashboard: Open-Meteo (free, no API key), proxied
// server-side with a short cache so the widget never hammers the API. Location
// is picked once in Settings → Profile via the geocoding endpoint.

import { loadConfig } from './config.js';

// WMO weather interpretation codes → label + emoji
const WMO = {
  0: ['Clear', '☀️'], 1: ['Mostly clear', '🌤️'], 2: ['Partly cloudy', '⛅'], 3: ['Overcast', '☁️'],
  45: ['Fog', '🌫️'], 48: ['Icy fog', '🌫️'],
  51: ['Light drizzle', '🌦️'], 53: ['Drizzle', '🌦️'], 55: ['Heavy drizzle', '🌧️'],
  56: ['Freezing drizzle', '🌧️'], 57: ['Freezing drizzle', '🌧️'],
  61: ['Light rain', '🌦️'], 63: ['Rain', '🌧️'], 65: ['Heavy rain', '🌧️'],
  66: ['Freezing rain', '🌧️'], 67: ['Freezing rain', '🌧️'],
  71: ['Light snow', '🌨️'], 73: ['Snow', '🌨️'], 75: ['Heavy snow', '❄️'], 77: ['Snow grains', '🌨️'],
  80: ['Light showers', '🌦️'], 81: ['Showers', '🌧️'], 82: ['Violent showers', '⛈️'],
  85: ['Snow showers', '🌨️'], 86: ['Snow showers', '❄️'],
  95: ['Thunderstorm', '⛈️'], 96: ['Thunderstorm, hail', '⛈️'], 99: ['Thunderstorm, hail', '⛈️'],
};
export const describeWMO = (code) => WMO[code] || ['—', '🌡️'];

let cache = { key: '', at: 0, data: null };

async function fetchJSON(url, timeoutMs = 8000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { signal: ctl.signal, headers: { 'user-agent': 'AIOS/1.0' } });
    if (!r.ok) throw new Error(`weather service HTTP ${r.status}`);
    return await r.json();
  } finally { clearTimeout(t); }
}

/** Current conditions + 4-day forecast for the configured location.
 *  { configured:false } until a location is set; { error } keeps the widget honest offline. */
export async function getWeather() {
  const w = loadConfig().weather || {};
  if (typeof w.lat !== 'number' || typeof w.lon !== 'number') return { configured: false };
  const units = w.units === 'f' ? 'f' : 'c';
  const key = `${w.lat},${w.lon},${units}`;
  if (cache.data && cache.key === key && Date.now() - cache.at < 10 * 60_000) return cache.data;

  const url = 'https://api.open-meteo.com/v1/forecast'
    + `?latitude=${w.lat}&longitude=${w.lon}`
    + '&current=temperature_2m,apparent_temperature,relative_humidity_2m,weather_code,wind_speed_10m'
    + '&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max'
    + '&timezone=auto&forecast_days=4'
    + (units === 'f' ? '&temperature_unit=fahrenheit&wind_speed_unit=mph' : '');
  let j;
  try { j = await fetchJSON(url); }
  catch (e) {
    // stale cache beats an empty widget when the network blips
    if (cache.data && cache.key === key) return cache.data;
    return { configured: true, place: w.place || '', error: 'weather unavailable: ' + e.message };
  }
  const cur = j.current || {};
  const [label, emoji] = describeWMO(cur.weather_code);
  const d = j.daily || {};
  const days = (d.time || []).map((date, i) => {
    const [dl, de] = describeWMO(d.weather_code?.[i]);
    return {
      date, label: dl, emoji: de,
      hi: Math.round(d.temperature_2m_max?.[i]), lo: Math.round(d.temperature_2m_min?.[i]),
      precip: d.precipitation_probability_max?.[i] ?? null,
    };
  });
  const data = {
    configured: true, place: w.place || '', units,
    current: {
      temp: Math.round(cur.temperature_2m), feels: Math.round(cur.apparent_temperature),
      humidity: cur.relative_humidity_2m, wind: Math.round(cur.wind_speed_10m),
      label, emoji,
    },
    days,
  };
  cache = { key, at: Date.now(), data };
  return data;
}

/** Lat/lon candidates for a place name (Open-Meteo geocoding, no key). */
export async function geocode(q) {
  q = String(q || '').trim();
  if (!q) return [];
  const j = await fetchJSON(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(q)}&count=6&language=en&format=json`);
  return (j.results || []).map(r => ({
    name: r.name,
    detail: [r.admin1, r.country].filter(Boolean).join(', '),
    lat: r.latitude, lon: r.longitude,
  }));
}
