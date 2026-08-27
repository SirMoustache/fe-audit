/**
 * Bounded-concurrency map. Registry lookups are IO-bound, so running them all at
 * once would open hundreds of sockets and spawn hundreds of processes, while
 * running them one at a time wastes almost all of the wall clock.
 */
export const mapWithConcurrency = async <T, R>(
  items: readonly T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>
): Promise<R[]> => {
  const results = new Array<R>(items.length);
  const width = Math.max(1, Math.min(limit, items.length));
  let cursor = 0;

  const run = async (): Promise<void> => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      results[index] = await worker(items[index] as T, index);
    }
  };

  await Promise.all(Array.from({ length: width }, run));
  return results;
};
