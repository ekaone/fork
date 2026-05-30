/**
 * @file fork.ts
 * @description The orchestrator. `createFork` validates config, runs branches via
 * the concurrency pool, scores them with the chosen selection strategy, breaks ties,
 * and assembles the result.
 */

import { runPool, type PoolOptions } from "./pool.js";
import { breakTie, resolveSelection } from "./strategies.js";
import type {
  Branch,
  BranchResult,
  ForkConfig,
  ForkHandle,
  ForkResult,
  Verdict,
} from "./types.js";

function asError(err: unknown): Error {
  return err instanceof Error ? err : new Error(String(err));
}

function validate<T, B extends Branch>(config: ForkConfig<T, B>): void {
  const { branches, run, selection, concurrency } = config;

  if (!Array.isArray(branches) || branches.length === 0) {
    throw new Error("createFork: `branches` must be a non-empty array.");
  }
  if (typeof run !== "function") {
    throw new Error("createFork: `run` must be a function.");
  }
  if (selection === undefined || selection === null) {
    throw new Error("createFork: `selection` strategy is required.");
  }

  const seen = new Set<string>();
  for (const branch of branches) {
    if (!branch || typeof branch.label !== "string" || branch.label.length === 0) {
      throw new Error(
        "createFork: every branch must have a non-empty string `label`.",
      );
    }
    if (seen.has(branch.label)) {
      throw new Error(
        `createFork: duplicate branch label "${branch.label}". Labels must be unique.`,
      );
    }
    seen.add(branch.label);
  }

  if (concurrency !== undefined) {
    if (typeof concurrency !== "number" || Number.isNaN(concurrency) || concurrency < 1) {
      throw new Error("createFork: `concurrency` must be a number >= 1.");
    }
  }
}

/** Take the tie-broken verdict but preserve the primary strategy's scores/reasoning when the breaker omits them. */
function mergeVerdict(broken: Verdict, primary: Verdict): Verdict {
  const scores = broken.scores ?? primary.scores;
  const reasoning = broken.reasoning ?? primary.reasoning;
  const verdict: Verdict = { winner: broken.winner, tie: false };
  if (scores !== undefined) verdict.scores = scores;
  if (reasoning !== undefined) verdict.reasoning = reasoning;
  return verdict;
}

/**
 * Create a fork: a set of branches explored in parallel and reduced to a single
 * winner by a pluggable selection strategy.
 */
export function createFork<T, B extends Branch = Branch>(
  config: ForkConfig<T, B>,
): ForkHandle<T, B> {
  validate(config);

  const explore = async (): Promise<ForkResult<T, B>> => {
    const poolOptions: PoolOptions = {
      concurrency: config.concurrency ?? Infinity,
      ...(config.signal ? { signal: config.signal } : {}),
    };

    const results = await runPool<B, BranchResult<T, B>>(
      config.branches,
      async (branch) => {
        const start = Date.now();
        try {
          const output = await config.run(branch);
          return {
            label: branch.label,
            branch,
            status: "fulfilled",
            output,
            durationMs: Date.now() - start,
          };
        } catch (err) {
          return {
            label: branch.label,
            branch,
            status: "rejected",
            error: asError(err),
            durationMs: Date.now() - start,
          };
        }
      },
      poolOptions,
    );

    if (!results.some((r) => r.status === "fulfilled")) {
      throw new Error(
        "createFork: every branch failed — no winner can be selected.",
      );
    }

    const primary = await resolveSelection(config.selection, results);
    const verdict = primary.tie
      ? mergeVerdict(
          await breakTie(primary, results, config.onTie ?? "first"),
          primary,
        )
      : primary;

    const scores = verdict.scores ?? {};
    for (const r of results) {
      const score = scores[r.label];
      if (score !== undefined) r.score = score;
    }

    const winner = results.find((r) => r.label === verdict.winner);
    if (!winner) {
      throw new Error(
        `createFork: selection returned unknown winner "${verdict.winner}".`,
      );
    }

    return { winner, verdict, scores, branches: results };
  };

  return { explore };
}
