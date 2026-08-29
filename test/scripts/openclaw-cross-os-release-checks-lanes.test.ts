import { afterEach, describe, expect, it, vi } from "vitest";
import type { LaneState } from "../../scripts/lib/cross-os-release-checks/config.ts";

const mocks = vi.hoisted(() => ({
  runInstalledCli: vi.fn(),
  runOpenClaw: vi.fn(),
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
    mocks.runInstalledCli.mockReset();
    mocks.runOpenClaw.mockReset();
  });

  it.each([
    { cliPath: undefined, runner: "packaged", supported: true },
    { cliPath: undefined, runner: "packaged", supported: false },
    { cliPath: "/tmp/openclaw", runner: "installed", supported: true },
    { cliPath: "/tmp/openclaw", runner: "installed", supported: false },
  ] as const)(
    "probes capability consent once through the $runner runner (supported=$supported)",
    async ({ cliPath, supported }) => {
      const lane = createLane();
      const env = { HOME: lane.homeDir };
      const runner = cliPath ? mocks.runInstalledCli : mocks.runOpenClaw;
      const unusedRunner = cliPath ? mocks.runOpenClaw : mocks.runInstalledCli;
      runner
        .mockResolvedValueOnce({
          exitCode: 0,
          stdout: supported ? "  --accept-capabilities  Accept declared capabilities\n" : "Usage\n",
          stderr: "",
        })
        .mockResolvedValue({ exitCode: 0, stdout: "", stderr: "" });

      await installLaneCompanions({
        companions: [
          { name: "@openclaw/codex", tarballPath: "/tmp/openclaw-codex.tgz" },
          { name: "@openclaw/discord", tarballPath: "/tmp/openclaw-discord.tgz" },
        ],
        logsDir: "/tmp/openclaw-release/logs",
        lane,
        env,
        ...(cliPath ? { cliPath } : {}),
      });

      expect(runner).toHaveBeenCalledTimes(3);
      expect(runner).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({ args: ["plugins", "install", "--help"], env }),
      );
      for (const [callIndex, tarball] of [
        [2, "/tmp/openclaw-codex.tgz"],
        [3, "/tmp/openclaw-discord.tgz"],
      ] as const) {
        expect(runner).toHaveBeenNthCalledWith(
          callIndex,
          expect.objectContaining({
            args: [
              "plugins",
              "install",
              `npm-pack:${tarball}`,
              "--force",
              ...(supported ? ["--accept-capabilities"] : []),
            ],
            env,
          }),
        );
      }
      expect(unusedRunner).not.toHaveBeenCalled();
    },
  );

  it.each([
    { cliPath: undefined, runner: "packaged" },
    { cliPath: "/tmp/openclaw", runner: "installed" },
  ] as const)("fails the lane when the $runner help probe fails", async ({ cliPath }) => {
    const lane = createLane();
    const runner = cliPath ? mocks.runInstalledCli : mocks.runOpenClaw;
    runner.mockRejectedValueOnce(new Error("help probe failed"));

    await expect(
      installLaneCompanions({
        companions: [{ name: "@openclaw/codex", tarballPath: "/tmp/openclaw-codex.tgz" }],
        logsDir: "/tmp/openclaw-release/logs",
        lane,
        env: { HOME: lane.homeDir },
        ...(cliPath ? { cliPath } : {}),
      }),
    ).rejects.toThrow("help probe failed");
    expect(runner).toHaveBeenCalledTimes(1);
  });
});
