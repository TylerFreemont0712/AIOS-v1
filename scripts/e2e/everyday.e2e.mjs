#!/usr/bin/env node
// Everyday-tools E2E: the new chat/agent toolbelt — calculator, unit/currency
// convert, datetime, website crawl, notes, maps, wikipedia, translate, weather.
// Offline assertions are HARD (they must pass); anything needing the network is a
// soft probe that reports but never fails the suite (CI/sandboxes may be offline).

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const tmpData = fs.mkdtempSync(path.join(os.tmpdir(), 'aios-e2e-everyday-'));
const tmpVault = fs.mkdtempSync(path.join(os.tmpdir(), 'aios-e2e-everyday-vault-'));
process.env.AIOS_DATA = tmpData;

let hardFails = 0, n = 0;
const ok = (cond, label) => { n++; if (cond) console.log('  ✓ ' + label); else { console.error('  ✗ ' + label); hardFails++; } };
const probe = async (label, fn) => {
  try { const d = await fn(); console.log(`  ✓ ${label}${d ? ' — ' + d : ''}`); }
  catch (e) { console.log(`  ⚠ ${label} (network/env: ${e.message.slice(0, 90)})`); }
};
const S = (m) => import(path.join(ROOT, 'server', m));
function cleanup(code) {
  fs.rmSync(tmpData, { recursive: true, force: true });
  fs.rmSync(tmpVault, { recursive: true, force: true });
  process.exit(code);
}

// Home = Takatsuki, Osaka (matches the user's real setup); vault = throwaway dir.
const cfg = await S('config.js');
cfg.updateConfig({ weather: { lat: 34.84833, lon: 135.61678, place: 'Takatsuki, Osaka' }, vault: { path: tmpVault } });

const geo = await S('geo.js');
const everyday = await S('everyday.js');
const tools = await S('tools.js');

// ---------- calculator (offline, exact) ----------
console.log('\ncalculate:');
ok(everyday.calculate('2+3*4') === 14, '2+3*4 = 14 (precedence)');
ok(everyday.calculate('(2+3)*4') === 20, '(2+3)*4 = 20 (parens)');
ok(everyday.calculate('2^10') === 1024, '2^10 = 1024 (power)');
ok(everyday.calculate('2^3^2') === 512, '2^3^2 = 512 (right-assoc)');
ok(Math.abs(everyday.calculate('sqrt(2)*pi') - Math.SQRT2 * Math.PI) < 1e-9, 'sqrt(2)*pi (funcs + consts)');
ok(everyday.calculate('-5 + 3') === -2, 'unary minus');
ok(everyday.calculate('max(3, 7, 2)') === 7, 'max(3,7,2) = 7 (varargs)');
ok(everyday.calculate('10 % 3') === 1, '10 % 3 = 1');
let threw = false; try { everyday.calculate('2 +'); } catch { threw = true; } ok(threw, 'incomplete expression throws');
threw = false; try { everyday.calculate('process.exit(1)'); } catch { threw = true; } ok(threw, 'no code execution — "process.exit(1)" is rejected');
threw = false; try { everyday.calculate('1; drop table'); } catch { threw = true; } ok(threw, 'junk input rejected');

// ---------- unit + temp conversion (offline) ----------
console.log('\nconvert (units):');
ok(Math.abs((await everyday.convert(10, 'km', 'mi')).value - 6.21371) < 1e-3, '10 km = 6.214 mi');
ok(Math.abs((await everyday.convert(0, 'c', 'f')).value - 32) < 1e-9, '0°C = 32°F');
ok(Math.abs((await everyday.convert(100, 'c', 'f')).value - 212) < 1e-9, '100°C = 212°F');
ok(Math.abs((await everyday.convert(1, 'kg', 'lb')).value - 2.20462) < 1e-3, '1 kg = 2.205 lb');
ok(Math.abs((await everyday.convert(1, 'gb', 'mb')).value - 1000) < 1e-6, '1 GB = 1000 MB');
ok(Math.abs((await everyday.convert(2, 'hour', 'min')).value - 120) < 1e-9, '2 hours = 120 min');
threw = false; try { await everyday.convert(1, 'km', 'kg'); } catch { threw = true; } ok(threw, 'incompatible units (km→kg) throws');

