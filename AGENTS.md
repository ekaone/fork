# AGENTS.md

This file provides guidance to Codex or Claude Code when working with code in this repository.

## What this package is

`@ekaone/fork` is a standalone, **zero-runtime-dependency** TypeScript primitive for **parallel exploration + selection**: take N branches, run each (caller-defined), score them with a pluggable strategy, pick a winner, break ties. It is one of three orthogonal `@ekaone/` primitives (`agent-relay` = task pipelines, `n-agent` = conversation loops, `fork` = parallel exploration + decision). `fork-plan.md` holds the original design notes and rationale.

The **zero-dependency discipline is the core constraint**: any strategy needing "intelligence" (LLM judging, human input) must be a caller-supplied callback. The package itself owns only orchestration and rule-based scoring (`coverage`, `confidence`). Do not add runtime dependencies.

## Commands

```bash
pnpm install            # uses pnpm; esbuild build script is intentionally not approved (vitest/tsup bundle their own)
pnpm test               # vitest run — full suite
pnpm test:watch         # vitest watch mode
pnpm test -- -t "coverage strategy"   # run a single test/describe by name
pnpm typecheck          # tsc --noEmit under strict flags
pnpm build              # typecheck → clean → tsup (emits ESM + CJS + .d.ts/.d.cts to dist/)
```

CI (`.github/workflows/ci.yml`) runs typecheck + test + build on Node 24. Release (`release.yml`) publishes to npm via OIDC trusted publishing + provenance, triggered by pushing a `v*` tag.

## Architecture

The data flows in one direction through four small modules in `src/`, each re-exported from `src/index.ts`:

```
createFork(config)  →  runPool (execute branches)  →  resolveSelection (score → Verdict)  →  breakTie (if tie)  →  ForkResult
```

- **`types.ts`** — the public contract. The central polymorphic type is `SelectionStrategy<T, B>`: a discriminated union (`coverage` | `confidence` | `judge` | `human` | `custom`) **plus** a bare `SelectionFn` as sugar. Understanding this union is key — most logic branches on it.
- **`pool.ts`** — `runPool`, a generic zero-dep concurrency pool. Order-preserving, caps in-flight workers at `concurrency`, and races worker completion against an `AbortSignal`. It does **not** know about branches or errors — the worker passed by `fork.ts` is what captures per-branch errors into a `BranchResult`.
- **`strategies.ts`** — rule-based scoring (`scoreCoverage`, `scoreConfidence`) plus the two normalization functions: `resolveSelection` (turns any strategy, including bare fn, into a `Verdict`) and `breakTie`. Built-in modes compute scores and only consider **fulfilled** branches as winner candidates; `judge`/`human`/`custom` are trusted callbacks.
- **`fork.ts`** — `createFork`: synchronous up-front validation (non-empty branches, unique labels, `concurrency >= 1`), then `explore()` orchestrates pool → resolve → tie-break → assemble `ForkResult`.

### Invariants to preserve when editing

- A **rejected** branch (its `run` threw) can never be the winner. One branch failing must not crash the run; if *all* fail, `explore()` throws.
- `BranchResult.branch` is a **reference**, not a clone — never deep-copy it.
- Tie-breaking preserves the **primary** strategy's scores for transparency even when a fallback strategy (e.g. a judge) produces the final winner — see `mergeVerdict` in `fork.ts`.
- `concurrency` defaults to `Infinity` **internally only** (`config.concurrency ?? Infinity`). Never document `Infinity` as a value users should pass; the public contract is "omit for unbounded."

## Conventions

- TypeScript is strict with `exactOptionalPropertyTypes` + `noUncheckedIndexedAccess`. Build optional-property objects via conditional spreads or guarded assignment (never assign `undefined` to an optional field); index access returns `T | undefined`, so narrow before use.
- `moduleResolution` is NodeNext: **relative imports must use the `.js` extension** (e.g. `import { runPool } from "./pool.js"`), including in `tests/`.
- Tests live in `tests/test.ts` (single file). `vitest.config.ts` sets `include: ["tests/**/*.ts"]` because the filename does not match Vitest's default `*.test.ts` pattern — keep that include if adding test files, or name them to match.
- `src/` is the build root (`tsconfig` excludes `tests`); only `src/index.ts` is a tsup entry.
