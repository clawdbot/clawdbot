// Status message tests cover status message formatting and persistence.
import { describe, expect, it } from "vitest";
import { formatFastModeLabel } from "./status-labels.js";

describe("formatFastModeLabel", () => {
  it("shows fast mode when enabled", () => {
    expect(formatFastModeLabel(true)).toBe("Fast: on");
  });

  it("shows fast mode when disabled", () => {
    expect(formatFastModeLabel(false)).toBe("Fast: off");
  });
});
