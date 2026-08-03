import { describe, expect, it } from "vitest";
import { parseCronPacingBounds } from "./pacing.js";

describe("parseCronPacingBounds", () => {
  it("rejects pacing without a minimum or maximum", () => {
    expect(() => parseCronPacingBounds({})).toThrow(
      "cron pacing requires at least one of min or max",
    );
  });
});
