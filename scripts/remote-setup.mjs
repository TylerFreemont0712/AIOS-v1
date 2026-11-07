#!/usr/bin/env node
// Get AIOS reachable from outside the house, over Tailscale.
//
// This script does the parts that don't need root, checks the parts that do, and
// prints the exact command for anything it cannot do itself. It never calls sudo:
// a server-side script that escalates on its own is a bad habit to build, and the
// two commands that need root are one-time.
//
// Run it as:  npm run remote-setup
//
// Why Tailscale rather than a tunnel: AIOS is never placed on the public internet,
// the `<host>.<tailnet>.ts.net` name is permanent (so Add to Home Screen sticks and
// localStorage survives), and `tailscale serve` fronts it with a real certificate —
// which is what makes the phone microphone exist at all. See server/remote.js.

import { execFileSync, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import os from 'node:os';
import readline from 'node:readline/promises';
import { stdin, stdout } from 'node:process';

const run = promisify(execFile);
const USER = os.userInfo().username;

const bold = (s) => `\x1b[1m${s}\x1b[0m`;
const dim = (s) => `\x1b[2m${s}\x1b[0m`;
const green = (s) => `\x1b[32m${s}\x1b[0m`;
const yellow = (s) => `\x1b[33m${s}\x1b[0m`;
const red = (s) => `\x1b[31m${s}\x1b[0m`;

const ok = (s) => console.log(`  ${green('✓')} ${s}`);
const warn = (s) => console.log(`  ${yellow('!')} ${s}`);
const bad = (s) => console.log(`  ${red('✗')} ${s}`);
const step = (n, s) => console.log(`\n${bold(`${n}. ${s}`)}`);
const cmd = (s) => console.log(`\n     ${bold(s)}\n`);

async function ts(args, timeout = 10000) {
  try { return { ok: true, out: (await run('tailscale', args, { timeout, encoding: 'utf8' })).stdout.trim() }; }
  catch (e) { return { ok: false, out: (e.stdout || '').trim(), err: (e.stderr || e.message || '').trim(), code: e.code }; }
}

async function ask(q) {
  const rl = readline.createInterface({ input: stdin, output: stdout });
  const a = (await rl.question(q)).trim().toLowerCase();
  rl.close();
  return a;
}

console.log(`
  ╭──────────────────────────────────────────────────────╮
  │        AIOS · remote access setup (Tailscale)        │
  ╰──────────────────────────────────────────────────────╯
`);

// ---------- 1. installed? ----------

step(1, 'Is Tailscale installed?');
let ver = await ts(['version']);
if (!ver.ok && ver.code === 'ENOENT') {
  bad('tailscale is not installed.');
  console.log(dim('\n  The official installer needs root. Run this, then re-run `npm run remote-setup`:'));
  cmd('curl -fsSL https://tailscale.com/install.sh | sh');
  console.log(dim(`  It adds Tailscale's apt repo and installs the daemon. (Detected: ${os.platform()}, Linux Mint / Ubuntu family.)`));
  process.exit(1);
}
ok(`tailscale ${ver.out.split('\n')[0]}`);

// ---------- 2. daemon + login ----------

step(2, 'Has this machine joined your tailnet?');
let st = await ts(['status', '--json']);
let js = null;
try { js = JSON.parse(st.out); } catch { /* handled below */ }

if (!js) {
  bad('tailscaled is not answering.');
  console.log(dim('\n  Start the daemon:'));
  cmd('sudo systemctl enable --now tailscaled');
  process.exit(1);
}

if (js.BackendState !== 'Running') {
  warn(`not logged in (state: ${js.BackendState}).`);
  console.log(dim('\n  This opens a browser to sign in — a free personal account is enough\n  (6 users, unlimited devices). Run it, then re-run this script:'));
  cmd('sudo tailscale up');
  process.exit(1);
}

const dnsName = String(js.Self?.DNSName || '').replace(/\.$/, '');
const tailIp = (js.Self?.TailscaleIPs || []).find(a => a.includes('.')) || '';
ok(`joined as ${bold(dnsName || js.Self?.HostName || 'this machine')}${tailIp ? dim(`  (${tailIp})`) : ''}`);
if (js.CurrentTailnet?.Name) ok(`tailnet: ${js.CurrentTailnet.Name}`);

// ---------- 3. operator ----------

step(3, 'Can AIOS manage the HTTPS front-end without sudo?');
let operatorOk = false;
const prefs = await ts(['debug', 'prefs']);
if (prefs.ok) {
  try { operatorOk = (JSON.parse(prefs.out).OperatorUser || '') === USER; } catch { /* probed below instead */ }
}
if (operatorOk) {
  ok(`operator is ${USER} — AIOS can turn HTTPS on and off from Settings.`);
} else {
  warn(`operator is not set to ${USER}.`);
  console.log(dim('\n  Without this, `tailscale serve` needs sudo, and the AIOS server will not\n  (and should not) escalate on its own. One-time:'));
  cmd(`sudo tailscale set --operator=${USER}`);
  const a = await ask('  Run that now in another terminal, then press Enter to continue (or "s" to skip): ');
  if (a !== 's') {
    const re = await ts(['debug', 'prefs']);
    try { operatorOk = (JSON.parse(re.out).OperatorUser || '') === USER; } catch { /* still unknown */ }
    if (operatorOk) ok('operator set.');
    else warn('still not set — HTTPS can be turned on later from Settings → Remote, or by re-running this.');
  }
}

// ---------- 4. HTTPS ----------

step(4, 'Put AIOS behind HTTPS on the tailnet');
console.log(dim(`  This is what makes the phone microphone work: getUserMedia only exists in a
  secure context, so on plain http the mic is not "denied" — it is absent. It is
  also what lets the phone shell install to the Home screen and stay installed.`));

const port = Number(process.env.AIOS_PORT) || 7777;
const serve = await ts(['serve', '--bg', '--https=443', String(port)], 90000);

if (serve.ok) {
  ok(`serving https://${dnsName} → http://localhost:${port}`);
} else {
  const err = serve.err || '';
  if (/HTTPS.*(not enabled|disabled)|cert|EnableHTTPS/i.test(err)) {
    bad('your tailnet does not have HTTPS certificates enabled yet.');
    console.log(dim(`
  One checkbox, once, in the admin console:

     https://login.tailscale.com/admin/dns  →  ${bold('Enable HTTPS Certificates')}

  Then re-run this script (or turn it on from AIOS → Settings → Remote).`));
  } else if (/permission|operator|access denied|must be root/i.test(err)) {
    bad('permission denied — step 3 above was skipped.');
    cmd(`sudo tailscale set --operator=${USER}`);
  } else {
    bad(err || 'tailscale serve failed');
  }
}

// ---------- 5. what to do on the phone ----------

const st2 = await ts(['serve', 'status']);
const httpsOn = st2.ok && st2.out.includes(String(port));
const base = httpsOn ? `https://${dnsName}` : `http://${dnsName}:${port}`;

let token = '';
try {
  const r = await fetch(`http://127.0.0.1:${port}/api/config/token`, { signal: AbortSignal.timeout(4000) });
  if (r.ok) token = (await r.json()).token || '';
} catch { /* server not running — the link is still correct, minus the token */ }

step(5, 'On your phone');
console.log(`
  a. Install ${bold('Tailscale')} from the App Store / Play Store and sign in with the
     same account. Leave the VPN toggle on when you want to reach the hub.

  b. Open this link ${dim('(it carries the pairing token, so nothing to type)')}:
`);
console.log(`     ${bold(base + '/m' + (token ? `?token=${encodeURIComponent(token)}` : ''))}\n`);
console.log(`  c. Share → ${bold('Add to Home Screen')}. It opens full-screen, like an app.
`);

if (!httpsOn) {
  console.log(yellow(`  Note: HTTPS is not on yet, so the microphone will not appear on the phone
  and the Home-screen install is less reliable. Finish step 4 to fix both.
`));
}

console.log(dim(`  AIOS shows all of this live at Settings → Remote, including a QR code.
  Nothing here is exposed to the public internet: the hub is reachable only from
  devices signed into your own tailnet.
`));

// A parting check that the thing is actually up, since a setup script that reports
// success against a dead server is the failure mode worth avoiding.
try {
  execFileSync('curl', ['-sf', '--max-time', '4', `http://127.0.0.1:${port}/api/status`], { stdio: 'ignore' });
  ok('AIOS is running and answering locally.');
} catch {
  warn(`AIOS does not seem to be running on :${port} — start it with \`npm start\`.`);
}
