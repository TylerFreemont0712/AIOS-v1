# Security essentials

## Inputs (trust nothing that crosses a boundary)
- Validate at the edge: type, length, range, allowed characters — allowlist over blocklist.
- Injection is one bug wearing many masks:
  - SQL → parameterized queries only, never string concat.
  - Shell → pass argument arrays (`spawn(cmd, [args])`), never interpolate into a command string.
  - HTML/XSS → escape by default; never `innerHTML` with user data; sanitize markdown output (DOMPurify-style) before insertion.
  - Paths → resolve then prefix-check against the allowed root before any fs call.
- Deserialization: `JSON.parse` in try/catch and validate the shape; never `eval`, `new Function`, pickle, or yaml.load on untrusted data.

## Secrets
- Only from env/config vaults; never in source, git history, client-side code, logs, or error messages.
- If a secret may have leaked (committed, pasted, logged): rotate it — deleting the line does not unleak it.
- Compare tokens with constant-time comparison where the framework offers it.

## AuthN / AuthZ
- Authenticate the request, then authorize the *specific resource* ("is this user allowed THIS object") — missing object-level checks (IDOR) are the most common real-world hole.
- Deny by default; auth middleware before routes; re-check on the server even if the UI hides the button.
- Passwords: bcrypt/argon2 (never home-rolled hashing); sessions: httpOnly, sameSite cookies; expire tokens.

## Web specifics
- CORS: explicit origin list, not `*` with credentials.
- CSRF protection for cookie-authenticated state changes.
- Set body-size limits and timeouts on every endpoint and outbound call.

## Dependencies & crypto
- Prefer stdlib/platform crypto (`crypto.randomUUID`, `crypto.getRandomValues`, `secrets` in Python) — `Math.random()` is never for tokens.
- Pin/lockfile dependencies; be suspicious of tiny packages doing trivial things.

## Mindset
- Every "it's only used internally" assumption eventually breaks — write the check anyway.
- Log the attempt, not the secret: log that auth failed, not the password tried.
