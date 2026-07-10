# Job Search Add-on — Game Plan

A new **Job Search** app for AIOS that turns the hub into a personal, AI-driven job
search engine tuned to *your* resume and goals — heavy on freelance and data-annotation
work. It leverages AI end-to-end: discover jobs, score fit, tailor your resume + cover
letters, assist (or automate) applications, track everything in a pipeline, and read
your email to keep statuses ("needs reply", "rejected", "accepted", …) up to date.

> Status: **building.** Blueprint below; decisions locked in and build order in the next section.

---

## 0. Locked decisions & build order (2026-07)

**Decisions (confirmed with the user):**
- **Data source = pluggable.** A swappable `JobSource` connector layer. First-class:
  (1) a **SearXNG** connector (works today, zero setup — site-scoped `indeed.jp` search
  via the already-running SearXNG); (2) a **Firecrawl** connector (self-hosted via Docker
  like SearXNG, upgrades scraping quality + reads any board with no API); (3) an optional
  **job-API** connector (SerpApi Google Jobs) for maximum Indeed reliability when a key is
  set. Config picks the active source; connectors return a common job shape.
- **Applying = open + track.** A job pill opens the Indeed apply page in a new tab; AIOS
  marks it applied and tracks status. AI can pre-draft a tailored cover letter/answers.
  (Indeed blocks true programmatic submit; mass-apply = a queued open-and-track, later.)
- **Email → status = in this build.** Connect email (IMAP first — works with any provider
  via app-password; Gmail API later), match threads to tracked jobs, AI-classify
  (rejected / interview / offer / needs-reply / …), auto-update status + flags.
- **Search = on-demand + saved.** Type a search → pill feed; save searches to re-run.
  Scheduled polling/alerts come later.
- **Model** = the app's own model picker (local 9B for bulk summaries/scoring/classify,
  Anthropic for high-stakes cover letters), same pattern as Chat/Agent/Research.

**Modularity guarantee:** all new code lives in new files (`server/jobs.js`,
`server/jobsource.js`, `server/jobmail.js`, `web/js/apps/jobsearch.js`, a Firecrawl
docker script). Existing files get only additive touches (register the app in `main.js`,
add routes in `index.js`, a `jobsearch` config section + secret handling in `config.js`,
a Settings tab). Nothing existing changes behavior → no regressions.

**Build order (incremental, each verifiable):**
1. ✅ **1a — core:** jobs store + pipeline, pluggable source (SearXNG connector),
   `/api/jobs/*` routes, the Job Search app (search → pill feed + board + open-and-track).
2. ✅ **1b — enrichment (2026-07-08):** Profile system (`server/profile.js` — structured
   resume "memory" with AI import, standing answers, taught Q&A, completeness meter) +
   `server/jobai.js` (fit-scoring, cover letters incl. Japanese, questionnaire answering
   grounded in the profile). Profile tab + per-pill AI actions in the app.
3. ✅ **1c — Firecrawl (2026-07-08):** `npm run firecrawl` (official compose flipped to
   prebuilt GHCR images, port 8899); connector scrapes Indeed (when Cloudflare allows —
   it's intermittent) + scrape-friendly boards (TokyoDev, Japan Dev for JP; RemoteOK/WWR
   elsewhere) and extracts structured jobs with AIOS's own model. SerpApi key optional
   (Settings → Job Search). Verified live: gemma extracted 12 real jobs from TokyoDev.
4. ✅ **1c+ — annotation platforms (2026-07-08):** `server/platforms.js` — seeded
   directory (Outlier, Alignerr, DataAnnotation, Prolific, CrowdGen, Clickworker, Toloka,
   TELUS, Mercor, Remotasks, Surge + custom), membership status, per-platform login
   cookie (redacted), availability checks (Firecrawl/fetch + heuristics + AI classify,
   with confidence + evidence). Platforms tab in the app.
5. **1d — email → status (next):** IMAP/Gmail connector, thread↔job matching, AI
   classification, auto status + needs-reply queue + draft replies (approve to send).
6. **1e — later:** mass-apply queue, scheduled saved-search alerts + platform-availability
   alerts, analytics/funnel, browser-automation login for platform checks.

---

## 1. Goals

- One place to run the whole hunt: discover → assess → apply → track → follow up.
- **Tuned to you**: everything flows from one structured profile/resume you set up once.
- **Autonomous where safe**: an AI job-hunt agent does the legwork; you approve the
  outward-facing steps (anything that sends an email or submits an application).
- **Two niches first-class**: freelance (Upwork-style *proposals*) and **annotation
  platforms** (signup + qualification tracking), plus normal salaried roles.
- **Email-aware tracking**: connect email so application status updates itself.
- Local-first and private: your resume, emails, and history stay on your machine.

---

