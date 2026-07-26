// Everyday location tools: geocoding, place search, travel time/distance, and
// weather for any place. Free and keyless by default — OpenStreetMap's Nominatim
// for geocoding/POIs, the public OSRM demo for road routing, Open-Meteo for weather.
// All are configurable (tools.maps.*); a Google Directions key unlocks transit and
// accurate walking/cycling times. Everything here is read-only and root-independent,
// so plain Chat can use it exactly like web_search.

import { loadConfig } from './config.js';
import { describeWMO } from './weather.js';

const UA = 'AIOS/1.0 (personal assistant hub)';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function mapsCfg() {
  const m = loadConfig().tools?.maps || {};
  return {
    nominatimUrl: (m.nominatimUrl || 'https://nominatim.openstreetmap.org').replace(/\/$/, ''),
    osrmUrl: (m.osrmUrl || 'https://router.project-osrm.org').replace(/\/$/, ''),
    googleKey: m.googleKey || '',
    units: m.units === 'imperial' ? 'imperial' : 'metric',
  };
}
export const mapsUnits = () => mapsCfg().units;

// Nominatim's usage policy caps us at ~1 request/second, so serialize geocoding
// behind a small spacer — a directions call geocodes two endpoints back to back.
let nomChain = Promise.resolve();
function nominatim(fn) {
  const run = nomChain.then(fn, fn);
  nomChain = run.then(() => sleep(1100), () => sleep(1100));
  return run;
}

async function getJSON(url, { signal, headers } = {}) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 15000);
  const onAbort = () => ctl.abort();
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    const r = await fetch(url, { signal: ctl.signal, headers: { 'user-agent': UA, accept: 'application/json', ...headers } });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.json();
  } finally { clearTimeout(t); signal?.removeEventListener('abort', onAbort); }
}

// ---------- home + place resolution ----------

/** The user's home location: an explicit user.home, else the weather location
 *  (which is the same place in practice), else null. */
export function homeLocation() {
  const c = loadConfig();
  const h = c.user?.home;
  if (h && Number.isFinite(h.lat) && Number.isFinite(h.lon)) return { lat: h.lat, lon: h.lon, place: h.place || 'home' };
  const w = c.weather;
  if (w && Number.isFinite(w.lat) && Number.isFinite(w.lon)) return { lat: w.lat, lon: w.lon, place: w.place || 'home' };
  return null;
}

export const placeLabel = (p) => p?.place || p?.name
  || (p?.display ? p.display.split(',').slice(0, 2).join(',').trim() : '')
  || (Number.isFinite(p?.lat) ? `${p.lat.toFixed(4)},${p.lon.toFixed(4)}` : 'unknown');

/** Geocode a free-text place with OSM Nominatim. `near` biases (viewbox) or, with
 *  bounded:true, restricts results to that area — good for "X near me". */
export async function geocode(query, { limit = 1, near, bounded = false, boxDeg = 1.2, signal } = {}) {
  const q = String(query || '').trim();
  if (!q) throw new Error('empty location');
  const { nominatimUrl } = mapsCfg();
  const u = new URL(nominatimUrl + '/search');
  u.searchParams.set('format', 'jsonv2');
  u.searchParams.set('q', q);
  u.searchParams.set('limit', String(Math.min(Math.max(limit, 1), 15)));
  u.searchParams.set('addressdetails', '1');
  if (near && Number.isFinite(near.lat) && Number.isFinite(near.lon)) {
    u.searchParams.set('viewbox', `${near.lon - boxDeg},${near.lat + boxDeg},${near.lon + boxDeg},${near.lat - boxDeg}`);
    if (bounded) u.searchParams.set('bounded', '1');
  }
  const rows = await nominatim(() => getJSON(u, { signal }));
  return (rows || []).map(r => ({
    name: r.name || (r.display_name || '').split(',')[0] || q,
    display: r.display_name || '',
    lat: Number(r.lat), lon: Number(r.lon),
    type: (r.type && r.type !== 'yes') ? r.type : (r.category || ''),
  })).filter(r => Number.isFinite(r.lat) && Number.isFinite(r.lon));
}

