/**
 * @file strategies.ts
 * @description Built-in rule-based selection strategies (coverage, confidence) plus
 * the normalization layer that turns any {@link SelectionStrategy} into a {@link Verdict},
 * and the tie-breaking logic.
 *
 * The "intelligent" strategies (judge, human) are caller-supplied callbacks — this
 * file only owns orchestration and the zero-dependency rule-based scoring, keeping
 * @ekaone/fork free of runtime dependencies.
 */

import type {
  Branch,
  BranchResult,
  ConfidenceAggregate,
  SelectionFn,
  SelectionStrategy,
  TieBreaker,
  Verdict,
} from "./types.js";

const EPSILON = 1e-9;

/** Matches self-reported `[CONFIDENCE: 0.87]` tokens (case-insensitive). */
const CONFIDENCE_RE = /\[\s*confidence\s*:\s*([01](?:\.\d+)?|\.\d+)\s*\]/gi;

function isSelectionFn<T, B extends Branch>(
  strategy: SelectionStrategy<T, B>,
): strategy is SelectionFn<T, B> {
  return typeof strategy === "function";
}

function defaultExtract<T>(output: T): string {
  return String(output);
}

function clamp01(n: number): number {
  return Math.min(1, Math.max(0, n));
}

/** Find the top score among `eligible` labels and every label within EPSILON of it. */
function rank(
  scores: Record<string, number>,
  eligible: string[],
): { max: number; topLabels: string[] } {
  let max = -Infinity;
  for (const label of eligible) {
    const v = scores[label] ?? 0;
    if (v > max) max = v;
  }
  const topLabels = eligible.filter(
    (l) => Math.abs((scores[l] ?? 0) - max) <= EPSILON,
  );
  return { max, topLabels };
}

function fulfilledLabels<T, B extends Branch>(
  results: BranchResult<T, B>[],
): string[] {
  return results.filter((r) => r.status === "fulfilled").map((r) => r.label);
}

/** Score each branch by how many `facts` appear in its output text. */
export function scoreCoverage<T, B extends Branch>(
  results: BranchResult<T, B>[],
  facts: string[],
  extract: (output: T) => string = defaultExtract,
): Record<string, number> {
  const scores: Record<string, number> = {};
  const needles = facts.map((f) => f.toLowerCase());
  for (const r of results) {
    if (r.status !== "fulfilled" || needles.length === 0) {
      scores[r.label] = 0;
      continue;
    }
    const text = extract(r.output as T).toLowerCase();
    let matched = 0;
    for (const needle of needles) if (text.includes(needle)) matched++;
    scores[r.label] = matched / needles.length;
  }
  return scores;
}

function aggregateConfidence(
  values: number[],
  aggregate: ConfidenceAggregate,
): number {
  if (values.length === 0) return 0;
  switch (aggregate) {
    case "max":
      return Math.max(...values);
    case "last":
      return values[values.length - 1] as number;
    case "mean":
      return values.reduce((a, b) => a + b, 0) / values.length;
  }
}

/** Score each branch by parsing and aggregating self-reported confidence tokens. */
export function scoreConfidence<T, B extends Branch>(
  results: BranchResult<T, B>[],
  aggregate: ConfidenceAggregate = "mean",
  extract: (output: T) => string = defaultExtract,
): Record<string, number> {
  const scores: Record<string, number> = {};
  for (const r of results) {
    if (r.status !== "fulfilled") {
      scores[r.label] = 0;
      continue;
    }
    const text = extract(r.output as T);
    const values: number[] = [];
    for (const match of text.matchAll(CONFIDENCE_RE)) {
      const n = Number(match[1]);
      if (!Number.isNaN(n)) values.push(clamp01(n));
    }
    scores[r.label] = aggregateConfidence(values, aggregate);
  }
  return scores;
}

/** Normalize any selection strategy into a concrete {@link Verdict}. */
export async function resolveSelection<T, B extends Branch>(
  strategy: SelectionStrategy<T, B>,
  results: BranchResult<T, B>[],
): Promise<Verdict> {
  if (isSelectionFn(strategy)) return strategy(results);

  switch (strategy.mode) {
    case "coverage": {
      const scores = scoreCoverage(results, strategy.facts, strategy.extract);
      const { topLabels } = rank(scores, fulfilledLabels(results));
      return { winner: topLabels[0] as string, scores, tie: topLabels.length > 1 };
    }
    case "confidence": {
      const scores = scoreConfidence(
        results,
        strategy.aggregate,
        strategy.extract,
      );
      const { topLabels } = rank(scores, fulfilledLabels(results));
      return { winner: topLabels[0] as string, scores, tie: topLabels.length > 1 };
    }
    case "judge":
      return strategy.judge(results);
    case "custom":
      return strategy.select(results);
    case "human": {
      const choice = await strategy.onPresent(results);
      return typeof choice === "string" ? { winner: choice } : choice;
    }
  }
}

function tiedLabelsOf<T, B extends Branch>(
  verdict: Verdict,
  results: BranchResult<T, B>[],
): string[] {
  const eligible = fulfilledLabels(results);
  if (!verdict.scores) return eligible;
  return rank(verdict.scores, eligible).topLabels;
}

/**
 * Resolve a tie according to `onTie`:
 * - `'first'` — first tied branch by input order
 * - `'error'` — throw
 * - a {@link SelectionStrategy} — re-run selection over only the tied branches
 */
export async function breakTie<T, B extends Branch>(
  verdict: Verdict,
  results: BranchResult<T, B>[],
  onTie: TieBreaker<T, B>,
): Promise<Verdict> {
  const labels = tiedLabelsOf(verdict, results);
  const tied = results.filter((r) => labels.includes(r.label));

  if (onTie === "first") {
    return { ...verdict, winner: (tied[0]?.label ?? verdict.winner), tie: false };
  }
  if (onTie === "error") {
    throw new Error(
      `Selection tied between: ${labels.join(", ")}. Provide an onTie strategy to resolve.`,
    );
  }

  const resolved = await resolveSelection(onTie, tied);
  return { ...resolved, tie: resolved.tie ?? false };
}
