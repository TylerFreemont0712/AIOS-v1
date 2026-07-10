# Core engineering discipline

Always follow these, in every language.

## Before changing anything
- Read the file you are about to edit. Never edit from memory of what it "probably" contains.
- Find how the codebase already does it: grep for a similar function/pattern and copy its style, naming, and error handling.
- Prefer the smallest change that solves the problem. Do not refactor, rename, or "clean up" code you were not asked to touch.

## While coding
- Match the existing style exactly: indentation, quotes, semicolons, naming convention, comment density.
- One change at a time. Make it work, verify it, then move to the next.
- Never leave placeholder code (`TODO`, `...`, `pass  # implement`) in something you claim is done.
- If you copy a block, immediately update every identifier inside it — copy-paste bugs are the #1 small-model mistake.
- Handle the error path: what happens when the file is missing, the list is empty, the network call fails, the input is malformed?

## After changing
- Verify with a command, not with confidence: run the test, run the build, run the script, curl the endpoint. Show the output.
- If a check or test fails, read the actual error message top to bottom before editing again. Fix the first error first — later errors are often cascades.
- Re-run after every fix. Never claim success without a passing run in this session.

## When stuck
- Re-read the exact error and the exact line it points to.
- Add a temporary print/log to confirm your assumption, then remove it.
- If two attempts at the same fix failed, stop and take a different approach — do not try the same edit a third time.
- Use web_search for exact error messages; prefer official docs over blog posts.

## Honesty rules
- Never invent an API, flag, or config key. If unsure it exists, check with web_search or read the installed package source.
- If you could not verify something, say so explicitly instead of implying it works.
