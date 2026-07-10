# TypeScript best practices

All of javascript.md applies. TypeScript adds:

## Types that pull their weight
- Let inference work: annotate function parameters and return types; skip annotations on obvious locals (`const n = 5`).
- `interface` for object shapes, `type` for unions/intersections/aliases. Pick what the codebase already uses.
- Model states as discriminated unions, not optional soup:
  `type Res = { status: 'ok'; data: Data } | { status: 'error'; message: string }` — then `switch (res.status)` narrows automatically.
- `unknown` over `any` for untrusted input — it forces you to narrow before use. Every `any` you add turns the checker off for everything it touches.
- Narrow with real checks: `typeof x === 'string'`, `'key' in obj`, `Array.isArray(x)`, or a type-guard function `(x): x is User => …`.

## API boundaries
- Types describe hopes; validate reality. Data from `fetch`/files/env is `unknown` until checked (zod if the project has it, else hand-written guards).
- Export the types your module's consumers need; keep internal types unexported.
- `as const` for literal maps/tuples; `satisfies T` to check a literal against a type without widening it.

## Pitfalls
- `as` assertions are lies until proven — prefer narrowing; if you must assert, verify at runtime nearby.
- Non-null `!` is a promise the compiler can't check — only where you can see the guarantee on the same screen.
- Optional (`x?: T`) means callers must handle `undefined` — don't add `?` just to silence an error.
- Enums: prefer union of string literals (`type Level = 'low' | 'high'`) — simpler, erasable, serializable.
- Errors in `catch` are `unknown`: `catch (e) { const msg = e instanceof Error ? e.message : String(e) }`.

## Config & verify
- Respect the project's `tsconfig.json` — never loosen `strict` flags to make an error go away; fix the type.
- The compiler is the test you get for free: `npx tsc --noEmit` after changes and fix EVERY error, starting with the first.
- Type errors read inside-out: the last "expected X, got Y" line is usually the real mismatch.