/** Turn "home"/"my house", a "lat,lon" literal, or a place name into coordinates. */
export async function resolvePlace(input, { signal } = {}) {
  const s = String(input || '').trim();
  if (!s || /^(home|my ?house|my ?home|here|the house)$/i.test(s)) {
    const h = homeLocation();
    if (!h) throw new Error('No home location set — set one in Settings → Profile (Home) or a weather location.');
    return { ...h, from: 'home' };
  }
  const m = s.match(/^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$/);
  if (m) return { lat: Number(m[1]), lon: Number(m[2]), place: s, from: 'coords' };
  const hits = await geocode(s, { limit: 1, near: homeLocation(), signal });
  if (!hits.length) throw new Error(`Could not find a place called "${s}".`);
  return { lat: hits[0].lat, lon: hits[0].lon, place: hits[0].display || hits[0].name, from: 'geocode' };
}

// ---------- distance + routing ----------

export function haversineKm(a, b) {
  const R = 6371, toRad = (d) => d * Math.PI / 180;
  const dLat = toRad(b.lat - a.lat), dLon = toRad(b.lon - a.lon);
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}

const OSRM_PROFILE = { driving: 'driving', walking: 'foot', cycling: 'bike' };
const SPEED_KMH = { walking: 4.8, cycling: 15 };

/** Travel time + distance between two coordinates. Google (when a key is set) covers
 *  every mode including transit; otherwise OSRM gives accurate driving figures and a
 *  distance-based estimate for walking/cycling (the public demo only routes cars). */
export async function route(from, to, { mode = 'driving', signal } = {}) {
  const m = ['driving', 'walking', 'cycling', 'transit'].includes(String(mode).toLowerCase()) ? String(mode).toLowerCase() : 'driving';
  const cfg = mapsCfg();

  if (m === 'transit') {
    if (!cfg.googleKey) throw new Error('Transit (train/bus) routing needs a Google Directions API key — add one in Settings → Tools → Maps. Driving, walking and cycling work without a key. For train schedules you can also use web_search.');
    return googleRoute(from, to, m, { signal });
  }
  if (cfg.googleKey) {
    try { return await googleRoute(from, to, m, { signal }); } catch { /* fall back to OSRM below */ }
  }

  const profile = OSRM_PROFILE[m] || 'driving';
  const url = `${cfg.osrmUrl}/route/v1/${profile}/${from.lon},${from.lat};${to.lon},${to.lat}?overview=false&alternatives=false`;
  const j = await getJSON(url, { signal });
  if (j.code !== 'Ok' || !j.routes?.length) throw new Error(`No ${m} route found (${j.code || 'error'}${j.message ? ': ' + j.message : ''}).`);
  const r = j.routes[0];
  const publicDemo = cfg.osrmUrl.includes('router.project-osrm.org');
  if ((m === 'walking' || m === 'cycling') && publicDemo) {
    // the public OSRM demo only loads the car profile, so recompute a sane duration
    // from the road distance at a typical mode speed and flag it an estimate
    const km = r.distance / 1000;
    return { distance_m: r.distance, duration_s: Math.round(km / SPEED_KMH[m] * 3600), mode: m, provider: 'OSRM (road distance)', estimated: true };
  }
  return { distance_m: r.distance, duration_s: r.duration, mode: m, provider: 'OSRM' };
}

async function googleRoute(from, to, mode, { signal } = {}) {
  const { googleKey } = mapsCfg();
  const gMode = mode === 'cycling' ? 'bicycling' : mode;   // driving|walking|bicycling|transit
  const u = new URL('https://maps.googleapis.com/maps/api/directions/json');
  u.searchParams.set('origin', `${from.lat},${from.lon}`);
  u.searchParams.set('destination', `${to.lat},${to.lon}`);
  u.searchParams.set('mode', gMode);
  u.searchParams.set('key', googleKey);
  const j = await getJSON(u, { signal });
  if (j.status !== 'OK' || !j.routes?.length) throw new Error(`Google Directions: ${j.status}${j.error_message ? ' — ' + j.error_message : ''}`);
  const leg = j.routes[0].legs[0];
  const steps = gMode === 'transit'
    ? (leg.steps || []).map(s => s.transit_details).filter(Boolean)
      .map(td => `${td.line?.short_name || td.line?.name || 'line'} ${td.departure_stop?.name || ''}→${td.arrival_stop?.name || ''}`.trim())
    : [];
  return { distance_m: leg.distance?.value ?? 0, duration_s: leg.duration?.value ?? 0, mode, provider: 'Google', summary: j.routes[0].summary || '', steps };
}

