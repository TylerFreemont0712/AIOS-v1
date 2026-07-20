// Seed the LLM wiki with a starter pack of programming notes in the canonical
// format (frontmatter tags, definition-first, Related links). Idempotent — re-running
// updates the same notes. Usage: npm run seed-wiki
//
// These notes exist for BOTH readers: the human browsing the Second Brain, and the
// agent pulling them back through wiki_recall before it works.

import { loadConfig } from '../server/config.js';
import { upsertNote, rebuildIndex, NOTE_KINDS } from '../server/wiki.js';

const cfg = loadConfig();
if (!cfg.vault?.path) {
  console.error('No vault connected — set one in Settings → Vault first.');
  process.exit(1);
}

const NOTES = [
  {
    title: 'Wiki Guide', folder: 'Meta', tags: ['meta'],
    content: `**This wiki is the shared long-term memory of the user and the AIOS agent — atomic, linked, and grounded.**

## Conventions
- **One topic per note.** Titles are concise noun phrases ("Async Patterns in JavaScript", not "Notes about async stuff").
- **Definition first.** The opening line is a bold one-sentence definition, so a recall of just the top of the note is still useful.
- **Folders by domain** (JavaScript, Python, Git, Practices, AIOS, …), two levels deep at most.
- **Tags in frontmatter** (\`tags: [js, async]\`), lowercase, few and reusable. Inline #tags are allowed but frontmatter is canonical.
- **Every note ends with a Related section** of [[wikilinks]] — an unlinked note is invisible to graph traversal.
- **Ground claims.** Prefer "X because Y (seen in Z)" over bare assertions; note version numbers when APIs change behaviour.

## How the agent uses this
- \`wiki_recall\` before starting work on a topic — packed note bodies, cheapest context there is.
- \`wiki_learn\` after learning something reusable — frontmatter, autolinks, and the [[Home]] index are automatic.
- \`wiki_generate\` to scaffold a new domain; then correct and densify the generated notes over time.

## Related
- [[Systematic Debugging Checklist]]
- [[AIOS Architecture Primer]]`,
  },
  {
    title: 'Systematic Debugging Checklist', folder: 'Practices', tags: ['debugging', 'practices'],
    content: `**Debugging is hypothesis testing against a reproducible failure — never change code before you can reproduce and read the actual error.**

## The loop
1. **Reproduce** deterministically; shrink the input until the failure is minimal.
2. **Read the error text literally** — the message, the *first* stack frame in your own code, and the line numbers. Most "mystery bugs" are answered in the message.
3. **State a hypothesis** ("X is undefined because the config loads after use") and design the cheapest observation that could falsify it (log, breakpoint, assertion).
4. **Bisect**: half the input, half the commit range (\`git bisect\`), half the code path. One variable at a time.
5. **Fix the cause, not the symptom** — if a null check "fixes" it, ask why the null got there.
6. **Verify by re-running the original reproduction**, then add a regression test.

## Traps
- Shotgun edits (changing several things, then not knowing which mattered).
- Debugging the wrong build/process — confirm the code you're editing is the code that's running.
- Heisenbugs from logging inside race windows; prefer counters or post-mortem dumps.
- Trusting a cache: stale node_modules, bundlers, or browser cache mask fixes.

## Related
- [[Git Recovery Commands]]
- [[Error Handling Principles]]
- [[Bash Scripting Safety]]`,
  },
  {
    title: 'Error Handling Principles', folder: 'Practices', tags: ['practices', 'errors'],
    content: `**Errors are data: catch only where you can act, keep the original cause, and fail loudly at boundaries.**

## Principles
- **Fail fast internally.** Validate inputs at module boundaries and throw with context; deep code should assume validated data.
- **Never swallow.** An empty \`catch {}\` is acceptable only for genuinely optional operations (best-effort cleanup) — and then a comment should say so.
- **Wrap with context, keep the cause**: \`throw new Error(\\\`loading config: \\\${e.message}\\\`, { cause: e })\` — the top-level handler then prints a story, not a bare "ENOENT".
- **One top-level handler per entry point** (request handler, CLI main, event loop tick) that logs and converts to the transport's error shape (HTTP status, exit code, UI toast).
- **Retries need bounds and jitter**, and only for transient classes (network, 429/503) — never retry validation errors.
- **User-facing message ≠ log message.** The log gets the stack; the user gets what to do next.

## Related
- [[Systematic Debugging Checklist]]
- [[Async Patterns in JavaScript]]`,
  },
  {
    title: 'Testing Strategy', folder: 'Practices', tags: ['testing', 'practices'],
    content: `**Test the behaviour users depend on, at the cheapest level that can catch the regression.**

## Shape
- **Many fast unit tests** for pure logic (parsers, scorers, formatters) — milliseconds, no I/O.
- **Some integration tests** where components meet (route → store → disk), with temp dirs and fake servers instead of mocks-of-everything.
- **Few end-to-end smoke tests** that walk the happy path of each critical flow. If a smoke test is flaky, the product probably is too.

## Habits
- A bug fix earns a regression test that fails before the fix and passes after.
- Test names state the expected behaviour ("rejects listing pages") not the method name.
- Determinism: freeze time, seed randomness, avoid real network; a test that needs retries is a bug.
- Assert on observable results (output, file content, response body), not internal call counts, or refactors will break tests without breaking behaviour.
- Keep test data small and inline — a reader should understand the case without opening fixtures.

## Related
- [[Systematic Debugging Checklist]]
- [[Error Handling Principles]]`,
  },
  {
    title: 'Async Patterns in JavaScript', folder: 'JavaScript', tags: ['js', 'async'],
    content: `**JavaScript concurrency is a single-threaded event loop: nothing runs in parallel in your code, but everything interleaves at \`await\` points.**

## Patterns that work
- \`await Promise.all([a, b])\` for independent work — sequential awaits are the most common accidental slowdown.
- \`Promise.allSettled\` when partial failure is acceptable; filter results by \`status\`.
- **Timeouts via AbortController**: create a controller, \`setTimeout(() => ctl.abort(), ms)\`, pass \`ctl.signal\` to fetch — and \`clearTimeout\` in \`finally\`.
- **Bounded concurrency** for N tasks: a small worker-pool loop, not \`Promise.all\` over 500 fetches.

## Gotchas
- An unhandled promise rejection crashes modern Node — every floating promise needs \`.catch\` or \`void\` with intent.
- \`forEach(async …)\` does NOT await; use \`for … of\` with \`await\`, or map to promises then \`Promise.all\`.
- A losing branch of \`Promise.race\` keeps running — cancel it via the shared AbortSignal, and \`.catch(() => {})\` it so its later rejection isn't "unhandled".
- CPU-heavy loops starve the event loop (timers, servers): chunk with \`setImmediate\`/\`await 0\`-style yields or move to a worker.

## Related
- [[Error Handling Principles]]
- [[Node ESM Gotchas]]`,
  },
  {
    title: 'Node ESM Gotchas', folder: 'JavaScript', tags: ['js', 'node', 'esm'],
    content: `**Node ESM ("type": "module") is strict: explicit file extensions, no \`require\`/\`__dirname\`, and different-but-workable circular-import rules.**

## The essentials
- **Relative imports need the extension**: \`import x from './util.js'\` — omitting \`.js\` fails at runtime.
- **\`__dirname\` replacement**: \`path.dirname(fileURLToPath(import.meta.url))\`.
- **CJS interop**: a CommonJS module imports as its \`module.exports\` on the *default* export; named destructuring works only when Node can statically detect the names.
- **JSON**: \`import cfg from './x.json' with { type: 'json' }\` (or just \`readFileSync\` + \`JSON.parse\` — boring and portable).
- **Top-level await** works — but anything importing that module waits for it; keep module init cheap.
- **Circular imports** are fine for *function declarations* (hoisted, resolved at call time) but \`undefined\` for values read during evaluation. When a cycle is unavoidable, use a dynamic \`await import()\` at call time — AIOS does this where research tools call back into the tool belt.

## Related
- [[Async Patterns in JavaScript]]
- [[AIOS Architecture Primer]]`,
  },
  {
    title: 'Python Environment Setup', folder: 'Python', tags: ['python', 'tooling'],
    content: `**Every Python project gets its own virtual environment; the system Python is for the system.**

## Baseline
\`\`\`bash
python3 -m venv .venv
source .venv/bin/activate      # Windows: .venv\\Scripts\\activate
python -m pip install -U pip
pip install -e ".[dev]"        # or: pip install -r requirements.txt
\`\`\`
- Use \`python -m pip\` (not bare \`pip\`) so the interpreter and installer always match.
- Pin with a lock file (\`pip freeze > requirements.txt\` at minimum; pip-tools/uv/poetry for real projects).
- \`pyproject.toml\` is the modern single home for metadata, deps, and tool config.
- **uv** is a fast drop-in for venv+pip (\`uv venv\`, \`uv pip install\`) — worth using when available.

## Symptoms of a broken setup
- \`ModuleNotFoundError\` after a successful install → installed into a different interpreter; check \`which python\` and \`python -c "import sys; print(sys.prefix)"\`.
- Works in the shell but not in scripts/cron → the venv isn't on PATH there; call \`.venv/bin/python\` explicitly.

## Related
- [[Python Common Pitfalls]]
- [[Bash Scripting Safety]]`,
  },
  {
    title: 'Python Common Pitfalls', folder: 'Python', tags: ['python', 'gotchas'],
    content: `**Most Python surprises come from names binding late and defaults binding once.**

## The classics
- **Mutable default arguments** evaluate once: \`def f(x, acc=[])\` shares one list across calls. Use \`acc=None\` + \`acc = acc or []\`.
- **Late-binding closures**: \`[lambda: i for i in range(3)]\` all return 2. Capture with a default: \`lambda i=i: i\`.
- **\`is\` vs \`==\`**: \`is\` means identity; small-int/string interning makes \`is\` *look* right until it isn't. Only \`is None\` is idiomatic.
- **Modifying a list while iterating** skips elements — iterate a copy or build a new list.
- \`except Exception\` hides \`KeyboardInterrupt\`? No — but bare \`except:\` does. Never use bare except.
- **Float keys / equality** in dicts and tests: compare with \`math.isclose\`.
- **pathlib over os.path** — \`Path(a) / b\`, \`.read_text()\`, \`.glob()\` are shorter and safer.
- The **GIL** means threads don't speed up CPU-bound code — use multiprocessing or native libs; threads are fine for I/O waits.

## Related
- [[Python Environment Setup]]
- [[Systematic Debugging Checklist]]`,
  },
  {
    title: 'Git Recovery Commands', folder: 'Git', tags: ['git', 'recovery'],
    content: `**Almost nothing committed to git is ever lost — \`git reflog\` remembers where every branch and HEAD has been for ~90 days.**

## Getting out of trouble
| Situation | Command |
|---|---|
| Undo last commit, keep changes staged | \`git reset --soft HEAD~1\` |
| Unstage a file | \`git restore --staged file\` |
| Discard a file's local edits | \`git restore file\` |
| "I deleted my branch/commits" | \`git reflog\` → \`git checkout -b rescue <sha>\` |
| Undo a pushed commit safely | \`git revert <sha>\` (new inverse commit) |
| Find the commit that broke it | \`git bisect start; git bisect bad; git bisect good <sha>\` |
| Stash including untracked | \`git stash -u\` |

## Rules of thumb
- \`reset --hard\` and \`clean -fd\` are the only two commands that destroy uncommitted work — pause before both.
- Never rewrite history that others have pulled (\`push --force-with-lease\` if you must, on your own branches).
- Commit early on a branch; a messy branch history is free, lost work is not.

## Related
- [[Systematic Debugging Checklist]]`,
  },
  {
    title: 'Bash Scripting Safety', folder: 'Shell', tags: ['shell', 'bash'],
    content: `**Every non-trivial bash script starts with \`set -euo pipefail\` and quotes every expansion.**

## The armor
\`\`\`bash
#!/usr/bin/env bash
set -euo pipefail        # exit on error, unset vars are errors, pipes fail properly
IFS=$'\\n\\t'
\`\`\`
- **Quote everything**: \`"$var"\`, \`"$@"\`, \`"$(cmd)"\`. Unquoted expansions split on whitespace and glob — the classic "works until a path has a space".
- \`[[ … ]]\` over \`[ … ]\` (no word-splitting, supports \`==\` globs and \`=~\` regex).
- \`local\` for function variables; \`readonly\` for constants.
- Temp files: \`t=$(mktemp)\` + \`trap 'rm -f "$t"' EXIT\` — cleanup that survives errors.
- Check commands exist: \`command -v jq >/dev/null || { echo "jq required" >&2; exit 1; }\`.
- **shellcheck** catches nearly all of this — run it on every script you write.

## When to stop using bash
More than ~100 lines, needs arrays-of-objects, JSON manipulation beyond \`jq\`, or error handling with retries → switch to Python or Node; the script will be shorter *and* safer.

## Related
- [[Python Environment Setup]]
- [[Git Recovery Commands]]`,
  },
  {
    title: 'AIOS Architecture Primer', folder: 'AIOS', tags: ['aios', 'architecture'],
    content: `**AIOS is a zero-build personal AI hub: plain ESM on both sides, an Express + WebSocket server on port 7777, and a web shell of page-views (not windows).**

## Layout
- \`server/\` — one module per concern: \`llm.js\` (provider abstraction, \`provider:model\` refs, streaming + reasoning split), \`agent.js\` (tool loop + approval gate), \`tools.js\` (tool belt; path-confined to the project root), \`vault.js\`/\`wiki.js\` (second brain), \`research.js\`, \`learn.js\`/\`learndb.js\` (Learning Corner), \`bench.js\`/\`router.js\` (model benchmarking + auto-routing), \`toolforge.js\` (AI-forged custom tools), \`config.js\` (data/config.json, deep-merged defaults).
- \`web/js/apps/*.js\` — one file per app, mounted once by \`wm.js\`; \`web/css/apps.css\` styles them.
- No bundler, no TypeScript, no framework: verify changes with \`npm run check\` (esbuild parse + bundle dry-run).

## Conventions that matter
- Everything the agent writes is approval-gated except \`.aios/\` project memory and (by default) wiki upkeep.
- Providers must all work — features use plain prompts over \`streamChat\`, never provider-specific APIs.
- Long-running work (research) streams over WS topics and persists under \`data/\` so a refresh never loses state.
- Local models are small: budget prompts with \`contextBudget()\`, keep tool output truncated.

## Related
- [[Node ESM Gotchas]]
- [[Wiki Guide]]`,
  },
];

