# @ekaone/fork — Design Notes

> Carry-over notes for next chat session. Package is at concept/design stage — no code written yet.

## What it is

A standalone, zero-dependency primitive for **parallel exploration + selection**. Generic decision-making pattern:

1. Take a state
2. Generate N parallel branches
3. Run each (caller-defined)
4. Score them by a selection strategy
5. Pick a winner

Orthogonal to conversations — could be used by someone who's never heard of n-agent.

## Why a separate package

The pattern isn't conversation-specific. Applies to:
- `agent-relay` — fork a task into parallel approaches, pick best result
- standalone reasoning tools — explore solution paths
- any LLM pipeline — generate N completions, select best
- non-AI stateful processes — A/B branching

Fits the `@ekaone/` family: small, composable, zero-dep, single-responsibility.

## Ecosystem positioning

```
@ekaone/agent-relay   task pipelines
@ekaone/n-agent       conversation loops
@ekaone/fork          parallel exploration + decision
```

Three orthogonal primitives, each zero-dep, each composable.

## Core API shape (draft)

```ts
import { createFork } from '@ekaone/fork'

const fork = createFork({
  branches: [
    { label: 'diabetes', seed: '...' },
    { label: 'cushings', seed: '...' },
  ],
  run: async (branch) => { /* caller defines what running a branch means */ },
  selection: { /* see below */ },
  onTie: 'escalate' | 'human' | 'first',
})

const result = await fork.explore()
// → { winner, scores, branches }
```

Key insight: `run` is a CALLBACK. fork doesn't know what a branch *is* — caller defines it. Same pattern as the adapter design in n-agent (aiSdkAdapter is the engine plug).

## KEY DECISION FROM THIS SESSION: selection strategies must be PLUGGABLE

User wants selection strategy as an **option the user decides** — not locked to built-ins.

So `selection` should accept EITHER a built-in mode OR a custom function:

```ts
type SelectionStrategy<T> =
  | { mode: 'coverage';   facts: string[] }
  | { mode: 'confidence'; aggregate: 'mean' | 'max' | 'last' }
  | { mode: 'judge';      judge: (branches: BranchResult<T>[]) => Promise<Verdict> }
  | { mode: 'human';      onPresent: (branches: BranchResult<T>[]) => Promise<string> }
  | { mode: 'custom';     select: (branches: BranchResult<T>[]) => Verdict | Promise<Verdict> }
  // OR just allow a bare function as the escape hatch:
  | ((branches: BranchResult<T>[]) => Verdict | Promise<Verdict>)
```

The `custom` / bare-function option is the important one — full user control.

## Built-in selection strategies (the defaults to ship)

| Mode | How it works | Deps | Best for |
|---|---|---|---|
| `coverage` | Score by how many known facts each branch explains | zero-dep ✅ | diagnosis ("explains all symptoms" is measurable) |
| `confidence` | Agents self-report [CONFIDENCE: 0.0-1.0], aggregate | zero-dep ✅ | quick triage |
| `judge` | LLM reads all branches, picks winner + reasoning | callback ⚠️ | qualitative/nuanced |
| `human` | Present transcripts, human picks | callback (just UI) | high-stakes accountability (medical/legal) |
| `custom` | User supplies own scoring function | zero-dep ✅ | anything |

## ZERO-DEP DISCIPLINE (critical)

Strategies that need intelligence must be CALLBACKS the caller supplies:
- `judge` mode → judge is a caller-supplied async fn that does the LLM call
- `human` mode → onPresent is a caller-supplied callback
- fork package itself owns ONLY orchestration + rule-based strategies (coverage, confidence)

This keeps `@ekaone/fork` completely zero-dependency. Same discipline as rest of @ekaone/ family.

## Recommended layered strategy for diagnosis (example to document in README)

Two-stage filter:
1. `coverage` (rule-based) → eliminate branches that don't explain key facts
2. `judge` (if tie remains) → break ties with reasoning
3. human sign-off (always) → final accountability

```ts
selection: { mode: 'coverage', facts: [...] },
onTie:     'escalate',   // judge breaks coverage ties
// human confirms before acting
```

Defensible for medical: objective filtering first, judgment only when needed, human owns final call. Never let pure-LLM-confidence be sole arbiter.

