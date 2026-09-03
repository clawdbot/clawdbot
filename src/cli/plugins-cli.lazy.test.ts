// Plugins CLI lazy tests cover lazy plugin command registration and imports.
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("plugins cli lazy runtime boundary", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.doUnmock("./plugins-cli.runtime.js");
    vi.doUnmock("./plugins-authoring-command.js");
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

  it.each(["enable", "install", "update"])(
    "parses --accept-capabilities on the %s command without loading runtime",
    async (commandName) => {
      const runtimeLoaded = vi.fn();
      vi.doMock("./plugins-cli.runtime.js", () => {
        runtimeLoaded();
        return {};
      });
      const { registerPluginsCli } = await import("./plugins-cli.js");
      const program = new Command();
      registerPluginsCli(program);
      const plugins = program.commands.find((command) => command.name() === "plugins");
      const command = plugins?.commands.find((entry) => entry.name() === commandName);
      if (!command) {
        throw new Error(`missing plugins ${commandName} command`);
      }

      expect(command.parseOptions(["--accept-capabilities"]).unknown).toEqual([]);
      expect(command.opts()).toEqual(expect.objectContaining({ acceptCapabilities: true }));
      expect(runtimeLoaded).not.toHaveBeenCalled();
    },
  );

  it.each([
    {
      name: "plugins",
      argv: ["plugins"],
      description: "Manage OpenClaw plugins and extensions",
    },
    {
      name: "plugins marketplace",
      argv: ["plugins", "marketplace"],
      description: "Inspect Claude-compatible plugin marketplaces",
    },
  ])("renders $name parent help successfully without importing the runtime", async (testCase) => {
    const runtimeLoaded = vi.fn();
    vi.doMock("./plugins-cli.runtime.js", () => {
      runtimeLoaded();
      return {};
    });

    const { registerPluginsCli } = await import("./plugins-cli.js");
    const program = new Command();
    const helpOutput: string[] = [];
    program.exitOverride();
    program.configureOutput({
      writeErr: (value) => helpOutput.push(value),
      writeOut: (value) => helpOutput.push(value),
    });
    registerPluginsCli(program);

    const originalExitCode = process.exitCode;
    try {
      process.exitCode = undefined;
      await program.parseAsync(testCase.argv, { from: "user" });

      expect(process.exitCode).toBe(0);
      expect(helpOutput.join("")).toContain(testCase.description);
      expect(runtimeLoaded).not.toHaveBeenCalled();
    } finally {
      process.exitCode = originalExitCode;
    }
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

  it("forwards JSON mode to plugin doctor and validation actions", async () => {
    const runPluginsDoctorCommand = vi.fn().mockResolvedValue(undefined);
    const runPluginsValidateCommand = vi.fn().mockResolvedValue(undefined);
    vi.doMock("./plugins-cli.runtime.js", () => ({ runPluginsDoctorCommand }));
    vi.doMock("./plugins-authoring-command.js", () => ({ runPluginsValidateCommand }));

    const { registerPluginsCli } = await import("./plugins-cli.js");
    const doctorProgram = new Command();
    registerPluginsCli(doctorProgram);
    await doctorProgram.parseAsync(["plugins", "doctor", "--json"], { from: "user" });

    const validateProgram = new Command();
    registerPluginsCli(validateProgram);
    await validateProgram.parseAsync(["plugins", "validate", "--json"], { from: "user" });

    expect(runPluginsDoctorCommand).toHaveBeenCalledWith(expect.objectContaining({ json: true }));
    expect(runPluginsValidateCommand).toHaveBeenCalledWith(expect.objectContaining({ json: true }));
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
