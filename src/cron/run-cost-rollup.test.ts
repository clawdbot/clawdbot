import { describe, expect, it } from "vitest";
import {
  formatCronRunCostRollup,
  mergeCronRunCostRollups,
  rollupCronRunCost,
} from "./run-cost-rollup.js";
import type { CronRunLogEntry } from "./run-log-types.js";

function entry(partial: Partial<CronRunLogEntry>): CronRunLogEntry {
  return {
    ts: 0,
    jobId: "j",
    action: "finished",
    ...partial,
  } as CronRunLogEntry;
}

describe("rollupCronRunCost", () => {
  it("counts statuses and tokens", () => {
    const r = rollupCronRunCost([
      entry({ status: "ok", usage: { input_tokens: 100, output_tokens: 50, total_tokens: 150 } }),
      entry({ status: "error" }),
      entry({ status: "skipped", error: "precheck-no-work", summary: "precheck-no-work" }),
      entry({ status: "skipped", error: "requests-in-flight" }),
    ]);
    expect(r.totalRuns).toBe(4);
    expect(r.ok).toBe(1);
    expect(r.error).toBe(1);
    expect(r.skipped).toBe(2);
    expect(r.precheckSkipped).toBe(1);
    expect(r.totalTokens).toBe(150);
    expect(r.modelRuns).toBe(1);
    expect(r.skipRate).toBeCloseTo(0.5);
  });

  it("ignores non-finished entries and handles empty input", () => {
    const r = rollupCronRunCost([
      entry({ action: "finished", status: "ok" }),
      { ts: 1, jobId: "j", action: "queued" } as unknown as CronRunLogEntry,
    ]);
    expect(r.totalRuns).toBe(1);
    expect(rollupCronRunCost([]).skipRate).toBe(0);
  });

  it("infers total tokens from input+output when total missing", () => {
    const r = rollupCronRunCost([
      entry({ status: "ok", usage: { input_tokens: 10, output_tokens: 5 } }),
    ]);
    expect(r.totalTokens).toBe(15);
    expect(r.modelRuns).toBe(1);
  });
});

describe("mergeCronRunCostRollups", () => {
  it("sums fleet rollups and recomputes skipRate", () => {
    const a = rollupCronRunCost([entry({ status: "skipped", error: "precheck-no-work" })]);
    const b = rollupCronRunCost([entry({ status: "ok" }), entry({ status: "ok" })]);
    const merged = mergeCronRunCostRollups([a, b]);
    expect(merged.totalRuns).toBe(3);
    expect(merged.skipped).toBe(1);
    expect(merged.precheckSkipped).toBe(1);
    expect(merged.skipRate).toBeCloseTo(1 / 3);
  });
});

describe("formatCronRunCostRollup", () => {
  it("renders a compact summary line", () => {
    const line = formatCronRunCostRollup(
      rollupCronRunCost([entry({ status: "skipped", error: "precheck-no-work" })]),
    );
    expect(line).toContain("runs=1");
    expect(line).toContain("skipped=1 (100.0%)");
    expect(line).toContain("precheckSkipped=1");
  });
});
