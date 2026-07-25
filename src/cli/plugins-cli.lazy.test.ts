// Plugins CLI lazy tests cover lazy plugin command registration and imports.
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
        runPluginMarketplaceEntriesCommand: vi.fn(),
        runPluginMarketplaceListCommand: vi.fn(),
        runPluginMarketplaceRefreshCommand: vi.fn(),
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
        runPluginMarketplaceEntriesCommand: vi.fn(),
        runPluginMarketplaceListCommand: vi.fn(),
        runPluginMarketplaceRefreshCommand: vi.fn(),
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

  it("loads the plugins runtime for marketplace entries", async () => {
    const runPluginMarketplaceEntriesCommand = vi.fn().mockResolvedValue(undefined);
    vi.doMock("./plugins-cli.runtime.js", () => ({
      runPluginMarketplaceEntriesCommand,
      runPluginMarketplaceListCommand: vi.fn(),
      runPluginMarketplaceRefreshCommand: vi.fn(),
      runPluginsDisableCommand: vi.fn(),
      runPluginsDoctorCommand: vi.fn(),
      runPluginsEnableCommand: vi.fn(),
      runPluginsInstallAction: vi.fn(),
      runPluginsRegistryCommand: vi.fn(),
    }));

    const { registerPluginsCli } = await import("./plugins-cli.js");
    const program = new Command();
    registerPluginsCli(program);

    await program.parseAsync(
      ["plugins", "marketplace", "entries", "--feed-profile", "acme", "--offline", "--json"],
      { from: "user" },
    );

    expect(runPluginMarketplaceEntriesCommand).toHaveBeenCalledWith(
      expect.objectContaining({ feedProfile: "acme", offline: true, json: true }),
    );
  });

  it("loads the plugins runtime for marketplace refresh", async () => {
    const runPluginMarketplaceRefreshCommand = vi.fn().mockResolvedValue(undefined);
    vi.doMock("./plugins-cli.runtime.js", () => ({
      runPluginMarketplaceEntriesCommand: vi.fn(),
      runPluginMarketplaceListCommand: vi.fn(),
      runPluginMarketplaceRefreshCommand,
      runPluginsDisableCommand: vi.fn(),
      runPluginsDoctorCommand: vi.fn(),
      runPluginsEnableCommand: vi.fn(),
      runPluginsInstallAction: vi.fn(),
      runPluginsRegistryCommand: vi.fn(),
    }));

    const { registerPluginsCli } = await import("./plugins-cli.js");
    const program = new Command();
    registerPluginsCli(program);

    await program.parseAsync(
      [
        "plugins",
        "marketplace",
        "refresh",
        "--feed-profile",
        "acme",
        "--expected-sha256",
        "abc123",
        "--json",
      ],
      { from: "user" },
    );

    expect(runPluginMarketplaceRefreshCommand).toHaveBeenCalledWith(
      expect.objectContaining({ feedProfile: "acme", expectedSha256: "abc123", json: true }),
    );
  });
});
