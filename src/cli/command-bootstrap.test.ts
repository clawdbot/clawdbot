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
      allowInvalid: true,
      suppressDoctorStdout: true,
    });
    expect(ensureCliPluginRegistryLoadedMock).toHaveBeenCalledWith({
      scope: "all",
      routeLogsToStderr: true,
    });
  });

  it("skips config guard without skipping plugin loading", async () => {
    await ensureCliCommandBootstrap({
      runtime: {} as never,
      commandPath: ["status"],
      suppressDoctorStdout: true,
      skipConfigGuard: true,
      loadPlugins: true,
    });

    expect(ensureConfigReadyMock).not.toHaveBeenCalled();
    expect(ensureCliPluginRegistryLoadedMock).toHaveBeenCalledWith({
      scope: "channels",
      routeLogsToStderr: true,
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

  it("does nothing extra when plugin loading is disabled", async () => {
    await ensureCliCommandBootstrap({
      runtime: {} as never,
      commandPath: ["config", "validate"],
      skipConfigGuard: true,
      loadPlugins: false,
    });

    expect(ensureConfigReadyMock).not.toHaveBeenCalled();
    expect(ensureCliPluginRegistryLoadedMock).not.toHaveBeenCalled();
  });
});
