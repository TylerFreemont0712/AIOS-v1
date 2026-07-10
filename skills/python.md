# Python best practices

## Project & environment
- Respect the project's tooling: if `pyproject.toml` exists, read it (deps, tool config, python version) before adding anything.
- Use a venv: `python3 -m venv .venv && .venv/bin/pip install …`. Never `pip install` globally.
- Run things through the venv explicitly: `.venv/bin/python`, `.venv/bin/pytest` — don't rely on `source activate` in scripts.

## Style (PEP 8, the parts that matter)
- 4-space indent; `snake_case` functions/variables; `PascalCase` classes; `UPPER_CASE` constants.
- f-strings for formatting: `f"{name}: {count}"` — never `%` or `.format()` in new code.
- Type hints on public functions: `def load(path: Path, limit: int = 10) -> list[Row]:`. Use modern builtins (`list[str]`, `dict[str, int]`, `X | None`) not `typing.List/Optional`.
- Docstring = one summary line. Only add detail when behavior is surprising.

## Idioms
- Iterate directly: `for item in items:`; use `enumerate(items)` when you need the index; `zip(a, b)` for pairs.
- Comprehensions for simple transforms, a plain loop when logic has branches.
- `pathlib.Path` over `os.path`: `Path(p).read_text()`, `path.exists()`, `path / "sub" / "file.txt"`.
- Unpack instead of indexing: `host, port = addr`.
- `dataclass` for record-like classes: `@dataclass class Config: host: str; port: int = 8080`.
- `with` for anything that opens/locks: files, connections, subprocesses.

## Pitfalls that bite every time
- Mutable default arguments: `def f(items=[])` is a bug — use `def f(items=None): items = items or []`.
- `except Exception:` swallowing errors — catch the specific exception, and never `except: pass`.
- Late-binding closures in loops: `lambda: x` inside `for x in …` captures the last value; use `lambda x=x: x`.
- Comparing with `==` to `None`/`True` — use `is None`, truthiness.
- Relative vs absolute imports breaking when run as a script: run modules with `python -m pkg.mod`.
- Encoding: always `open(p, encoding="utf-8")`.

## Errors & logging
- Raise specific exceptions with context: `raise ValueError(f"bad port: {port!r}")`.
- Only catch where you can actually handle or add information; re-raise with `raise … from err`.
- `logging.getLogger(__name__)` in libraries; plain `print` is fine in short scripts/CLIs.

## Testing
- `pytest`, files named `test_*.py`, plain `assert`.
- Test behavior through the public function, not internals. One behavior per test, named `test_<what>_<when>`.
- Parametrize repetitive cases: `@pytest.mark.parametrize("raw,expected", [...])`.
- Run the narrowest thing first: `pytest tests/test_x.py::test_case -x -q`.

## Verify
- Syntax/import check: `python -m py_compile file.py` or just run it.
- If ruff/black/mypy configs exist in the project, run them and fix what they report.
