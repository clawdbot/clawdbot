// Route CLI tests cover route command registration, channel routing, and output.
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const emitCliBannerMock = vi.hoisted(() => vi.fn());
const ensureConfigReadyMock = vi.hoisted(() =>
  vi.fn(async (_params: { runtime?: unknown; commandPath?: unknown }) => {}),
);
const ensurePluginRegistryLoadedMock = vi.hoisted(() => vi.fn());
const runRouteMock = vi.hoisted(() => vi.fn(async () => true));

vi.mock("./banner.js", () => ({
  emitCliBanner: emitCliBannerMock,
}));

vi.mock("./program/config-guard.js", () => ({
  ensureConfigReady: ensureConfigReadyMock,
}));

vi.mock("./plugin-registry.js", () => ({
  ensurePluginRegistryLoaded: ensurePluginRegistryLoadedMock,
}));

// Keep route selection and argument parsing real; replace only command side effects.
vi.mock("../commands/status.js", () => ({ statusCommand: runRouteMock }));
vi.mock("../commands/status-json.js", () => ({ statusJsonCommand: runRouteMock }));
vi.mock("../commands/health.js", () => ({ healthCommand: runRouteMock }));
vi.mock("../commands/agents.commands.list.js", () => ({ agentsListCommand: runRouteMock }));
vi.mock("../commands/tasks-json.js", () => ({
  tasksListJsonCommand: runRouteMock,
  tasksAuditJsonCommand: runRouteMock,
}));
vi.mock("../commands/sessions.js", () => ({ sessionsCommand: runRouteMock }));
vi.mock("../commands/channels/list.js", () => ({ channelsListCommand: runRouteMock }));
vi.mock("../commands/channels/status.js", () => ({ channelsStatusCommand: runRouteMock }));
vi.mock("./plugins-list-command.js", () => ({ runPluginsListCommand: runRouteMock }));
vi.mock("./daemon-cli/status.js", () => ({ runDaemonStatus: runRouteMock }));
vi.mock("./gateway-cli/health-route.js", () => ({ runGatewayHealthJsonRoute: runRouteMock }));
vi.mock("./config-cli.js", () => ({ runConfigGet: runRouteMock, runConfigUnset: runRouteMock }));
vi.mock("../commands/models/list.status-command.js", () => ({ modelsStatusCommand: runRouteMock }));

vi.mock("../runtime.js", () => ({
  defaultRuntime: {
    error: vi.fn(),
    log: vi.fn(),
    exit: vi.fn(),
    writeStdout: vi.fn(),
    writeJson: vi.fn(),
  },
}));

