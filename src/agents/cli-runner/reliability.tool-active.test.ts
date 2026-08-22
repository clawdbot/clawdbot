import { describe, expect, it } from "vitest";
import { CLI_TOOL_ACTIVE_NO_OUTPUT_TIMEOUT_DEFAULT_MS } from "../cli-watchdog-defaults.js";
import { resolveCliToolActiveNoOutputTimeoutMs } from "./reliability.js";

describe("resolveCliToolActiveNoOutputTimeoutMs", () => {
  it("uses the default allowance capped by the run timeout", () => {
    expect(
      resolveCliToolActiveNoOutputTimeoutMs({
        timeoutMs: 3_600_000,
        noOutputTimeoutMs: 180_000,
      }),
    ).toBe(CLI_TOOL_ACTIVE_NO_OUTPUT_TIMEOUT_DEFAULT_MS);
  });

  it("never exceeds the run timeout minus the shutdown margin", () => {
    expect(
      resolveCliToolActiveNoOutputTimeoutMs({
        timeoutMs: 600_000,
        noOutputTimeoutMs: 180_000,
      }),
    ).toBe(599_000);
  });

  it("never drops below the idle no-output watchdog", () => {
    expect(
      resolveCliToolActiveNoOutputTimeoutMs({
        timeoutMs: 3_600_000,
        noOutputTimeoutMs: 2_000_000,
      }),
    ).toBe(2_000_000);
  });
});
