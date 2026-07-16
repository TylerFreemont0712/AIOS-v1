# AIOS — instructions for the agent working on this project

verify: npm run check

- Zero-build project: plain ESM on both sides, no bundler, no TypeScript. `npm run check`
  must pass after every change (it esbuild-parses web/js and syntax-checks server/).
- UI is pages, not windows: apps mount once into `.page` sections (web/js/wm.js).
  Register new apps in web/js/main.js (import + registerApp + dock list).
- Server modules live in server/, one concern per file. Routes are wired in
  server/index.js with the `h()` JSON wrapper — but use a PLAIN handler for
  `res.sendFile` (h() races it).
- Secrets never reach the client: redact in `publicConfig()` (server/config.js) and
  accept them only via explicit fields in `updateConfig()`.
- Deeper suites when touching core flows: `npm run audit` (units), `npm run e2e`
  (loop-level with mock providers). Keep both green.
- Before deep-diving a subsystem, read Roadmap.md "Shipped" notes — most design
  decisions and gotchas are recorded there.
