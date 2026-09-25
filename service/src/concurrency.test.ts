import { describe, expect, test } from 'bun:test';
import { mapWithConcurrency } from './concurrency';

describe('mapWithConcurrency', () => {
  test('returns results in input order regardless of completion order', async () => {
    const items = [30, 5, 20, 1];
    const results = await mapWithConcurrency(items, 4, async (ms) => {
      await new Promise(resolve => setTimeout(resolve, ms));
      return ms * 2;
    });
    expect(results).toEqual([60, 10, 40, 2]);
  });

  test('never exceeds the limit', async () => {
    let running = 0;
    let peak = 0;
    await mapWithConcurrency(Array.from({ length: 40 }, (_, i) => i), 7, async () => {
      running += 1;
      peak = Math.max(peak, running);
      await new Promise(resolve => setTimeout(resolve, 2));
      running -= 1;
    });
    expect(peak).toBeLessThanOrEqual(7);
    expect(peak).toBeGreaterThan(1);
  });

  test('visits every item exactly once', async () => {
    const seen: number[] = [];
    await mapWithConcurrency(Array.from({ length: 65 }, (_, i) => i), 16, async (item) => {
      seen.push(item);
    });
    expect(seen.sort((a, b) => a - b)).toEqual(Array.from({ length: 65 }, (_, i) => i));
  });

  test('handles an empty list', async () => {
    expect(await mapWithConcurrency([], 16, async () => 1)).toEqual([]);
  });

  test('treats a non-positive limit as one at a time rather than stalling', async () => {
    expect(await mapWithConcurrency([1, 2, 3], 0, async (n) => n + 1)).toEqual([2, 3, 4]);
  });

  test('propagates a worker failure', async () => {
    await expect(
      mapWithConcurrency([1, 2, 3], 2, async (n) => {
        if (n === 2) throw new Error('stat failed');
        return n;
      }),
    ).rejects.toThrow('stat failed');
  });
});