## How n-agent consumes it

Thin adapter `@ekaone/n-agent/fork` (~15 lines) supplies the conversation runner:

```ts
import { createFork } from '@ekaone/fork'
import { forkRunner } from '@ekaone/n-agent/fork'

const result = await createFork({
  branches: [
    { label: 'diabetes', seed: 'Assume Type 2 Diabetes...' },
    { label: 'cushings', seed: "Assume Cushing's..." },
  ],
  run: forkRunner(convo),   // n-agent teaches fork how to run a conversation branch
  selection: { mode: 'coverage', facts: [...] },
}).explore()
```

n-agent owns: deep-copying conversation history (fork() = copy history by VALUE not reference,
each branch gets own MessageStore + AbortManager + loop state — already isolated, almost free architecturally).

fork owns: branch generation, parallel execution orchestration, selection, tie-breaking.

## IMPORTANT: what goes in n-agent vs fork package (clarified end of session)

Two distinct pieces on the n-agent side — don't conflate them:

| Piece | Where | Size | Required for? |
|---|---|---|---|
| `fork()` method | n-agent CORE (conversation.ts) | ~10 lines + `_seedHistory` handling | the actual snapshot mechanism — needed for ANY branching |
| `forkRunner()` | n-agent `/fork` subpath | ~15 lines | only when using @ekaone/fork |
| selection/scoring/tie-break | @ekaone/fork | the bulk | the decision engine |

KEY POINT: `fork()` belongs in n-agent core REGARDLESS of @ekaone/fork — it's a legit
standalone conversation primitive. Users can branch manually without the fork package:

```ts
const branchA = convo.fork()   // just n-agent, no fork pkg
const branchB = convo.fork()
// run + compare manually
```

@ekaone/fork only adds the SELECTION LAYER on top (scoring, judging, tie-breaking).

forkRunner is the trivial ~15-line bridge:
```ts
// @ekaone/n-agent/fork
export function forkRunner(convo: ConversationHandle) {
  return async (branch: { label: string; seed: string }) => {
    const forked = convo.fork()
    forked.send(branch.seed)
    return await forked.start()   // history → BranchResult.output
  }
}
```

Roadmap implication:
- n-agent v0.4.0 → add fork() to core (enables manual branching standalone)
- @ekaone/fork v0.1.0 → the selection engine
- @ekaone/n-agent/fork → the ~15-line bridge
- `_seedHistory` needs internal support in createConversation: skip topic-seeding, use copied history

## fork() mechanism recap (the n-agent side)

```ts
function fork(): ConversationHandle {
  const forkedStore = createMessageStore()
  for (const msg of store.all()) forkedStore.append({ ...msg })  // copy not reference
  return createConversation(bus, { ...options, _seedHistory: forkedStore })
}
```
Branches can't pollute each other or the original. Inherits history by VALUE.

## Open questions for next session

1. Bare function vs `{ mode: 'custom', select }` — which is the cleaner escape hatch? (lean: support both, bare fn is sugar)
2. Should `explore()` run branches in parallel (Promise.all) or sequential? Parallel = faster but N× cost spike. Maybe `concurrency` option.
3. What does `BranchResult<T>` carry? At minimum: `{ label, output: T, score? }`. Generic over T since run() returns anything.
4. `Verdict` shape: `{ winner: string, reasoning?: string, scores?: Record<string, number> }`
5. Should fork support nested forking (a branch that itself forks)? Probably yes naturally, but document depth limits.
6. Package name: `@ekaone/fork` vs `@ekaone/branch` vs `@ekaone/explore`. Lean `@ekaone/fork`.

## Toolchain (standard @ekaone/)

pnpm, tsup (ESM+CJS), Vitest, OIDC trusted publishing on `v*` tags. Zero runtime deps core.

## Status

- n-agent currently v0.1.1 shipped (programmatic, no UI/SSE — stays that way by design)
- n-agent v0.2.0 scaffolded: .n-agent.toml config + SQLite persistence (config/ + persistence/ dirs, 24 tests passing)
- n-agent v0.3.0 planned: consensusCheck, maxStaleTurns, onUnresolved, onConsensus, escalateTo, resolutionMode, onError