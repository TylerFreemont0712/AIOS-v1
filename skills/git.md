# Git best practices

## Before touching anything
- `git status` + `git log --oneline -5` first: know the branch, what's already staged, and recent history.
- Never work directly on main/master for multi-file changes: `git switch -c fix/short-name`.
- If the tree is dirty with someone else's changes, don't mix them into your commit — stage selectively.

## Committing
- Small, coherent commits: one logical change each. Stage precisely with `git add <files>` (or `-p`), not `git add .` blindly.
- Message = imperative summary ≤ 72 chars, then a blank line, then *why* if non-obvious:
  `fix: reject empty vault path before mkdir`.
- Review your own diff before committing: `git diff --staged`. Remove debug prints, commented-out code, stray files.
- Never commit secrets, `.env`, `node_modules`, build output — check `.gitignore` covers them first.

## Undoing (choose the safe one)
- Unstage: `git restore --staged f`; discard local edits: `git restore f` (destructive — be sure).
- Amend only unpushed commits: `git commit --amend`.
- Undo a pushed commit: `git revert <sha>` (new inverse commit). Do not rewrite pushed history.
- `git reset --hard` erases work permanently — stash instead if in doubt: `git stash push -m "wip"`.

## Sync & conflicts
- `git pull --rebase` for linear history on shared branches (match the project's convention).
- Conflict markers `<<<<<<<` must never survive: resolve, re-run the tests, then `git add` + continue.
- After resolving, verify the merged result actually builds — a "clean" merge can still be semantically broken.

## Inspection (use git as a debugger)
- What changed recently here? `git log -p --follow -- path/file`.
- Who/when for a line: `git blame -L 40,60 file`.
- Find the breaking commit: `git bisect start/bad/good`.