## 2. How it fits into AIOS (reuse, don't reinvent)

This maps onto patterns AIOS already has, so it's mostly composition:

| Need | Reuse |
|---|---|
| App page + dock entry + palette actions | `registerApp`, page views, `renderDock`, palette in `main.js` |
| Job discovery / company research loop | the **research engine** (`server/research.js`: plan→search→read→reflect→synthesize) |
| Web search + page reading | `web_search` (bundled SearXNG) + `fetch_url` in `tools.js` |
| Autonomous multi-step flow + **approval gate** | the **agent loop** (`server/agent.js`) — approvals are perfect for "before you send/apply" |
| Streaming progress to the UI | the WebSocket hub (`chat:`, `agent:`, `research:` → add `jobs:`) |
| Persistent per-entity JSON store | the `data/<thing>/*.json` pattern used by chats/agent/research/mindmaps |
| Settings + secrets | `config.js` + Settings tabs; redact secrets in `publicConfig()` |
| Notes / knowledge | optionally the **vault** (store company research, interview prep as notes) |
| Reminders / recurring runs | the roadmap's scheduled-tasks idea (daily digest, email triage) |
| Model choice per task | provider abstraction (`llm.js`) — big model for drafting, local 9B for triage |
| Services status | add email/board connectors to the Home **services panel** registry |

New surface area is small and modular by design.

---

## 3. Core concepts & data model

**Profile** — the single source of truth the AI uses everywhere.
```
profile: {
  contact: { name, email, phone, location, links: { linkedin, github, portfolio, ... } },
  summary, skills: [ { name, level, years } ],
  experience: [ { title, org, start, end, bullets[], tech[] } ],
  education, projects, certifications,
  preferences: { roles[], remote, locations[], minPay, workType: [salaried|freelance|annotation],
                 excludeCompanies[], keywords[], dealbreakers[] },
  voice: { tone, sampleWriting }   // so cover letters sound like you
}
```

**Resume** — a master + tailored variants.
```
resume: { id, label, base: bool, format: 'structured', data: <profile-subset>,
          renderedPdfPath?, atsText? }
```

**Job** — one opportunity, whatever the source.
```
job: {
  id, source, sourceId, url, title, company, companyDomain,
  location, remote, type: 'salaried|freelance|annotation',
  description, requirements[], salary, postedAt, discoveredAt,
  matchScore, matchReasons[], redFlags[], tags[],
  status, stage, appliedAt, appliedWith: { resumeId, coverLetterId, answers },
  contacts: [ { name, role, email } ],
  emails: [ emailRef ], events: [ calendarRef ],
  followUps: [ { due, done, note } ], notes, timeline: [ { at, kind, text } ]
}
```

**Application pipeline (stages)** — a kanban:
`Saved → Interested → Preparing → Applied → Acknowledged → Assessment → Interview →
Offer → Accepted` with side states `Rejected`, `Ghosted`, `Withdrawn`.
Plus email-driven **flags**: `Needs reply`, `Action required`, `Waiting on them`.

**For annotation/freelance**, "apply" means different things — the model handles it:
- *Annotation platform*: track `signed up → qualification test → approved → active/paused`.
- *Freelance gig*: a **proposal** (draft + connects/budget) rather than an application.

---

## 4. Feature areas

### 4.1 Profile & Resume
- **One-time import**: drop in your existing resume (PDF/DOCX/TXT) → AI parses it into
  the structured profile. Review/edit in the UI.
- **Master resume** + **variants** (e.g. "SWE", "Data annotation", "Freelance/ML").
- **AI tailoring per job**: rewrite summary + bullets to match a posting, surface
  missing keywords for ATS, keep it truthful (no invented experience).
- **Cover letters / proposals** generated per job in *your* voice.
- **Application-question autofill**: generate answers to common form questions
  ("Why us?", "Salary expectations", "Years with X") from the profile.
- **Export**: clean PDF/DOCX from a couple of templates; keep an ATS-plain-text version.
- **Gap analysis**: "roles you want vs. skills you show" → suggested resume improvements.

### 4.2 Job discovery & research
- **Aggregated search** across sources with clean feeds/APIs first (see §5), SearXNG
  for the rest. Filters: role, keywords, remote, location, pay, type, freshness.
- **Saved searches** + **standing/scheduled search** (daily poll for new postings →
  digest). Dedupe across sources by title+company+url.
- **AI fit-scoring**: each job ranked against your profile → match %, reasons, gaps,
  and **red flags** ("unpaid", "commission-only", vague scope, known content farm).
- **Company research** (reuse research.js): what they do, size, recent news, reputation,
  pay data, "why this fits you / watch-outs" — saved as a note per company.
