import { describe, expect, it } from "vitest";
import { summarizeAllowedValues } from "./allowed-values.js";

describe("summarizeAllowedValues", () => {
  it("does not collapse mixed-type entries that stringify similarly", () => {
    const summary = summarizeAllowedValues([1, "1", 1, "1"]);
    expect(summary).toStrictEqual({
      formatted: '1, "1"',
      hiddenCount: 0,
      values: ["1", "1"],
    });
  });

  it("keeps distinct long values even when labels truncate the same way", () => {
    const prefix = "a".repeat(200);
    const summary = summarizeAllowedValues([`${prefix}x`, `${prefix}y`]);
    expect(summary).toStrictEqual({
      formatted:
        '"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa... (+41 chars)", "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa... (+41 chars)"',
      hiddenCount: 0,
      values: [`${prefix}x`, `${prefix}y`],
    });
  });
});