// ---------- datetime (offline) ----------
console.log('\ndatetime:');
const dt = everyday.datetime({ tz: 'Asia/Tokyo' });
ok(typeof dt.local === 'string' && dt.tz === 'Asia/Tokyo', 'current time in a timezone');
const cd = everyday.datetime({ until: new Date(Date.now() + 50 * 3600e3).toISOString() });
ok(cd.until && cd.until.days === 2 && cd.until.direction === 'from now', 'countdown 50h out = 2 days from now');
const past = everyday.datetime({ until: new Date(Date.now() - 26 * 3600e3).toISOString() });
ok(past.until && past.until.days === 1 && past.until.direction === 'ago', 'countdown 26h back = 1 day ago');
threw = false; try { everyday.datetime({ tz: 'Not/AZone' }); } catch { threw = true; } ok(threw, 'bad timezone throws a clear error');

// ---------- geo helpers (offline) ----------
console.log('\ngeo (offline):');
const home = geo.homeLocation();
ok(home && Math.abs(home.lat - 34.84833) < 1e-4, 'homeLocation() falls back to the weather location');
const suma = { lat: 34.6435, lon: 135.1138 };
const km = geo.haversineKm(home, suma);
ok(km > 40 && km < 55, `Takatsuki→Suma straight-line ≈ ${km.toFixed(1)} km (40–55)`);
const rp = await geo.resolvePlace('home');
ok(rp.from === 'home' && Math.abs(rp.lat - 34.84833) < 1e-4, 'resolvePlace("home") → home coords, no network');
const rc = await geo.resolvePlace('34.6435,135.1138');
ok(rc.from === 'coords' && Math.abs(rc.lat - 34.6435) < 1e-6, 'resolvePlace("lat,lon") parses coordinates');
ok(geo.fmtDuration(3764) === '1 hr 3 min', 'fmtDuration(3764s) = "1 hr 3 min"');
ok(geo.fmtDistance(56064, 'metric') === '56.1 km' && geo.fmtDistance(850, 'metric') === '850 m', 'fmtDistance metric');

