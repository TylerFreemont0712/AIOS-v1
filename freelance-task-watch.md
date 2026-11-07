# Watching for freelance tasks — what's possible

**Question asked:** poll `feather.openai.com/campaigns/<id>?tab=tasks&tasks-tab=unclaimed`
every 30–40 minutes and notify when unclaimed tasks appear.

**Short answer: not by fetching that URL.** Everything below is an alternative that gets
you the same outcome without touching it.

---

## The check that was asked for

`robots.txt` could not be read, because the host does not serve it to anything that
isn't a browser:

```
$ curl https://feather.openai.com/robots.txt
  http=403
  cf-mitigated: challenge
  server: cloudflare
  → "Just a moment..." / "Enable JavaScript and cookies to continue"
```

Same response on `/` and on the campaign URL itself — `cf-mitigated: challenge`, HTTP
403, every time. (For contrast, `openai.com/robots.txt` returns a normal permissive file,
so this is specific to the Feather host, not to OpenAI generally.)

That is a **deliberate technical control**: Cloudflare bot management is switched on for
the whole host, and it blocks non-browser clients at the edge before any content is
served. There is no robots rule to comply with because the operator has gone a step
further than robots and simply refuses automated clients.

Making a scheduled fetch work would mean defeating that — harvesting and replaying a
`cf_clearance` cookie, or driving a headless browser fingerprinted to look human. That is
circumventing an access control rather than following one, and on a platform where you
hold a contractor account it also risks the account itself. So that route is out, and
I won't build it.

Two things worth separating, because they are often confused:

- **The bot challenge** is the operator's technical "no" to automated clients.
- **Your contractor agreement** is a separate, contractual question about whether you may
  script against the platform at all, even from your own browser. Options 3 and 5 below
  depend on that, and only you can check it.

---

## Option 1 — Watch your inbox instead of the site *(recommended)*

If Feather emails you when work drops, the notification already exists and is already
addressed to you. Nothing needs to touch the site.

**Why this one is first:** it uses a channel intended for you, it needs no credentials
beyond the ones AIOS already has, and there is no ToS question at all.

**What already exists here:** `server/mail.js` runs an IMAP session against
`imap.gmail.com`, is enabled, and self-schedules via `startAutoScan()` (a 60-second tick
gated by `mail.scanIntervalMin`, currently `600`).

**What would need building:**

- A sender/subject filter — e.g. anything from `@openai.com` whose subject matches the
  campaign — checked on a short interval.
- **Do not just set `scanIntervalMin` to 30.** The existing scan runs `classify()`, which
  sends up to 30 messages to the chat model in one call with a 6000-token budget. On this
  box that is minutes of GPU per run and it holds the only model slot — it is exactly what
  was starving receipt OCR earlier this week. This watcher needs a *separate, LLM-free*
  path: fetch headers, match a sender, count, notify. Milliseconds, no GPU.
- Better than polling: **IMAP IDLE** keeps one connection open and the server pushes on
  arrival — near-instant, and cheaper than waking every 30 minutes.

**First thing to check:** search your mail for messages from Feather about available
tasks. If they exist, this option is a couple of hours of work and strictly better than
anything else on this list. If they don't, it's dead and Option 2 becomes the move.

---

## Option 2 — Ask for the supported path

Before building anything, two cheap questions:

- Does Feather have a **notification setting** in its own UI (email, browser push, digest)?
  Platforms that hand out task-based work usually do, because they want claims to be fast.
- Is there an **official API, webhook, or RSS feed** for contractors? Ask support.

One message might make this entire document unnecessary, and an answer from them is the
only version of this that is unambiguously sanctioned. Worth doing first even if you
intend to build something else.

---

## Option 3 — A helper inside your own browser session

*(carries a ToS question — see below)*

A userscript (Violentmonkey/Tampermonkey) or a small extension that runs **on the page you
already have open, in your real logged-in browser**. It reads the unclaimed-task count out
of the DOM you are already looking at and raises a native `Notification` when it changes.

**Why this is different from a scraper:** it defeats nothing. The browser passed the
Cloudflare challenge normally because it *is* a browser, with you driving it. No cookie
harvesting, no fingerprint spoofing, no headless anything.

**Why it still isn't free:** it is still automated interaction with the platform, and a
page left open on a timer is still a form of polling. Whether that is acceptable is a
contract question, not a technical one. **Check your contractor agreement for language
about automated access, scripting, or scraping before using this.** If it prohibits
automation, this is out too — and Options 1, 2 and 4 remain.

**Shape:**

- `@match` the campaign URL, run on an interval, read the count, `Notification.requestPermission()`.
- Optionally POST the count to AIOS (`/api/...`) so the phone gets it too, reusing the
  hub's existing notify path.
- Keep the interval humane — 30–40 minutes as you described, not seconds.

---

## Option 4 — A reminder, not a watcher *(zero risk, works today)*

Don't query anything. Have AIOS nudge *you* every 30–40 minutes during working hours:
"check Feather for tasks."

Unglamorous, but it solves the actual problem — that work arrives at random times and you
forget to look — with no access to the site, no credentials, no ToS exposure, and no
maintenance. It is also the only option here that cannot break when the site changes.

**What exists:** `server/tools.js` already has a `notify({ message })` tool that posts to a
Discord webhook when one is configured, and the Planner already stores tasks and events.
A recurring reminder is close to free.

**Sharpen it cheaply:** only fire during the hours you actually work, and let one tap say
"checked, nothing there" so it backs off for a while. That turns a dumb timer into
something you won't mute after two days.

---

## Option 5 — Native push, if the platform offers it

If Feather supports **web push** or has a mobile app with notifications, turn it on and
let the OS deliver it. Nothing to build and nothing to maintain.

Worth noting for the phone side: the AIOS phone shell is already an installed PWA on a
real HTTPS origin (`joejin-nitro-an515-46.tail0036a2.ts.net`), which is the hard
prerequisite for web push on iOS. AIOS has **no VAPID/web-push setup today**, so pushing
from your own hub to your phone would be new work — but the origin situation that usually
blocks it is already solved. That matters for Options 1 and 4 too: it is how a hub-side
notification reaches your phone rather than a Discord webhook.

---

## Recommendation

1. **Check whether Feather emails you** when tasks appear (one search of your inbox).
2. **Ask Feather** whether there's a notification setting or contractor API (one message).
3. If either lands → **Option 1**, using a lightweight LLM-free IMAP path, not the
   existing triage scan.
4. If neither lands → **Option 4** today, and **Option 3** only if your contractor
   agreement permits automation.

The one thing not on this list is fetching that URL on a schedule. The site says no in the
clearest way a site can, and the value of the account is worth more than the convenience.
