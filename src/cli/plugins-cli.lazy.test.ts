import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("plugins cli lazy runtime boundary", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.doUnmock("./plugins-cli.runtime.js");
    vi.resetModules();
  });

  it("renders parent help without importing the plugins runtime", async () => {
    const runtimeLoaded = vi.fn();
    vi.doMock("./plugins-cli.runtime.js", () => {
      runtimeLoaded();
      return {
        runPluginMarketplaceListCommand: vi.fn(),
        runPluginsDisableCommand: vi.fn(),
        runPluginsDoctorCommand: vi.fn(),
        runPluginsEnableCommand: vi.fn(),
        runPluginsInstallAction: vi.fn(),
        runPluginsRegistryCommand: vi.fn(),
      };
    });

    const { registerPluginsCli } = await import("./plugins-cli.js");
    const program = new Command();
    program.exitOverride();
    program.configureOutput({
      writeErr: () => {},
      writeOut: () => {},
    });
    registerPluginsCli(program);

    await expect(program.parseAsync(["plugins", "--help"], { from: "user" })).rejects.toMatchObject(
      {
        exitCode: 0,
      },
    );
    expect(runtimeLoaded).not.toHaveBeenCalled();
  });

  it("loads the plugins runtime for runtime-backed actions", async () => {
    const runPluginsRegistryCommand = vi.fn().mockResolvedValue(undefined);
    const runtimeLoaded = vi.fn();
    vi.doMock("./plugins-cli.runtime.js", () => {
      runtimeLoaded();
      return {
        runPluginMarketplaceListCommand: vi.fn(),
        runPluginsDisableCommand: vi.fn(),
        runPluginsDoctorCommand: vi.fn(),
        runPluginsEnableCommand: vi.fn(),
        runPluginsInstallAction: vi.fn(),
        runPluginsRegistryCommand,
      };
    });

    const { registerPluginsCli } = await import("./plugins-cli.js");
    const program = new Command();
    registerPluginsCli(program);

    await program.parseAsync(["plugins", "registry", "--json"], { from: "user" });

    expect(runtimeLoaded).toHaveBeenCalledTimes(1);
    expect(runPluginsRegistryCommand).toHaveBeenCalledWith(expect.objectContaining({ json: true }));
  });
});
