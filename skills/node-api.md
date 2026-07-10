# Node backend / API best practices

## Route handlers
- Thin handlers: parse/validate input → call a plain function → shape the response. Business logic lives outside the framework.
- Async handlers must catch: an unhandled rejection inside Express 4 kills the request silently. Wrap with a helper
  `const h = fn => async (req, res, next) => { try { await fn(req, res) } catch (e) { next(e) } }` (Express 5 forwards automatically).
- One centralized error middleware `(err, req, res, next)` that logs the real error and returns a safe message + correct status.

## Input validation
- Validate body/query/params at the edge — types, ranges, allowed values. Reject early with 400 and a specific message.
- Never trust `req.body` shape; never pass client data into file paths, shell commands, or query strings unchecked.
- Path traversal guard for any user-supplied path: resolve then verify the prefix:
  `const abs = path.resolve(root, p); if (!abs.startsWith(root + path.sep)) throw …`.

## HTTP semantics
- Status codes: 200 read, 201 created, 204 no body, 400 bad input, 401 unauthenticated, 403 forbidden, 404 missing, 409 conflict, 500 bug.
- Return JSON errors in one consistent shape: `{ error: "message" }`.
- Idempotency: GET never mutates; PUT replaces; PATCH merges; repeated DELETE is still 200/204.

## Config & secrets
- Config from env vars with explicit defaults, read in one module — not `process.env` scattered everywhere.
- Secrets never in code, logs, or error responses. `.env` is gitignored.

## Reliability
- Timeouts on every outbound call (`AbortController`); the default is infinite.
- Don't block the event loop: no sync fs/crypto calls in request paths (`readFileSync` at startup is fine).
- Graceful shutdown: on SIGTERM/SIGINT close the server, finish in-flight requests, then exit.
- Streams for large files (`fs.createReadStream(...).pipe(res)`), not `readFile` into memory.

## Security quick list
- `express.json({ limit })` — bound the body size.
- Parameterized queries only — never string-concatenate SQL.
- Auth middleware runs before the routes it protects; deny by default.
- Escape/sanitize anything reflected into HTML (or send `text/plain`).

## Verify
- Actually call it: `curl -s localhost:PORT/api/x | head`, check both the happy path and one bad input (expect 400, not a stack trace).
- Watch the server log while testing — errors that don't reach the response still matter.
