/**
 * Applies `worker` to every item with at most `limit` running at once, and
 * returns the results in input order.
 *
 * Exists because awaiting per item inside a loop turns a listing of N objects
 * into N serial round trips to object storage — the dominant cost of starting
 * a sandbox job that inherits a large session.
 */
export async function mapWithConcurrency<TItem, TResult>(
  items: readonly TItem[],
  limit: number,
  worker: (item: TItem, index: number) => Promise<TResult> | TResult,
): Promise<TResult[]> {
  const results = new Array<TResult>(items.length);
  if (items.length === 0) return results;

  let next = 0;
  const lanes = Math.max(1, Math.min(limit, items.length));
  await Promise.all(
    Array.from({ length: lanes }, async () => {
      while (next < items.length) {
        const index = next++;
        results[index] = await worker(items[index], index);
      }
    }),
  );
  return results;
}