// ---------- POI / everyday place search ----------

export async function findPlaces(query, { near, radiusKm = 12, limit = 6, signal } = {}) {
  const origin = near || homeLocation();
  // bounded search first (keeps results local); widen if it comes back empty
  let hits = await geocode(query, { limit: Math.min(limit * 2, 15), near: origin, bounded: !!origin, boxDeg: 0.2, signal });
  if (!hits.length && origin) hits = await geocode(query, { limit: Math.min(limit * 2, 15), near: origin, boxDeg: 0.6, signal });
  let places = hits.map(h => ({ ...h, distanceKm: origin ? haversineKm(origin, h) : null }));
  if (origin) {
    places = places
      .filter(p => p.distanceKm == null || p.distanceKm <= radiusKm * 2)
      .sort((a, b) => (a.distanceKm ?? 1e9) - (b.distanceKm ?? 1e9));
  }
  return { origin, places: places.slice(0, limit) };
}

// ---------- weather for any place ----------

/** Current conditions + forecast for a place (default: home), via Open-Meteo (no key). */
export async function forecast(place, { days = 3, units, signal } = {}) {
  const loc = await resolvePlace(place || 'home', { signal });
  const u = (units === 'f' || units === 'imperial') ? 'f' : (units === 'c' || units === 'metric') ? 'c' : (loadConfig().weather?.units === 'f' ? 'f' : 'c');
  const n = Math.min(Math.max(Math.floor(days) || 3, 1), 10);
  const url = 'https://api.open-meteo.com/v1/forecast'
    + `?latitude=${loc.lat}&longitude=${loc.lon}`
    + '&current=temperature_2m,apparent_temperature,relative_humidity_2m,weather_code,wind_speed_10m'
    + '&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max'
    + `&timezone=auto&forecast_days=${n}`
    + (u === 'f' ? '&temperature_unit=fahrenheit&wind_speed_unit=mph' : '');
  const j = await getJSON(url, { signal });
  const cur = j.current || {};
  const [label, emoji] = describeWMO(cur.weather_code);
  const d = j.daily || {};
  const days2 = (d.time || []).map((date, i) => {
    const [dl, de] = describeWMO(d.weather_code?.[i]);
    return { date, label: dl, emoji: de, hi: Math.round(d.temperature_2m_max?.[i]), lo: Math.round(d.temperature_2m_min?.[i]), precip: d.precipitation_probability_max?.[i] ?? null };
  });
  return {
    place: placeLabel(loc), unit: u === 'f' ? '°F' : '°C',
    current: { temp: Math.round(cur.temperature_2m), feels: Math.round(cur.apparent_temperature), humidity: cur.relative_humidity_2m, wind: Math.round(cur.wind_speed_10m), label, emoji },
    days: days2,
  };
}

// ---------- formatting ----------

export function fmtDuration(sec) {
  const s = Math.max(0, Math.round(sec));
  const h = Math.floor(s / 3600), m = Math.round((s % 3600) / 60);
  if (h && m) return `${h} hr ${m} min`;
  if (h) return `${h} hr`;
  return `${m} min`;
}

export function fmtDistance(meters, units = 'metric') {
  const m = Math.max(0, meters);
  if (units === 'imperial') { const mi = m / 1609.34; return mi < 0.2 ? `${Math.round(m / 0.3048)} ft` : `${mi.toFixed(1)} mi`; }
  return m < 1000 ? `${Math.round(m)} m` : `${(m / 1000).toFixed(1)} km`;
}
