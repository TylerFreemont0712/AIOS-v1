# Debugging method

Debugging is hypothesis testing, not guess-and-edit.

## The loop
1. **Reproduce first.** Find the smallest command/input that shows the failure. If you can't reproduce it, you can't verify a fix.
2. **Read the error, all of it.** The exception type, the message, and the *first* frame inside project code. Line numbers are evidence; "probably" is not.
3. **State one hypothesis.** "X is undefined because the config never loads" — something checkable.
4. **Check it cheaply.** One print/log at the boundary: `console.log('cfg=', cfg)` / `print(f"{cfg=}")`. Confirm or kill the hypothesis before editing logic.
5. **Fix the cause, not the symptom.** Adding `?.` or `try/except` to silence the error usually hides the real bug — ask *why* the value was bad.
6. **Re-run the reproduction.** Then remove your debug prints.

## Localizing
- Binary-search the failure: does the bad value exist at input? mid-pipeline? output? Cut the space in half each probe.
- Diff against a working state: `git diff`, `git stash` (does it work without your changes?), `git bisect` for regressions.
- Boundaries are prime suspects: serialization, env/config, timezones, encoding, path resolution, cache staleness.
- Works in isolation but fails in the app → the difference is environment: env vars, cwd, versions, async ordering.

## Classic causes checklist
- Stale build/cache/process — restart the dev server, clear cache, re-install after lockfile changes.
- Async race: something reads before the write finishes; add an await/ordering, don't add sleep.
- Off-by-one / fencepost at loop edges and slicing.
- Shadowed variable or duplicate config key silently winning.
- Wrong environment entirely (editing file A while server runs file B) — verify with a deliberate syntax error: does it even crash?

## Discipline
- Change one thing per iteration; two changes at once → you learn nothing from the result.
- Two failed attempts at the same theory = the theory is wrong. Step back, re-read code, list what you *know* vs *assume*.
- Search the exact error text (quoted) with web_search when it looks library-internal.
