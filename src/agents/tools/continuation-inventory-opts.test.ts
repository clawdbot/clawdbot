import { describe, expect, it } from "vitest";
import { buildInventoryContinuationToolOpts } from "./continuation-inventory-opts.js";

describe("buildInventoryContinuationToolOpts", () => {
  it("returns no opts when continuation is disabled", () => {
    expect(buildInventoryContinuationToolOpts(false)).toEqual({});
  });

  it("returns stub continueWorkOpts + requestCompactionOpts when enabled", () => {
    const opts = buildInventoryContinuationToolOpts(true);
    expect(opts.continueWorkOpts?.requestContinuation).toBeTypeOf("function");
    expect(opts.requestCompactionOpts?.getContextUsage).toBeTypeOf("function");
    expect(opts.requestCompactionOpts?.triggerCompaction).toBeTypeOf("function");
  });

  it("stub getContextUsage returns null (no live usage on inventory paths)", () => {
    const opts = buildInventoryContinuationToolOpts(true);
    expect(opts.requestCompactionOpts?.getContextUsage()).toBeNull();
  });

  it("stub requestContinuation throws a clear error (registered-but-not-runnable; no silent success)", () => {
    const opts = buildInventoryContinuationToolOpts(true);
    expect(() => opts.continueWorkOpts?.requestContinuation()).toThrow(
      /not available in this catalog\/inventory context/,
    );
  });

  it("stub triggerCompaction resolves to an inert rejection (no compaction fires)", async () => {
    const opts = buildInventoryContinuationToolOpts(true);
    const result = await opts.requestCompactionOpts?.triggerCompaction();
    expect(result).toEqual({ ok: false, compacted: false, reason: "inventory-only path" });
  });
});
