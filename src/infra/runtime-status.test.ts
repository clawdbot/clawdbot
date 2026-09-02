// Covers runtime status formatting.
import { describe, expect, it } from "vitest";
import { formatRuntimeStatusWithDetails } from "./runtime-status.js";

describe("formatRuntimeStatusWithDetails", () => {
  it("falls back to unknown when status is missing", () => {
    expect(formatRuntimeStatusWithDetails({})).toBe("unknown");
    expect(formatRuntimeStatusWithDetails({ status: "   " })).toBe("unknown");
  });

  it("includes pid, distinct state, and non-empty details", () => {
    expect(
      formatRuntimeStatusWithDetails({
        status: "running",
        pid: 1234,
        state: "sleeping",
        details: ["healthy", "", "port 18789"],
      }),
    ).toBe("running (pid 1234, state sleeping, healthy, port 18789)");
  });

  it("trims distinct state and detail text before formatting", () => {
    expect(
      formatRuntimeStatusWithDetails({
        status: "running",
        state: " sleeping ",
        details: [" healthy ", "  port 18789  "],
      }),
    ).toBe("running (state sleeping, healthy, port 18789)");
  });

  it("omits duplicate state text and falsy pid values", () => {
    expect(
      formatRuntimeStatusWithDetails({
        status: "running",
        pid: 0,
        state: "RUNNING",
        details: [],
      }),
    ).toBe("running");
    expect(
      formatRuntimeStatusWithDetails({
        status: " RUNNING ",
        state: "running",
        details: [],
      }),
    ).toBe("RUNNING");
  });

  it("drops whitespace-only state and detail entries", () => {
    expect(
      formatRuntimeStatusWithDetails({
        status: "running",
        state: "   ",
        details: ["", "   "],
      }),
    ).toBe("running");
  });
});
