import process from "node:process";
import { CommanderError } from "commander";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { loggingState } from "../logging/state.js";
import { runCli, shouldStartProxyForCli } from "./run-main.js";

const tryRouteCliMock = vi.hoisted(() => vi.fn());
const loadDotEnvMock = vi.hoisted(() => vi.fn());
const normalizeEnvMock = vi.hoisted(() => vi.fn());
const ensurePathMock = vi.hoisted(() => vi.fn());
const assertRuntimeMock = vi.hoisted(() => vi.fn());
const closeActiveMemorySearchManagersMock = vi.hoisted(() => vi.fn(async () => {}));
const hasMemoryRuntimeMock = vi.hoisted(() => vi.fn(() => false));
const listAgentHarnessIdsMock = vi.hoisted(() => vi.fn((): string[] => []));
const disposeRegisteredAgentHarnessesMock = vi.hoisted(() => vi.fn(async () => {}));
const ensureTaskRegistryReadyMock = vi.hoisted(() => vi.fn());
const startTaskRegistryMaintenanceMock = vi.hoisted(() => vi.fn());
const outputRootHelpMock = vi.hoisted(() => vi.fn());
const outputPrecomputedRootHelpTextMock = vi.hoisted(() => vi.fn(() => false));
const outputPrecomputedBrowserHelpTextMock = vi.hoisted(() => vi.fn(() => false));
const buildProgramMock = vi.hoisted(() => vi.fn());
const getProgramContextMock = vi.hoisted(() => vi.fn(() => null));
const registerCoreCliByNameMock = vi.hoisted(() => vi.fn());
const registerSubCliByNameMock = vi.hoisted(() => vi.fn());
const registerPluginCliCommandsFromValidatedConfigMock = vi.hoisted(() => vi.fn(async () => ({})));
const resolvePluginCliRootOwnerIdsMock = vi.hoisted(() => vi.fn());
const resolveManifestCommandAliasOwnerMock = vi.hoisted(() => vi.fn());
const resolveManifestToolOwnerMock = vi.hoisted(() => vi.fn());
const resolveManifestCliCommandSurfaceOwnerMock = vi.hoisted(() => vi.fn());
const restoreTerminalStateMock = vi.hoisted(() => vi.fn());
const hasEnvHttpProxyAgentConfiguredMock = vi.hoisted(() => vi.fn(() => false));
const ensureGlobalUndiciEnvProxyDispatcherMock = vi.hoisted(() => vi.fn());
const runCrestodianMock = vi.hoisted(() =>
  vi.fn<(options?: unknown) => Promise<void>>(async () => {}),
);
const commanderParseAsyncMock = vi.hoisted(() => vi.fn(async () => {}));
const addGatewayRunCommandMock = vi.hoisted(() => vi.fn((command: unknown) => command));
const emitCliBannerMock = vi.hoisted(() => vi.fn());
const enableConsoleCaptureMock = vi.hoisted(() => vi.fn());
const progressDoneMock = vi.hoisted(() => vi.fn());
const createCliProgressMock = vi.hoisted(() =>
  vi.fn(() => ({
    done: progressDoneMock,
  })),
);
const loadConfigMock = vi.hoisted(() => vi.fn(() => ({})));
const startProxyMock = vi.hoisted(() =>
  vi.fn<(config: unknown) => Promise<unknown>>(async () => null),
);
const stopProxyMock = vi.hoisted(() => vi.fn<(handle: unknown) => Promise<void>>(async () => {}));
const maybeRunCliInContainerMock = vi.hoisted(() =>
  vi.fn<
    (argv: string[]) => { handled: true; exitCode: number } | { handled: false; argv: string[] }
  >((argv: string[]) => ({ handled: false, argv })),
);

function requireRunCrestodianOptions(index = 0): { onReady?: unknown } {
  const call = runCrestodianMock.mock.calls[index];
  if (!call) {
    throw new Error(`expected runCrestodian call ${index}`);
  }
  expect(typeof call[0]).toBe("object");
  if (typeof call[0] !== "object" || call[0] === null) {
    throw new Error(`expected runCrestodian call ${index} to receive options`);
  }
  return call[0] as { onReady?: unknown };
}

vi.mock("commander", () => {
  class MockCommanderError extends Error {
    exitCode: number;
    code: string;

    constructor(exitCode: number, code: string, message: string) {
      super(message);
      this.exitCode = exitCode;
      this.code = code;
    }
  }

  class MockCommand {
    name = vi.fn(() => this);
    enablePositionalOptions = vi.fn(() => this);
    option = vi.fn(() => this);
    exitOverride = vi.fn(() => this);
    description = vi.fn(() => this);
    command = vi.fn(() => new MockCommand());
    parseAsync = commanderParseAsyncMock;
  }

  return {
    Command: MockCommand,
    CommanderError: MockCommanderError,
  };
});

vi.mock("./route.js", () => ({
  tryRouteCli: tryRouteCliMock,
}));

vi.mock("./gateway-cli/run.js", () => ({
  addGatewayRunCommand: addGatewayRunCommandMock,
}));

vi.mock("../version.js", () => ({
  VERSION: "9.9.9-test",
}));

