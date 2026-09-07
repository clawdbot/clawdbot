// Command bootstrap tests cover CLI command bootstrap sequencing and side effects.
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveCliStartupPolicy } from "./command-startup-policy.js";

const ensureConfigReadyMock = vi.hoisted(() => vi.fn(async () => {}));
const ensureCliPluginRegistryLoadedMock = vi.hoisted(() => vi.fn(async () => {}));

vi.mock("./program/config-guard.js", () => ({
  ensureConfigReady: ensureConfigReadyMock,
}));

vi.mock("./plugin-registry-loader.js", () => ({
  ensureCliPluginRegistryLoaded: ensureCliPluginRegistryLoadedMock,
}));

function bootstrapPolicy(commandPath: string[], suppressDoctorStdout = false) {
  return {
    ...resolveCliStartupPolicy({ commandPath, jsonOutputMode: suppressDoctorStdout, env: {} }),
    skipConfigGuard: false,
    loadPlugins: false,
  };
}

describe("ensureCliExecutionBootstrap", () => {
  let ensureCliExecutionBootstrap: typeof import("./command-execution-startup.js").ensureCliExecutionBootstrap;

  beforeAll(async () => {
    vi.resetModules();
    ({ ensureCliExecutionBootstrap } = await import("./command-execution-startup.js"));
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("runs config guard and plugin loading with shared options", async () => {
    const runtime = {} as never;

    await ensureCliExecutionBootstrap({
      runtime,
      commandPath: ["agents", "list"],
      startupPolicy: bootstrapPolicy(["agents", "list"], true),
      allowInvalid: true,
      loadPlugins: true,
    });

    expect(ensureConfigReadyMock).toHaveBeenCalledWith({
      runtime,
      commandPath: ["agents", "list"],
      measure: expect.any(Function),
      allowInvalid: true,
      suppressDoctorStdout: true,
    });
    expect(ensureCliPluginRegistryLoadedMock).toHaveBeenCalledWith({
      scope: "all",
      routeLogsToStderr: true,
    });
  });

  it("forwards prepared pristine migration facts to the config guard", async () => {
    const runtime = {} as never;

    await ensureCliExecutionBootstrap({
      runtime,
      commandPath: ["gateway"],
      startupPolicy: bootstrapPolicy(["gateway"]),
      loadPlugins: false,
      skipPristineCoreStateMigrations: true,
      skipPristineStartupStateMigrations: true,
    });

    expect(ensureConfigReadyMock).toHaveBeenCalledWith({
      runtime,
      commandPath: ["gateway"],
      measure: expect.any(Function),
      skipPristineCoreStateMigrations: true,
      skipPristineStartupStateMigrations: true,
    });
  });

  it("skips config guard without skipping plugin loading", async () => {
    await ensureCliExecutionBootstrap({
      runtime: {} as never,
      commandPath: ["memory", "search"],
      startupPolicy: {
        ...bootstrapPolicy(["memory", "search"], true),
        pluginRegistry: { scope: "memory" },
      },
      skipConfigGuard: true,
      loadPlugins: true,
    });

    expect(ensureConfigReadyMock).not.toHaveBeenCalled();
    expect(ensureCliPluginRegistryLoadedMock).toHaveBeenCalledWith({
      scope: "memory",
      routeLogsToStderr: true,
    });
  });

  it("forwards validation-only config guards without state migration", async () => {
    const runtime = {} as never;

    await ensureCliExecutionBootstrap({
      runtime,
      commandPath: ["nodes", "approve"],
      startupPolicy: bootstrapPolicy(["nodes", "approve"]),
      validateConfigOnly: true,
      loadPlugins: false,
    });

    expect(ensureConfigReadyMock).toHaveBeenCalledWith({
      runtime,
      commandPath: ["nodes", "approve"],
      measure: expect.any(Function),
      validateConfigOnly: true,
    });
  });

  it("loads configured channel plugins with repair enabled for operational channel commands", async () => {
    await ensureCliExecutionBootstrap({
      runtime: {} as never,
      commandPath: ["channels", "send"],
      startupPolicy: bootstrapPolicy(["channels", "send"]),
      loadPlugins: true,
    });

    expect(ensureCliPluginRegistryLoadedMock).toHaveBeenCalledWith({
      scope: "configured-channels",
      routeLogsToStderr: false,
    });
  });

  it("loads configured channel plugins without package-manager repair for read-only channel commands", async () => {
    await ensureCliExecutionBootstrap({
      runtime: {} as never,
      commandPath: ["channels", "resolve"],
      startupPolicy: bootstrapPolicy(["channels", "resolve"]),
      loadPlugins: true,
    });

    expect(ensureCliPluginRegistryLoadedMock).toHaveBeenCalledWith({
      scope: "configured-channels",
      routeLogsToStderr: false,
    });
  });

  it("loads agent command plugins without package-manager repair", async () => {
    await ensureCliExecutionBootstrap({
      runtime: {} as never,
      commandPath: ["agent"],
      loadPlugins: true,
      startupPolicy: bootstrapPolicy(["agent"]),
    });

    expect(ensureCliPluginRegistryLoadedMock).toHaveBeenCalledWith({
      scope: "all",
      routeLogsToStderr: false,
    });
  });

  it("loads configured and persisted backend owners for sandbox management", async () => {
    await ensureCliExecutionBootstrap({
      runtime: {} as never,
      commandPath: ["sandbox", "list"],
      startupPolicy: bootstrapPolicy(["sandbox", "list"]),
      loadPlugins: true,
    });

    expect(ensureCliPluginRegistryLoadedMock).toHaveBeenCalledWith({
      scope: "sandbox-management",
      routeLogsToStderr: false,
    });
  });

  it("skips config and plugin activation for a gateway-backed agent turn", async () => {
    await ensureCliExecutionBootstrap({
      runtime: {} as never,
      commandPath: ["agent"],
      startupPolicy: bootstrapPolicy(["agent"]),
      skipConfigGuard: true,
      loadPlugins: false,
    });

    expect(ensureConfigReadyMock).not.toHaveBeenCalled();
    expect(ensureCliPluginRegistryLoadedMock).not.toHaveBeenCalled();
  });
});
