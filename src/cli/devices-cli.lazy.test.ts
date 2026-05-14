import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("devices cli lazy runtime boundary", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.doUnmock("./devices-cli.runtime.js");
    vi.resetModules();
  });

  it("renders parent help without importing the devices runtime", async () => {
    const runtimeLoaded = vi.fn();
    vi.doMock("./devices-cli.runtime.js", () => {
      runtimeLoaded();
      return {
        runDevicesApproveCommand: vi.fn(),
        runDevicesClearCommand: vi.fn(),
        runDevicesListCommand: vi.fn(),
        runDevicesRejectCommand: vi.fn(),
        runDevicesRemoveCommand: vi.fn(),
        runDevicesRevokeCommand: vi.fn(),
        runDevicesRotateCommand: vi.fn(),
      };
    });

    const { registerDevicesCli } = await import("./devices-cli.js");
    const program = new Command();
    program.exitOverride();
    program.configureOutput({
      writeErr: () => {},
      writeOut: () => {},
    });
    registerDevicesCli(program);

    await expect(program.parseAsync(["devices", "--help"], { from: "user" })).rejects.toMatchObject(
      {
        exitCode: 0,
      },
    );
    expect(runtimeLoaded).not.toHaveBeenCalled();
  });

  it("loads the devices runtime for command actions", async () => {
    const runDevicesListCommand = vi.fn().mockResolvedValue(undefined);
    const runtimeLoaded = vi.fn();
    vi.doMock("./devices-cli.runtime.js", () => {
      runtimeLoaded();
      return {
        runDevicesApproveCommand: vi.fn(),
        runDevicesClearCommand: vi.fn(),
        runDevicesListCommand,
        runDevicesRejectCommand: vi.fn(),
        runDevicesRemoveCommand: vi.fn(),
        runDevicesRevokeCommand: vi.fn(),
        runDevicesRotateCommand: vi.fn(),
      };
    });

    const { registerDevicesCli } = await import("./devices-cli.js");
    const program = new Command();
    registerDevicesCli(program);

    await program.parseAsync(["devices", "list", "--json"], { from: "user" });

    expect(runtimeLoaded).toHaveBeenCalledTimes(1);
    expect(runDevicesListCommand).toHaveBeenCalledWith(expect.objectContaining({ json: true }));
  });
});
