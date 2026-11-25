export interface Batch {
  done: number;
  error?: unknown;
}

interface Options {
  /** Browsers open 6 connections per host, more would just queue. */
  atOnce?: number;
  signal?: AbortSignal;
  onProgress?: (done: number) => void;
}

/**
 * Calls `send` count times, a few at a time. Stops at the first failure and
 * never retries: a retry after a lost answer could store a job twice.
 */
export async function sendAll(
  count: number,
  send: (index: number) => Promise<void>,
  { atOnce = 6, signal, onProgress }: Options = {},
): Promise<Batch> {
  const batch: Batch = { done: 0 };
  let next = 0;

  async function lane() {
    while (next < count && !("error" in batch) && !signal?.aborted) {
      try {
        await send(next++);
        batch.done += 1;
        onProgress?.(batch.done);
      } catch (err) {
        if (signal?.aborted) return; // stopped by the caller, not by the API
        if (!("error" in batch)) batch.error = err;
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(atOnce, count) }, lane));
  return batch;
}
