import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const emitCliBannerMock = vi.hoisted(() => vi.fn());
const ensureConfigReadyMock = vi.hoisted(() => vi.fn(async () => {}));
const ensurePluginRegistryLoadedMock = vi.hoisted(() => vi.fn());
const findRoutedCommandMock = vi.hoisted(() => vi.fn());
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

vi.mock("./program/routes.js", () => ({
  findRoutedCommand: findRoutedCommandMock,
}));

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
  // After vi.resetModules(), reimported modules get fresh loggingState.
  // Capture the same reference that route.js uses.
  let loggingState: typeof import("../logging/state.js").loggingState;
  let originalDisableRouteFirst: string | undefined;
  let originalHideBanner: string | undefined;
  let originalForceStderr: boolean;

  beforeAll(async () => {
    ({ tryRouteCli } = await import("./route.js"));
    ({ loggingState } = await import("../logging/state.js"));
  });

  beforeEach(() => {
    vi.clearAllMocks();
    originalDisableRouteFirst = process.env.OPENCLAW_DISABLE_ROUTE_FIRST;
    originalHideBanner = process.env.OPENCLAW_HIDE_BANNER;
    delete process.env.OPENCLAW_DISABLE_ROUTE_FIRST;
    delete process.env.OPENCLAW_HIDE_BANNER;
    originalForceStderr = loggingState.forceConsoleToStderr;
    loggingState.forceConsoleToStderr = false;
    findRoutedCommandMock.mockReturnValue({
      loadPlugins: (argv: string[]) => !argv.includes("--json"),
      run: runRouteMock,
    });
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
  });

  it("skips config guard for routed status --json commands", async () => {
    await expect(tryRouteCli(["node", "openclaw", "status", "--json"])).resolves.toBe(true);

    expect(ensureConfigReadyMock).not.toHaveBeenCalled();
    expect(ensurePluginRegistryLoadedMock).not.toHaveBeenCalled();
  });

  it("does not pass suppressDoctorStdout for routed non-json commands", async () => {
    await expect(tryRouteCli(["node", "openclaw", "status"])).resolves.toBe(true);

    expect(ensureConfigReadyMock).toHaveBeenCalledWith({
      runtime: expect.any(Object),
      commandPath: ["status"],
    });
    expect(ensurePluginRegistryLoadedMock).toHaveBeenCalledWith({
      scope: "channels",
    });
  });

  it("keeps logs routed to stderr for routed --json commands", async () => {
    findRoutedCommandMock.mockReturnValue({
      loadPlugins: true,
      run: runRouteMock,
    });

    // Capture the value inside the mock callback using the same loggingState
    // reference that route.js sees (both imported after vi.resetModules()).
    const captured: boolean[] = [];
    ensurePluginRegistryLoadedMock.mockImplementation(() => {
      captured.push(loggingState.forceConsoleToStderr);
    });

    await tryRouteCli(["node", "openclaw", "agents", "--json"]);

    expect(ensurePluginRegistryLoadedMock).toHaveBeenCalled();
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

  it("does not route logs to stderr during plugin loading without --json", async () => {
    findRoutedCommandMock.mockReturnValue({
      loadPlugins: true,
      run: runRouteMock,
    });

    const captured: boolean[] = [];
    ensurePluginRegistryLoadedMock.mockImplementation(() => {
      captured.push(loggingState.forceConsoleToStderr);
    });

    await tryRouteCli(["node", "openclaw", "agents"]);

    expect(ensurePluginRegistryLoadedMock).toHaveBeenCalled();
    expect(captured[0]).toBe(false);
    expect(loggingState.forceConsoleToStderr).toBe(false);
  });

  it("routes status when root options precede the command", async () => {
    await expect(tryRouteCli(["node", "openclaw", "--log-level", "debug", "status"])).resolves.toBe(
      true,
    );

    expect(findRoutedCommandMock).toHaveBeenCalledWith(
      ["status"],
      ["node", "openclaw", "--log-level", "debug", "status"],
    );
    expect(ensureConfigReadyMock).toHaveBeenCalledWith({
      runtime: expect.any(Object),
      commandPath: ["status"],
    });
    expect(ensurePluginRegistryLoadedMock).toHaveBeenCalledWith({
      scope: "channels",
    });
  });

  it("respects OPENCLAW_HIDE_BANNER for routed commands", async () => {
    process.env.OPENCLAW_HIDE_BANNER = "1";

    await expect(tryRouteCli(["node", "openclaw", "status"])).resolves.toBe(true);

    expect(emitCliBannerMock).not.toHaveBeenCalled();
  });

  it("falls back before bootstrap when the route cannot parse the argv", async () => {
    findRoutedCommandMock.mockReturnValue({
      canRun: () => false,
      loadPlugins: true,
      run: runRouteMock,
    });

    await expect(tryRouteCli(["node", "openclaw", "tasks", "list"])).resolves.toBe(false);

    expect(ensureConfigReadyMock).not.toHaveBeenCalled();
    expect(ensurePluginRegistryLoadedMock).not.toHaveBeenCalled();
    expect(runRouteMock).not.toHaveBeenCalled();
  });
});
