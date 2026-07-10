# Testing best practices

## What to test
- Test behavior through the public interface — what callers observe — not private internals or implementation details.
- Priority order: core logic with branches > data transforms > error paths > integration seams. Skip trivial getters/config.
- Every bug you fix gets a test that fails before the fix and passes after. That's the highest-value test you can write.

## Writing tests
- One behavior per test. Name it after the behavior: `test_rejects_expired_token`, `renders empty state when no items`.
- Arrange–Act–Assert, visibly separated. Keep setup small; extract builders/fixtures for repeated setup.
- Assert specific values (`assert total == 42`), not vague truths (`assert result`). Assert error messages/types for failure cases.
- Table/parametrized tests for input matrices instead of copy-pasted tests.
- Test edges explicitly: empty list, one item, duplicate, unicode, zero, negative, missing key, huge input.

## Test doubles
- Fake the boundary, not the world: stub the HTTP client / clock / fs — never the function under test.
- If a test needs many mocks, the design is coupled — consider extracting a pure function instead of piling on patches.
- Freeze time and seed randomness; flaky tests are worse than no tests.

## Running (the loop that matters)
- Find the runner from the project: `package.json` scripts, `pyproject.toml`, Makefile. Use the project's runner, not your favorite.
- Run the narrowest scope while iterating (one test, `-x` stop-on-first-failure), the full suite before declaring done.
- Read failures top-down: first failure first; a red assertion message tells you expected vs actual — believe it over your mental model.
- Never mark work complete with a failing suite, and never "fix" a test by weakening its assertion unless the spec truly changed.
