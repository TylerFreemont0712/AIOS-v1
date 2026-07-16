// Inbox v2 smoke: flags/message-id parsing, IMAP date parsing, webmail links,
// and the seen/starred-aware notifications composition.
import { fileURLToPath, pathToFileURL } from 'node:url';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const tmpData = fs.mkdtempSync(path.join(os.tmpdir(), 'aios-mail2-'));
process.env.AIOS_DATA = tmpData;

let n = 0;
const ok = (cond, label) => { n++; if (!cond) { console.error(`✗ ${label}`); process.exit(1); } console.log(`✓ ${label}`); };

const mail = await import(pathToFileURL(path.join(ROOT, 'server/mail.js')).href);
const cfgMod = await import(pathToFileURL(path.join(ROOT, 'server/config.js')).href);
cfgMod.loadConfig().mail.host = 'imap.gmail.com';

// ---- parseFetch: flags + message-id ----
const chunk = `* 3 FETCH (UID 42 FLAGS (\\Seen \\Flagged) INTERNALDATE "09-Jul-2026 08:15:22 +0900" BODY[HEADER.FIELDS (FROM SUBJECT DATE MESSAGE-ID)] {120}\r\nFrom: Alice <alice@example.com>\r\nSubject: Lunch?\r\nDate: Thu, 9 Jul 2026 08:15:22 +0900\r\nMessage-ID: <abc123@mail.example.com>\r\n\r\n BODY[TEXT]<0> {20}\r\nHi! Lunch tomorrow?)\r\n`;
const msgs = mail.parseFetch(chunk, 'imap.gmail.com');
ok(msgs.length === 1 && msgs[0].seen === true && msgs[0].starred === true, 'parseFetch: \\Seen + \\Flagged extracted');
ok(msgs[0].messageId === 'abc123@mail.example.com', 'parseFetch: Message-ID without angle brackets');

// ---- date + link helpers ----
ok(mail.parseImapDate('09-Jul-2026 08:15:22 +0900') > 0, 'parseImapDate: INTERNALDATE format');
ok(mail.parseImapDate('garbage') === 0, 'parseImapDate: junk → 0');
const link = mail.webmailLink('imap.gmail.com', 'abc123@mail.example.com');
ok(link.startsWith('https://mail.google.com/mail/u/0/#search/') && link.includes('rfc822msgid'), 'webmailLink: gmail deep link');
ok(mail.webmailLink('imap.fastmail.com', 'x@y') === '', 'webmailLink: non-gmail → none');
ok(mail.TRIAGE_VERSION >= 2, 'triage version bumped (cached strict verdicts re-judge)');

