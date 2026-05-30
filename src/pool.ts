/**
 * @file pool.ts
 * @description Zero-dependency async concurrency pool. Runs at most `concurrency`
 * workers at once, preserves input order in the output, and supports cancellation
 * via an AbortSignal. Workers are expected to capture their own errors — the pool
 * itself only rejects on abort.
 */

export interface PoolOptions {
  /** Maximum number of workers running concurrently. */
  concurrency: number;
  /** Optional cancellation signal. */
  signal?: AbortSignal;
}

function toAbortError(signal: AbortSignal): Error {
  const reason: unknown = signal.reason;
  if (reason instanceof Error) return reason;
  const err = new Error("The fork was aborted.");
  err.name = "AbortError";
  return err;
}

/**
 * Run `worker` over every item, capping concurrency. Results are returned in the
 * same order as `items`. If `signal` aborts, the returned promise rejects with an
 * AbortError (in-flight workers are abandoned, not awaited).
 */
export async function runPool<I, O>(
  items: I[],
  worker: (item: I, index: number) => Promise<O>,
  options: PoolOptions,
): Promise<O[]> {
  const { signal } = options;
  if (signal?.aborted) throw toAbortError(signal);

  const results = new Array<O>(items.length);
  if (items.length === 0) return results;

  const limit = Math.min(
    Math.max(1, Math.floor(options.concurrency)),
    items.length,
  );

  let next = 0;
  let aborted = false;

  let onAbort: (() => void) | undefined;
  const abortPromise = signal
    ? new Promise<never>((_, reject) => {
        onAbort = () => {
          aborted = true;
          reject(toAbortError(signal));
        };
        signal.addEventListener("abort", onAbort, { once: true });
      })
    : undefined;

  const runWorker = async (): Promise<void> => {
    while (next < items.length && !aborted) {
      const index = next++;
      results[index] = await worker(items[index] as I, index);
    }
  };

  const workers: Promise<void>[] = [];
  for (let i = 0; i < limit; i++) workers.push(runWorker());

  try {
    if (abortPromise) {
      await Promise.race([Promise.all(workers), abortPromise]);
    } else {
      await Promise.all(workers);
    }
  } finally {
    if (signal && onAbort) signal.removeEventListener("abort", onAbort);
  }

  return results;
}
