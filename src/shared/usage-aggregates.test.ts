import { describe, expect, it } from "vitest";
import {
  buildUsageAggregateTail,
  mergeUsageDailyLatency,
  mergeUsageLatency,
} from "./usage-aggregates.js";

describe("shared/usage-aggregates", () => {
  it("merges latency totals and ignores empty inputs", () => {
    const totals = {
      count: 1,
      sum: 100,
      min: 100,
      max: 100,
      p95Max: 100,
    };

    mergeUsageLatency(totals, undefined);
    mergeUsageLatency(totals, {
      count: 0,
      avgMs: 999,
      minMs: 1,
      maxMs: 999,
      p95Ms: 999,
    });
    mergeUsageLatency(totals, {
      count: 2,
      avgMs: 50,
      minMs: 20,
      maxMs: 90,
      p95Ms: 80,
    });

    expect(totals).toEqual({
      count: 3,
      sum: 200,
      min: 20,
      max: 100,
      p95Max: 100,
    });
  });

  it("merges daily latency by date and computes aggregate tail sorting", () => {
    const dailyLatencyMap = new Map<
      string,
      {
        date: string;
        count: number;
        sum: number;
        min: number;
        max: number;
        p95Max: number;
      }
    >();

    mergeUsageDailyLatency(dailyLatencyMap, [
      { date: "2026-03-12", count: 2, avgMs: 50, minMs: 20, maxMs: 90, p95Ms: 80 },
      { date: "2026-03-12", count: 1, avgMs: 120, minMs: 120, maxMs: 120, p95Ms: 120 },
      { date: "2026-03-11", count: 1, avgMs: 30, minMs: 30, maxMs: 30, p95Ms: 30 },
    ]);
    mergeUsageDailyLatency(dailyLatencyMap, null);

    const tail = buildUsageAggregateTail({
      byChannelMap: new Map([
        ["discord", { totalCost: 4 }],
        ["telegram", { totalCost: 8 }],
      ]),
      latencyTotals: {
        count: 3,
        sum: 200,
        min: 20,
        max: 120,
        p95Max: 120,
      },
      dailyLatencyMap,
      modelDailyMap: new Map([
        ["b", { date: "2026-03-12", cost: 1 }],
        ["a", { date: "2026-03-12", cost: 2 }],
        ["c", { date: "2026-03-11", cost: 9 }],
      ]),
      dailyMap: new Map([
        ["b", { date: "2026-03-12" }],
        ["a", { date: "2026-03-11" }],
      ]),
    });

    expect(tail.byChannel.map((entry) => entry.channel)).toEqual(["telegram", "discord"]);
    expect(tail.latency).toEqual({
      count: 3,
      avgMs: 200 / 3,
      minMs: 20,
      maxMs: 120,
      p95Ms: 120,
    });
    expect(tail.dailyLatency).toEqual([
      { date: "2026-03-11", count: 1, avgMs: 30, minMs: 30, maxMs: 30, p95Ms: 30 },
      { date: "2026-03-12", count: 3, avgMs: 220 / 3, minMs: 20, maxMs: 120, p95Ms: 120 },
    ]);
    expect(tail.modelDaily).toEqual([
      { date: "2026-03-11", cost: 9 },
      { date: "2026-03-12", cost: 2 },
      { date: "2026-03-12", cost: 1 },
    ]);
    expect(tail.daily).toEqual([{ date: "2026-03-11" }, { date: "2026-03-12" }]);
  });

  it("omits latency when no requests were counted", () => {
    const tail = buildUsageAggregateTail({
      byChannelMap: new Map(),
      latencyTotals: {
        count: 0,
        sum: 0,
        min: Number.POSITIVE_INFINITY,
        max: 0,
        p95Max: 0,
      },
      dailyLatencyMap: new Map(),
      modelDailyMap: new Map(),
      dailyMap: new Map(),
    });

    expect(tail.latency).toBeUndefined();
    expect(tail.dailyLatency).toStrictEqual([]);
  });

  it("normalizes zero-count daily latency entries to zero averages and mins", () => {
    const dailyLatencyMap = new Map([
      [
        "2026-03-12",
        {
          date: "2026-03-12",
          count: 0,
          sum: 0,
          min: Number.POSITIVE_INFINITY,
          max: 0,
          p95Max: 0,
        },
      ],
    ]);

    const tail = buildUsageAggregateTail({
      byChannelMap: new Map(),
      latencyTotals: {
        count: 0,
        sum: 0,
        min: Number.POSITIVE_INFINITY,
        max: 0,
        p95Max: 0,
      },
      dailyLatencyMap,
      modelDailyMap: new Map(),
      dailyMap: new Map(),
    });

    expect(tail.dailyLatency).toEqual([
      { date: "2026-03-12", count: 0, avgMs: 0, minMs: 0, maxMs: 0, p95Ms: 0 },
    ]);
  });
});