// ---- notifications composition ----
const day = (offset) => {
  const d = new Date(Date.now() - offset * 86400_000);
  const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${String(d.getDate()).padStart(2, '0')}-${MON[d.getMonth()]}-${d.getFullYear()} 10:00:00 +0900`;
};
const msg = (uid, over) => ({
  id: `${uid}@imap.gmail.com`, uid, from: `Sender ${uid} <s${uid}@x.com>`, subject: `Subject ${uid}`,
  date: day(1), seen: false, starred: false, important: true, urgency: 'normal',
  category: 'other', reason: 'r', via: 'ai', tv: 2, snippet: 'snip', messageId: `mid-${uid}@x`, ...over,
});
fs.mkdirSync(path.join(tmpData, 'mail'), { recursive: true });
fs.writeFileSync(path.join(tmpData, 'mail', 'state.json'), JSON.stringify({
  scannedAt: new Date().toISOString(), account: 'me@gmail.com', error: '',
  dismissed: ['77@imap.gmail.com'],
  messages: [
    msg(10),                                                       // important unread → main
    msg(11, { urgency: 'high' }),                                  // high → top of main
    msg(20, { seen: true }),                                       // important but READ → dropped
    msg(77),                                                       // dismissed → dropped
    msg(30, { important: false, seen: true, starred: true, date: day(3) }),   // starred, 3d → tail
    msg(31, { important: false, seen: true, starred: true, date: day(8) }),   // starred, 8d → tail (after 30)
    msg(32, { important: false, seen: true, starred: true, date: day(20) }),  // starred, 20d → outside horizon
    msg(40, { important: false, seen: false }),                    // unimportant unread → nowhere
  ],
}));
const out = mail.notifications();
ok(out.items.length === 2 && out.items[0].uid === 11 && out.items[1].uid === 10, 'main: unread important only, high urgency first');
ok(!out.items.some(m => m.uid === 20), 'read mail removed from notifications');
ok(!out.items.some(m => m.uid === 77) && !out.starred.some(m => m.uid === 77), 'dismissed stays gone');
ok(out.starred.length === 2 && out.starred[0].uid === 30 && out.starred[1].uid === 31, 'starred tail: ≤10 days, newest first');
ok(!out.starred.some(m => m.uid === 32), 'starred beyond 10 days excluded');
ok(out.items[0].link.includes('rfc822msgid'), 'notification items carry webmail links');
ok(out.items[0].snippet === 'snip' && out.items[0].reason === 'r', 'items carry snippet + reason for the modal');

// ---- sender rating rules ----
ok(mail.addrOf('Universal Studios <info@usj.co.jp>') === 'info@usj.co.jp', 'addrOf: angled');
ok(mail.addrOf('recruiter@agency.com') === 'recruiter@agency.com', 'addrOf: bare');

const state2 = {
  scannedAt: 'x', account: 'a', error: '', dismissed: [], senders: {}, senderStats: {},
  messages: [
    msg(50, { from: 'USJ <info@usj.co.jp>', important: true }),
    msg(51, { from: 'HotPepper <mag@hotpepper.jp>', important: true }),
    msg(52, { from: 'Jane Recruiter <jane@recruiter.com>', important: false, urgency: 'low' }),
    msg(53, { from: 'Bank <alert@bank.com>', important: true, urgency: 'high' }),
  ],
};
fs.writeFileSync(path.join(tmpData, 'mail', 'state.json'), JSON.stringify(state2));

mail.setSenderRule({ from: 'USJ <info@usj.co.jp>', rule: 'block' });
mail.setSenderRule({ from: 'x@hotpepper.jp', rule: 'block', kind: 'domain' });
mail.setSenderRule({ from: 'jane@recruiter.com', rule: 'star' });
let out2 = mail.notifications();
ok(!out2.items.some(m => m.uid === 50), 'muted address never surfaces');
ok(!out2.items.some(m => m.uid === 51), 'muted domain covers every sender at it');
ok(out2.items[0].uid === 52 && out2.items[0].fast === true, 'starred sender fast-tracks past triage (unimportant → top)');
ok(out2.items[1].uid === 53, 'high-urgency mail follows the fast track');

const rules = mail.listSenderRules();
ok(rules.length === 3 && rules.some(r => r.key === '@hotpepper.jp' && r.kind === 'domain'), 'rules list: address + domain + star');
mail.setSenderRule({ from: 'info@usj.co.jp', rule: 'clear' });
ok(mail.listSenderRules().length === 2, 'clear removes a rule');

// auto-mute: dismissing the same sender 3× learns the refusal
const st3 = JSON.parse(fs.readFileSync(path.join(tmpData, 'mail', 'state.json'), 'utf8'));
st3.messages.push(msg(60, { from: 'Spammy <deals@spam.io>' }), msg(61, { from: 'Spammy <deals@spam.io>' }), msg(62, { from: 'Spammy <deals@spam.io>' }));
st3.dismissed = [];
fs.writeFileSync(path.join(tmpData, 'mail', 'state.json'), JSON.stringify(st3));
ok(!mail.dismiss('60@imap.gmail.com').mutedSender, 'dismiss 1: no auto-mute yet');
ok(!mail.dismiss('61@imap.gmail.com').mutedSender, 'dismiss 2: no auto-mute yet');
ok(mail.dismiss('62@imap.gmail.com').mutedSender === 'deals@spam.io', 'dismiss 3: sender auto-muted');
ok(mail.listSenderRules().some(r => r.key === 'deals@spam.io' && r.via === 'auto'), 'auto rule recorded');
ok(!mail.notifications().items.some(m => /spam\.io/.test(m.from)), 'auto-muted sender gone from list');

// ---- MIME extraction (mini-Gmail viewer) ----
const htmlB64 = Buffer.from('<div><b>Hello</b> ünïcode 世界</div>', 'utf8').toString('base64');
const alt = 'Content-Type: multipart/alternative; boundary="BB"\r\nSubject: t\r\n\r\n'
  + '--BB\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: quoted-printable\r\n\r\nHello =E4=B8=96=E7=95=8C\r\n'
  + '--BB\r\nContent-Type: text/html; charset="utf-8"\r\nContent-Transfer-Encoding: base64\r\n\r\n' + htmlB64 + '\r\n--BB--\r\n';
const r1 = mail.bestMimePart(alt);
ok(r1?.html && r1.html.includes('<b>Hello</b>') && r1.html.includes('世界'), 'MIME: alternative → html wins, base64 utf8 decoded');
const mixed = 'Content-Type: multipart/mixed; boundary="OUTER"\r\n\r\n--OUTER\r\n' + alt
  + '\r\n--OUTER\r\nContent-Type: application/pdf\r\nContent-Transfer-Encoding: base64\r\n\r\nAAAA\r\n--OUTER--\r\n';
ok(mail.bestMimePart(mixed)?.html?.includes('Hello'), 'MIME: nested mixed → alternative html found');
const plainOnly = 'Content-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: quoted-printable\r\n\r\nCaf=C3=A9 line';
ok(mail.bestMimePart(plainOnly)?.text?.includes('Café'), 'MIME: plain-only QP decoded');
const cleaned = mail.stripActiveHtml('<p onclick="x()">hi</p><script>alert(1)</script><a href=x onmouseover=steal()>y</a>');
ok(!/script|onclick|onmouseover/i.test(cleaned) && cleaned.includes('<p'), 'MIME: scripts + handlers stripped');
ok(mail.deJis('Re: \x1b$B%[%C%H\x1b(B deal') === 'Re: 〔JP〕deal', 'deJis: JIS runs replaced');

fs.rmSync(tmpData, { recursive: true, force: true });
console.log(`\nALL ${n} MAIL-V2 CHECKS PASSED`);