// ---------- crawl_site over a local server (offline, deterministic) ----------
console.log('\ncrawl_site (local server):');
const pad = 'This paragraph exists purely to push the page over the readable-length threshold so the crawler keeps it. ';
const pages = {
  '/': '<title>Home</title><a href="/a">A</a> <a href="/b">B</a> <a href="mailto:x@y.z">mail</a> <a href="http://example.invalid/x">ext</a>',
  '/a': `<title>Alpha</title><p>alpha apple page. ${pad} It mentions banana exactly once here.</p><a href="/">home</a>`,
  '/b': `<title>Beta</title><p>beta page about banana and banana again. ${pad}</p><a href="/c">C</a>`,
  '/c': `<title>Gamma</title><p>cherry gamma page, no yellow fruit. ${pad}</p>`,
};
const srv = http.createServer((req, res) => {
  const p = req.url.split('?')[0];
  if (pages[p] !== undefined) { res.writeHead(200, { 'content-type': 'text/html' }); res.end(pages[p]); }
  else { res.writeHead(404); res.end('nope'); }
});
await new Promise(r => srv.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${srv.address().port}`;
const crawl = await tools.crawlSite(base + '/', { maxPages: 10, depth: 2 });
ok(/\/a\b/.test(crawl) && /\/b\b/.test(crawl) && /\/c\b/.test(crawl), 'crawl reached same-host pages /a /b /c');
ok(!/example\.invalid/.test(crawl), 'crawl did NOT follow the external link (same-host confinement)');
const ranked = await tools.crawlSite(base + '/', { query: 'banana', maxPages: 10, depth: 2 });
ok(ranked.includes('/b') && ranked.indexOf('/b') < ranked.indexOf('/a') && /relevance 2/.test(ranked), 'query "banana" ranks /b (2 hits) above /a (1 hit)');
ok(!/\/c\b/.test(ranked), 'query "banana" drops /c (0 matches)');
srv.close();

// ---------- notes: quick_note create + append (never clobber) ----------
console.log('\nquick_note:');
const q1 = await tools.runTool('quick_note', { title: 'Grocery ideas', content: 'first' }, {});
ok(!q1.isError && /Saved note Notes\/Grocery ideas\.md/.test(q1.content), 'quick_note creates Notes/<title>.md');
const q2 = await tools.runTool('quick_note', { title: 'Grocery ideas', content: 'second' }, {});
ok(!q2.isError && /Appended/.test(q2.content), 'second quick_note APPENDS (does not overwrite)');
const noteBody = fs.readFileSync(path.join(tmpVault, 'Notes', 'Grocery ideas.md'), 'utf8');
ok(/first/.test(noteBody) && /second/.test(noteBody), 'both entries preserved in the note');

// ---------- registry + chat gating (offline) ----------
console.log('\nregistry & chat gating:');
const chatNames = new Set(tools.chatTools().map(t => t.name));
for (const t of ['directions', 'find_places', 'weather', 'wikipedia', 'translate', 'calculate', 'convert', 'datetime', 'quick_note'])
  ok(chatNames.has(t), `chat can call ${t}`);
ok(!chatNames.has('write_file') && !chatNames.has('bash'), 'chat still cannot call write_file / bash');
// crawl_site is read-only and would pass the gate on merit — it is held out on cost. It
// walks a whole site over many fetches, which stalls a chat turn, and the Research app
// does that job properly. Asserted rather than merely dropped, so putting it back is a
// decision someone makes on purpose.
ok(!chatNames.has('crawl_site'), 'crawl_site stays out of chat (Research app does site walks)');
ok(tools.isChatSafeWrite('quick_note') && tools.isChatSafeWrite('task_add'), 'quick_note & task_add are chat-safe writes');
ok(!tools.isChatSafeWrite('write_file') && !tools.isChatSafeWrite('vault_write'), 'write_file & vault_write are NOT chat-safe');
const cat = tools.toolCatalog();
ok(cat.some(t => t.group === 'maps') && cat.some(t => t.group === 'utility'), 'tool catalog exposes maps + utility groups');
ok(tools.toolGroups().includes('maps') && tools.toolGroups().includes('utility'), 'toolGroups() lists the new groups (agent can load_tools them)');

// ---------- soft network probes (report only) ----------
console.log('\nnetwork probes (soft — never fail the suite):');
await probe('geocode "Suma Station Kobe"', async () => {
  const h = await geo.geocode('Suma Station, Kobe', { limit: 1 });
  if (!h.length) throw new Error('no hits');
  return `${h[0].lat.toFixed(3)},${h[0].lon.toFixed(3)}`;
});
await probe('directions home → Suma Station (driving)', async () => {
  const r = await tools.runTool('directions', { to: 'Suma Station, Kobe' }, {});
  if (r.isError) throw new Error(r.content);
  return r.content.split('\n')[1];
});
await probe('wikipedia "Kobe"', async () => {
  const r = await tools.runTool('wikipedia', { query: 'Kobe' }, {});
  if (r.isError) throw new Error(r.content);
  return r.content.slice(0, 60).replace(/\n/g, ' ');
});
await probe('translate "こんにちは" → en', async () => {
  const r = await everyday.translate('こんにちは', { to: 'en' });
  return `${r.from}→${r.to}: ${r.text}`;
});
await probe('weather for home', async () => {
  const r = await tools.runTool('weather', { days: 2 }, {});
  if (r.isError) throw new Error(r.content);
  return r.content.split('\n')[0].slice(0, 70);
});
await probe('convert 100 USD → JPY (live FX)', async () => {
  const r = await everyday.convert(100, 'usd', 'jpy');
  return `¥${Math.round(r.value)} (rate ${r.rate})`;
});
await probe('find_places "station" near home', async () => {
  const r = await tools.runTool('find_places', { query: 'train station', limit: 3 }, {});
  if (r.isError) throw new Error(r.content);
  return r.content.split('\n')[1] || 'ok';
});

console.log(`\n${n - hardFails}/${n} hard checks passed` + (hardFails ? ` — ${hardFails} FAILED` : ''));
cleanup(hardFails ? 1 : 0);