describe("tryRouteCli", () => {
  let tryRouteCli: typeof import("./route.js").tryRouteCli;
  // Capture the same loggingState reference that route.js uses.
  let loggingState: typeof import("../logging/state.js").loggingState;
  let originalDisableRouteFirst: string | undefined;
  let originalHideBanner: string | undefined;
  let originalLogLevel: string | undefined;
  let originalForceStderr: boolean;

  beforeAll(async () => {
    ({ tryRouteCli } = await import("./route.js"));
    ({ loggingState } = await import("../logging/state.js"));
  });

  beforeEach(() => {
    vi.clearAllMocks();
    originalDisableRouteFirst = process.env.OPENCLAW_DISABLE_ROUTE_FIRST;
    originalHideBanner = process.env.OPENCLAW_HIDE_BANNER;
    originalLogLevel = process.env.OPENCLAW_LOG_LEVEL;
    delete process.env.OPENCLAW_DISABLE_ROUTE_FIRST;
    delete process.env.OPENCLAW_HIDE_BANNER;
    delete process.env.OPENCLAW_LOG_LEVEL;
    originalForceStderr = loggingState.forceConsoleToStderr;
    loggingState.forceConsoleToStderr = false;
  });

  afterEach(() => {
    if (loggingState) {
      loggingState.forceConsoleToStderr = originalForceStderr;
    }
    if (originalDisableRouteFirst === undefined) {
      delete process.env.OPENCLAW_DISABLE_ROUTE_FIRST;
    } else {
      process.env.OPENCLAW_DISABLE_ROUTE_FIRST = originalDisableRouteFirst;
    }
    if (originalHideBanner === undefined) {
      delete process.env.OPENCLAW_HIDE_BANNER;
    } else {
      process.env.OPENCLAW_HIDE_BANNER = originalHideBanner;
    }
    if (originalLogLevel === undefined) {
      delete process.env.OPENCLAW_LOG_LEVEL;
    } else {
      process.env.OPENCLAW_LOG_LEVEL = originalLogLevel;
    }
  });

  it.each([
    ["status"],
    ["status", "--json"],
    ["health"],
    ["health", "--json"],
    ["agents"],
    ["agents", "list", "--json"],
    ["channels", "list"],
    ["channels", "status", "--json"],
    ["plugins", "list", "--json"],
    ["gateway", "status", "--json"],
    ["sessions", "--json"],
    ["tasks", "--json"],
    ["tasks", "list", "--json"],
    ["tasks", "audit", "--json"],
  ])("dispatches %j without startup config observation or plugin activation", async (...args) => {
    await expect(tryRouteCli(["node", "openclaw", ...args])).resolves.toBe(true);

    expect(ensureConfigReadyMock).not.toHaveBeenCalled();
    expect(ensurePluginRegistryLoadedMock).not.toHaveBeenCalled();
    expect(runRouteMock).toHaveBeenCalledOnce();
  });

  it("suppresses config get machine output without running an observing startup guard", async () => {
    const captured: boolean[] = [];
    runRouteMock.mockImplementationOnce(async () => {
      captured.push(loggingState.forceConsoleToStderr);
      return true;
    });

    await expect(
      tryRouteCli(["node", "openclaw", "config", "get", "gateway.port"], {
        machineOutput: true,
      }),
    ).resolves.toBe(true);

    expect(ensureConfigReadyMock).not.toHaveBeenCalled();
    expect(captured).toEqual([true]);
  });

  it("lets routed gateway health own its config read", async () => {
    await expect(tryRouteCli(["node", "openclaw", "gateway", "health", "--json"])).resolves.toBe(
      true,
    );

    expect(ensureConfigReadyMock).not.toHaveBeenCalled();
    expect(ensurePluginRegistryLoadedMock).not.toHaveBeenCalled();
  });

  it("finishes config readiness once before a routed config mutation", async () => {
    const events: string[] = [];
    ensureConfigReadyMock.mockImplementationOnce(async () => {
      events.push("config-ready");
    });
    runRouteMock.mockImplementationOnce(async () => {
      events.push("action");
      return true;
    });
    await expect(
      tryRouteCli(["node", "openclaw", "config", "unset", "gateway.port"]),
    ).resolves.toBe(true);

    expect(ensureConfigReadyMock.mock.calls[0]?.[0].commandPath).toEqual(["config", "unset"]);
    expect(events).toEqual(["config-ready", "action"]);
  });

  it("propagates config failure before running the mutation", async () => {
    const error = new Error("invalid synthetic config");
    ensureConfigReadyMock.mockRejectedValueOnce(error);

    await expect(tryRouteCli(["node", "openclaw", "config", "unset", "gateway.port"])).rejects.toBe(
      error,
    );

    expect(runRouteMock).not.toHaveBeenCalled();
    expect(ensurePluginRegistryLoadedMock).not.toHaveBeenCalled();
  });

  it("propagates action failure without falling back to Commander", async () => {
    const error = new Error("synthetic command failure");
    runRouteMock.mockRejectedValueOnce(error);

    await expect(tryRouteCli(["node", "openclaw", "status", "--json"])).rejects.toBe(error);

    expect(runRouteMock).toHaveBeenCalledOnce();
  });

  it("keeps action logs routed to stderr for routed --json commands", async () => {
    const captured: boolean[] = [];
    runRouteMock.mockImplementationOnce(async () => {
      captured.push(loggingState.forceConsoleToStderr);
      return true;
    });

    await tryRouteCli(["node", "openclaw", "agents", "--json"]);

    expect(runRouteMock).toHaveBeenCalledOnce();
    expect(captured[0]).toBe(true);
    expect(loggingState.forceConsoleToStderr).toBe(true);
  });

  it("routes command-run logs to stderr for config-guard-skipping --json routes", async () => {
    const captured: boolean[] = [];
    runRouteMock.mockImplementationOnce(async () => {
      captured.push(loggingState.forceConsoleToStderr);
      return true;
    });

    await expect(tryRouteCli(["node", "openclaw", "models", "status", "--json"])).resolves.toBe(
      true,
    );

    expect(ensureConfigReadyMock).not.toHaveBeenCalled();
    expect(captured).toEqual([true]);
  });

  it("keeps human action output on stdout", async () => {
    const captured: boolean[] = [];
    runRouteMock.mockImplementationOnce(async () => {
      captured.push(loggingState.forceConsoleToStderr);
      return true;
    });

    await tryRouteCli(["node", "openclaw", "agents"]);

    expect(runRouteMock).toHaveBeenCalledOnce();
    expect(captured[0]).toBe(false);
    expect(loggingState.forceConsoleToStderr).toBe(false);
  });

  it("routes status when root options precede the command", async () => {
    const capturedLogLevels: Array<string | undefined> = [];
    runRouteMock.mockImplementationOnce(async () => {
      capturedLogLevels.push(process.env.OPENCLAW_LOG_LEVEL);
      return true;
    });

    await expect(tryRouteCli(["node", "openclaw", "--log-level", "debug", "status"])).resolves.toBe(
      true,
    );

    expect(runRouteMock).toHaveBeenCalledOnce();
    expect(ensureConfigReadyMock).not.toHaveBeenCalled();
    expect(ensurePluginRegistryLoadedMock).not.toHaveBeenCalled();
    expect(capturedLogLevels).toEqual(["debug"]);
    expect(process.env.OPENCLAW_LOG_LEVEL).toBe("debug");
  });

  it("applies routed log level options after the command", async () => {
    const capturedLogLevels: Array<string | undefined> = [];
    runRouteMock.mockImplementationOnce(async () => {
      capturedLogLevels.push(process.env.OPENCLAW_LOG_LEVEL);
      return true;
    });

    await expect(tryRouteCli(["node", "openclaw", "status", "--log-level=trace"])).resolves.toBe(
      true,
    );

    expect(ensureConfigReadyMock).not.toHaveBeenCalled();
    expect(runRouteMock).toHaveBeenCalledTimes(1);
    expect(capturedLogLevels).toEqual(["trace"]);
    expect(process.env.OPENCLAW_LOG_LEVEL).toBe("trace");
  });

  it("uses the last valid routed log level option", async () => {
    await expect(
      tryRouteCli(["node", "openclaw", "--log-level", "debug", "status", "--log-level=trace"]),
    ).resolves.toBe(true);

    expect(ensureConfigReadyMock).not.toHaveBeenCalled();
    expect(runRouteMock).toHaveBeenCalledTimes(1);
    expect(process.env.OPENCLAW_LOG_LEVEL).toBe("trace");
  });

  it.each([
    ["invalid value", ["node", "openclaw", "status", "--log-level", "verbose"]],
    ["missing value", ["node", "openclaw", "status", "--log-level"]],
    [
      "later invalid value",
      ["node", "openclaw", "--log-level", "debug", "status", "--log-level", "verbose"],
    ],
  ])("falls back for %s routed log level options before bootstrap", async (_name, argv) => {
    await expect(tryRouteCli(argv)).resolves.toBe(false);

    expect(ensureConfigReadyMock).not.toHaveBeenCalled();
    expect(ensurePluginRegistryLoadedMock).not.toHaveBeenCalled();
    expect(runRouteMock).not.toHaveBeenCalled();
    expect(process.env.OPENCLAW_LOG_LEVEL).toBeUndefined();
  });

  it("respects OPENCLAW_HIDE_BANNER for routed commands", async () => {
    process.env.OPENCLAW_HIDE_BANNER = "1";

    await expect(tryRouteCli(["node", "openclaw", "status"])).resolves.toBe(true);

    expect(emitCliBannerMock).not.toHaveBeenCalled();
  });

  it("falls back before bootstrap when the route cannot parse the argv", async () => {
    await expect(
      tryRouteCli(["node", "openclaw", "tasks", "list", "--json", "--unknown"]),
    ).resolves.toBe(false);

    expect(ensureConfigReadyMock).not.toHaveBeenCalled();
    expect(ensurePluginRegistryLoadedMock).not.toHaveBeenCalled();
    expect(runRouteMock).not.toHaveBeenCalled();
  });
});
