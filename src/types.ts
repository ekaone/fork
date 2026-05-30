/**
 * @file types.ts
 * @description Public types for @ekaone/fork — a zero-dependency primitive for
 * parallel exploration + selection.
 */

/**
 * Base branch shape. Callers extend this with whatever data their {@link ForkConfig.run}
 * needs (e.g. a `seed` prompt). The only requirement is a unique `label`.
 */
export interface Branch {
  /** Unique identifier for this branch — used as the key in scores/verdicts. */
  label: string;
}

/** Outcome of executing a single branch. */
export interface BranchResult<T, B extends Branch = Branch> {
  /** The branch's label (mirrors `branch.label` for convenience). */
  label: string;
  /**
   * The original branch definition the caller supplied. This is a **reference**,
   * not a clone — heavy data on the branch is not duplicated. Useful for custom
   * selection functions that score using branch metadata (e.g. a weight or seed).
   */
  branch: B;
  /** Whether `run` resolved (`fulfilled`) or threw (`rejected`). */
  status: "fulfilled" | "rejected";
  /** The value returned by `run`. Present only when `status === 'fulfilled'`. */
  output?: T;
  /** The error thrown by `run`. Present only when `status === 'rejected'`. */
  error?: Error;
  /** Score assigned by the selection strategy (rule-based modes set this). */
  score?: number;
  /** Wall-clock time spent running this branch, in milliseconds. */
  durationMs: number;
}

/** The decision produced by a selection strategy. */
export interface Verdict {
  /** Label of the winning branch. */
  winner: string;
  /** Optional human-readable explanation (judges/humans typically supply this). */
  reasoning?: string;
  /** Optional per-branch scores, keyed by label. */
  scores?: Record<string, number>;
  /** Set when two or more branches share the top score. Triggers `onTie`. */
  tie?: boolean;
}

/** A selection function: inspect branch results, return a verdict. */
export type SelectionFn<T, B extends Branch = Branch> = (
  results: BranchResult<T, B>[],
) => Verdict | Promise<Verdict>;

/** Aggregation method for the `confidence` strategy. */
export type ConfidenceAggregate = "mean" | "max" | "last";

/**
 * How to pick a winner. Either a built-in mode, a custom function wrapper, or —
 * as sugar — a bare {@link SelectionFn}.
 */
export type SelectionStrategy<T, B extends Branch = Branch> =
  | { mode: "coverage"; facts: string[]; extract?: (output: T) => string }
  | {
      mode: "confidence";
      aggregate?: ConfidenceAggregate;
      extract?: (output: T) => string;
    }
  | { mode: "judge"; judge: SelectionFn<T, B> }
  | {
      mode: "human";
      /**
       * Present the branches and return the decision. A bare `string` is sugar
       * for the winning label; return a full {@link Verdict} to attach reasoning
       * or scores.
       */
      onPresent: (
        results: BranchResult<T, B>[],
      ) => string | Verdict | Promise<string | Verdict>;
    }
  | { mode: "custom"; select: SelectionFn<T, B> }
  | SelectionFn<T, B>;

/**
 * What to do when the primary strategy reports a tie.
 * - `'first'` — pick the first tied branch by input order.
 * - `'error'` — throw a descriptive error.
 * - a {@link SelectionStrategy} — re-run selection over only the tied branches
 *   (e.g. break a `coverage` tie with a `judge`).
 */
export type TieBreaker<T, B extends Branch = Branch> =
  | "first"
  | "error"
  | SelectionStrategy<T, B>;

/** Configuration for {@link createFork}. */
export interface ForkConfig<T, B extends Branch = Branch> {
  /** The branches to explore. Must be non-empty with unique labels. */
  branches: B[];
  /** Caller-defined executor — decides what "running a branch" means. */
  run: (branch: B) => T | Promise<T>;
  /** How to score branches and pick a winner. */
  selection: SelectionStrategy<T, B>;
  /** Tie-breaking behaviour. Defaults to `'first'`. */
  onTie?: TieBreaker<T, B>;
  /** Max branches running at once. Defaults to `Infinity` (all in parallel). */
  concurrency?: number;
  /** Optional cancellation signal. Aborting stops scheduling further branches. */
  signal?: AbortSignal;
}

/** The result of {@link ForkHandle.explore}. */
export interface ForkResult<T, B extends Branch = Branch> {
  /** The winning branch's result. */
  winner: BranchResult<T, B>;
  /** The full verdict (winner, reasoning, scores, tie flag). */
  verdict: Verdict;
  /** Per-branch scores keyed by label (empty for strategies that don't score). */
  scores: Record<string, number>;
  /** Every branch result, in input order. */
  branches: BranchResult<T, B>[];
}

/** Handle returned by {@link createFork}. */
export interface ForkHandle<T, B extends Branch = Branch> {
  /** Run all branches, score them, and pick a winner. */
  explore: () => Promise<ForkResult<T, B>>;
}
