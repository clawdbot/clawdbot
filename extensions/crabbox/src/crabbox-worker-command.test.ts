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

function stopWith(result: SpawnResult, calls: string[][] = []) {
  const runCommand: CrabboxCommandRunner = async (argv) => {
    calls.push(argv);
    return result;
  };
  return stopCrabboxLease({ binary: "crabbox", id: LEASE_ID, provider: "incus", runCommand });
}

describe("stopCrabboxLease", () => {
  it("treats exit 4 lease/server not found as confirmed gone", async () => {
    const calls: string[][] = [];
    await expect(
      stopWith(commandResult({ code: 4, stderr: `lease/server not found: ${LEASE_ID}\n` }), calls),
    ).resolves.toBeUndefined();
    expect(calls).toEqual([["crabbox", "stop", "--provider", "incus", "--id", LEASE_ID]]);
  });

  it("accepts the not-found line on stdout and for other resource words", async () => {
    await expect(
      stopWith(commandResult({ code: 4, stdout: `lease/droplet not found: ${LEASE_ID}` })),
    ).resolves.toBeUndefined();
  });

  it.each([
    {
      name: "exit 5 cleanup failure or scheduled retry after a coordinator 404 warning",
      code: 5,
      stderr: `warning: could not inspect lease before release: coordinator GET http://127.0.0.1/v1/leases/${LEASE_ID}: http 404: not_found\ncoordinator accepted release for ${LEASE_ID}, but remote cleanup reported a cleanup failure or scheduled retry`,
    },
    {
      name: "exit 5 coder workspace not found",
      code: 5,
      stderr: `coder workspace "${LEASE_ID}" not found`,
    },
    {
      name: "the not-found line on any exit code other than 4",
      code: 5,
      stderr: `lease/server not found: ${LEASE_ID}`,
    },
    {
      name: "coordinator lease 404 on exit 1",
      code: 1,
      stderr: `coordinator GET http://127.0.0.1/v1/leases/${LEASE_ID}: http 404: not_found`,
    },
    {
      name: "exit 4 missing local claim",
      code: 4,
      stderr: `sandbox ${LEASE_ID} is not claimed by Crabbox`,
    },
    {
      name: "exit 4 lease no longer exists",
      code: 4,
      stderr: `unikraftcloud lease ${LEASE_ID} no longer exists`,
    },
    {
      name: "exit 4 unknown lease",
      code: 4,
      stderr: `unknown lease: ${LEASE_ID}`,
    },
    {
      name: "exit 4 not found for a different lease",
      code: 4,
      stderr: `lease/server not found: cbx_000000000000`,
    },
    {
      name: "exit 4 not found next to a credential failure",
      code: 4,
      stderr: `credentials expired\nlease/server not found: ${LEASE_ID}`,
    },
    {
      name: "exit 4 already stopped prose",
      code: 4,
      stderr: `lease ${LEASE_ID} already stopped`,
    },
  ])("still errors on $name", async ({ code, stderr }) => {
    await expect(stopWith(commandResult({ code, stderr }))).rejects.toThrow(
      `Crabbox stop failed with exit code ${code}`,
    );
  });

  it("errors when stop does not exit normally", async () => {
    await expect(
      stopWith(
        commandResult({
          code: null,
          termination: "timeout",
          stderr: `lease/server not found: ${LEASE_ID}`,
        }),
      ),
    ).rejects.toThrow("Crabbox stop did not exit normally (timeout)");
  });
});
