import { beforeEach, describe, expect, it, vi } from "vitest";

const emitCliBannerMock = vi.hoisted(() => vi.fn());
const routeLogsToStderrMock = vi.hoisted(() => vi.fn());
const ensureCliCommandBootstrapMock = vi.hoisted(() => vi.fn(async () => {}));

vi.mock("./banner.js", () => ({
  emitCliBanner: emitCliBannerMock,
}));

vi.mock("../logging/console.js", () => ({
  routeLogsToStderr: routeLogsToStderrMock,
}));

vi.mock("./command-bootstrap.js", () => ({
  ensureCliCommandBootstrap: ensureCliCommandBootstrapMock,
}));

describe("command-execution-startup", () => {
  let mod: typeof import("./command-execution-startup.js");

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.resetModules();
    mod = await import("./command-execution-startup.js");
  });

  it("resolves startup context from argv and mode", () => {
    expect(
      mod.resolveCliExecutionStartupContext({
        argv: ["node", "openclaw", "status", "--json"],
        jsonOutputMode: true,
        env: {},
        routeMode: true,
      }),
    ).toEqual({
      invocation: {
        argv: ["node", "openclaw", "status", "--json"],
        commandPath: ["status"],
        primary: "status",
        hasHelpOrVersion: false,
        isRootHelpInvocation: false,
      },
      commandPath: ["status"],
      startupPolicy: {
        suppressDoctorStdout: true,
        hideBanner: false,
        skipConfigGuard: true,
        loadPlugins: false,
        pluginRegistry: { scope: "channels", installBundledRuntimeDeps: false },
      },
    });
  });

  it("uses process env banner suppression when startup env is omitted", () => {
    const originalHideBanner = process.env.OPENCLAW_HIDE_BANNER;
    try {
      process.env.OPENCLAW_HIDE_BANNER = "1";

      expect(
        mod.resolveCliExecutionStartupContext({
          argv: ["node", "openclaw", "status"],
          jsonOutputMode: false,
        }).startupPolicy.hideBanner,
      ).toBe(true);
      expect(
        mod.resolveCliExecutionStartupContext({
          argv: ["node", "openclaw", "status"],
          jsonOutputMode: false,
          env: {},
        }).startupPolicy.hideBanner,
      ).toBe(false);
    } finally {
      if (originalHideBanner === undefined) {
        delete process.env.OPENCLAW_HIDE_BANNER;
      } else {
        process.env.OPENCLAW_HIDE_BANNER = originalHideBanner;
      }
    }
  });

  it("skips local plugin bootstrap for JSON gateway agent calls", () => {
    expect(
      mod.resolveCliExecutionStartupContext({
        argv: ["node", "openclaw", "agent", "--agent", "main", "--message", "hi", "--json"],
        jsonOutputMode: true,
      }).startupPolicy.loadPlugins,
    ).toBe(false);
    expect(
      mod.resolveCliExecutionStartupContext({
        argv: [
          "node",
          "openclaw",
          "agent",
          "--agent",
          "main",
          "--message",
          "hi",
          "--json",
          "--local",
        ],
        jsonOutputMode: true,
      }).startupPolicy.loadPlugins,
    ).toBe(true);
    expect(
      mod.resolveCliExecutionStartupContext({
        argv: ["node", "openclaw", "agent", "--agent", "main", "--message", "hi"],
        jsonOutputMode: false,
      }).startupPolicy.loadPlugins,
    ).toBe(true);
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

  it("forwards startup policy into bootstrap defaults and overrides", async () => {
    const statusRuntime = {} as never;
    await mod.ensureCliExecutionBootstrap({
      runtime: statusRuntime,
      commandPath: ["status"],
      startupPolicy: {
        suppressDoctorStdout: true,
        hideBanner: false,
        skipConfigGuard: true,
        loadPlugins: false,
        pluginRegistry: { scope: "channels", installBundledRuntimeDeps: false },
      },
    });

    expect(ensureCliCommandBootstrapMock).toHaveBeenCalledWith({
      runtime: statusRuntime,
      commandPath: ["status"],
      suppressDoctorStdout: true,
      allowInvalid: undefined,
      loadPlugins: false,
      pluginRegistry: { scope: "channels", installBundledRuntimeDeps: false },
      skipConfigGuard: true,
    });

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
    });

    expect(ensureCliCommandBootstrapMock).toHaveBeenLastCalledWith({
      runtime: messageRuntime,
      commandPath: ["message", "send"],
      suppressDoctorStdout: false,
      allowInvalid: true,
      loadPlugins: true,
      pluginRegistry: { scope: "all" },
      skipConfigGuard: false,
    });
  });
});
