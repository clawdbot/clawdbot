// Command bootstrap tests cover CLI command bootstrap sequencing and side effects.
import { beforeEach, describe, expect, it, vi } from "vitest";

const ensureConfigReadyMock = vi.hoisted(() => vi.fn(async () => {}));
const ensureCliPluginRegistryLoadedMock = vi.hoisted(() => vi.fn(async () => {}));

vi.mock("./program/config-guard.js", () => ({
  ensureConfigReady: ensureConfigReadyMock,
}));

vi.mock("./plugin-registry-loader.js", () => ({
  ensureCliPluginRegistryLoaded: ensureCliPluginRegistryLoadedMock,
}));

describe("ensureCliCommandBootstrap", () => {
  let ensureCliCommandBootstrap: typeof import("./command-bootstrap.js").ensureCliCommandBootstrap;

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.resetModules();
    ({ ensureCliCommandBootstrap } = await import("./command-bootstrap.js"));
  });

  it("runs config guard and plugin loading with shared options", async () => {
    const runtime = {} as never;

    await ensureCliCommandBootstrap({
      runtime,
      commandPath: ["agents", "list"],
      suppressDoctorStdout: true,
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

    await ensureCliCommandBootstrap({
      runtime,
      commandPath: ["gateway"],
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
    await ensureCliCommandBootstrap({
      runtime: {} as never,
      commandPath: ["memory", "search"],
      suppressDoctorStdout: true,
      skipConfigGuard: true,
      loadPlugins: true,
      pluginRegistry: { scope: "memory" },
    });

    expect(ensureConfigReadyMock).not.toHaveBeenCalled();
    expect(ensureCliPluginRegistryLoadedMock).toHaveBeenCalledWith({
      scope: "memory",
      routeLogsToStderr: true,
    });
  });

  it("forwards validation-only config guards without state migration", async () => {
    const runtime = {} as never;

    await ensureCliCommandBootstrap({
      runtime,
      commandPath: ["nodes", "approve"],
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
    await ensureCliCommandBootstrap({
      runtime: {} as never,
      commandPath: ["channels", "send"],
      loadPlugins: true,
    });

    expect(ensureCliPluginRegistryLoadedMock).toHaveBeenCalledWith({
      scope: "configured-channels",
      routeLogsToStderr: undefined,
    });
  });

  it("loads configured channel plugins without package-manager repair for read-only channel commands", async () => {
    await ensureCliCommandBootstrap({
      runtime: {} as never,
      commandPath: ["channels", "resolve"],
      loadPlugins: true,
    });

    expect(ensureCliPluginRegistryLoadedMock).toHaveBeenCalledWith({
      scope: "configured-channels",
      routeLogsToStderr: undefined,
    });
  });

  it("loads agent command plugins without package-manager repair", async () => {
    await ensureCliCommandBootstrap({
      runtime: {} as never,
      commandPath: ["agent"],
      loadPlugins: true,
    });

    expect(ensureCliPluginRegistryLoadedMock).toHaveBeenCalledWith({
      scope: "all",
      routeLogsToStderr: undefined,
    });
  });

  it("does not evaluate config or plugin runtimes for a gateway-backed agent turn", async () => {
    await ensureCliCommandBootstrap({
      runtime: {} as never,
      commandPath: ["agent"],
      skipConfigGuard: true,
      loadPlugins: false,
    });

    expect(ensureConfigReadyMock).not.toHaveBeenCalled();
    expect(ensureCliPluginRegistryLoadedMock).not.toHaveBeenCalled();
  });
});

describe("sandbox browser-only operations survive a broken plugin", () => {
  // `sandbox list --browser` / `sandbox recreate --browser` only read/remove
  // containers through the core Docker browser manager, never the
  // plugin-populated backend registry. Drive the real command-path policy
  // resolution (unmocked) into the bootstrap step so an unrelated plugin that
  // fails to load (mocked at the plugin-registry-loader boundary, matching its
  // `throwOnLoadError: true` contract) cannot block the browser-only path,
  // while a plain `sandbox list` still surfaces that same failure.
  let ensureCliCommandBootstrap: typeof import("./command-bootstrap.js").ensureCliCommandBootstrap;
  let resolveCliStartupPolicy: typeof import("./command-startup-policy.js").resolveCliStartupPolicy;

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.resetModules();
    ({ ensureCliCommandBootstrap } = await import("./command-bootstrap.js"));
    ({ resolveCliStartupPolicy } = await import("./command-startup-policy.js"));
  });

  function resolveSandboxLoadPlugins(argv: string[], commandPath: string[]) {
    return resolveCliStartupPolicy({ argv, commandPath, jsonOutputMode: false }).loadPlugins;
  }

  it("skips plugin loading for `sandbox list --browser` so a broken plugin cannot block it", async () => {
    ensureCliPluginRegistryLoadedMock.mockRejectedValueOnce(
      new Error("broken-plugin failed to load"),
    );
    const commandPath = ["sandbox", "list"];
    const argv = ["node", "openclaw", ...commandPath, "--browser"];

    await expect(
      ensureCliCommandBootstrap({
        runtime: {} as never,
        commandPath,
        skipConfigGuard: true,
        loadPlugins: resolveSandboxLoadPlugins(argv, commandPath),
      }),
    ).resolves.toBeUndefined();

    expect(ensureCliPluginRegistryLoadedMock).not.toHaveBeenCalled();
  });

  it("still loads plugins for plain `sandbox list`, so a broken plugin surfaces the failure", async () => {
    ensureCliPluginRegistryLoadedMock.mockRejectedValueOnce(
      new Error("broken-plugin failed to load"),
    );
    const commandPath = ["sandbox", "list"];
    const argv = ["node", "openclaw", ...commandPath];

    await expect(
      ensureCliCommandBootstrap({
        runtime: {} as never,
        commandPath,
        skipConfigGuard: true,
        loadPlugins: resolveSandboxLoadPlugins(argv, commandPath),
      }),
    ).rejects.toThrow("broken-plugin failed to load");

    expect(ensureCliPluginRegistryLoadedMock).toHaveBeenCalled();
  });
});
