import type { SpawnResult } from "openclaw/plugin-sdk/process-runtime";
import { describe, expect, it } from "vitest";
import { stopCrabboxLease, type CrabboxCommandRunner } from "./crabbox-worker-command.js";

const LEASE_ID = "cbx_1caa6f6fd07c";

function commandResult(overrides: Partial<SpawnResult> = {}): SpawnResult {
  return {
    stdout: "",
    stderr: "",
    code: 0,
    signal: null,
    killed: false,
    termination: "exit",
    ...overrides,
  };
}

function runnerWith(result: SpawnResult): CrabboxCommandRunner {
  return async () => result;
}

describe("stopCrabboxLease", () => {
  it("treats exit 4 lease/server not found as confirmed gone", async () => {
    await expect(
      stopCrabboxLease({
        binary: "crabbox",
        id: LEASE_ID,
        provider: "incus",
        runCommand: runnerWith(
          commandResult({ code: 4, stderr: `lease/server not found: ${LEASE_ID}` }),
        ),
      }),
    ).resolves.toBeUndefined();
  });

  it("still errors on a different stop failure", async () => {
    await expect(
      stopCrabboxLease({
        binary: "crabbox",
        id: LEASE_ID,
        provider: "incus",
        runCommand: runnerWith(
          commandResult({ code: 5, stderr: `remote cleanup failed for ${LEASE_ID}` }),
        ),
      }),
    ).rejects.toThrow("Crabbox stop failed with exit code 5");
  });
});