vi.mock("./banner.js", () => ({
  emitCliBanner: emitCliBannerMock,
}));

vi.mock("../logging.js", async () => ({
  ...(await vi.importActual<typeof import("../logging.js")>("../logging.js")),
  enableConsoleCapture: enableConsoleCaptureMock,
}));

vi.mock("./container-target.js", () => ({
  maybeRunCliInContainer: maybeRunCliInContainerMock,
  parseCliContainerArgs: (argv: string[]) => ({ ok: true, container: null, argv }),
}));

vi.mock("./dotenv.js", () => ({
  loadCliDotEnv: loadDotEnvMock,
}));

vi.mock("../infra/env.js", () => ({
  isTruthyEnvValue: (value?: string) =>
    typeof value === "string" && ["1", "on", "true", "yes"].includes(value.trim().toLowerCase()),
  normalizeEnv: normalizeEnvMock,
}));

vi.mock("../infra/path-env.js", () => ({
  ensureOpenClawCliOnPath: ensurePathMock,
}));

vi.mock("../infra/runtime-guard.js", () => ({
  assertSupportedRuntime: assertRuntimeMock,
}));

vi.mock("../plugins/memory-runtime.js", () => ({
  closeActiveMemorySearchManagers: closeActiveMemorySearchManagersMock,
}));

vi.mock("../plugins/memory-state.js", () => ({
  hasMemoryRuntime: hasMemoryRuntimeMock,
}));

vi.mock("../agents/harness/registry.js", () => ({
  listAgentHarnessIds: listAgentHarnessIdsMock,
  disposeRegisteredAgentHarnesses: disposeRegisteredAgentHarnessesMock,
}));

vi.mock("../tasks/task-registry.js", () => ({
  ensureTaskRegistryReady: ensureTaskRegistryReadyMock,
}));

vi.mock("../tasks/task-registry.maintenance.js", () => ({
  startTaskRegistryMaintenance: startTaskRegistryMaintenanceMock,
}));

vi.mock("./program/root-help.js", () => ({
  outputRootHelp: outputRootHelpMock,
}));

vi.mock("./root-help-metadata.js", () => ({
  outputPrecomputedBrowserHelpText: outputPrecomputedBrowserHelpTextMock,
  outputPrecomputedRootHelpText: outputPrecomputedRootHelpTextMock,
}));

vi.mock("./program.js", () => ({
  buildProgram: buildProgramMock,
}));

vi.mock("./program/program-context.js", () => ({
  getProgramContext: getProgramContextMock,
}));

vi.mock("./program/command-registry.js", () => ({
  registerCoreCliByName: registerCoreCliByNameMock,
}));

vi.mock("./program/register.subclis.js", () => ({
  registerSubCliByName: registerSubCliByNameMock,
}));

vi.mock("../plugins/cli.js", () => ({
  registerPluginCliCommandsFromValidatedConfig: registerPluginCliCommandsFromValidatedConfigMock,
}));

vi.mock("../plugins/cli-registry-loader.js", () => ({
  resolvePluginCliRootOwnerIds: resolvePluginCliRootOwnerIdsMock,
}));

vi.mock("../plugins/manifest-command-aliases.runtime.js", () => ({
  resolveManifestCliCommandSurfaceOwner: resolveManifestCliCommandSurfaceOwnerMock,
  resolveManifestCommandAliasOwner: resolveManifestCommandAliasOwnerMock,
  resolveManifestToolOwner: resolveManifestToolOwnerMock,
}));

vi.mock("../terminal/restore.js", () => ({
  restoreTerminalState: restoreTerminalStateMock,
}));

vi.mock("../infra/net/proxy-env.js", () => ({
  hasEnvHttpProxyAgentConfigured: hasEnvHttpProxyAgentConfiguredMock,
}));

vi.mock("../infra/net/undici-global-dispatcher.js", () => ({
  ensureGlobalUndiciEnvProxyDispatcher: ensureGlobalUndiciEnvProxyDispatcherMock,
}));

vi.mock("../crestodian/crestodian.js", () => ({
  runCrestodian: runCrestodianMock,
}));

vi.mock("./progress.js", () => ({
  createCliProgress: createCliProgressMock,
}));

vi.mock("../config/io.js", () => ({
  readBestEffortConfig: loadConfigMock,
}));

vi.mock("../infra/net/proxy/proxy-lifecycle.js", () => ({
  startProxy: startProxyMock,
  stopProxy: stopProxyMock,
}));

function makeProxyHandle() {
  return {
    proxyUrl: "http://127.0.0.1:19876",
    stop: vi.fn(async () => {}),
    kill: vi.fn(),
  };
}

