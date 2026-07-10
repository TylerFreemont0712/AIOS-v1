# React best practices

## Components
- Function components only. `PascalCase` names, one main component per file.
- Props: destructure in the signature `function Card({ title, onPick })`. Keep components small — extract when JSX nests more than ~3 levels or a section has its own state.
- Derive, don't store: if a value can be computed from props/state (`const total = items.length`), compute it in render. Storing derived data in state causes stale-sync bugs.
- Lift state to the closest common parent; pass callbacks down. Reach for context only for truly global things (theme, auth, current user).

## State
- `useState` for independent values; `useReducer` when several values change together.
- Never mutate: `setItems([...items, next])`, `setUser({ ...user, name })`. Mutating state is the #1 React bug.
- Updates that depend on previous state must use the function form: `setCount(c => c + 1)`.
- State updates are async — never read the state variable right after setting it and expect the new value.

## Effects — use sparingly
- `useEffect` is for synchronizing with things *outside* React: fetches, subscriptions, timers, DOM APIs. Not for reacting to state you already control.
- Always write the dependency array and include everything referenced inside. Missing deps = stale closures.
- Return a cleanup for anything you start: `return () => { controller.abort(); clearInterval(id); }`.
- Fetching in an effect: guard against unmounted updates with `AbortController` or an `ignore` flag.
- If you're "transforming data with an effect + extra state", delete it — compute during render (memoize with `useMemo` only if measurably expensive).

## Lists & keys
- `key` must be a stable id from the data (`item.id`) — never the array index when items can reorder/insert/delete.

## Events & forms
- Handlers named `handleX`, props named `onX`.
- Controlled inputs: `value={text} onChange={e => setText(e.target.value)}`.
- Don't call the handler in JSX: `onClick={() => remove(id)}` not `onClick={remove(id)}`.

## Common pitfalls
- Conditional hooks: hooks must run in the same order every render — never inside `if`/loops/early returns.
- `0 && <X/>` renders `0`: use `count > 0 && <X/>`.
- New object/array literals in props (`style={{…}}`, `options={[…]}`) defeat memoization — hoist or memo them if a child is memoized.
- Effects that set state watched by another effect → cascades; restructure into a single event handler.

## Structure & verify
- Co-locate: `Component.jsx` + styles + test next to each other.
- Follow the project's data-fetching pattern (React Query/SWR/fetch wrapper) — grep for an existing example first.
- Verify: run the dev server and exercise the changed UI, or run the component test. Check the browser console for warnings — React warnings are real bugs.
