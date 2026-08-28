import { afterEach, describe, expect, it, vi } from "vitest";
import type { LaneState } from "../../scripts/lib/cross-os-release-checks/config.ts";

const mocks = vi.hoisted(() => ({
  runInstalledCli: vi.fn().mockResolvedValue(undefined),
  runOpenClaw: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../scripts/lib/cross-os-release-checks/installed.ts", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../../scripts/lib/cross-os-release-checks/installed.ts")
  >()),
  runInstalledCli: mocks.runInstalledCli,
}));

vi.mock("../../scripts/lib/cross-os-release-checks/runtime.ts", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../../scripts/lib/cross-os-release-checks/runtime.ts")
  >()),
  runOpenClaw: mocks.runOpenClaw,
}));

import { installLaneCompanions } from "../../scripts/lib/cross-os-release-checks/lane-companions.ts";

function createLane(): LaneState {
  return {
    name: "fresh",
    rootDir: "/tmp/openclaw-release",
    prefixDir: "/tmp/openclaw-release/prefix",
    homeDir: "/tmp/openclaw-release/home",
    stateDir: "/tmp/openclaw-release/state",
    appDataDir: "/tmp/openclaw-release/app-data",
    gatewayPort: 18789,
    phaseTimings: [],
  };
}

describe("cross-OS release companion installation", () => {
  afterEach(() => {
    mocks.runInstalledCli.mockClear();
    mocks.runOpenClaw.mockClear();
  });

  it.each([
    { cliPath: undefined, runner: "packaged" },
    { cliPath: "/tmp/openclaw", runner: "installed" },
  ] as const)("accepts declared capabilities through the $runner runner", async ({ cliPath }) => {
    const lane = createLane();
    const env = { HOME: lane.homeDir };

    await installLaneCompanions({
      companions: [{ name: "@openclaw/codex", tarballPath: "/tmp/openclaw-codex.tgz" }],
      logsDir: "/tmp/openclaw-release/logs",
      lane,
      env,
      ...(cliPath ? { cliPath } : {}),
    });

    const expectedArgs = [
      "plugins",
      "install",
      "npm-pack:/tmp/openclaw-codex.tgz",
      "--force",
      "--accept-capabilities",
    ];
    const expectedCall = expect.objectContaining({ args: expectedArgs, env });
    if (cliPath) {
      expect(mocks.runInstalledCli).toHaveBeenCalledWith(expectedCall);
      expect(mocks.runOpenClaw).not.toHaveBeenCalled();
    } else {
      expect(mocks.runOpenClaw).toHaveBeenCalledWith(expectedCall);
      expect(mocks.runInstalledCli).not.toHaveBeenCalled();
    }
  });
});