describe("runCli exit behavior", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    hasMemoryRuntimeMock.mockReturnValue(false);
    listAgentHarnessIdsMock.mockReturnValue([]);
    outputPrecomputedBrowserHelpTextMock.mockReturnValue(false);
    outputPrecomputedRootHelpTextMock.mockReturnValue(false);
    hasEnvHttpProxyAgentConfiguredMock.mockReturnValue(false);
    loadConfigMock.mockReturnValue({});
    startProxyMock.mockResolvedValue(null);
    stopProxyMock.mockResolvedValue(undefined);
    getProgramContextMock.mockReturnValue(null);
    resolvePluginCliRootOwnerIdsMock.mockImplementation(
      ({ primaryCommand }: { primaryCommand?: string }) =>
        primaryCommand === "googlemeet" ? ["google-meet"] : [],
    );
    resolveManifestCommandAliasOwnerMock.mockReturnValue(undefined);
    resolveManifestToolOwnerMock.mockReturnValue(undefined);
    resolveManifestCliCommandSurfaceOwnerMock.mockReturnValue(undefined);
    delete process.env.OPENCLAW_DISABLE_CLI_STARTUP_HELP_FAST_PATH;
    delete process.env.OPENCLAW_HIDE_BANNER;
    loggingState.forceConsoleToStderr = false;
  });

  it("does not force process.exit after successful routed command", async () => {
    tryRouteCliMock.mockResolvedValueOnce(true);
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`unexpected process.exit(${String(code)})`);
    }) as typeof process.exit);

    await runCli(["node", "openclaw", "status"]);

    expect(maybeRunCliInContainerMock).toHaveBeenCalledWith(["node", "openclaw", "status"]);
    expect(tryRouteCliMock).toHaveBeenCalledWith(["node", "openclaw", "status"]);
    expect(closeActiveMemorySearchManagersMock).not.toHaveBeenCalled();
    expect(disposeRegisteredAgentHarnessesMock).not.toHaveBeenCalled();
    expect(ensureTaskRegistryReadyMock).not.toHaveBeenCalled();
    expect(startTaskRegistryMaintenanceMock).not.toHaveBeenCalled();
    expect(exitSpy).not.toHaveBeenCalled();
    exitSpy.mockRestore();
  });

  it("disposes registered harnesses after full CLI command completion", async () => {
    listAgentHarnessIdsMock.mockReturnValueOnce(["codex"]);
    tryRouteCliMock.mockResolvedValueOnce(false);
    const parseAsync = vi.fn().mockResolvedValueOnce(undefined);
    buildProgramMock.mockReturnValueOnce({
      commands: [{ name: () => "agent", aliases: () => [] }],
      parseAsync,
    });

    await runCli(["node", "openclaw", "agent", "--local"]);

    expect(parseAsync).toHaveBeenCalledWith(["node", "openclaw", "agent", "--local"]);
    expect(disposeRegisteredAgentHarnessesMock).toHaveBeenCalledTimes(1);
  });

  it("pauses non-tty stdin after full CLI command completion", async () => {
    tryRouteCliMock.mockResolvedValueOnce(false);
    const parseAsync = vi.fn().mockResolvedValueOnce(undefined);
    buildProgramMock.mockReturnValueOnce({
      commands: [{ name: () => "channels", aliases: () => [] }],
      parseAsync,
    });
    const stdinTty = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
    Object.defineProperty(process.stdin, "isTTY", { configurable: true, value: false });
    const pauseSpy = vi.spyOn(process.stdin, "pause").mockImplementation(() => process.stdin);

    try {
      await runCli(["node", "openclaw", "channels"]);

      expect(parseAsync).toHaveBeenCalledWith(["node", "openclaw", "channels"]);
      expect(pauseSpy).toHaveBeenCalledTimes(1);
    } finally {
      pauseSpy.mockRestore();
      if (stdinTty) {
        Object.defineProperty(process.stdin, "isTTY", stdinTty);
      } else {
        Reflect.deleteProperty(process.stdin, "isTTY");
      }
    }
  });

  it("emits the startup banner before gateway foreground fast-path startup", async () => {
    await runCli(["node", "openclaw", "gateway", "--force"]);

    expect(tryRouteCliMock).not.toHaveBeenCalled();
    expect(emitCliBannerMock).toHaveBeenCalledWith("9.9.9-test", {
      argv: ["node", "openclaw", "gateway", "--force"],
    });
    expect(addGatewayRunCommandMock).toHaveBeenCalledTimes(2);
    expect(commanderParseAsyncMock).toHaveBeenCalledWith([
      "node",
      "openclaw",
      "gateway",
      "--force",
    ]);
  });

  it("installs console capture before parsing the gateway foreground fast path", async () => {
    await runCli(["node", "openclaw", "gateway", "--force"]);

    expect(enableConsoleCaptureMock).toHaveBeenCalledTimes(1);
    expect(commanderParseAsyncMock).toHaveBeenCalledTimes(1);
    const captureOrder = enableConsoleCaptureMock.mock.invocationCallOrder[0] ?? 0;
    const parseOrder = commanderParseAsyncMock.mock.invocationCallOrder[0] ?? 0;
    expect(captureOrder).toBeGreaterThan(0);
    expect(parseOrder).toBeGreaterThan(captureOrder);
  });

  it("honors banner suppression on the gateway foreground fast path", async () => {
    process.env.OPENCLAW_HIDE_BANNER = "1";

    await runCli(["node", "openclaw", "gateway"]);

    expect(tryRouteCliMock).not.toHaveBeenCalled();
    expect(emitCliBannerMock).not.toHaveBeenCalled();
    expect(commanderParseAsyncMock).toHaveBeenCalledWith(["node", "openclaw", "gateway"]);
  });

  it("renders browser help from startup metadata without building the full program", async () => {
    outputPrecomputedBrowserHelpTextMock.mockReturnValueOnce(true);
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`unexpected process.exit(${String(code)})`);
    }) as typeof process.exit);

    await runCli(["node", "openclaw", "browser", "--help"]);

    expect(maybeRunCliInContainerMock).toHaveBeenCalledWith([
      "node",
      "openclaw",
      "browser",
      "--help",
    ]);
    expect(tryRouteCliMock).not.toHaveBeenCalled();
    expect(outputPrecomputedBrowserHelpTextMock).toHaveBeenCalledTimes(1);
    expect(outputRootHelpMock).not.toHaveBeenCalled();
    expect(buildProgramMock).not.toHaveBeenCalled();
    expect(closeActiveMemorySearchManagersMock).not.toHaveBeenCalled();
    expect(exitSpy).not.toHaveBeenCalled();
    exitSpy.mockRestore();
  });

  it("keeps root help on the precomputed path without proxy bootstrap", async () => {
    outputPrecomputedRootHelpTextMock.mockReturnValueOnce(true);

    await runCli(["node", "openclaw", "--help"]);

    expect(outputPrecomputedRootHelpTextMock).toHaveBeenCalledTimes(1);
    expect(hasEnvHttpProxyAgentConfiguredMock).not.toHaveBeenCalled();
    expect(ensureGlobalUndiciEnvProxyDispatcherMock).not.toHaveBeenCalled();
    expect(runCrestodianMock).not.toHaveBeenCalled();
  });

  it("renders root help without building the full program", async () => {
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`unexpected process.exit(${String(code)})`);
    }) as typeof process.exit);

    await runCli(["node", "openclaw", "--help"]);

    expect(maybeRunCliInContainerMock).toHaveBeenCalledWith(["node", "openclaw", "--help"]);
    expect(tryRouteCliMock).not.toHaveBeenCalled();
    expect(outputPrecomputedRootHelpTextMock).toHaveBeenCalledTimes(1);
    expect(outputRootHelpMock).toHaveBeenCalledTimes(1);
    expect(buildProgramMock).not.toHaveBeenCalled();
    expect(closeActiveMemorySearchManagersMock).not.toHaveBeenCalled();
    expect(exitSpy).not.toHaveBeenCalled();
    exitSpy.mockRestore();
  });

  it("does not start the managed proxy for local gateway client commands", async () => {
    tryRouteCliMock.mockResolvedValueOnce(true);

    await runCli(["node", "openclaw", "status"]);

    expect(startProxyMock).not.toHaveBeenCalled();
    expect(stopProxyMock).not.toHaveBeenCalled();
  });

  it.each([
    ["gateway runtime", ["node", "openclaw", "gateway", "run"]],
    ["bare gateway runtime", ["node", "openclaw", "gateway"]],
    ["node runtime", ["node", "openclaw", "node", "run"]],
    ["local agent runtime", ["node", "openclaw", "agent", "--local"]],
    ["provider inference", ["node", "openclaw", "infer", "web", "fetch", "https://example.com"]],
    ["model command", ["node", "openclaw", "models", "auth", "login", "openai"]],
    ["plugin command", ["node", "openclaw", "plugins", "marketplace", "list"]],
    ["skill command", ["node", "openclaw", "skills", "search", "browser"]],
    ["update command", ["node", "openclaw", "update", "check"]],
    ["channel probe", ["node", "openclaw", "channels", "status", "--probe"]],
    ["channel capabilities probe", ["node", "openclaw", "channels", "capabilities"]],
    ["directory plugin command", ["node", "openclaw", "directory", "peers", "list"]],
    ["message plugin command", ["node", "openclaw", "message", "send", "--to", "demo"]],
    ["metadata-owned plugin command", ["node", "openclaw", "googlemeet", "login"]],
  ])("starts managed proxy routing for %s", (_name, argv) => {
    expect(shouldStartProxyForCli(argv)).toBe(true);
  });

  it.each([
    ["root help", ["node", "openclaw", "--help"]],
    ["root version", ["node", "openclaw", "--version"]],
    ["gateway help", ["node", "openclaw", "gateway", "--help"]],
    ["gateway run help", ["node", "openclaw", "gateway", "run", "--help"]],
    ["status", ["node", "openclaw", "status"]],
    ["health", ["node", "openclaw", "health"]],
    ["gateway status", ["node", "openclaw", "gateway", "status"]],
    ["gateway health", ["node", "openclaw", "gateway", "health"]],
    ["remote agent control-plane", ["node", "openclaw", "agent", "run"]],
    ["chat control-plane", ["node", "openclaw", "chat"]],
    ["terminal control-plane", ["node", "openclaw", "terminal"]],
    ["config", ["node", "openclaw", "config", "get", "proxy.enabled"]],
    ["channels parent help", ["node", "openclaw", "channels"]],
    ["completion", ["node", "openclaw", "completion", "zsh"]],
    ["debug proxy cli", ["node", "openclaw", "proxy", "start"]],
    ["agents list", ["node", "openclaw", "agents", "list"]],
    ["models list", ["node", "openclaw", "models", "list"]],
    ["models status without live probe", ["node", "openclaw", "models", "status"]],
    ["skills check", ["node", "openclaw", "skills", "check"]],
    ["skills info", ["node", "openclaw", "skills", "info", "weather"]],
    ["skills list", ["node", "openclaw", "skills", "list"]],
    ["tasks list", ["node", "openclaw", "tasks", "list"]],
    ["legacy singular tool namespace", ["node", "openclaw", "tool", "image_generate"]],
    ["gateway tools namespace typo", ["node", "openclaw", "tools", "effective"]],
    ["migrate", ["node", "openclaw", "migrate"]],
  ])("skips managed proxy routing for %s", (_name, argv) => {
    expect(shouldStartProxyForCli(argv)).toBe(false);
  });

  it("starts the managed proxy for network-capable commands by default", async () => {
    tryRouteCliMock.mockResolvedValueOnce(true);

    await runCli(["node", "openclaw", "plugins", "marketplace", "list"]);

    expect(startProxyMock).toHaveBeenCalledWith(undefined);
  });

  it("starts the managed proxy for metadata-owned plugin commands by default", async () => {
    tryRouteCliMock.mockResolvedValueOnce(true);

    await runCli(["node", "openclaw", "googlemeet", "login"]);

    expect(startProxyMock).toHaveBeenCalledWith(undefined);
  });

  it("rejects unowned command roots before proxy and plugin runtime registration", async () => {
    await expect(runCli(["node", "openclaw", "foo"])).rejects.toThrow(
      'No built-in command or plugin CLI metadata owns "foo"',
    );

    expect(startProxyMock).not.toHaveBeenCalled();
    expect(tryRouteCliMock).not.toHaveBeenCalled();
    expect(buildProgramMock).not.toHaveBeenCalled();
    expect(registerPluginCliCommandsFromValidatedConfigMock).not.toHaveBeenCalled();
  });

  it("does not suggest plugins.allow for unknown command roots before proxy startup", async () => {
    loadConfigMock.mockReturnValueOnce({
      plugins: {
        allow: ["browser"],
      },
    });

    let error: unknown;
    try {
      await runCli(["node", "openclaw", "totally-unknown"]);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain(
      'No built-in command or plugin CLI metadata owns "totally-unknown"',
    );
    expect((error as Error).message).not.toContain("plugins.allow");
    expect(startProxyMock).not.toHaveBeenCalled();
    expect(tryRouteCliMock).not.toHaveBeenCalled();
    expect(registerPluginCliCommandsFromValidatedConfigMock).not.toHaveBeenCalled();
  });

  it("preserves plugins.allow diagnostics for roots owned only by CLI metadata", async () => {
    loadConfigMock.mockReturnValueOnce({
      plugins: {
        allow: ["browser"],
      },
    });
    resolvePluginCliRootOwnerIdsMock.mockImplementation(
      ({
        cfg,
        primaryCommand,
      }: {
        cfg?: { plugins?: { allow?: string[] } };
        primaryCommand?: string;
      }) => (primaryCommand === "qa" && cfg?.plugins?.allow?.length === 0 ? ["qa-lab"] : []),
    );

    await expect(runCli(["node", "openclaw", "qa"])).rejects.toThrow(
      'Add "qa-lab" to `plugins.allow` instead of "qa"',
    );
    expect(startProxyMock).not.toHaveBeenCalled();
    expect(tryRouteCliMock).not.toHaveBeenCalled();
    expect(registerPluginCliCommandsFromValidatedConfigMock).not.toHaveBeenCalled();
  });

  it("reports plugin tool command mistakes before proxy startup", async () => {
    resolveManifestToolOwnerMock.mockReturnValueOnce({
      toolName: "lcm_recent",
      pluginId: "lossless-claw",
      availability: "loaded",
    });

    await expect(runCli(["node", "openclaw", "lcm_recent"])).rejects.toThrow(
      '"lcm_recent" is an agent tool available from the "lossless-claw" plugin',
    );

    expect(startProxyMock).not.toHaveBeenCalled();
    expect(tryRouteCliMock).not.toHaveBeenCalled();
    expect(registerPluginCliCommandsFromValidatedConfigMock).not.toHaveBeenCalled();
  });

  it("does not install the env proxy dispatcher for bypassed skills inspection commands", async () => {
    hasEnvHttpProxyAgentConfiguredMock.mockReturnValue(true);
    tryRouteCliMock.mockResolvedValueOnce(true);

    await runCli(["node", "openclaw", "skills", "check"]);

    expect(hasEnvHttpProxyAgentConfiguredMock).not.toHaveBeenCalled();
    expect(ensureGlobalUndiciEnvProxyDispatcherMock).not.toHaveBeenCalled();
  });

  it.each([
    ["auth", ["node", "openclaw", "auth", "--help"]],
    ["tool", ["node", "openclaw", "tool", "image_generate"]],
    ["tools", ["node", "openclaw", "tools", "effective"]],
  ])("keeps reserved %s command roots out of plugin command discovery", async (_name, argv) => {
    const parseAsync = vi.fn().mockResolvedValueOnce(undefined);
    const program = {
      commands: [],
      parseAsync,
    };
    buildProgramMock.mockReturnValueOnce(program);

    await runCli(argv);

    expect(startProxyMock).not.toHaveBeenCalled();
    expect(registerSubCliByNameMock.mock.calls).toEqual([[program, argv[2], argv]]);
    expect(registerPluginCliCommandsFromValidatedConfigMock).not.toHaveBeenCalled();
    expect(parseAsync).toHaveBeenCalledWith(argv);
  });

  it("routes lazy plugin registration logs to stderr only during --json registration", async () => {
    tryRouteCliMock.mockResolvedValueOnce(false);
    resolvePluginCliRootOwnerIdsMock.mockImplementation(
      ({ primaryCommand }: { primaryCommand?: string }) =>
        primaryCommand === "memory" ? ["memory"] : [],
    );
    let stderrDuringPluginRegistration = false;
    let stderrDuringParse = true;
    registerPluginCliCommandsFromValidatedConfigMock.mockImplementationOnce(async () => {
      stderrDuringPluginRegistration = loggingState.forceConsoleToStderr;
      return {};
    });
    const parseAsync = vi.fn().mockImplementationOnce(async () => {
      stderrDuringParse = loggingState.forceConsoleToStderr;
    });
    buildProgramMock.mockReturnValueOnce({
      commands: [],
      parseAsync,
    });

    await runCli(["node", "openclaw", "memory", "search", "query", "--json"]);

    expect(registerPluginCliCommandsFromValidatedConfigMock).toHaveBeenCalledWith(
      expect.anything(),
      undefined,
      undefined,
      { mode: "lazy", primary: "memory" },
    );
    expect(stderrDuringPluginRegistration).toBe(true);
    expect(stderrDuringParse).toBe(false);
    expect(loggingState.forceConsoleToStderr).toBe(false);
  });

  it("does not route lazy plugin registration logs for pass-through --json after terminator", async () => {
    tryRouteCliMock.mockResolvedValueOnce(false);
    resolvePluginCliRootOwnerIdsMock.mockImplementation(
      ({ primaryCommand }: { primaryCommand?: string }) =>
        primaryCommand === "memory" ? ["memory"] : [],
    );
    let stderrDuringPluginRegistration = true;
    registerPluginCliCommandsFromValidatedConfigMock.mockImplementationOnce(async () => {
      stderrDuringPluginRegistration = loggingState.forceConsoleToStderr;
      return {};
    });
    const parseAsync = vi.fn().mockResolvedValueOnce(undefined);
    buildProgramMock.mockReturnValueOnce({
      commands: [],
      parseAsync,
    });

    await runCli(["node", "openclaw", "memory", "--", "--json"]);

    expect(registerPluginCliCommandsFromValidatedConfigMock).toHaveBeenCalledWith(
      expect.anything(),
      undefined,
      undefined,
      { mode: "lazy", primary: "memory" },
    );
    expect(stderrDuringPluginRegistration).toBe(false);
    expect(loggingState.forceConsoleToStderr).toBe(false);
  });

  it("fails protected commands when managed proxy activation fails", async () => {
    startProxyMock.mockRejectedValueOnce(new Error("proxy: enabled but no HTTP proxy URL"));

    await expect(runCli(["node", "openclaw", "gateway", "run"])).rejects.toThrow(
      "proxy: enabled but no HTTP proxy URL",
    );

    expect(tryRouteCliMock).not.toHaveBeenCalled();
    expect(stopProxyMock).not.toHaveBeenCalled();
  });

  it("fails protected commands when config cannot be loaded for managed proxy startup", async () => {
    loadConfigMock.mockImplementationOnce(() => {
      throw new Error("config parse failed");
    });

    await expect(runCli(["node", "openclaw", "gateway", "run"])).rejects.toThrow(
      "config parse failed",
    );

    expect(startProxyMock).not.toHaveBeenCalled();
    expect(tryRouteCliMock).not.toHaveBeenCalled();
  });

  it("stops the managed proxy after normal gateway runtime completion", async () => {
    const handle = makeProxyHandle();
    startProxyMock.mockResolvedValueOnce(handle);

    await runCli(["node", "openclaw", "gateway", "run"]);

    expect(startProxyMock).toHaveBeenCalledWith(undefined);
    expect(stopProxyMock).toHaveBeenCalledOnce();
    expect(stopProxyMock).toHaveBeenCalledWith(handle);
  });

  it("stops the managed proxy and exits after SIGINT", async () => {
    const handle = makeProxyHandle();
    startProxyMock.mockResolvedValueOnce(handle);
    let resolveRoute: (value: boolean) => void = () => {};
    tryRouteCliMock.mockReturnValueOnce(
      new Promise<boolean>((resolve) => {
        resolveRoute = resolve;
      }),
    );

    const processOnceSpy = vi.spyOn(process, "once");
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number | string) => {
      void code;
      return undefined as never;
    }) as typeof process.exit);

    try {
      const runPromise = runCli(["node", "openclaw", "plugins", "marketplace", "list"]);
      await vi.waitFor(() => {
        expect(
          processOnceSpy.mock.calls.some(
            ([event, listener]) => event === "SIGINT" && typeof listener === "function",
          ),
        ).toBe(true);
      });

      const sigintHandler = processOnceSpy.mock.calls.find(([event]) => event === "SIGINT")?.[1];
      if (typeof sigintHandler !== "function") {
        throw new Error("SIGINT handler was not registered");
      }
      sigintHandler();

      await vi.waitFor(() => {
        expect(stopProxyMock).toHaveBeenCalledWith(handle);
      });
      await vi.waitFor(() => {
        expect(exitSpy).toHaveBeenCalledWith(130);
      });

      resolveRoute(true);
      await runPromise;
      expect(stopProxyMock).toHaveBeenCalledTimes(1);
    } finally {
      exitSpy.mockRestore();
      processOnceSpy.mockRestore();
    }
  });

  it("synchronously kills the managed proxy during hard process exit", async () => {
    const handle = makeProxyHandle();
    startProxyMock.mockResolvedValueOnce(handle);
    let resolveRoute: (value: boolean) => void = () => {};
    tryRouteCliMock.mockReturnValueOnce(
      new Promise<boolean>((resolve) => {
        resolveRoute = resolve;
      }),
    );

    const processOnceSpy = vi.spyOn(process, "once");
    try {
      const runPromise = runCli(["node", "openclaw", "plugins", "marketplace", "list"]);
      await vi.waitFor(() => {
        expect(
          processOnceSpy.mock.calls.reduce(
            (count, [event]) => count + (event === "exit" ? 1 : 0),
            0,
          ),
        ).toBe(2);
      });

      const exitHandler = processOnceSpy.mock.calls.find(([event]) => event === "exit")?.[1];
      if (typeof exitHandler !== "function") {
        throw new Error("exit handler was not registered");
      }
      exitHandler(0 as never);

      expect(handle.kill).toHaveBeenCalledWith("SIGTERM");
      resolveRoute(true);
      await runPromise;
      expect(stopProxyMock).not.toHaveBeenCalledWith(handle);
    } finally {
      processOnceSpy.mockRestore();
    }
  });

  it("bootstraps env proxy before bare Crestodian startup", async () => {
    hasEnvHttpProxyAgentConfiguredMock.mockReturnValue(true);
    const stdinTty = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
    const stdoutTty = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
    Object.defineProperty(process.stdin, "isTTY", { configurable: true, value: true });
    Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: true });

    try {
      await runCli(["node", "openclaw"]);
    } finally {
      if (stdinTty) {
        Object.defineProperty(process.stdin, "isTTY", stdinTty);
      } else {
        delete (process.stdin as { isTTY?: boolean }).isTTY;
      }
      if (stdoutTty) {
        Object.defineProperty(process.stdout, "isTTY", stdoutTty);
      } else {
        delete (process.stdout as { isTTY?: boolean }).isTTY;
      }
    }

    expect(ensureGlobalUndiciEnvProxyDispatcherMock).toHaveBeenCalledTimes(1);
    expect(runCrestodianMock).toHaveBeenCalledOnce();
    const crestodianOptions = requireRunCrestodianOptions();
    expect(crestodianOptions).toEqual({ onReady: crestodianOptions.onReady });
    expect(crestodianOptions.onReady).toBeTypeOf("function");
    expect(ensureGlobalUndiciEnvProxyDispatcherMock.mock.invocationCallOrder[0]).toBeLessThan(
      runCrestodianMock.mock.invocationCallOrder[0],
    );
  });

  it("bootstraps env proxy before modern onboard Crestodian startup", async () => {
    hasEnvHttpProxyAgentConfiguredMock.mockReturnValue(true);

    await runCli(["node", "openclaw", "onboard", "--modern", "--json"]);

    expect(ensureGlobalUndiciEnvProxyDispatcherMock).toHaveBeenCalledTimes(1);
    expect(runCrestodianMock).toHaveBeenCalledWith({
      message: undefined,
      yes: false,
      json: true,
      interactive: true,
    });
    expect(ensureGlobalUndiciEnvProxyDispatcherMock.mock.invocationCallOrder[0]).toBeLessThan(
      runCrestodianMock.mock.invocationCallOrder[0],
    );
  });

  it("closes memory managers when a runtime was registered", async () => {
    tryRouteCliMock.mockResolvedValueOnce(true);
    hasMemoryRuntimeMock.mockReturnValue(true);

    await runCli(["node", "openclaw", "status"]);

    expect(closeActiveMemorySearchManagersMock).toHaveBeenCalledTimes(1);
  });

  it("does not fail the command when memory cleanup is unavailable", async () => {
    tryRouteCliMock.mockResolvedValueOnce(true);
    hasMemoryRuntimeMock.mockImplementationOnce(() => {
      throw new Error("stale memory-state chunk");
    });

    await expect(runCli(["node", "openclaw", "status"])).resolves.toBeUndefined();

    expect(closeActiveMemorySearchManagersMock).not.toHaveBeenCalled();
  });

  it("returns after a handled container-target invocation", async () => {
    maybeRunCliInContainerMock.mockReturnValueOnce({ handled: true, exitCode: 0 });

    await runCli(["node", "openclaw", "--container", "demo", "status"]);

    expect(maybeRunCliInContainerMock).toHaveBeenCalledWith([
      "node",
      "openclaw",
      "--container",
      "demo",
      "status",
    ]);
    expect(loadDotEnvMock).not.toHaveBeenCalled();
    expect(tryRouteCliMock).not.toHaveBeenCalled();
    expect(closeActiveMemorySearchManagersMock).not.toHaveBeenCalled();
  });

  it("propagates a handled container-target exit code", async () => {
    const exitCode = process.exitCode;
    maybeRunCliInContainerMock.mockReturnValueOnce({ handled: true, exitCode: 7 });

    await runCli(["node", "openclaw", "--container", "demo", "status"]);

    expect(process.exitCode).toBe(7);
    process.exitCode = exitCode;
  });

  it("swallows Commander parse exits after recording the exit code", async () => {
    const exitCode = process.exitCode;
    const program = {
      commands: [{ name: () => "status" }],
      parseAsync: vi
        .fn()
        .mockRejectedValueOnce(
          new CommanderError(1, "commander.excessArguments", "too many arguments for 'status'"),
        ),
    };
    buildProgramMock.mockReturnValueOnce(program);

    await expect(runCli(["node", "openclaw", "status"])).resolves.toBeUndefined();

    expect(registerSubCliByNameMock.mock.calls).toEqual([
      [program, "status", ["node", "openclaw", "status"]],
    ]);
    expect(process.exitCode).toBe(1);
    process.exitCode = exitCode;
  });

  it("loads the real primary command before rendering command help", async () => {
    const program = {
      commands: [{ name: () => "doctor" }],
      parseAsync: vi.fn().mockResolvedValueOnce(undefined),
    };
    buildProgramMock.mockReturnValueOnce(program);
    const ctx = { programVersion: "0.0.0-test" };
    getProgramContextMock.mockReturnValueOnce(ctx as never);

    await runCli(["node", "openclaw", "doctor", "--help"]);

    expect(registerCoreCliByNameMock.mock.calls).toEqual([
      [program, ctx, "doctor", ["node", "openclaw", "doctor", "--help"]],
    ]);
    expect(registerSubCliByNameMock.mock.calls).toEqual([
      [program, "doctor", ["node", "openclaw", "doctor", "--help"]],
    ]);
  });

  it("restores terminal state before uncaught CLI exits", async () => {
    buildProgramMock.mockReturnValueOnce({
      commands: [{ name: () => "status" }],
      parseAsync: vi.fn().mockResolvedValueOnce(undefined),
    });

    const processOnSpy = vi.spyOn(process, "on");
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`process.exit(${String(code)})`);
    }) as typeof process.exit);

    await runCli(["node", "openclaw", "status"]);

    const handler = processOnSpy.mock.calls.find(([event]) => event === "uncaughtException")?.[1];
    if (typeof handler !== "function") {
      throw new Error("uncaughtException handler was not registered");
    }

    try {
      expect(() => handler(new Error("boom"))).toThrow("process.exit(1)");
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        "[openclaw] OpenClaw hit an unexpected runtime error.",
      );
      expect(consoleErrorSpy).toHaveBeenCalledWith("[openclaw] Reason: boom");
      expect(restoreTerminalStateMock).toHaveBeenCalledWith("uncaught exception", {
        resumeStdinIfPaused: false,
      });
    } finally {
      if (typeof handler === "function") {
        process.off("uncaughtException", handler);
      }
      consoleErrorSpy.mockRestore();
      exitSpy.mockRestore();
      processOnSpy.mockRestore();
    }
  });

  it("does not exit for transient uncaught CLI exceptions", async () => {
    buildProgramMock.mockReturnValueOnce({
      commands: [{ name: () => "status" }],
      parseAsync: vi.fn().mockResolvedValueOnce(undefined),
    });

    const processOnSpy = vi.spyOn(process, "on");
    const consoleWarnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`process.exit(${String(code)})`);
    }) as typeof process.exit);

    await runCli(["node", "openclaw", "status"]);

    const handler = processOnSpy.mock.calls.find(([event]) => event === "uncaughtException")?.[1];
    if (typeof handler !== "function") {
      throw new Error("uncaughtException handler was not registered");
    }

    try {
      const hostUnreachable = Object.assign(new Error("connect EHOSTUNREACH 149.154.167.220:443"), {
        code: "EHOSTUNREACH",
      });
      expect(handler(hostUnreachable)).toBeUndefined();
      expect(consoleWarnSpy.mock.calls).toEqual([
        ["[openclaw] Non-fatal uncaught exception (continuing):", hostUnreachable.stack],
      ]);
      expect(restoreTerminalStateMock).not.toHaveBeenCalled();
      expect(exitSpy).not.toHaveBeenCalled();
    } finally {
      if (typeof handler === "function") {
        process.off("uncaughtException", handler);
      }
      consoleWarnSpy.mockRestore();
      exitSpy.mockRestore();
      processOnSpy.mockRestore();
    }
  });
});
