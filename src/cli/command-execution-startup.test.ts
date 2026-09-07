// Command execution startup tests cover startup behavior before CLI command execution.
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const emitCliBannerMock = vi.hoisted(() => vi.fn());
const routeLogsToStderrMock = vi.hoisted(() => vi.fn());
const ensureConfigReadyMock = vi.hoisted(() => vi.fn(async () => {}));
const ensureCliPluginRegistryLoadedMock = vi.hoisted(() => vi.fn(async () => {}));

vi.mock("./banner.js", () => ({
  emitCliBanner: emitCliBannerMock,
}));

vi.mock("../logging/console.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../logging/console.js")>();
  return {
    ...actual,
    routeLogsToStderr: routeLogsToStderrMock,
  };
});

vi.mock("./program/config-guard.js", () => ({
  ensureConfigReady: ensureConfigReadyMock,
}));

vi.mock("./plugin-registry-loader.js", () => ({
  ensureCliPluginRegistryLoaded: ensureCliPluginRegistryLoadedMock,
}));

describe("command-execution-startup", () => {
  let mod: typeof import("./command-execution-startup.js");

  beforeAll(async () => {
    vi.resetModules();
    mod = await import("./command-execution-startup.js");
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("preserves console exports for a co-sharded subsystem logger", async () => {
    const { createSubsystemLogger } = await import("../logging/subsystem.js");

    expect(() =>
      createSubsystemLogger("test/cli-startup").isEnabled("info", "console"),
    ).not.toThrow();
  });

  it("routes logs to stderr and emits banner only when allowed", async () => {
    await mod.applyCliExecutionStartupPresentation({
      startupPolicy: {
        suppressDoctorStdout: true,
        hideBanner: false,
        skipConfigGuard: false,
        loadPlugins: true,
        pluginRegistry: { scope: "all" },
      },
      version: "1.2.3",
      argv: ["node", "openclaw", "status"],
    });

    expect(routeLogsToStderrMock).toHaveBeenCalledTimes(1);
    expect(emitCliBannerMock).toHaveBeenCalledWith("1.2.3", {
      argv: ["node", "openclaw", "status"],
    });

    await mod.applyCliExecutionStartupPresentation({
      startupPolicy: {
        suppressDoctorStdout: false,
        hideBanner: true,
        skipConfigGuard: false,
        loadPlugins: true,
        pluginRegistry: { scope: "all" },
      },
      version: "1.2.3",
      showBanner: true,
    });

    expect(emitCliBannerMock).toHaveBeenCalledTimes(1);
  });

  it("does not emit the banner for JSON output", async () => {
    await mod.applyCliExecutionStartupPresentation({
      startupPolicy: {
        suppressDoctorStdout: true,
        hideBanner: false,
        skipConfigGuard: false,
        loadPlugins: false,
        pluginRegistry: { scope: "channels" },
      },
      version: "1.2.3",
      argv: ["node", "openclaw", "status", "--json"],
    });

    expect(routeLogsToStderrMock).toHaveBeenCalledTimes(1);
    expect(emitCliBannerMock).not.toHaveBeenCalled();
  });

  it("forwards startup policy into bootstrap defaults and overrides", async () => {
    const statusRuntime = {} as never;
    await mod.ensureCliExecutionBootstrap({
      runtime: statusRuntime,
      commandPath: ["status"],
      startupPolicy: {
        suppressDoctorStdout: true,
        hideBanner: false,
        skipConfigGuard: false,
        loadPlugins: false,
        pluginRegistry: { scope: "channels" },
      },
    });

    expect(ensureConfigReadyMock).toHaveBeenCalledWith({
      runtime: statusRuntime,
      commandPath: ["status"],
      measure: expect.any(Function),
      suppressDoctorStdout: true,
    });
    expect(ensureCliPluginRegistryLoadedMock).not.toHaveBeenCalled();

    const messageRuntime = {} as never;
    await mod.ensureCliExecutionBootstrap({
      runtime: messageRuntime,
      commandPath: ["message", "send"],
      startupPolicy: {
        suppressDoctorStdout: false,
        hideBanner: false,
        skipConfigGuard: false,
        loadPlugins: false,
        pluginRegistry: { scope: "all" },
      },
      allowInvalid: true,
      loadPlugins: true,
      skipPristineCoreStateMigrations: true,
      skipPristineStartupStateMigrations: true,
    });

    expect(ensureConfigReadyMock).toHaveBeenLastCalledWith({
      runtime: messageRuntime,
      commandPath: ["message", "send"],
      measure: expect.any(Function),
      allowInvalid: true,
      skipPristineCoreStateMigrations: true,
      skipPristineStartupStateMigrations: true,
    });
    expect(ensureCliPluginRegistryLoadedMock).toHaveBeenCalledWith({
      scope: "all",
      routeLogsToStderr: false,
    });
  });
});
