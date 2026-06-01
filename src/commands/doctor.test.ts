import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  runPostUpgradeProbes: vi.fn(),
  resolveInstalledPluginIndexStorePath: vi.fn(() => "/tmp/openclaw-installed-plugins.json"),
}));

vi.mock("./doctor-post-upgrade.js", () => ({
  runPostUpgradeProbes: mocks.runPostUpgradeProbes,
}));

vi.mock("../plugins/installed-plugin-index-store-path.js", () => ({
  resolveInstalledPluginIndexStorePath: mocks.resolveInstalledPluginIndexStorePath,
}));

const { doctorCommand } = await import("./doctor.js");

describe("doctorCommand", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("writes post-upgrade JSON through the runtime before exiting with findings", async () => {
    const report = {
      probesRun: ["plugin.index_unavailable"],
      findings: [
        {
          level: "error",
          code: "plugin.index_unavailable",
          message: "missing index",
        },
      ],
    };
    mocks.runPostUpgradeProbes.mockResolvedValueOnce(report);
    const runtime = {
      log: vi.fn(),
      error: vi.fn(),
      writeStdout: vi.fn(),
      writeJson: vi.fn(),
      exit: vi.fn((code: number) => {
        throw new Error(`exit:${code}`);
      }),
    };

    await expect(doctorCommand(runtime, { postUpgrade: true, json: true })).rejects.toThrow(
      "exit:1",
    );

    expect(runtime.writeJson).toHaveBeenCalledWith(report, 2);
    expect(runtime.log).not.toHaveBeenCalled();
    expect(runtime.exit).toHaveBeenCalledWith(1);
  });
});
