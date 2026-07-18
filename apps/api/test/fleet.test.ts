import { describe, test, expect } from "bun:test";
import { percentile, computeStats, computeQueueView } from "../src/fleet";
import type { CompletionRecord, JobSpec } from "@mill/queue";

const NOW = 1_700_000_000_000;
const rec = (over: Partial<CompletionRecord> = {}): CompletionRecord => ({ w: "wf", ok: 1, d: 100, wait: 10, t: NOW, ...over });

describe("percentile (nearest-rank)", () => {
  test("empty set → 0", () => expect(percentile([], 50)).toBe(0));
  test("p50 / p95 over a known set", () => {
    const vals = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
    expect(percentile(vals, 50)).toBe(60);
    expect(percentile(vals, 95)).toBe(100);
    expect(percentile(vals, 0)).toBe(10);
  });
  test("is order-independent", () => {
    expect(percentile([100, 10, 50, 30], 50)).toBe(percentile([10, 30, 50, 100], 50));
  });
});

describe("computeStats", () => {
  test("empty window → zeros but 100% success and no NaN", () => {
    const s = computeStats([], NOW);
    expect(s.completedLastHour).toBe(0);
    expect(s.failedLastHour).toBe(0);
    expect(s.successRatePct).toBe(100);
    expect(s.p50Ms).toBe(0);
    expect(s.avgWaitMs).toBe(0);
    expect(s.throughputTrend).toHaveLength(12);
    expect(s.throughputTrend.every((n) => n === 0)).toBe(true);
  });

  test("success rate, avg wait, and count", () => {
    const window = [rec({ ok: 1, wait: 100 }), rec({ ok: 0, wait: 200 }), rec({ ok: 1, wait: 300 }), rec({ ok: 1, wait: 400 })];
    const s = computeStats(window, NOW);
    expect(s.completedLastHour).toBe(4);
    expect(s.failedLastHour).toBe(1); // one ok:0 in the window
    expect(s.successRatePct).toBe(75); // 3/4
    expect(s.avgWaitMs).toBe(250); // (100+200+300+400)/4
  });

  test("throughput trend buckets by minute, newest last", () => {
    const window = [
      rec({ t: NOW - 30_000 }), // this minute (bucket 11)
      rec({ t: NOW - 90_000 }), // 1 min ago (bucket 10)
      rec({ t: NOW - 90_000 }),
      rec({ t: NOW - 11 * 60_000 - 5_000 }), // 11 min ago (bucket 0)
      rec({ t: NOW - 30 * 60_000 }), // outside 12-min window → ignored in trend
    ];
    const s = computeStats(window, NOW);
    expect(s.throughputTrend[11]).toBe(1);
    expect(s.throughputTrend[10]).toBe(2);
    expect(s.throughputTrend[0]).toBe(1);
    expect(s.throughputTrend.reduce((a, b) => a + b, 0)).toBe(4); // the 30-min-old one is excluded
    expect(s.completedLastHour).toBe(5); // but still counted in the hour window
  });
});

describe("computeQueueView", () => {
  const spec = (workflow: string): JobSpec => ({ id: "x", projectDir: "/p", workflow, input: {} });

  test("empty queue → zero wait, no rows", () => {
    const v = computeQueueView([], 0, 0, NOW);
    expect(v.depth).toBe(0);
    expect(v.oldestWaitMs).toBe(0);
    expect(v.byWorkflow).toEqual([]);
  });

  test("groups by workflow, sorted by count desc", () => {
    const queued = [spec("a"), spec("b"), spec("a"), spec("a"), spec("b")];
    const v = computeQueueView(queued, 5, NOW - 4000, NOW);
    expect(v.byWorkflow).toEqual([{ workflow: "a", count: 3 }, { workflow: "b", count: 2 }]);
    expect(v.oldestWaitMs).toBe(4000);
  });
});
