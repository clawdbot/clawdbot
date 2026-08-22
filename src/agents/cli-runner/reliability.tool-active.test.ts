import { describe, expect, it } from "vitest";
import type { CliBackendConfig } from "../../plugins/cli-backend.types.js";
import { CLI_TOOL_ACTIVE_NO_OUTPUT_TIMEOUT_DEFAULT_MS } from "../cli-watchdog-defaults.js";
import { resolveCliToolActiveNoOutputTimeoutMs } from "./reliability.js";

const baseBackend = { command: "claude" } as CliBackendConfig;

function backendWith(toolActiveNoOutputTimeoutMs?: number): CliBackendConfig {
  return {
    ...baseBackend,
    reliability: { liveSession: { toolActiveNoOutputTimeoutMs } },
  } as CliBackendConfig;
}

describe("resolveCliToolActiveNoOutputTimeoutMs", () => {
  it("uses the default allowance capped by the run timeout", () => {
    expect(
      resolveCliToolActiveNoOutputTimeoutMs({
        backend: baseBackend,
        timeoutMs: 3_600_000,
        noOutputTimeoutMs: 180_000,
      }),
    ).toBe(CLI_TOOL_ACTIVE_NO_OUTPUT_TIMEOUT_DEFAULT_MS);
  });

  it("never exceeds the run timeout minus the shutdown margin", () => {
    expect(
      resolveCliToolActiveNoOutputTimeoutMs({
        backend: baseBackend,
        timeoutMs: 600_000,
        noOutputTimeoutMs: 180_000,
      }),
    ).toBe(599_000);
  });

  it("never drops below the idle no-output watchdog", () => {
    expect(
      resolveCliToolActiveNoOutputTimeoutMs({
        backend: backendWith(60_000),
        timeoutMs: 3_600_000,
        noOutputTimeoutMs: 180_000,
      }),
    ).toBe(180_000);
  });

  it("honors a configured allowance", () => {
    expect(
      resolveCliToolActiveNoOutputTimeoutMs({
        backend: backendWith(900_000),
        timeoutMs: 3_600_000,
        noOutputTimeoutMs: 180_000,
      }),
    ).toBe(900_000);
  });

  it("ignores non-finite configured values", () => {
    expect(
      resolveCliToolActiveNoOutputTimeoutMs({
        backend: backendWith(Number.NaN),
        timeoutMs: 3_600_000,
        noOutputTimeoutMs: 180_000,
      }),
    ).toBe(CLI_TOOL_ACTIVE_NO_OUTPUT_TIMEOUT_DEFAULT_MS);
  });
});
