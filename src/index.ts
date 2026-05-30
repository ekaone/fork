/**
 * @file index.ts
 * @description Core entry point for @ekaone/fork
 * @website https://prasetia.me
 * @license MIT
 */

export { createFork } from "./fork.js";
export {
  scoreCoverage,
  scoreConfidence,
  resolveSelection,
  breakTie,
} from "./strategies.js";
export { runPool, type PoolOptions } from "./pool.js";

export type {
  Branch,
  BranchResult,
  Verdict,
  SelectionFn,
  SelectionStrategy,
  ConfidenceAggregate,
  TieBreaker,
  ForkConfig,
  ForkResult,
  ForkHandle,
} from "./types.js";
