# Shell / bash best practices

## Writing scripts
- Start with `set -euo pipefail` — exit on error, on unset vars, and on pipe failures. Debug with `bash -x`.
- Quote every expansion: `"$var"`, `"$(cmd)"`, `"$@"`. Unquoted variables are the #1 shell bug (splitting + globbing).
- `[[ ]]` for tests, `$(...)` for substitution (never backticks), `local` for function variables.
- Check tools exist before using them: `command -v jq >/dev/null || { echo "need jq"; exit 1; }`.
- Temp files via `mktemp`; clean up with `trap 'rm -f "$tmp"' EXIT`.
- Scripts should be re-runnable (idempotent): `mkdir -p`, guard against double-append, check before create.

## One-liners at the prompt
- Compose with pipes; `grep -rn` to find, `wc -l` to count, `sort | uniq -c | sort -rn` for frequencies.
- Modern flags that save pain: `grep -F` (literal), `find -print0 | xargs -0` (spaces in names), `sed -i.bak` (backup on in-place edits).
- Test destructive commands first: echo the `rm`/`mv` target list before running it for real. Never `rm -rf "$var/"` without knowing `$var` is set and sane.

## Robust patterns
- Iterate files with globs, not `ls`: `for f in *.log; do [ -e "$f" ] || continue; …; done`.
- Read lines safely: `while IFS= read -r line; do …; done < file`.
- Exit codes: `if cmd; then` (don't compare `$?` after the fact); `cmd || true` when failure is acceptable.
- Long pipelines: build incrementally, checking output at each stage before adding the next.

## Portability & safety
- `#!/usr/bin/env bash` shebang; don't assume GNU-only flags if the script must run elsewhere (macOS `sed`/`date` differ).
- Prefer absolute paths in scripts run by launchers/cron — their PATH and cwd are not your shell's.
- Verify with `bash -n script.sh` (syntax) and a dry run.