// The typed-note system: a guide note + one template note per kind, straight from
// the NOTE_KINDS registry so Meta/Templates never drifts from what the tools serve.
const kindTitle = (k) => k === 'howto' ? 'How-To' : k[0].toUpperCase() + k.slice(1);
NOTES.push({
  title: 'Note System', folder: 'Meta', tags: ['meta'],
  content: `**Every durable note in this wiki is one of seven typed kinds, each with a fixed template — typed notes stay scannable, recall packs them efficiently, and human + agent can co-maintain them without style drift.**

## The kinds
${Object.entries(NOTE_KINDS).map(([k, v]) => `- **${k}** — ${v.what} → [[Template — ${kindTitle(k)}]]`).join('\n')}

## Rules of thumb
- Pick the kind BEFORE writing; if a note wants to be two kinds, it is two notes.
- Definition-first bold line, concrete facts, ≥2 [[links]] in a closing Related section.
- The agent gets templates via the \`note_template\` tool and stamps \`type:\` frontmatter through \`wiki_learn {kind}\`; the full quality bar lives in the \`notes\` skill.
- Templates live under Meta/Templates — copy their structure, never fill them in.

## Related
- [[Wiki Guide]]`,
});
for (const [k, v] of Object.entries(NOTE_KINDS)) {
  NOTES.push({
    title: `Template — ${kindTitle(k)}`, folder: 'Meta/Templates', tags: ['meta', 'template'], kind: k,
    content: `**Canonical scaffold for a \`${k}\` note — ${v.what}. Copy the structure; keep the section names.**\n\n\`\`\`markdown\n${v.template}\n\`\`\`\n\n## Related\n- [[Note System]]`,
  });
}

let created = 0, updated = 0;
for (const n of NOTES) {
  const r = upsertNote({ ...n, source: 'starter pack' });
  r.created ? created++ : updated++;
  console.log(`${r.created ? '+ created' : '~ updated'} ${r.path}${r.linked.length ? `  (autolinked: ${r.linked.join(', ')})` : ''}`);
}
const idx = rebuildIndex();
console.log(`\n✓ ${created} created, ${updated} updated · Home index rebuilt (${idx.notes} notes${idx.orphans ? `, ${idx.orphans} orphans` : ''}) → ${idx.path}`);
