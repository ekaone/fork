# @ekaone/fork

> A standalone, zero-dependency primitive for **parallel exploration + selection**. A generic decision-making pattern.

[![npm version](https://img.shields.io/npm/v/@ekaone/fork.svg)](https://www.npmjs.com/package/@ekaone/fork)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.0+-blue.svg)](https://www.typescriptlang.org/)

## What it is

`@ekaone/fork` captures one reusable pattern in a tiny, zero-dependency package:

1. Take a state
2. Generate **N parallel branches**
3. Run each (you define what "running" means)
4. **Score** them with a selection strategy
5. Pick a **winner** - break ties deterministically

It's deliberately orthogonal to anything else. `run` is a **callback** - fork doesn't
know or care what a branch *is*. That makes it useful for:

- **Diagnosis / reasoning** - explore competing [hypotheses](https://en.wikipedia.org/wiki/Hypothesis), pick the one that explains the facts
- **LLM pipelines** - generate N completions, select the best
- **Task pipelines** - fork a task into parallel approaches, keep the winning result
- **Any stateful process** - A/B branching with a measurable outcome

It fits the `@ekaone/` family of small, composable, zero-dependency primitives:

```
@ekaone/agent-relay   task pipelines
@ekaone/n-agent       conversation loops
@ekaone/fork          parallel exploration + decision
```

---

## Install

```bash
npm install @ekaone/fork
```

```bash
pnpm add @ekaone/fork
```

```bash
yarn add @ekaone/fork
```

---

## Quick Start

```ts
import { createFork } from '@ekaone/fork'

const fork = createFork({
  branches: [
    { label: 'diabetes', text: 'high glucose and frequent thirst' },
    { label: 'cushings', text: 'high glucose, thirst, and moon face' },
  ],
  // You decide what "running a branch" means.
  run: async (branch) => branch.text,
  // Score by how many known facts each branch explains.
  selection: {
    mode: 'coverage',
    facts: ['high glucose', 'thirst', 'moon face'],
  },
})

const result = await fork.explore()

console.log(result.winner.label) // 'cushings'  (explains 3/3 facts)
console.log(result.scores)       // { diabetes: 0.666…, cushings: 1 }
```

`explore()` resolves to `{ winner, verdict, scores, branches }`.

---

## Key behaviors

### Parallel execution + concurrency cap

Branches run **in parallel** by default. Pass `concurrency` to throttle - useful when
each branch is an expensive LLM call you don't want N-wide all at once.

```ts
const result = await createFork({
  branches,
  run,
  selection,
  concurrency: 2,        // at most 2 branches in flight at a time
  signal: ac.signal,     // optional AbortSignal - aborting stops scheduling
}).explore()
```

A branch that throws becomes a **`rejected`** result instead of crashing the run -
the other branches keep going and are still scored. If *every* branch fails,
`explore()` throws.

### Pluggable selection

The selection strategy is **your decision**, not locked to built-ins. Use a built-in
mode, or supply your own function. The two rule-based modes (`coverage`, `confidence`)
are pure and zero-dependency; the "intelligent" modes (`judge`, `human`) are callbacks
**you** provide - keeping the package free of any runtime dependency.

| Mode | How it works | Deps | Best for |
|---|---|---|---|
| `coverage` | Score by how many known facts each branch's text contains | zero-dep ✅ | diagnosis ("explains all symptoms" is measurable) |
| `confidence` | Parse self-reported `[CONFIDENCE: 0.0–1.0]` tokens, aggregate | zero-dep ✅ | quick triage |
| `judge` | A callback (e.g. an LLM) reads all branches and picks a winner | callback ⚠️ | qualitative / nuanced |
| `human` | Present branches, a human picks | callback (UI) | high-stakes accountability |
| `custom` | Your own scoring function | zero-dep ✅ | anything |

```ts
// Built-in rule-based
selection: { mode: 'coverage',   facts: ['fever', 'cough'] }
selection: { mode: 'confidence', aggregate: 'mean' }   // 'mean' | 'max' | 'last'

// Caller-supplied intelligence
selection: { mode: 'judge', judge: async (branches) => ({ winner: 'b', reasoning: '…' }) }
selection: { mode: 'human', onPresent: async (branches) => promptUser(branches) }

// Full control - object form…
selection: { mode: 'custom', select: (branches) => ({ winner: pick(branches) }) }
// …or bare-function sugar (identical behavior)
selection: (branches) => ({ winner: pick(branches) })
```

For non-string output, rule-based modes take an optional `extract` (defaults to `String(output)`):

```ts
run: (b) => ({ symptoms: b.facts }),
selection: {
  mode: 'coverage',
  facts: ['fever', 'cough'],
  extract: (o) => o.symptoms.join(' '),
}
```

### Tie-breaking

When the top score is shared, `onTie` decides what happens. It accepts a fallback
**strategy chain**, so you can filter cheaply first and only escalate when needed.

```ts
onTie: 'first'   // pick the first tied branch by input order (default)
onTie: 'error'   // throw a descriptive error
onTie: { mode: 'judge', judge }   // re-run selection over only the tied branches
```

A defensible layered pattern (e.g. for diagnosis): objective filter first, judgment
only on ties - never let raw confidence be the sole arbiter.

```ts
selection: { mode: 'coverage', facts: [...] },  // 1. rule-based filter
onTie:     { mode: 'judge', judge },            // 2. break remaining ties
// 3. human sign-off before acting (your call, outside fork)
```

### Guardrails

`createFork` validates **before** running anything and throws on:

- an empty `branches` array
- duplicate branch `label`s
- `concurrency` below `1`

At run time, `explore()` throws if every branch fails, or if a custom strategy returns
an unknown winner label.

### Nested forking

A branch's `run` can itself call `createFork().explore()` - nesting works naturally,
since each fork is fully self-contained.

---

## API

### `createFork(config)`

Creates a fork. Returns a handle with a single `explore()` method.

```ts
const fork = createFork<T, B>({
  branches,        // B[] - each branch extends { label: string }; carries your own data
  run,             // (branch: B) => T | Promise<T>   - what "running a branch" means
  selection,       // SelectionStrategy<T, B>
  onTie,           // 'first' | 'error' | SelectionStrategy<T, B>   (default 'first')
  concurrency,     // number - omit for unbounded (all in parallel)
  signal,          // optional AbortSignal
})
```

**`ForkConfig` fields**

| Field | Type | Description |
|---|---|---|
| `branches` | `B[]` | Non-empty list of branches with unique `label`s. Carry any extra data you need. |
| `run` | `(branch: B) => T \| Promise<T>` | Caller-defined executor. Its return value becomes the branch output. |
| `selection` | `SelectionStrategy<T, B>` | How to score branches and pick a winner. |
| `onTie` | `'first' \| 'error' \| SelectionStrategy<T, B>` | Tie behavior. Default `'first'`. |
| `concurrency` | `number` | Max branches running at once. **Omit for unbounded** (all in parallel). Don't pass `Infinity` — just leave it out. |
| `signal` | `AbortSignal` | Aborting stops scheduling further branches; `explore()` rejects. |

---

### `fork.explore()`

Runs all branches, scores them, breaks ties, and resolves to a `ForkResult`.

```ts
const { winner, verdict, scores, branches } = await fork.explore()
```

| Field | Type | Description |
|---|---|---|
| `winner` | `BranchResult<T, B>` | The winning branch's result (never a failed branch). |
| `verdict` | `Verdict` | The full decision: winner, optional reasoning, scores, tie flag. |
| `scores` | `Record<string, number>` | Per-branch scores keyed by label (empty for non-scoring strategies). |
| `branches` | `BranchResult<T, B>[]` | Every branch result, in input order. |

---

### Types

```ts
interface Branch {
  label: string                  // unique; extend with your own fields
}

interface BranchResult<T, B = Branch> {
  label: string
  branch: B
  status: 'fulfilled' | 'rejected'
  output?: T                     // present when fulfilled
  error?: Error                  // present when rejected
  score?: number                 // set by rule-based strategies
  durationMs: number
}

interface Verdict {
  winner: string
  reasoning?: string
  scores?: Record<string, number>
  tie?: boolean
}

type SelectionFn<T, B = Branch> =
  (results: BranchResult<T, B>[]) => Verdict | Promise<Verdict>

type SelectionStrategy<T, B = Branch> =
  | { mode: 'coverage';   facts: string[]; extract?: (o: T) => string }
  | { mode: 'confidence'; aggregate?: 'mean' | 'max' | 'last'; extract?: (o: T) => string }
  | { mode: 'judge';      judge: SelectionFn<T, B> }
  | { mode: 'human';      onPresent: (results: BranchResult<T, B>[]) => string | Verdict | Promise<string | Verdict> }
  | { mode: 'custom';     select: SelectionFn<T, B> }
  | SelectionFn<T, B>            // bare-function sugar for `custom`
```

---

### Exposed helpers

The scoring and selection internals are exported too, in case you want to compose them:

| Export | Description |
|---|---|
| `scoreCoverage(results, facts, extract?)` | Per-branch coverage scores. |
| `scoreConfidence(results, aggregate?, extract?)` | Per-branch confidence scores. |
| `resolveSelection(strategy, results)` | Normalize any strategy into a `Verdict`. |
| `breakTie(verdict, results, onTie)` | Apply a tie-breaker to a verdict. |
| `runPool(items, worker, options)` | The zero-dep concurrency pool used by `explore()`. |

---

## License

MIT © [Eka Prasetia](./LICENSE)

## Links

- [npm Package](https://www.npmjs.com/package/@ekaone/fork)
- [GitHub Repository](https://github.com/ekaone/fork)
- [Issue Tracker](https://github.com/ekaone/fork/issues)

---

⭐ If this library helps you, please consider giving it a star on GitHub!
