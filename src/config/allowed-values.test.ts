import { describe, expect, it } from "vitest";
import { summarizeAllowedValues } from "./allowed-values.js";

describe("summarizeAllowedValues", () => {
  it("does not collapse mixed-type entries that stringify similarly", () => {
    const summary = summarizeAllowedValues([1, "1", 1, "1"]);
    expect(summary?.hiddenCount).toBe(0);
    expect(summary?.formatted).toContain('1, "1"');
    expect(summary?.values).toHaveLength(2);
  });

  it("keeps distinct long values even when labels truncate the same way", () => {
    const prefix = "a".repeat(200);
    const summary = summarizeAllowedValues([`${prefix}x`, `${prefix}y`]);
    expect(summary?.hiddenCount).toBe(0);
    expect(summary?.values).toHaveLength(2);
    expect(summary?.values[0]).not.toBe(summary?.values[1]);
  });
});
