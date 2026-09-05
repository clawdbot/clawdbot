// Covers machine name resolution fallback behavior.
import os from "node:os";
import { importFreshModule } from "openclaw/plugin-sdk/test-fixtures";
import { afterEach, describe, expect, it, vi } from "vitest";

const runExecMock = vi.hoisted(() => vi.fn());

vi.mock("../process/exec.js", () => ({ runExec: runExecMock }));

async function importMachineName(scope: string) {
  return await importFreshModule<typeof import("./machine-name.js")>(
    import.meta.url,
    `./machine-name.js?scope=${scope}`,
  );
}

afterEach(() => {
  runExecMock.mockReset();
  vi.restoreAllMocks();
});

describe("getMachineDisplayName", () => {
  it.each([
    {
      name: "uses the hostname fallback in test mode and strips a trimmed .local suffix",
      scope: "test-fallback",
      hostname: "  clawbox.LOCAL  ",
      expected: "clawbox",
      expectedCalls: 1,
      repeatLookup: true,
    },
    {
      name: "falls back to the default product name when hostname is blank",
      scope: "blank-hostname",
      hostname: "   ",
      expected: "openclaw",
      expectedCalls: 1,
      repeatLookup: false,
    },
  ])("$name", async ({ scope, hostname, expected, expectedCalls, repeatLookup }) => {
    const hostnameSpy = vi.spyOn(os, "hostname").mockReturnValue(hostname);
    const machineName = await importMachineName(scope);

    await expect(machineName.getMachineDisplayName()).resolves.toBe(expected);
    if (repeatLookup) {
      await expect(machineName.getMachineDisplayName()).resolves.toBe(expected);
    }
    expect(hostnameSpy).toHaveBeenCalledTimes(expectedCalls);
    expect(runExecMock).not.toHaveBeenCalled();
  });
});
