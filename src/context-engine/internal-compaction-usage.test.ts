import { describe, expect, it } from "vitest";
import {
  attachInternalCompactionUsage,
  getInternalCompactionUsage,
} from "./internal-compaction-usage.js";
import type { CompactResult } from "./types.js";

describe("internal compaction usage", () => {
  it("keeps usage out of the plugin-facing compact result", () => {
    const result: CompactResult = {
      ok: true,
      compacted: true,
      result: {
        summary: "summary",
        firstKeptEntryId: "entry-1",
        tokensBefore: 100,
      },
    };
    const usage = {
      input: 80,
      output: 20,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 100,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    };

    expect(getInternalCompactionUsage(result)).toBeUndefined();
    expect(attachInternalCompactionUsage(result, usage)).toBe(result);
    expect(getInternalCompactionUsage(result)).toBe(usage);
    expect(result.result).not.toHaveProperty("usage");
  });
});