- **Annotation/freelance directory**: a curated, taggable list of platforms
  (DataAnnotation, Outlier/Remotasks, Appen, Alignerr, Mercor, Prolific, Toloka,
  Clickworker, Surge AI, Telus/Lionbridge, Upwork, Freelancer, Fiverr, Contra, …)
  with your signup + qualification status on each, and "opening now" alerts.

### 4.3 Application assistance & automation
Realistic spectrum (default = human-in-the-loop; full auto is opt-in/experimental):
- **Assisted apply (default)**: AI assembles the package — tailored resume + cover
  letter + drafted answers — you review, then it opens the posting and copies the
  right fields to clipboard / prefills where possible; you click submit.
- **Proposal drafting** for freelance gigs (Upwork etc.), with connects/budget notes.
- **Approval queue**: nothing leaves your machine without an explicit OK (mirrors the
  agent's approval gate). Every submission is logged (what resume/letter/answers went).
- **Experimental full auto** (clearly flagged, opt-in): a Playwright-driven autofill
  for specific sites you authorize. Caveats up front: many boards' ToS forbid bots,
  captchas/anti-bot break it, accounts can be banned. We favor assist over bot.

### 4.4 Application tracking (pipeline / CRM)
- **Kanban board** by stage; drag to move; per-job detail drawer.
- **Timeline** per job (discovered, applied, follow-ups, emails, interviews).
- **Follow-up reminders** ("nudge if no reply in 7 days") → surfaced on Home + a queue.
- **Contacts** (recruiter/hiring manager) and interview prep per job.
- **Stats/funnel**: sent, response rate, interview rate, by source/role/resume variant.

### 4.5 Email integration & status automation  ⭐ (explicitly requested)
- **Connect email**: Gmail API via OAuth (least-privilege scopes) preferred; **IMAP**
  as a generic fallback. Tokens encrypted at rest; read-only by default.
- **Match emails → jobs**: by company domain, recruiter address, subject, or the alias
  you applied from.
- **AI classification** of each thread → `Acknowledged`, `Rejected`, `Interview invite`,
  `Assessment/Test`, `Offer`, `Request for info`, `Recruiter outreach`, `Needs reply`.
- **Auto-update status** from the classification; set the **Needs reply / Action
  required** flags; keep the source thread linked on the job.
- **Reply drafting**: AI drafts replies (accept interview, ask questions, decline) —
  saved as **drafts**; sending requires explicit approval.
- **Digest**: "3 need replies, 1 interview invite, 2 rejections" on Home / as a run.

### 4.6 Calendar & interviews
- Detect interview invites → propose a **calendar event** (Google Calendar API / .ics).
- **Interview prep**: AI generates likely questions from the posting + company research,
  and a STAR-story bank pulled from your resume; reminders before the event.

### 4.7 Autonomous job-hunt agent
A scheduled loop built on the agent framework:
`discover new jobs → score & shortlist → draft applications for top matches →
queue for your approval → on approval, log & (assist-)apply → scan email → update
statuses & flags → propose follow-ups`. Streams progress; stops at every outward action.

### 4.8 Analytics & insights
- Funnel + response rates; which **resume variant / source / role** performs best.
- Rejection pattern analysis → concrete resume/targeting suggestions.
- Weekly summary ("applied to 22, 4 replies, 1 interview; annotation platforms slow").

---

## 5. Integrations (and a reality check)

**Clean, allowed data sources (prefer these):**
- Public job feeds/APIs: RemoteOK, WeWorkRemotely, Remotive, Arbeitnow, Hacker News
  "Who is hiring", Adzuna (free API), USAJobs — mostly JSON, no scraping.
- **Upwork API** (OAuth): read gigs, draft proposals.
- **Gmail API** + **Google Calendar API** (OAuth) for email/calendar.
- **SearXNG** (already bundled) for everything else, + `fetch_url` to read postings.

**Restricted / no official individual API (discover via SearXNG, apply assisted):**
- LinkedIn, Indeed (partner-only API), most annotation platforms — treat as
  discover-and-assist, not auto-submit.

**Integration strategy — recommend an MCP client in AIOS.** Rather than hard-wiring
each service, add a small **MCP client** so AIOS (and the agent) can connect to MCP
servers for Gmail, Calendar, Upwork, Indeed, etc. — modular, matches the "easy to add
services later" goal, and mirrors how these are already exposed elsewhere. Fallback:
direct REST connectors behind a common `connector` interface. Either way, connectors
register into the Home **services panel** so their status shows up automatically.

**Honest caveats (design around these):**
- Auto-submitting to third-party boards can violate ToS and get accounts banned;
  captchas/anti-bot defeat headless bots. → default to **assisted**, flag full-auto.
- Don't fabricate resume content or spam low-fit roles (hurts you + looks like spam).
- Respect rate limits / robots; use official feeds where they exist.

---

## 6. Privacy & security (non-negotiable)
- Local-first: resume, emails, tokens, history live in `data/` on your machine.
- OAuth with **least-privilege** scopes; **encrypt tokens/secrets at rest**; redact in
  `publicConfig()`; never log secrets (extend the existing secret-scrub).
- Email is **read + draft by default**; sending or submitting requires explicit approval.
- A clear "what's connected / revoke" panel; one-command data export & wipe.

---

## 7. Technical design (proposed)

**Server modules (new):**
- `server/jobs.js` — job store + pipeline/status + follow-ups + stats (CRUD, `data/jobs/`).
- `server/resume.js` — profile + resume variants, import/parse, tailoring, PDF export.
- `server/jobsearch.js` — the discovery/aggregation engine (research.js-style loop) +
  fit-scoring; connectors for each source.
- `server/connectors/` — `email/` (gmail, imap), `boards/` (remoteok, upwork, adzuna,
  searxng…), `calendar/`; a common interface + a registry (feeds the services panel).
- `server/mail.js` — email fetch, thread→job matching, AI classification, draft replies.
- (optional) `server/mcp.js` — MCP client if we go that route.
- Extend `tools.js` with agent tools: `job_search`, `job_fetch`, `score_job`,
  `tailor_resume`, `draft_cover_letter`, `draft_answers`, `update_job_status`,
  `scan_email`, `classify_email`, `draft_reply`, `company_research`.

**Client (new):** `web/js/apps/jobsearch.js` with views:
`Pipeline (kanban)` · `Discover (job feed + fit scores)` · `Resume/Profile` ·
`Application composer` · `Inbox/needs-reply` · `Insights` · `Sources & connectors`.
Plus dock entry, palette actions, and Home widgets ("needs reply", "new matches").

**Config:** a `jobsearch` section (profile ref, sources enabled, filters/preferences,
connector settings) + connected-accounts (secrets separate, encrypted).

**Data:** `data/jobs/*.json`, `data/resume/*.json`, `data/jobsearch/{profile,searches,connectors}.json`.

**API/WS:** REST under `/api/jobs`, `/api/resume`, `/api/jobsearch/*`, `/api/mail/*`;
WS topic `jobs:<runId>` for streaming discovery/agent/triage progress.

**AI usage:** big model (Anthropic) for high-stakes drafting (resume/cover letters,
offer replies); local 9B for cheap/bulk work (fit-scoring, email classification,
dedupe). All prompts kept truthful and grounded in the profile.

---

## 8. Implementation phases

**Phase 0 — foundations (MVP core):**
- App shell + dock/palette; `jobs.js` store; **manual add-a-job** + **Kanban pipeline**
  with status/flags; job detail drawer + notes/timeline. (Immediately useful, no
  external deps.)

**Phase 1 — profile & resume:**
- Resume import/parse → structured profile; resume variants; AI tailoring + cover
  letter drafting; PDF export.

**Phase 2 — discovery & fit:**
- `jobsearch.js` aggregation over clean feeds + SearXNG; fit-scoring; saved searches;
  company research; annotation/freelance directory with status tracking.

**Phase 3 — email & status automation (the ⭐ feature):**
- Email connector (Gmail OAuth, IMAP fallback); thread→job matching; AI classification;
  auto status + needs-reply flags; draft replies (approve to send); daily digest.

**Phase 4 — assisted applications & the agent:**
- Application composer + approval queue + submission logging; the autonomous hunt loop;
  scheduled daily digest + email triage; calendar/interview prep.

**Phase 5 — insights & polish:**
- Funnel analytics, per-variant/source performance, rejection insights; full-auto
  autofill (experimental, opt-in); MCP client if pursued.

---

## 9. Decisions to make before we start
1. **Email**: Gmail API (OAuth, richer) vs. generic IMAP (works with any provider) —
   or both, Gmail first?
2. **Auto-apply appetite**: assisted-only to start (recommended), or invest early in
   experimental browser autofill?
3. **Integration path**: build a small **MCP client** (modular, reusable) or direct
   REST connectors first?
4. **Which sources matter most to you** day one — annotation platforms, Upwork, remote
   job feeds, or all?
5. **Model policy**: default drafting on Anthropic (quality) vs. keep everything on the
   local 9B (private/free)?
6. **Resume**: do you have a current resume file to import as the master profile?

---

## 10. Nice-to-haves / later
- Referral/network tracker; contacts CRM with reminders.
- Salary benchmarking per role/location; negotiation helper for offers.
- Portfolio/case-study generator for freelance profiles.
- Browser extension: "save this job to AIOS" + autofill on any site.
- Mobile-friendly pipeline (apply/triage from your phone on the LAN).
- Auto-generate tailored Upwork/Fiverr profile blurbs per gig category.
- "Application heatmap" calendar; goal tracking (e.g. 10 quality apps/week).
