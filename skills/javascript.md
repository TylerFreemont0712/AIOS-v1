# Modern JavaScript best practices

## Declarations & style
- `const` by default, `let` only when reassigned, never `var`.
- Strict equality always: `===` / `!==`.
- Template literals for building strings; arrow functions for callbacks; regular `function` for top-level named functions.
- Early returns over nested `if` pyramids.

## Async — where most bugs live
- `async/await` over `.then()` chains. Wrap awaited code that can fail in `try/catch` and handle it — an ignored rejection is a silent crash.
- A function that awaits must be awaited by its caller. Grep callers after making a function async.
- Parallel independent work: `await Promise.all([a(), b()])` — not sequential awaits.
- `array.forEach(async …)` does NOT wait. Use `for (const x of items)` with await, or `Promise.all(items.map(…))`.
- Every `fetch` needs: `if (!res.ok) throw new Error(…)` — fetch does not reject on HTTP errors. Add a timeout with `AbortController` for anything user-facing.

## Data handling
- Transform with `map`/`filter`/`find`/`some`/`reduce`; don't mutate inputs — spread to copy: `{ ...obj, key }`, `[...arr, item]`.
- Optional chaining + nullish coalescing: `user?.profile?.name ?? 'anon'`. Note `??` vs `||`: `||` also replaces `0`, `''`, `false`.
- `JSON.parse` throws — wrap it when input isn't fully trusted.
- Copy before sort: `[...items].sort((a, b) => a.n - b.n)` — sort mutates, and default sort is lexicographic.

## Modules
- ESM (`import`/`export`) in new code; check `package.json` `"type"` before assuming. Don't mix `require` and `import` in one file.
- Named exports over default exports — they survive renames and autocomplete better.

## Pitfalls
- Losing `this`: extracting a method (`const f = obj.method`) unbinds it — use arrows or `.bind`.
- Floating-point: `0.1 + 0.2 !== 0.3`; compare with a tolerance or work in integers (cents, ms).
- `typeof null === 'object'`; `NaN !== NaN` (use `Number.isNaN`).
- Date months are 0-indexed. Prefer ISO strings + `Date.parse`, or do date math in ms.
- Truthiness traps: `if (value)` skips `0` and `''` — test `value !== undefined` when those are valid.

## Node specifics
- `node:` prefix for builtins: `import fs from 'node:fs'`.
- Paths relative to the file, not the cwd: `new URL('./data.json', import.meta.url)` or `path.join(__dirname, …)`.
- Never build shell commands from strings — pass args as arrays (`spawn(cmd, [a, b])`).

## Verify
- Run it: `node file.js`, or the project's script (`npm test`, `npm run dev`). Check the terminal AND the browser console for errors.
