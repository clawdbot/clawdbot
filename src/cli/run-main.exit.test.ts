// Run main exit tests cover process exit behavior for CLI failures.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { expectDefined } from "@openclaw/normalization-core";
import { CommanderError } from "commander";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { GATEWAY_SERVICE_RUNTIME_PID_ENV } from "../daemon/constants.js";
import { createNewerSqliteSchemaVersionError } from "../infra/sqlite-user-version.js";
import { setLoggerOverride } from "../logging/logger.js";
import { loggingState } from "../logging/state.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { getPluginCache, getScopedPluginCache, type PluginCache } from "../plugins/plugin-cache.js";
import { withSecureTestNodeExecPath } from "../secrets/test-node-command.test-support.js";
import type { LocalOnboardingState } from "../state/local-onboarding-state.js";
import { captureEnv, withEnvAsync } from "../test-utils/env.js";
import { ExpectedCliError } from "./failure-output.js";
import { getGatewayRunRuntimeHooks } from "./gateway-cli/runtime-hooks.js";
import type { RootHelpRenderOptions } from "./program/root-help.js";
import { registerSignalExitBarrier } from "./signal-exit-barrier.js";

const TLS_FINGERPRINT = "ab".repeat(32);
const PREFIXED_TLS_FINGERPRINT = `sha256:${TLS_FINGERPRINT.toUpperCase()}`;

type RunMainModule = typeof import("./run-main.js");

let runCli: RunMainModule["runCli"];
let shouldStartProxyForCli: RunMainModule["shouldStartProxyForCli"];

type ConfigSnapshotStub = {
  exists: boolean;
  hash?: string;
  issues?: Array<{ message: string; path: string }>;
  legacyIssues?: Array<{ message: string; path: string }>;
  path?: string;
  raw?: string | null;
  valid: boolean;
  sourceConfig: Record<string, unknown>;
};

type ConfigSnapshotReadOptionsStub = {
  isolateEnv?: boolean;
  observe?: boolean;
  recoverSuspicious?: boolean;
  allowSuspiciousRecovery?: (
    candidate: Record<string, unknown>,
    current: Record<string, unknown>,
  ) => boolean | Promise<boolean>;
};

const tryRouteCliMock = vi.hoisted(() => vi.fn());
const loadDotEnvMock = vi.hoisted(() => vi.fn());
const dotenvModuleImportState = vi.hoisted(() => ({ count: 0 }));
const existsSyncOverride = vi.hoisted(
  () =>
    ({ value: undefined }) as {
      value: ((target: string) => boolean) | undefined;
    },
);
const normalizeEnvMock = vi.hoisted(() => vi.fn());
const pinConfigDirMock = vi.hoisted(() => vi.fn());
const pinRuntimePathsMock = vi.hoisted(() => vi.fn());
const ensurePathMock = vi.hoisted(() => vi.fn());
const assertRuntimeMock = vi.hoisted(() => vi.fn());
const closeActiveMemorySearchManagersMock = vi.hoisted(() => vi.fn(async () => {}));
const hasMemoryRuntimeMock = vi.hoisted(() => vi.fn(() => false));
const listRegisteredAgentHarnessesMock = vi.hoisted(() => vi.fn((): unknown[] => []));
const disposeRegisteredAgentHarnessesMock = vi.hoisted(() => vi.fn(async () => {}));
const hasManagedProviderLocalServicesMock = vi.hoisted(() => vi.fn(() => false));
const hasProviderTransportDispatcherPoolMock = vi.hoisted(() => vi.fn(() => false));
const providerCleanupModuleImportState = vi.hoisted(() => ({ local: 0, transport: 0 }));
const stopManagedProviderLocalServicesMock = vi.hoisted(() => vi.fn());
const closeProviderTransportDispatcherPoolMock = vi.hoisted(() => vi.fn(async () => {}));
const getActiveMcpLoopbackRuntimeMock = vi.hoisted(() =>
  vi.fn<() => { port: number } | undefined>(() => undefined),
);
const closeMcpLoopbackServerMock = vi.hoisted(() => vi.fn(async () => {}));
const ensureTaskRegistryReadyMock = vi.hoisted(() => vi.fn());
const startTaskRegistryMaintenanceMock = vi.hoisted(() => vi.fn());
const outputRootHelpMock = vi.hoisted(() => vi.fn());
const outputPrecomputedRootHelpTextMock = vi.hoisted(() => vi.fn(() => false));
const outputPrecomputedBrowserHelpTextMock = vi.hoisted(() => vi.fn(() => false));
const outputPrecomputedSecretsHelpTextMock = vi.hoisted(() => vi.fn(() => false));
const outputPrecomputedNodesHelpTextMock = vi.hoisted(() => vi.fn(() => false));
const outputPrecomputedSubcommandHelpTextMock = vi.hoisted(() => vi.fn(() => false));
const loadRootHelpRenderOptionsForConfigSensitivePluginsMock = vi.hoisted(() =>
  vi.fn<() => Promise<RootHelpRenderOptions | null>>(async () => null),
);
const tryOutputSetupOnboardConfigureHelpMock = vi.hoisted(() => vi.fn(async () => true));
const buildProgramMock = vi.hoisted(() => vi.fn());
const parkCurrentLaunchAgentForMaintenanceMock = vi.hoisted(() => vi.fn(async () => true));
const getProgramContextMock = vi.hoisted(() => vi.fn(() => null));
const registerCoreCliByNameMock = vi.hoisted(() => vi.fn());
const registerSubCliByNameMock = vi.hoisted(() => vi.fn());
const registerPluginCliCommandsFromValidatedConfigMock = vi.hoisted(() => vi.fn(async () => ({})));
const resolvePluginCliRootOwnerIdsMock = vi.hoisted(() => vi.fn());
const createPluginCliLoadSessionMock = vi.hoisted(() =>
  vi.fn(() => ({
    readConfig: <T>(read: () => Promise<T>) => read(),
    withCache: <T>(run: () => T) => run(),
    close: vi.fn(),
  })),
);
const loadPluginCliDescriptorsMock = vi.hoisted(() =>
  vi.fn<
    () => Promise<
      Array<{
        name: string;
        description: string;
        hasSubcommands: boolean;
        machineOutput?: (params: { argv: readonly string[]; stdoutIsTTY: boolean }) => boolean;
      }>
    >
  >(async () => []),
);
const resolveManifestCommandAliasOwnerMock = vi.hoisted(() => vi.fn());
const resolveManifestToolOwnerMock = vi.hoisted(() => vi.fn());
const resolveManifestCliCommandSurfaceOwnerMock = vi.hoisted(() => vi.fn());
const restoreRuntimeTerminalStateMock = vi.hoisted(() => vi.fn());
const hasEnvHttpProxyAgentConfiguredMock = vi.hoisted(() => vi.fn(() => false));
const ensureGlobalUndiciEnvProxyDispatcherMock = vi.hoisted(() => vi.fn());
const readConfigFileSnapshotMock = vi.hoisted(() =>
  vi.fn<(options?: ConfigSnapshotReadOptionsStub) => Promise<ConfigSnapshotStub>>(async () => ({
    exists: true,
    valid: true,
    sourceConfig: { gateway: { mode: "local" } },
  })),
);
const readLocalOnboardingStateMock = vi.hoisted(() =>
  vi.fn<
    (
      configPath: string,
      config: { wizard?: { securityAcknowledgedAt?: string } },
    ) => LocalOnboardingState | undefined
  >(() => undefined),
);
const setupWizardCommandMock = vi.hoisted(() => vi.fn(async () => {}));
const runRemoteGatewayInferenceOnboardingMock = vi.hoisted(() => vi.fn(async () => {}));
const runTuiMock = vi.hoisted(() => vi.fn<(opts: unknown) => Promise<void>>(async () => {}));
const runTuiCliActionMock = vi.hoisted(() =>
  vi.fn<(target: string | undefined, opts: unknown) => Promise<void>>(async () => {}),
);
const probeGatewayConfiguredModelMock = vi.hoisted(() =>
  vi.fn<typeof import("../commands/onboard-helpers.js").probeGatewayConfiguredModel>(async () => ({
    kind: "configured",
  })),
);
const readActiveGatewayLockPortMock = vi.hoisted(() =>
  vi.fn(async (): Promise<number | undefined> => undefined),
);
const loadGatewayTlsRuntimeMock = vi.hoisted(() =>
  vi.fn<
    () => Promise<{
      enabled: boolean;
      required: boolean;
      fingerprintSha256?: string;
    }>
  >(async () => ({ enabled: false, required: false })),
);
const resolveControlUiLinksMock = vi.hoisted(() =>
  vi.fn(() => ({
    httpUrl: "http://127.0.0.1:18789/",
    wsUrl: "ws://127.0.0.1:18789",
  })),
);
const commanderParseAsyncMock = vi.hoisted(() => vi.fn(async () => {}));
type GatewayRunCommandHooks = {
  beforeRun?: (opts: { reset?: boolean }) => Promise<void>;
};
type CliExecutionBootstrapOptions = {
  beforeStateMigrations?: (snapshot?: ConfigSnapshotStub) => Promise<boolean>;
};
const addGatewayRunCommandMock = vi.hoisted(() =>
  vi.fn<(command: unknown, hooks?: GatewayRunCommandHooks) => unknown>((command) => command),
);
const ensureCliExecutionBootstrapMock = vi.hoisted(() =>
  vi.fn<(_opts: CliExecutionBootstrapOptions) => Promise<void>>(async () => {}),
);
const emitCliBannerMock = vi.hoisted(() => vi.fn());
const enableConsoleCaptureMock = vi.hoisted(() => vi.fn());
const progressDoneMock = vi.hoisted(() => vi.fn());
const createCliProgressMock = vi.hoisted(() =>
  vi.fn(() => ({
    done: progressDoneMock,
  })),
);
const loadConfigMock = vi.hoisted(() =>
  vi.fn<
    (...args: Parameters<typeof import("../config/io.js").readBestEffortConfig>) => OpenClawConfig
  >(() => ({})),
);
const readSourceConfigBestEffortMock = vi.hoisted(() => vi.fn(async () => ({})));
const startProxyMock = vi.hoisted(() =>
  vi.fn<(config: unknown) => Promise<unknown>>(async () => null),
);
const stopProxyMock = vi.hoisted(() => vi.fn<(handle: unknown) => Promise<void>>(async () => {}));
const flushExitAfterOneShotOutputMock = vi.hoisted(() => vi.fn());
const requestExitAfterOneShotOutputMock = vi.hoisted(() => vi.fn());
const maybeRunCliInContainerMock = vi.hoisted(() =>
  vi.fn<
    (argv: string[]) => { handled: true; exitCode: number } | { handled: false; argv: string[] }
  >((argv: string[]) => ({ handled: false, argv })),
);
const serviceEnvSnapshot = captureEnv([
  "OPENCLAW_SERVICE_MARKER",
  "OPENCLAW_SERVICE_KIND",
  GATEWAY_SERVICE_RUNTIME_PID_ENV,
]);

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

vi.mock("./gateway-cli/run-command.js", () => ({
  addGatewayRunCommand: addGatewayRunCommandMock,
}));

vi.mock("../daemon/launchd.js", () => ({
  parkCurrentLaunchAgentForMaintenance: parkCurrentLaunchAgentForMaintenanceMock,
}));

vi.mock("./command-execution-startup.js", () => ({
  ensureCliExecutionBootstrap: ensureCliExecutionBootstrapMock,
}));

vi.mock("../version.js", () => ({
  VERSION: "9.9.9-test",
  resolveRuntimeServiceCommit: () => null,
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

vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  return {
    ...actual,
    existsSync: (target: Parameters<typeof actual.existsSync>[0]) =>
      typeof target === "string" && existsSyncOverride.value
        ? existsSyncOverride.value(target)
        : actual.existsSync(target),
  };
});

vi.mock("./dotenv.js", () => {
  dotenvModuleImportState.count += 1;
  return {
    loadCliDotEnv: loadDotEnvMock,
  };
});

vi.mock("./one-shot-exit.js", () => ({
  flushExitAfterOneShotOutput: flushExitAfterOneShotOutputMock,
  requestExitAfterOneShotOutput: requestExitAfterOneShotOutputMock,
}));

vi.mock("../infra/env.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../infra/env.js")>()),
  normalizeEnv: normalizeEnvMock,
}));

vi.mock("../config/paths.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../config/paths.js")>()),
  pinRuntimePaths: pinRuntimePathsMock,
}));

vi.mock("../gateway/control-ui-links.js", () => ({
  resolveControlUiLinks: resolveControlUiLinksMock,
}));

vi.mock("../infra/gateway-lock.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../infra/gateway-lock.js")>()),
  readActiveGatewayLockPort: readActiveGatewayLockPortMock,
}));

vi.mock("../infra/tls/gateway.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../infra/tls/gateway.js")>()),
  loadGatewayTlsRuntime: loadGatewayTlsRuntimeMock,
}));

vi.mock("../utils.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../utils.js")>()),
  pinConfigDir: pinConfigDirMock,
}));

vi.mock("../infra/path-env.js", () => ({
  ensureOpenClawCliOnPath: ensurePathMock,
}));

vi.mock("../infra/runtime-guard.js", () => ({
  assertSupportedRuntime: assertRuntimeMock,
}));

vi.mock("../plugins/memory-runtime.js", () => ({
  closeActiveMemorySearchManagersCore: closeActiveMemorySearchManagersMock,
}));

vi.mock("../plugins/memory-state.js", () => ({
  hasMemoryRuntime: hasMemoryRuntimeMock,
}));

vi.mock("../agents/harness/registry.js", () => ({
  listRegisteredAgentHarnesses: listRegisteredAgentHarnessesMock,
  disposeRegisteredAgentHarnesses: disposeRegisteredAgentHarnessesMock,
}));

vi.mock("../agents/provider-runtime-lifecycle.js", () => ({
  hasManagedProviderLocalServices: hasManagedProviderLocalServicesMock,
  hasProviderTransportDispatcherPool: hasProviderTransportDispatcherPoolMock,
}));

vi.mock("../agents/provider-local-service.js", () => {
  providerCleanupModuleImportState.local += 1;
  return { stopManagedProviderLocalServices: stopManagedProviderLocalServicesMock };
});

vi.mock("../agents/provider-transport-dispatcher-pool.js", () => {
  providerCleanupModuleImportState.transport += 1;
  return { closeProviderTransportDispatcherPool: closeProviderTransportDispatcherPoolMock };
});

vi.mock("../gateway/mcp-http.loopback-runtime.js", () => ({
  getActiveMcpLoopbackRuntime: getActiveMcpLoopbackRuntimeMock,
}));

vi.mock("../gateway/mcp-http.js", () => ({
  closeMcpLoopbackServer: closeMcpLoopbackServerMock,
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
  outputPrecomputedNodesHelpText: outputPrecomputedNodesHelpTextMock,
  outputPrecomputedRootHelpText: outputPrecomputedRootHelpTextMock,
  outputPrecomputedSecretsHelpText: outputPrecomputedSecretsHelpTextMock,
  outputPrecomputedSubcommandHelpText: outputPrecomputedSubcommandHelpTextMock,
}));

vi.mock("./root-help-live-config.js", () => ({
  loadRootHelpRenderOptionsForConfigSensitivePlugins:
    loadRootHelpRenderOptionsForConfigSensitivePluginsMock,
}));

vi.mock("./setup-onboard-configure-help-fast-path.js", () => ({
  tryOutputSetupOnboardConfigureHelp: tryOutputSetupOnboardConfigureHelpMock,
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
  loadPluginCliDescriptors: loadPluginCliDescriptorsMock,
  createPluginCliLoadSession: createPluginCliLoadSessionMock,
  resolvePluginCliRootOwnerIds: resolvePluginCliRootOwnerIdsMock,
}));

vi.mock("../plugins/manifest-command-aliases.runtime.js", () => ({
  resolveManifestCliCommandSurfaceOwner: resolveManifestCliCommandSurfaceOwnerMock,
  resolveManifestCommandAliasOwner: resolveManifestCommandAliasOwnerMock,
  resolveManifestToolOwner: resolveManifestToolOwnerMock,
}));

vi.mock("../runtime.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../runtime.js")>();
  return {
    ...actual,
    restoreRuntimeTerminalState: restoreRuntimeTerminalStateMock,
  };
});

vi.mock("../infra/net/proxy-env.js", () => ({
  hasEnvHttpProxyAgentConfigured: hasEnvHttpProxyAgentConfiguredMock,
}));

vi.mock("../infra/net/undici-global-dispatcher.js", () => ({
  ensureGlobalUndiciEnvProxyDispatcher: ensureGlobalUndiciEnvProxyDispatcherMock,
}));

vi.mock("../config/config.js", () => ({
  readConfigFileSnapshot: readConfigFileSnapshotMock,
}));

vi.mock("../state/local-onboarding-state.js", () => ({
  readLocalOnboardingStateForConfig: readLocalOnboardingStateMock,
}));

vi.mock("../commands/onboard.js", () => ({
  setupWizardCommand: setupWizardCommandMock,
}));

vi.mock("../commands/onboard-remote-gateway.js", () => ({
  runRemoteGatewayInferenceOnboarding: runRemoteGatewayInferenceOnboardingMock,
}));

vi.mock("../commands/onboard-helpers.js", () => ({
  probeGatewayConfiguredModel: probeGatewayConfiguredModelMock,
}));

vi.mock("../tui/tui.js", () => ({
  runTui: runTuiMock,
}));

vi.mock("./tui-cli.js", () => ({
  runTuiCliAction: runTuiCliActionMock,
}));

vi.mock("./progress.js", () => ({
  createCliProgress: createCliProgressMock,
}));

vi.mock("../config/io.js", () => ({
  readBestEffortConfig: loadConfigMock,
  readBestEffortConfigSnapshot: async (...args: Parameters<typeof loadConfigMock>) => ({
    config: loadConfigMock(...args),
  }),
  readSourceConfigBestEffort: readSourceConfigBestEffortMock,
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

async function withCliTty(value: boolean, fn: () => Promise<void>): Promise<void> {
  const stdinDescriptor = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
  const stdoutDescriptor = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
  Object.defineProperty(process.stdin, "isTTY", { configurable: true, value });
  Object.defineProperty(process.stdout, "isTTY", { configurable: true, value });
  try {
    await fn();
  } finally {
    if (stdinDescriptor) {
      Object.defineProperty(process.stdin, "isTTY", stdinDescriptor);
    } else {
      Reflect.deleteProperty(process.stdin, "isTTY");
    }
    if (stdoutDescriptor) {
      Object.defineProperty(process.stdout, "isTTY", stdoutDescriptor);
    } else {
      Reflect.deleteProperty(process.stdout, "isTTY");
    }
  }
}

function withInteractiveTty(fn: () => Promise<void>): Promise<void> {
  return withCliTty(true, fn);
}

function runBareCli(): Promise<void> {
  return withInteractiveTty(() => runCli(["node", "openclaw"]));
}

function expectBoundTui(expected: {
  url: string;
  token?: string;
  password?: string;
  tlsFingerprint?: string;
}): void {
  expect(runTuiMock).toHaveBeenCalledWith(
    expect.objectContaining({
      deliver: false,
      forceProcessExitOnReturn: true,
      boundGateway: expected,
    }),
  );
}

function primeBareRootConfig(sourceConfig: ConfigSnapshotStub["sourceConfig"]): void {
  readConfigFileSnapshotMock.mockResolvedValueOnce({ exists: true, valid: true, sourceConfig });
}

async function expectNonInteractiveBareCliError(
  message: string,
  assert?: () => void,
): Promise<void> {
  const previousExitCode = process.exitCode;
  const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  process.exitCode = undefined;
  try {
    await withCliTty(false, () => runCli(["node", "openclaw"]));
    expect(process.exitCode).toBe(1);
    expect(errorSpy).toHaveBeenCalledWith(message);
    assert?.();
  } finally {
    errorSpy.mockRestore();
    process.exitCode = previousExitCode;
  }
}

describe("runCli exit behavior", () => {
  beforeAll(async () => {
    expect(dotenvModuleImportState.count).toBe(0);
    const runMainModule = await import("./run-main.js");
    expect(dotenvModuleImportState.count).toBe(0);
    runCli = runMainModule.runCli;
    shouldStartProxyForCli = runMainModule.shouldStartProxyForCli;
  });

  afterAll(() => {
    serviceEnvSnapshot.restore();
  });

  beforeEach(() => {
    delete process.env.OPENCLAW_SERVICE_MARKER;
    delete process.env.OPENCLAW_SERVICE_KIND;
    // Sibling CLI suites run `gateway run --token/--password`, which exports
    // credentials into process.env; leaked values change gateway preflight
    // auth in shared vitest workers.
    delete process.env.OPENCLAW_GATEWAY_TOKEN;
    delete process.env.OPENCLAW_GATEWAY_PASSWORD;
    delete process.env[GATEWAY_SERVICE_RUNTIME_PID_ENV];
    existsSyncOverride.value = undefined;
    vi.clearAllMocks();
    readConfigFileSnapshotMock.mockResolvedValue({
      exists: true,
      valid: true,
      sourceConfig: { gateway: { mode: "local" } },
    });
    readLocalOnboardingStateMock.mockReset().mockReturnValue(undefined);
    probeGatewayConfiguredModelMock.mockResolvedValue({ kind: "configured" });
    readActiveGatewayLockPortMock.mockReset().mockResolvedValue(undefined);
    loadGatewayTlsRuntimeMock.mockReset().mockResolvedValue({
      enabled: false,
      required: false,
    });
    resolveControlUiLinksMock.mockReturnValue({
      httpUrl: "http://127.0.0.1:18789/",
      wsUrl: "ws://127.0.0.1:18789",
    });
    hasMemoryRuntimeMock.mockReturnValue(false);
    listRegisteredAgentHarnessesMock.mockReturnValue([]);
    hasManagedProviderLocalServicesMock.mockReturnValue(false);
    hasProviderTransportDispatcherPoolMock.mockReturnValue(false);
    outputPrecomputedBrowserHelpTextMock.mockReturnValue(false);
    outputPrecomputedNodesHelpTextMock.mockReturnValue(false);
    outputPrecomputedRootHelpTextMock.mockReturnValue(false);
    outputPrecomputedSecretsHelpTextMock.mockReturnValue(false);
    outputPrecomputedSubcommandHelpTextMock.mockReturnValue(false);
    loadRootHelpRenderOptionsForConfigSensitivePluginsMock.mockResolvedValue(null);
    tryOutputSetupOnboardConfigureHelpMock.mockResolvedValue(true);
    hasEnvHttpProxyAgentConfiguredMock.mockReturnValue(false);
    loadConfigMock.mockReturnValue({});
    startProxyMock.mockResolvedValue(null);
    stopProxyMock.mockResolvedValue(undefined);
    getProgramContextMock.mockReturnValue(null);
    loadPluginCliDescriptorsMock.mockReset().mockResolvedValue([]);
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

  it("carries one lightweight generation through builtin reads, nested registration and actions", async () => {
    const outside = getPluginCache();
    const phases: PluginCache[] = [];
    loadConfigMock.mockImplementationOnce(() => {
      phases.push(getPluginCache());
      return {};
    });
    registerSubCliByNameMock.mockImplementationOnce(async () => {
      await Promise.resolve();
      phases.push(getPluginCache());
    });
    const parseAsync = vi.fn(async () => {
      await Promise.resolve();
      phases.push(getPluginCache());
    });
    const program = {
      commands: [{ name: () => "plugins", aliases: () => [] }],
      parseAsync,
    };
    buildProgramMock.mockReturnValueOnce(program).mockReturnValueOnce(program);
    tryRouteCliMock.mockResolvedValueOnce(false).mockResolvedValueOnce(false);

    await runCli(["node", "openclaw", "plugins", "late"]);

    expect(phases).toHaveLength(3);
    const owner = phases[0]!;
    expect(owner.kind).toBe("operation");
    expect(phases.every((cache) => cache === owner)).toBe(true);
    expect(owner).not.toBe(outside);
    expect(getPluginCache()).toBe(outside);
    expect(createPluginCliLoadSessionMock).not.toHaveBeenCalled();
    expect(registerPluginCliCommandsFromValidatedConfigMock).not.toHaveBeenCalled();

    await runCli(["node", "openclaw", "plugins", "late"]);
    expect(phases.at(-1)).not.toBe(owner);
    expect(getPluginCache()).toBe(outside);
  });

  it("does not replace Gateway's cache owner on the full Commander path", async () => {
    const owner = getPluginCache();
    const scoped = getScopedPluginCache();
    const parseAsync = vi.fn(async () => {
      await Promise.resolve();
      expect(getPluginCache()).toBe(owner);
      expect(getScopedPluginCache()).toBe(scoped);
    });
    buildProgramMock.mockReturnValueOnce({
      commands: [{ name: () => "gateway", aliases: () => [] }],
      parseAsync,
    });
    tryRouteCliMock.mockResolvedValueOnce(false);
    await runCli(["node", "openclaw", "--log-level", "debug", "gateway", "run"]);
    expect(parseAsync).toHaveBeenCalledTimes(1);
    expect(getPluginCache()).toBe(owner);
  });

  it.each(["environment selection", "full Commander preaction"])(
    "parks the managed Gateway when a newer schema blocks %s",
    async (phase) => {
      const error = createNewerSqliteSchemaVersionError(
        "OpenClaw state database",
        "/tmp/openclaw-startup/state/openclaw.sqlite",
        14,
        13,
      );
      const argv = ["node", "openclaw", "--log-level", "debug", "gateway", "run"];
      if (phase === "environment selection") {
        readConfigFileSnapshotMock.mockRejectedValueOnce(error);
      } else {
        buildProgramMock.mockReturnValueOnce({
          commands: [{ name: () => "gateway", aliases: () => [] }],
          parseAsync: vi.fn().mockRejectedValueOnce(error),
        });
        tryRouteCliMock.mockResolvedValueOnce(false);
      }
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      const exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
        throw new Error(`exit:${code}`);
      }) as never);
      try {
        await expect(runCli(argv)).rejects.toThrow("exit:78");

        expect(parkCurrentLaunchAgentForMaintenanceMock).toHaveBeenCalledOnce();
        expect(exitSpy).toHaveBeenCalledWith(78);
        expect(errorSpy.mock.calls.flat().join("\n")).toContain(error.message);
        expect(addGatewayRunCommandMock).not.toHaveBeenCalled();
        if (phase === "environment selection") {
          expect(buildProgramMock).not.toHaveBeenCalled();
        } else {
          expect(buildProgramMock).toHaveBeenCalledOnce();
        }
      } finally {
        errorSpy.mockRestore();
        exitSpy.mockRestore();
      }
    },
  );

  it.each([
    { label: "Gateway help", args: ["gateway", "--help"] },
    { label: "another command", args: ["status"] },
  ])("does not park the Gateway for a newer-schema failure during $label", async ({ args }) => {
    const error = createNewerSqliteSchemaVersionError(
      "OpenClaw state database",
      "/tmp/openclaw-startup/state/openclaw.sqlite",
      14,
      13,
    );
    buildProgramMock.mockReturnValueOnce({
      commands: [{ name: () => args[0], aliases: () => [] }],
      parseAsync: vi.fn().mockRejectedValueOnce(error),
    });

    await withEnvAsync({ OPENCLAW_DISABLE_CLI_STARTUP_HELP_FAST_PATH: "1" }, async () => {
      await expect(runCli(["node", "openclaw", ...args])).rejects.toBe(error);
    });

    expect(parkCurrentLaunchAgentForMaintenanceMock).not.toHaveBeenCalled();
  });

  it("does not load inactive provider cleanup modules for cold help", async () => {
    const parseAsync = vi.fn().mockResolvedValueOnce(undefined);
    buildProgramMock.mockReturnValueOnce({
      commands: [{ name: () => "nodes", aliases: () => [] }],
      parseAsync,
    });

    await withEnvAsync({ OPENCLAW_DISABLE_CLI_STARTUP_HELP_FAST_PATH: "1" }, async () => {
      await runCli(["node", "openclaw", "nodes", "--help"]);
    });

    expect(parseAsync).toHaveBeenCalledWith(["node", "openclaw", "nodes", "--help"]);
    expect(providerCleanupModuleImportState).toEqual({ local: 0, transport: 0 });
  });

  it("does not import dotenv for gateway forms without a workspace file", async () => {
    existsSyncOverride.value = () => false;
    expect(dotenvModuleImportState.count).toBe(0);

    await runCli(["node", "openclaw", "gateway"]);
    await runCli(["node", "openclaw", "gateway", "run"]);
    tryRouteCliMock.mockResolvedValueOnce(false);
    buildProgramMock.mockReturnValueOnce({
      commands: [{ name: () => "gateway", aliases: () => [] }],
      parseAsync: commanderParseAsyncMock,
    });
    await runCli(["node", "openclaw", "--log-level", "debug", "gateway", "run"]);

    expect(dotenvModuleImportState.count).toBe(0);
    expect(loadDotEnvMock).not.toHaveBeenCalled();
    expect(buildProgramMock).toHaveBeenCalledTimes(1);
    expect(commanderParseAsyncMock).toHaveBeenLastCalledWith([
      "node",
      "openclaw",
      "--log-level",
      "debug",
      "gateway",
      "run",
    ]);
  });

  it("does not force process.exit after successful routed command", async () => {
    tryRouteCliMock.mockResolvedValueOnce(true);
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`unexpected process.exit(${String(code)})`);
    }) as typeof process.exit);

    await runCli(["node", "openclaw", "status"]);

    expect(maybeRunCliInContainerMock).toHaveBeenCalledWith(["node", "openclaw", "status"]);
    expect(enableConsoleCaptureMock).toHaveBeenCalledTimes(1);
    expect(tryRouteCliMock).toHaveBeenCalledWith(["node", "openclaw", "status"]);
    const captureOrder = enableConsoleCaptureMock.mock.invocationCallOrder[0] ?? 0;
    const routeOrder = tryRouteCliMock.mock.invocationCallOrder[0] ?? 0;
    expect(captureOrder).toBeGreaterThan(0);
    expect(routeOrder).toBeGreaterThan(captureOrder);
    expect(closeActiveMemorySearchManagersMock).not.toHaveBeenCalled();
    expect(disposeRegisteredAgentHarnessesMock).not.toHaveBeenCalled();
    expect(ensureTaskRegistryReadyMock).not.toHaveBeenCalled();
    expect(startTaskRegistryMaintenanceMock).not.toHaveBeenCalled();
    expect(exitSpy).not.toHaveBeenCalled();
    exitSpy.mockRestore();
  });

  it("passes config get machine ownership into route-first startup", async () => {
    tryRouteCliMock.mockResolvedValueOnce(true);

    await runCli(["node", "openclaw", "config", "get", "gateway.port"]);

    expect(tryRouteCliMock).toHaveBeenCalledWith(
      ["node", "openclaw", "config", "get", "gateway.port"],
      { machineOutput: true },
    );
  });

  it("disposes registered harnesses after full CLI command completion", async () => {
    listRegisteredAgentHarnessesMock.mockReturnValueOnce([{ harness: { id: "codex" } }]);
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

  it("completes asynchronous teardown before returning to the outer entrypoint", async () => {
    const order: string[] = [];
    listRegisteredAgentHarnessesMock.mockReturnValueOnce([{ harness: { id: "copilot" } }]);
    hasManagedProviderLocalServicesMock.mockReturnValueOnce(true);
    hasProviderTransportDispatcherPoolMock.mockReturnValueOnce(true);
    disposeRegisteredAgentHarnessesMock.mockImplementationOnce(async () => {
      order.push("harnesses");
    });
    stopManagedProviderLocalServicesMock.mockImplementationOnce(() => {
      order.push("provider-local-services");
    });
    closeProviderTransportDispatcherPoolMock.mockImplementationOnce(async () => {
      order.push("provider-transport-dispatchers");
    });
    getActiveMcpLoopbackRuntimeMock.mockReturnValueOnce({ port: 1234 });
    closeMcpLoopbackServerMock.mockImplementationOnce(async () => {
      order.push("mcp-loopback");
    });
    hasMemoryRuntimeMock.mockReturnValueOnce(true);
    closeActiveMemorySearchManagersMock.mockImplementationOnce(async () => {
      order.push("memory");
    });
    tryRouteCliMock.mockResolvedValueOnce(true);

    await runCli(["node", "openclaw", "models", "status", "--probe"]);

    expect(order).toEqual([
      "harnesses",
      "provider-local-services",
      "provider-transport-dispatchers",
      "mcp-loopback",
      "memory",
    ]);
    expect(flushExitAfterOneShotOutputMock).not.toHaveBeenCalled();
  });

  it("does not fail the command when MCP loopback cleanup fails", async () => {
    tryRouteCliMock.mockResolvedValueOnce(true);
    getActiveMcpLoopbackRuntimeMock.mockReturnValueOnce({ port: 1234 });
    closeMcpLoopbackServerMock.mockRejectedValueOnce(new Error("listener cleanup failed"));

    await expect(runCli(["node", "openclaw", "status"])).resolves.toBeUndefined();

    expect(closeMcpLoopbackServerMock).toHaveBeenCalledTimes(1);
  });

  it("shows the standard spinner while loading the full CLI", async () => {
    tryRouteCliMock.mockResolvedValueOnce(false);
    const parseAsync = vi.fn().mockResolvedValueOnce(undefined);
    buildProgramMock.mockReturnValueOnce({
      commands: [{ name: () => "config", aliases: () => [] }],
      parseAsync,
    });

    await runCli(["node", "openclaw", "config"]);

    expect(createCliProgressMock).toHaveBeenCalledWith({
      label: "Loading OpenClaw CLI…",
      indeterminate: true,
      delayMs: 0,
    });
    expect(progressDoneMock).toHaveBeenCalledTimes(1);
  });

  it("suppresses startup progress for json output commands before full CLI parsing", async () => {
    tryRouteCliMock.mockResolvedValueOnce(false);
    const parseAsync = vi.fn().mockResolvedValueOnce(undefined);
    buildProgramMock.mockReturnValueOnce({
      commands: [{ name: () => "sessions", aliases: () => [] }],
      parseAsync,
    });

    await runCli(["node", "openclaw", "sessions", "--json", "--limit", "all"]);

    expect(createCliProgressMock).toHaveBeenCalledWith({
      label: "Loading OpenClaw CLI…",
      indeterminate: true,
      delayMs: 0,
      enabled: false,
    });
    expect(parseAsync).toHaveBeenCalledWith([
      "node",
      "openclaw",
      "sessions",
      "--json",
      "--limit",
      "all",
    ]);
    expect(progressDoneMock).toHaveBeenCalledTimes(1);
  });

  it("suppresses startup progress for plain model output before full CLI parsing", async () => {
    tryRouteCliMock.mockResolvedValueOnce(false);
    const parseAsync = vi.fn().mockResolvedValueOnce(undefined);
    buildProgramMock.mockReturnValueOnce({
      commands: [{ name: () => "models", aliases: () => [] }],
      parseAsync,
    });

    await runCli(["node", "openclaw", "models", "aliases", "list", "--plain"]);

    expect(createCliProgressMock).toHaveBeenCalledWith({
      label: "Loading OpenClaw CLI…",
      indeterminate: true,
      delayMs: 0,
      enabled: false,
    });
    expect(parseAsync).toHaveBeenCalledWith([
      "node",
      "openclaw",
      "models",
      "aliases",
      "list",
      "--plain",
    ]);
    expect(progressDoneMock).toHaveBeenCalledTimes(1);
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

  it("configures the gateway foreground fast path with the standard CLI bootstrap", async () => {
    await runCli(["node", "openclaw", "gateway", "--force"]);

    expect(readConfigFileSnapshotMock.mock.calls).toEqual([[{ isolateEnv: true, observe: false }]]);
    const hooks = addGatewayRunCommandMock.mock.calls[0]?.[1] as
      | { beforeRun?: (opts: { reset?: boolean }) => Promise<void> }
      | undefined;
    await hooks?.beforeRun?.({});

    expect(ensureCliExecutionBootstrapMock).toHaveBeenCalledWith(
      expect.objectContaining({
        beforeStateMigrations: expect.any(Function),
        commandPath: ["gateway"],
        loadPlugins: false,
      }),
    );
    expect(readConfigFileSnapshotMock).toHaveBeenCalledWith({
      isolateEnv: true,
      recoverSuspicious: true,
      allowSuspiciousRecovery: expect.any(Function),
    });
    const recoveryOrder = readConfigFileSnapshotMock.mock.invocationCallOrder[2] ?? 0;
    const bootstrapOrder = ensureCliExecutionBootstrapMock.mock.invocationCallOrder[0] ?? 0;
    expect(recoveryOrder).toBeGreaterThan(0);
    expect(bootstrapOrder).toBeGreaterThan(recoveryOrder);
  });

  it("defers config-drift exit to the migration owner before startup migrations", async () => {
    readConfigFileSnapshotMock.mockResolvedValue({
      exists: true,
      hash: "guarded",
      path: "/tmp/openclaw.json",
      raw: "{}",
      valid: true,
      sourceConfig: {
        cron: { store: "/tmp/included-a.json" },
        gateway: { mode: "local" },
      },
    });
    await runCli(["node", "openclaw", "gateway"]);
    const hooks = addGatewayRunCommandMock.mock.calls[0]?.[1] as
      | { beforeRun?: (opts: { reset?: boolean }) => Promise<void> }
      | undefined;
    await hooks?.beforeRun?.({});
    const beforeStateMigrations = (
      ensureCliExecutionBootstrapMock.mock.calls[0]?.[0] as
        | { beforeStateMigrations?: (snapshot?: ConfigSnapshotStub) => Promise<boolean> }
        | undefined
    )?.beforeStateMigrations;
    readConfigFileSnapshotMock.mockResolvedValue({
      exists: true,
      hash: "guarded",
      path: "/tmp/openclaw.json",
      raw: "{}",
      valid: true,
      sourceConfig: {
        cron: { store: "/tmp/included-b.json" },
        gateway: { mode: "local" },
      },
    });
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`exit:${String(code)}`);
    }) as typeof process.exit);
    try {
      await expect(beforeStateMigrations?.()).rejects.toMatchObject({
        name: "ExitError",
        code: 1,
      });
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("changed during startup"));
      expect(exitSpy).not.toHaveBeenCalled();
    } finally {
      exitSpy.mockRestore();
      errorSpy.mockRestore();
    }
  });

  it("defers a service-mode future-config exit to the migration owner", async () => {
    readConfigFileSnapshotMock.mockResolvedValue({
      exists: true,
      hash: "guarded",
      path: "/tmp/openclaw.json",
      raw: "{}",
      valid: true,
      sourceConfig: { gateway: { mode: "local" } },
    });
    await runCli(["node", "openclaw", "gateway"]);
    const hooks = addGatewayRunCommandMock.mock.calls[0]?.[1] as
      | { beforeRun?: (opts: { reset?: boolean }) => Promise<void> }
      | undefined;
    await hooks?.beforeRun?.({});
    const beforeStateMigrations =
      ensureCliExecutionBootstrapMock.mock.calls[0]?.[0]?.beforeStateMigrations;
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`exit:${String(code)}`);
    }) as typeof process.exit);
    try {
      await withEnvAsync(
        {
          OPENCLAW_ALLOW_OLDER_BINARY_DESTRUCTIVE_ACTIONS: "1",
          OPENCLAW_SERVICE_MARKER: undefined,
        },
        async () => {
          await expect(
            beforeStateMigrations?.({
              exists: true,
              hash: "future",
              path: "/tmp/openclaw.json",
              raw: "{}",
              valid: true,
              sourceConfig: {
                env: { vars: { OPENCLAW_SERVICE_MARKER: "gateway" } },
                meta: { lastTouchedVersion: "9999.1.1" },
              },
            }),
          ).rejects.toMatchObject({ name: "ExitError", code: 78 });
          expect(errorSpy).toHaveBeenCalledWith(
            expect.stringContaining("start the gateway service"),
          );
          expect(process.env.OPENCLAW_ALLOW_OLDER_BINARY_DESTRUCTIVE_ACTIONS).toBeUndefined();
          expect(exitSpy).not.toHaveBeenCalled();
        },
      );
    } finally {
      exitSpy.mockRestore();
      errorSpy.mockRestore();
    }
  });

  it.each([
    {
      name: "automatic startup migrations",
      flags: [],
      marker: undefined,
      override: undefined,
      expectedAction: "run automatic gateway startup migrations",
      expectedExitCode: 1,
    },
    {
      name: "service-mode startup",
      flags: [],
      marker: "gateway",
      override: "1",
      expectedAction: "start the gateway service",
      expectedExitCode: 78,
    },
    {
      name: "forced port cleanup",
      flags: ["--force"],
      marker: undefined,
      override: undefined,
      expectedAction: "force-kill gateway port listeners",
      expectedExitCode: 1,
    },
    {
      name: "dev reset",
      flags: ["--dev", "--reset"],
      marker: undefined,
      override: undefined,
      expectedAction: "reset the dev gateway state",
      expectedExitCode: 1,
    },
    {
      name: "forced dev reset",
      flags: ["--dev", "--reset", "--force"],
      marker: undefined,
      override: undefined,
      expectedAction: "reset the dev gateway state",
      expectedExitCode: 1,
    },
  ])("blocks future-config $name before gateway bootstrap", async (params) => {
    readConfigFileSnapshotMock.mockResolvedValue({
      exists: true,
      valid: true,
      sourceConfig: { meta: { lastTouchedVersion: "9999.1.1" } },
    });
    const previousMarker = process.env.OPENCLAW_SERVICE_MARKER;
    const previousOverride = process.env.OPENCLAW_ALLOW_OLDER_BINARY_DESTRUCTIVE_ACTIONS;
    if (params.marker) {
      process.env.OPENCLAW_SERVICE_MARKER = params.marker;
    } else {
      delete process.env.OPENCLAW_SERVICE_MARKER;
    }
    if (params.override) {
      process.env.OPENCLAW_ALLOW_OLDER_BINARY_DESTRUCTIVE_ACTIONS = params.override;
    } else {
      delete process.env.OPENCLAW_ALLOW_OLDER_BINARY_DESTRUCTIVE_ACTIONS;
    }
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`exit:${String(code)}`);
    }) as typeof process.exit);
    try {
      await expect(runCli(["node", "openclaw", "gateway", ...params.flags])).rejects.toThrow(
        `exit:${params.expectedExitCode}`,
      );
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining(params.expectedAction));
      expect(ensureCliExecutionBootstrapMock).not.toHaveBeenCalled();
      expect(readConfigFileSnapshotMock.mock.calls).toEqual([
        [{ isolateEnv: true, observe: false }],
      ]);
      if (params.marker) {
        expect(process.env.OPENCLAW_ALLOW_OLDER_BINARY_DESTRUCTIVE_ACTIONS).toBeUndefined();
      }
    } finally {
      exitSpy.mockRestore();
      errorSpy.mockRestore();
      if (previousMarker === undefined) {
        delete process.env.OPENCLAW_SERVICE_MARKER;
      } else {
        process.env.OPENCLAW_SERVICE_MARKER = previousMarker;
      }
      if (previousOverride === undefined) {
        delete process.env.OPENCLAW_ALLOW_OLDER_BINARY_DESTRUCTIVE_ACTIONS;
      } else {
        process.env.OPENCLAW_ALLOW_OLDER_BINARY_DESTRUCTIVE_ACTIONS = previousOverride;
      }
    }
  });

  it("blocks and revokes the destructive override when selected config declares service mode", async () => {
    readConfigFileSnapshotMock.mockResolvedValue({
      exists: true,
      valid: true,
      sourceConfig: {
        env: { vars: { OPENCLAW_SERVICE_MARKER: "gateway" } },
        meta: { lastTouchedVersion: "9999.1.1" },
      },
    });
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`exit:${String(code)}`);
    }) as typeof process.exit);
    try {
      await withEnvAsync(
        {
          OPENCLAW_ALLOW_OLDER_BINARY_DESTRUCTIVE_ACTIONS: "1",
          OPENCLAW_SERVICE_MARKER: undefined,
        },
        async () => {
          await expect(runCli(["node", "openclaw", "gateway"])).rejects.toThrow("exit:78");
          expect(process.env.OPENCLAW_SERVICE_MARKER).toBeUndefined();
          expect(process.env.OPENCLAW_ALLOW_OLDER_BINARY_DESTRUCTIVE_ACTIONS).toBeUndefined();
          expect(ensureCliExecutionBootstrapMock).not.toHaveBeenCalled();
        },
      );
    } finally {
      exitSpy.mockRestore();
      errorSpy.mockRestore();
    }
  });

  it("ignores service mode declared by an invalid selected config", async () => {
    readConfigFileSnapshotMock.mockResolvedValue({
      exists: true,
      issues: [{ message: "invalid", path: "gateway" }],
      legacyIssues: [],
      valid: false,
      sourceConfig: {
        env: { vars: { OPENCLAW_SERVICE_MARKER: "gateway" } },
        meta: { lastTouchedVersion: "9999.1.1" },
      },
    });

    await withEnvAsync(
      {
        OPENCLAW_ALLOW_OLDER_BINARY_DESTRUCTIVE_ACTIONS: "1",
        OPENCLAW_SERVICE_MARKER: undefined,
      },
      async () => {
        await runCli(["node", "openclaw", "gateway"]);

        expect(process.env.OPENCLAW_SERVICE_MARKER).toBeUndefined();
        expect(process.env.OPENCLAW_ALLOW_OLDER_BINARY_DESTRUCTIVE_ACTIONS).toBe("1");
      },
    );
  });

  it("guards the config selected by trusted global dotenv before the default config", async () => {
    const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-gateway-global-selection-"));
    const stateDir = path.join(homeDir, ".openclaw");
    const selectedConfigPath = path.join(stateDir, "selected.json");
    await fs.mkdir(stateDir, { recursive: true });
    await fs.writeFile(
      path.join(stateDir, ".env"),
      [
        `OPENCLAW_CONFIG_PATH=${selectedConfigPath}`,
        "OPENCLAW_ALLOW_OLDER_BINARY_DESTRUCTIVE_ACTIONS=1",
        "",
      ].join("\n"),
    );
    try {
      await withEnvAsync(
        {
          HOME: homeDir,
          OPENCLAW_ALLOW_OLDER_BINARY_DESTRUCTIVE_ACTIONS: undefined,
          OPENCLAW_CONFIG_PATH: undefined,
          OPENCLAW_HOME: homeDir,
          OPENCLAW_STATE_DIR: undefined,
        },
        async () => {
          readConfigFileSnapshotMock.mockImplementation(async () =>
            process.env.OPENCLAW_CONFIG_PATH === selectedConfigPath
              ? {
                  exists: true,
                  valid: true,
                  sourceConfig: { gateway: { mode: "local" } },
                }
              : {
                  exists: true,
                  valid: true,
                  sourceConfig: { meta: { lastTouchedVersion: "9999.1.1" } },
                },
          );

          await runCli(["node", "openclaw", "gateway"]);

          expect(process.env.OPENCLAW_CONFIG_PATH).toBe(selectedConfigPath);
          expect(process.env.OPENCLAW_ALLOW_OLDER_BINARY_DESTRUCTIVE_ACTIONS).toBeUndefined();
          expect(readConfigFileSnapshotMock).toHaveBeenCalledOnce();
        },
      );
    } finally {
      await fs.rm(homeDir, { recursive: true, force: true });
    }
  });

  it("loads state dotenv before a custom config-root fallback", async () => {
    const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-gateway-config-env-"));
    const stateDir = path.join(homeDir, ".openclaw");
    const configDir = path.join(homeDir, "profile");
    const configPath = path.join(configDir, "openclaw.json");
    await fs.mkdir(stateDir, { recursive: true });
    await fs.mkdir(configDir, { recursive: true });
    await fs.writeFile(path.join(stateDir, ".env"), "OPENCLAW_GATEWAY_TOKEN=state-token\n");
    await fs.writeFile(
      path.join(configDir, ".env"),
      [
        "OPENCLAW_GATEWAY_PASSWORD=config-root-password",
        "OPENCLAW_GATEWAY_TOKEN=config-root-token",
        "",
      ].join("\n"),
    );
    try {
      await withEnvAsync(
        {
          HOME: homeDir,
          OPENCLAW_CONFIG_PATH: configPath,
          OPENCLAW_GATEWAY_PASSWORD: undefined,
          OPENCLAW_GATEWAY_TOKEN: undefined,
          OPENCLAW_HOME: homeDir,
          OPENCLAW_STATE_DIR: undefined,
        },
        async () => {
          await runCli(["node", "openclaw", "gateway"]);

          expect(process.env.OPENCLAW_GATEWAY_TOKEN).toBe("state-token");
          expect(process.env.OPENCLAW_GATEWAY_PASSWORD).toBe("config-root-password");
        },
      );
    } finally {
      await fs.rm(homeDir, { recursive: true, force: true });
    }
  });

  it("loads and repins a legacy state dotenv after automatic state migration", async () => {
    const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-gateway-legacy-env-"));
    const legacyStateDir = path.join(homeDir, ".clawdbot");
    const newStateDir = path.join(homeDir, ".openclaw");
    await fs.mkdir(legacyStateDir, { recursive: true });
    await fs.writeFile(path.join(legacyStateDir, ".env"), "OPENCLAW_GATEWAY_TOKEN=legacy-token\n");
    try {
      await withEnvAsync(
        {
          HOME: homeDir,
          OPENCLAW_CONFIG_PATH: undefined,
          OPENCLAW_GATEWAY_TOKEN: undefined,
          OPENCLAW_HOME: homeDir,
          OPENCLAW_STATE_DIR: undefined,
          OPENCLAW_TEST_FAST: undefined,
        },
        async () => {
          ensureCliExecutionBootstrapMock.mockImplementationOnce(async () => {
            await fs.rename(legacyStateDir, newStateDir);
          });
          await runCli(["node", "openclaw", "gateway"]);
          const hooks = addGatewayRunCommandMock.mock.calls[0]?.[1] as
            | { beforeRun?: (opts: { reset?: boolean }) => Promise<void> }
            | undefined;
          await hooks?.beforeRun?.({});

          expect(process.env.OPENCLAW_GATEWAY_TOKEN).toBe("legacy-token");
          await expect(fs.access(path.join(newStateDir, ".env"))).resolves.toBeUndefined();
          const bootstrapOrder = ensureCliExecutionBootstrapMock.mock.invocationCallOrder[0] ?? 0;
          const finalPinOrder = pinRuntimePathsMock.mock.invocationCallOrder.at(-1) ?? 0;
          expect(finalPinOrder).toBeGreaterThan(bootstrapOrder);
        },
      );
    } finally {
      await fs.rm(homeDir, { recursive: true, force: true });
    }
  });

  it("blocks a future-config recovery candidate before destructive gateway reset", async () => {
    const currentSnapshot = {
      exists: true,
      valid: true,
      sourceConfig: { gateway: { mode: "local" } },
    };
    readConfigFileSnapshotMock.mockImplementation(async (options) => {
      if (options?.recoverSuspicious) {
        await options?.allowSuspiciousRecovery?.(
          {
            meta: { lastTouchedVersion: "9999.1.1" },
            gateway: { mode: "local" },
          },
          currentSnapshot.sourceConfig,
        );
      }
      return currentSnapshot;
    });
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`exit:${String(code)}`);
    }) as typeof process.exit);
    try {
      await runCli(["node", "openclaw", "gateway", "--dev", "--reset"]);
      const hooks = addGatewayRunCommandMock.mock.calls[0]?.[1] as
        | { beforeRun?: (opts: { reset?: boolean }) => Promise<void> }
        | undefined;
      await expect(hooks?.beforeRun?.({ reset: true })).rejects.toThrow("exit:1");
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining("Refusing to reset the dev gateway state"),
      );
      expect(ensureCliExecutionBootstrapMock).not.toHaveBeenCalled();
    } finally {
      exitSpy.mockRestore();
      errorSpy.mockRestore();
    }
  });

  it("blocks a future current config before pre-bootstrap suspicious recovery", async () => {
    const currentSnapshot = {
      exists: true,
      valid: true,
      sourceConfig: { gateway: { mode: "local" } },
    };
    readConfigFileSnapshotMock.mockImplementation(async (options) => {
      if (options?.recoverSuspicious) {
        await options.allowSuspiciousRecovery?.(
          { gateway: { mode: "local" } },
          {
            meta: { lastTouchedVersion: "9999.1.1" },
            gateway: { mode: "local" },
          },
        );
      }
      return currentSnapshot;
    });
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`exit:${String(code)}`);
    }) as typeof process.exit);
    try {
      await runCli(["node", "openclaw", "gateway"]);
      const hooks = addGatewayRunCommandMock.mock.calls[0]?.[1] as
        | { beforeRun?: (opts: { force?: boolean }) => Promise<void> }
        | undefined;
      await expect(hooks?.beforeRun?.({})).rejects.toThrow("exit:1");
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining("run automatic gateway startup migrations"),
      );
      expect(ensureCliExecutionBootstrapMock).not.toHaveBeenCalled();
    } finally {
      exitSpy.mockRestore();
      errorSpy.mockRestore();
    }
  });

  it("blocks a future service-mode candidate before pre-bootstrap suspicious recovery", async () => {
    const currentSnapshot = {
      exists: true,
      valid: true,
      sourceConfig: { gateway: { mode: "local" } },
    };
    readConfigFileSnapshotMock.mockImplementation(async (options) => {
      if (options?.recoverSuspicious) {
        await options.allowSuspiciousRecovery?.(
          {
            env: { vars: { OPENCLAW_SERVICE_MARKER: "gateway" } },
            gateway: { mode: "local" },
            meta: { lastTouchedVersion: "9999.1.1" },
          },
          { gateway: { mode: "local" } },
        );
      }
      return currentSnapshot;
    });
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`exit:${String(code)}`);
    }) as typeof process.exit);
    try {
      await withEnvAsync(
        {
          OPENCLAW_ALLOW_OLDER_BINARY_DESTRUCTIVE_ACTIONS: "1",
          OPENCLAW_SERVICE_MARKER: undefined,
        },
        async () => {
          await runCli(["node", "openclaw", "gateway"]);
          const hooks = addGatewayRunCommandMock.mock.calls[0]?.[1] as
            | { beforeRun?: (opts: { force?: boolean }) => Promise<void> }
            | undefined;
          await expect(hooks?.beforeRun?.({})).rejects.toThrow("exit:78");
        },
      );
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("start the gateway service"));
      expect(ensureCliExecutionBootstrapMock).not.toHaveBeenCalled();
    } finally {
      exitSpy.mockRestore();
      errorSpy.mockRestore();
    }
  });

  it("re-guards config env path selection until the gateway config is stable", async () => {
    const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-gateway-selection-"));
    try {
      await withEnvAsync(
        {
          HOME: homeDir,
          OPENCLAW_CONFIG_PATH: undefined,
          OPENCLAW_HOME: homeDir,
          OPENCLAW_STATE_DIR: undefined,
        },
        async () => {
          readConfigFileSnapshotMock.mockImplementation(async () => {
            if (process.env.OPENCLAW_CONFIG_PATH === "/tmp/openclaw-chain-c.json") {
              return {
                exists: true,
                valid: true,
                sourceConfig: { meta: { lastTouchedVersion: "9999.1.1" } },
              };
            }
            if (process.env.OPENCLAW_STATE_DIR === "/tmp/openclaw-chain-b") {
              return {
                exists: true,
                valid: true,
                sourceConfig: {
                  env: { vars: { OPENCLAW_CONFIG_PATH: "/tmp/openclaw-chain-c.json" } },
                  gateway: { mode: "local" },
                },
              };
            }
            return {
              exists: true,
              valid: true,
              sourceConfig: {
                env: { vars: { OPENCLAW_STATE_DIR: "/tmp/openclaw-chain-b" } },
                gateway: { mode: "local" },
              },
            };
          });
          const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
          const exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
            throw new Error(`exit:${String(code)}`);
          }) as typeof process.exit);
          try {
            await expect(runCli(["node", "openclaw", "gateway"])).rejects.toThrow("exit:1");
            expect(errorSpy).toHaveBeenCalledWith(
              expect.stringContaining("run automatic gateway startup migrations"),
            );
            expect(ensureCliExecutionBootstrapMock).not.toHaveBeenCalled();
            expect(readConfigFileSnapshotMock).toHaveBeenCalledTimes(3);
          } finally {
            exitSpy.mockRestore();
            errorSpy.mockRestore();
          }
        },
      );
    } finally {
      await fs.rm(homeDir, { recursive: true, force: true });
    }
  });

  it("re-guards config changes to Termux home selectors", async () => {
    await withEnvAsync({ ANDROID_DATA: undefined, PREFIX: undefined }, async () => {
      readConfigFileSnapshotMock.mockImplementation(async () =>
        process.env.ANDROID_DATA === "/data" &&
        process.env.PREFIX === "/data/data/com.termux/files/usr"
          ? {
              exists: true,
              valid: true,
              sourceConfig: { meta: { lastTouchedVersion: "9999.1.1" } },
            }
          : {
              exists: true,
              valid: true,
              sourceConfig: {
                env: {
                  vars: {
                    ANDROID_DATA: "/data",
                    PREFIX: "/data/data/com.termux/files/usr",
                  },
                },
                gateway: { mode: "local" },
              },
            },
      );
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      const exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
        throw new Error(`exit:${String(code)}`);
      }) as typeof process.exit);
      try {
        await expect(runCli(["node", "openclaw", "gateway"])).rejects.toThrow("exit:1");
        expect(errorSpy).toHaveBeenCalledWith(
          expect.stringContaining("run automatic gateway startup migrations"),
        );
        expect(readConfigFileSnapshotMock).toHaveBeenCalledTimes(2);
      } finally {
        exitSpy.mockRestore();
        errorSpy.mockRestore();
      }
    });
  });

  it("drops credentials from configs superseded during state selection", async () => {
    await withEnvAsync(
      {
        OPENCLAW_GATEWAY_TOKEN: undefined,
        OPENCLAW_HOME: undefined,
        OPENCLAW_STATE_DIR: undefined,
      },
      async () => {
        readConfigFileSnapshotMock.mockImplementation(async () =>
          process.env.OPENCLAW_STATE_DIR === "/tmp/openclaw-selected-state"
            ? {
                exists: true,
                valid: true,
                sourceConfig: {
                  env: { vars: { OPENCLAW_GATEWAY_TOKEN: "selected-token" } },
                  gateway: { mode: "local" },
                },
              }
            : {
                exists: true,
                valid: true,
                sourceConfig: {
                  env: {
                    vars: {
                      OPENCLAW_GATEWAY_TOKEN: "superseded-token",
                      OPENCLAW_STATE_DIR: "/tmp/openclaw-selected-state",
                    },
                  },
                  gateway: { mode: "local" },
                },
              },
        );
        await runCli(["node", "openclaw", "gateway"]);

        const hooks = addGatewayRunCommandMock.mock.calls[0]?.[1] as
          | { beforeRun?: (opts: { force?: boolean }) => Promise<void> }
          | undefined;
        await hooks?.beforeRun?.({});

        expect(process.env.OPENCLAW_STATE_DIR).toBe("/tmp/openclaw-selected-state");
        expect(process.env.OPENCLAW_GATEWAY_TOKEN).toBe("selected-token");
        expect(ensureCliExecutionBootstrapMock).toHaveBeenCalledOnce();
      },
    );
  });

  it("re-guards config selection from a newly selected state dotenv", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-gateway-dotenv-"));
    const futureConfigPath = path.join(stateDir, "future.json");
    await fs.writeFile(
      path.join(stateDir, ".env"),
      [
        `OPENCLAW_CONFIG_PATH=${futureConfigPath}`,
        "OPENCLAW_ALLOW_OLDER_BINARY_DESTRUCTIVE_ACTIONS=1",
        "",
      ].join("\n"),
    );
    try {
      await withEnvAsync(
        {
          OPENCLAW_CONFIG_PATH: undefined,
          OPENCLAW_HOME: undefined,
          OPENCLAW_STATE_DIR: undefined,
          OPENCLAW_ALLOW_OLDER_BINARY_DESTRUCTIVE_ACTIONS: undefined,
        },
        async () => {
          readConfigFileSnapshotMock.mockImplementation(async () => {
            if (process.env.OPENCLAW_CONFIG_PATH === futureConfigPath) {
              return {
                exists: true,
                valid: true,
                sourceConfig: { meta: { lastTouchedVersion: "9999.1.1" } },
              };
            }
            return {
              exists: true,
              valid: true,
              sourceConfig: {
                env: { vars: { OPENCLAW_STATE_DIR: stateDir } },
                gateway: { mode: "local" },
              },
            };
          });
          const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
          const exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
            throw new Error(`exit:${String(code)}`);
          }) as typeof process.exit);
          try {
            await expect(runCli(["node", "openclaw", "gateway"])).rejects.toThrow("exit:1");
            expect(errorSpy).toHaveBeenCalledWith(
              expect.stringContaining("run automatic gateway startup migrations"),
            );
            expect(ensureCliExecutionBootstrapMock).not.toHaveBeenCalled();
            expect(readConfigFileSnapshotMock).toHaveBeenCalledTimes(2);
            expect(process.env.OPENCLAW_ALLOW_OLDER_BINARY_DESTRUCTIVE_ACTIONS).toBeUndefined();
          } finally {
            exitSpy.mockRestore();
            errorSpy.mockRestore();
          }
        },
      );
    } finally {
      await fs.rm(stateDir, { recursive: true, force: true });
    }
  });

  it("re-inspects recovery after recovery changes config selection", async () => {
    await withEnvAsync({ OPENCLAW_CONFIG_PATH: undefined }, async () => {
      const selectedConfigPath = "/tmp/openclaw-recovered-selection.json";
      const currentSnapshot = {
        exists: true,
        valid: true,
        sourceConfig: { gateway: { mode: "local" } },
      };
      let recoveryReads = 0;
      readConfigFileSnapshotMock.mockImplementation(async (options) => {
        if (!options?.recoverSuspicious) {
          return currentSnapshot;
        }
        recoveryReads += 1;
        if (recoveryReads === 1) {
          const recoveredSnapshot = {
            exists: true,
            valid: true,
            sourceConfig: {
              env: { vars: { OPENCLAW_CONFIG_PATH: selectedConfigPath } },
              gateway: { mode: "local" },
            },
          };
          await options.allowSuspiciousRecovery?.(
            recoveredSnapshot.sourceConfig,
            currentSnapshot.sourceConfig,
          );
          return recoveredSnapshot;
        }
        await options.allowSuspiciousRecovery?.(
          {
            meta: { lastTouchedVersion: "9999.1.1" },
            gateway: { mode: "local" },
          },
          currentSnapshot.sourceConfig,
        );
        return currentSnapshot;
      });
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      const exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
        throw new Error(`exit:${String(code)}`);
      }) as typeof process.exit);
      try {
        await runCli(["node", "openclaw", "gateway"]);
        const hooks = addGatewayRunCommandMock.mock.calls[0]?.[1] as
          | { beforeRun?: (opts: { force?: boolean }) => Promise<void> }
          | undefined;
        await expect(hooks?.beforeRun?.({})).rejects.toThrow("exit:1");
        expect(errorSpy).toHaveBeenCalledWith(
          expect.stringContaining("run automatic gateway startup migrations"),
        );
        expect(ensureCliExecutionBootstrapMock).not.toHaveBeenCalled();
        expect(recoveryReads).toBe(2);
      } finally {
        exitSpy.mockRestore();
        errorSpy.mockRestore();
      }
    });
  });

  it("discards env from a config replaced by suspicious recovery", async () => {
    await withEnvAsync(
      { OPENCLAW_GATEWAY_TOKEN: undefined, OPENCLAW_PROXY_ACTIVE: undefined },
      async () => {
        const clobberedSnapshot = {
          exists: true,
          valid: true,
          sourceConfig: {
            env: { vars: { OPENCLAW_GATEWAY_TOKEN: "discarded-token" } },
            gateway: { mode: "local" },
          },
          hash: "clobbered",
          path: "/tmp/openclaw.json",
        };
        const recoveredSnapshot = {
          exists: true,
          valid: true,
          sourceConfig: { gateway: { mode: "local" } },
          hash: "recovered",
          path: "/tmp/openclaw.json",
        };
        const initialSnapshot = {
          exists: true,
          valid: true,
          sourceConfig: { gateway: { mode: "local" } },
          hash: "initial",
          path: "/tmp/openclaw.json",
        };
        let currentSnapshot = initialSnapshot;
        let recovered = false;
        readConfigFileSnapshotMock.mockImplementation(async (options) => {
          if (!options?.recoverSuspicious) {
            return recovered ? recoveredSnapshot : currentSnapshot;
          }
          recovered = true;
          await options.allowSuspiciousRecovery?.(
            recoveredSnapshot.sourceConfig,
            currentSnapshot.sourceConfig,
          );
          return recoveredSnapshot;
        });
        await runCli(["node", "openclaw", "gateway"]);

        currentSnapshot = clobberedSnapshot;
        process.env.OPENCLAW_PROXY_ACTIVE = "1";
        const hooks = addGatewayRunCommandMock.mock.calls[0]?.[1] as
          | { beforeRun?: (opts: { force?: boolean }) => Promise<void> }
          | undefined;
        await hooks?.beforeRun?.({});

        expect(process.env.OPENCLAW_GATEWAY_TOKEN).toBeUndefined();
        expect(process.env.OPENCLAW_PROXY_ACTIVE).toBe("1");
        expect(ensureCliExecutionBootstrapMock).toHaveBeenCalledOnce();
      },
    );
  });

  it("does not apply environment variables from invalid config snapshots", async () => {
    await withEnvAsync({ OPENCLAW_INCLUDE_ROOTS: undefined }, async () => {
      readConfigFileSnapshotMock.mockResolvedValue({
        exists: true,
        issues: [{ message: "invalid", path: "gateway" }],
        legacyIssues: [],
        valid: false,
        sourceConfig: {
          env: { vars: { OPENCLAW_INCLUDE_ROOTS: "/tmp/openclaw-includes" } },
          gateway: { mode: "local" },
        },
      });

      await runCli(["node", "openclaw", "gateway"]);
      const hooks = addGatewayRunCommandMock.mock.calls[0]?.[1] as
        | { beforeRun?: (opts: { force?: boolean }) => Promise<void> }
        | undefined;
      await hooks?.beforeRun?.({});

      expect(process.env.OPENCLAW_INCLUDE_ROOTS).toBeUndefined();
      expect(readConfigFileSnapshotMock.mock.calls).toEqual([
        [{ isolateEnv: true, observe: false }],
        [{ isolateEnv: true, observe: false }],
      ]);
      expect(ensureCliExecutionBootstrapMock).not.toHaveBeenCalled();
    });
  });

  it("loads selected state dotenv before config env and environment normalization", async () => {
    const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-gateway-selected-env-"));
    const stateDir = path.join(homeDir, "state");
    await fs.mkdir(stateDir, { recursive: true });
    await fs.writeFile(path.join(stateDir, ".env"), "OPENCLAW_GATEWAY_TOKEN=state-token\n");
    try {
      await withEnvAsync(
        {
          HOME: homeDir,
          OPENCLAW_CONFIG_PATH: undefined,
          OPENCLAW_GATEWAY_TOKEN: undefined,
          OPENCLAW_HOME: homeDir,
          OPENCLAW_STATE_DIR: undefined,
        },
        async () => {
          readConfigFileSnapshotMock.mockResolvedValue({
            exists: true,
            valid: true,
            sourceConfig: {
              env: {
                vars: {
                  OPENCLAW_GATEWAY_TOKEN: "config-token",
                  OPENCLAW_STATE_DIR: stateDir,
                },
              },
              gateway: { mode: "local" },
            },
          });
          let tokenAtNormalize: string | undefined;
          normalizeEnvMock.mockImplementation(() => {
            tokenAtNormalize = process.env.OPENCLAW_GATEWAY_TOKEN;
          });

          await runCli(["node", "openclaw", "gateway"]);

          expect(process.env.OPENCLAW_GATEWAY_TOKEN).toBe("state-token");
          expect(tokenAtNormalize).toBe("state-token");
        },
      );
    } finally {
      await fs.rm(homeDir, { recursive: true, force: true });
    }
  });

  it("drops credentials from a trusted dotenv superseded by state selection", async () => {
    const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-gateway-dotenv-hop-"));
    const defaultStateDir = path.join(homeDir, ".openclaw");
    const selectedStateDir = path.join(homeDir, "selected-state");
    await fs.mkdir(defaultStateDir, { recursive: true });
    await fs.mkdir(selectedStateDir, { recursive: true });
    await fs.writeFile(
      path.join(defaultStateDir, ".env"),
      [
        `OPENCLAW_STATE_DIR=${selectedStateDir}`,
        "OPENCLAW_GATEWAY_TOKEN=superseded-token",
        "",
      ].join("\n"),
    );
    await fs.writeFile(
      path.join(selectedStateDir, ".env"),
      "OPENCLAW_GATEWAY_TOKEN=selected-token\n",
    );
    try {
      await withEnvAsync(
        {
          HOME: homeDir,
          OPENCLAW_GATEWAY_TOKEN: undefined,
          OPENCLAW_HOME: homeDir,
          OPENCLAW_STATE_DIR: undefined,
        },
        async () => {
          await runCli(["node", "openclaw", "gateway"]);

          expect(process.env.OPENCLAW_STATE_DIR).toBe(selectedStateDir);
          expect(process.env.OPENCLAW_GATEWAY_TOKEN).toBe("selected-token");
        },
      );
    } finally {
      await fs.rm(homeDir, { recursive: true, force: true });
    }
  });

  it("drops gateway.env selectors when the default state dotenv selects a custom state", async () => {
    const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-gateway-env-hop-"));
    const defaultStateDir = path.join(homeDir, ".openclaw");
    const selectedStateDir = path.join(homeDir, "selected-state");
    const gatewayEnvDir = path.join(homeDir, ".config", "openclaw");
    await fs.mkdir(defaultStateDir, { recursive: true });
    await fs.mkdir(selectedStateDir, { recursive: true });
    await fs.mkdir(gatewayEnvDir, { recursive: true });
    await fs.writeFile(
      path.join(defaultStateDir, ".env"),
      `OPENCLAW_STATE_DIR=${selectedStateDir}\n`,
    );
    await fs.writeFile(
      path.join(gatewayEnvDir, "gateway.env"),
      [
        "OPENCLAW_CONFIG_PATH=/tmp/wrong-openclaw.json",
        "OPENCLAW_GATEWAY_TOKEN=fallback-token",
        "",
      ].join("\n"),
    );
    await fs.writeFile(
      path.join(selectedStateDir, ".env"),
      [
        "OPENCLAW_GATEWAY_TOKEN=selected-token",
        "OPENCLAW_INCLUDE_ROOTS=/tmp/untrusted-include-root",
        "NODE_OPTIONS=--require /tmp/untrusted.js",
        "",
      ].join("\n"),
    );
    try {
      await withEnvAsync(
        {
          HOME: homeDir,
          OPENCLAW_CONFIG_PATH: undefined,
          OPENCLAW_GATEWAY_TOKEN: undefined,
          OPENCLAW_HOME: homeDir,
          OPENCLAW_STATE_DIR: undefined,
          NODE_OPTIONS: undefined,
        },
        async () => {
          await runCli(["node", "openclaw", "gateway"]);

          expect(process.env.OPENCLAW_STATE_DIR).toBe(selectedStateDir);
          expect(process.env.OPENCLAW_CONFIG_PATH).toBeUndefined();
          expect(process.env.OPENCLAW_GATEWAY_TOKEN).toBe("selected-token");
        },
      );
    } finally {
      await fs.rm(homeDir, { recursive: true, force: true });
    }
  });

  it("preserves gateway.env selectors when the compatibility fallback selects the target", async () => {
    const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-gateway-env-select-"));
    const selectedStateDir = path.join(homeDir, "selected-state");
    const gatewayEnvDir = path.join(homeDir, ".config", "openclaw");
    await fs.mkdir(selectedStateDir, { recursive: true });
    await fs.mkdir(gatewayEnvDir, { recursive: true });
    await fs.writeFile(
      path.join(gatewayEnvDir, "gateway.env"),
      [`OPENCLAW_STATE_DIR=${selectedStateDir}`, "OPENCLAW_GATEWAY_TOKEN=fallback-token", ""].join(
        "\n",
      ),
    );
    await fs.writeFile(
      path.join(selectedStateDir, ".env"),
      "OPENCLAW_GATEWAY_TOKEN=selected-token\n",
    );
    try {
      await withEnvAsync(
        {
          HOME: homeDir,
          OPENCLAW_GATEWAY_TOKEN: undefined,
          OPENCLAW_HOME: homeDir,
          OPENCLAW_INCLUDE_ROOTS: undefined,
          OPENCLAW_STATE_DIR: undefined,
          NODE_OPTIONS: undefined,
        },
        async () => {
          await runCli(["node", "openclaw", "gateway"]);

          expect(process.env.OPENCLAW_STATE_DIR).toBe(selectedStateDir);
          expect(process.env.OPENCLAW_GATEWAY_TOKEN).toBe("selected-token");
          expect(process.env.OPENCLAW_INCLUDE_ROOTS).toBeUndefined();
          expect(process.env.NODE_OPTIONS).toBeUndefined();
        },
      );
    } finally {
      await fs.rm(homeDir, { recursive: true, force: true });
    }
  });

  it("drops old state dotenv credentials when config selects another state", async () => {
    const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-gateway-config-state-hop-"));
    const defaultStateDir = path.join(homeDir, ".openclaw");
    const selectedStateDir = path.join(homeDir, "selected-state");
    await fs.mkdir(defaultStateDir, { recursive: true });
    await fs.mkdir(selectedStateDir, { recursive: true });
    await fs.writeFile(
      path.join(defaultStateDir, ".env"),
      "OPENCLAW_GATEWAY_TOKEN=superseded-token\n",
    );
    await fs.writeFile(
      path.join(selectedStateDir, ".env"),
      "OPENCLAW_GATEWAY_TOKEN=selected-token\n",
    );
    try {
      await withEnvAsync(
        {
          HOME: homeDir,
          OPENCLAW_GATEWAY_TOKEN: undefined,
          OPENCLAW_HOME: homeDir,
          OPENCLAW_STATE_DIR: undefined,
        },
        async () => {
          readConfigFileSnapshotMock.mockImplementation(async () => ({
            exists: true,
            valid: true,
            sourceConfig:
              process.env.OPENCLAW_STATE_DIR === selectedStateDir
                ? { gateway: { mode: "local" } }
                : {
                    env: { vars: { OPENCLAW_STATE_DIR: selectedStateDir } },
                    gateway: { mode: "local" },
                  },
          }));

          await runCli(["node", "openclaw", "gateway"]);

          expect(process.env.OPENCLAW_STATE_DIR).toBe(selectedStateDir);
          expect(process.env.OPENCLAW_GATEWAY_TOKEN).toBe("selected-token");
        },
      );
    } finally {
      await fs.rm(homeDir, { recursive: true, force: true });
    }
  });

  it("drops early target credentials when a later guard selects another state", async () => {
    const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-gateway-late-state-hop-"));
    const defaultStateDir = path.join(homeDir, ".openclaw");
    const selectedStateDir = path.join(homeDir, "selected-state");
    await fs.mkdir(defaultStateDir, { recursive: true });
    await fs.mkdir(selectedStateDir, { recursive: true });
    await fs.writeFile(path.join(defaultStateDir, ".env"), "OPENCLAW_GATEWAY_TOKEN=early-token\n");
    await fs.writeFile(
      path.join(selectedStateDir, ".env"),
      "OPENCLAW_GATEWAY_TOKEN=selected-token\n",
    );
    try {
      await withEnvAsync(
        {
          HOME: homeDir,
          OPENCLAW_GATEWAY_TOKEN: undefined,
          OPENCLAW_HOME: homeDir,
          OPENCLAW_STATE_DIR: undefined,
        },
        async () => {
          let selectLateState = false;
          readConfigFileSnapshotMock.mockImplementation(async () => ({
            exists: true,
            valid: true,
            sourceConfig:
              selectLateState && process.env.OPENCLAW_STATE_DIR !== selectedStateDir
                ? {
                    env: { vars: { OPENCLAW_STATE_DIR: selectedStateDir } },
                    gateway: { mode: "local" },
                  }
                : { gateway: { mode: "local" } },
          }));

          await runCli(["node", "openclaw", "gateway"]);
          expect(process.env.OPENCLAW_GATEWAY_TOKEN).toBe("early-token");

          selectLateState = true;
          const hooks = addGatewayRunCommandMock.mock.calls[0]?.[1] as
            | { beforeRun?: (opts: { force?: boolean }) => Promise<void> }
            | undefined;
          await hooks?.beforeRun?.({});

          expect(process.env.OPENCLAW_STATE_DIR).toBe(selectedStateDir);
          expect(process.env.OPENCLAW_GATEWAY_TOKEN).toBe("selected-token");
          expect(ensureCliExecutionBootstrapMock).toHaveBeenCalledOnce();
        },
      );
    } finally {
      await fs.rm(homeDir, { recursive: true, force: true });
    }
  });

  it("drops normalized credentials from an early config replaced by a later guard", async () => {
    await withEnvAsync({ ZAI_API_KEY: undefined, Z_AI_API_KEY: undefined }, async () => {
      let useReplacement = false;
      readConfigFileSnapshotMock.mockImplementation(async () => ({
        exists: true,
        valid: true,
        sourceConfig: {
          env: {
            vars: {
              Z_AI_API_KEY: useReplacement ? "replacement-key" : "superseded-key",
            },
          },
          gateway: { mode: "local" },
        },
      }));
      normalizeEnvMock.mockImplementation(() => {
        if (!process.env.ZAI_API_KEY?.trim() && process.env.Z_AI_API_KEY?.trim()) {
          process.env.ZAI_API_KEY = process.env.Z_AI_API_KEY;
        }
      });

      await runCli(["node", "openclaw", "gateway"]);
      expect(process.env.ZAI_API_KEY).toBe("superseded-key");

      useReplacement = true;
      const hooks = addGatewayRunCommandMock.mock.calls[0]?.[1] as
        | { beforeRun?: (opts: { force?: boolean }) => Promise<void> }
        | undefined;
      await hooks?.beforeRun?.({});

      expect(process.env.Z_AI_API_KEY).toBe("replacement-key");
      expect(process.env.ZAI_API_KEY).toBe("replacement-key");
    });
  });

  it("does not let gateway.env authorize automatic mutations of a selected future config", async () => {
    const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-gateway-global-env-"));
    const gatewayEnvDir = path.join(homeDir, ".config", "openclaw");
    const futureConfigPath = path.join(homeDir, "future.json");
    await fs.mkdir(gatewayEnvDir, { recursive: true });
    await fs.writeFile(
      path.join(gatewayEnvDir, "gateway.env"),
      "OPENCLAW_ALLOW_OLDER_BINARY_DESTRUCTIVE_ACTIONS=1\n",
    );
    try {
      await withEnvAsync(
        {
          HOME: homeDir,
          OPENCLAW_ALLOW_OLDER_BINARY_DESTRUCTIVE_ACTIONS: undefined,
          OPENCLAW_CONFIG_PATH: undefined,
          OPENCLAW_HOME: homeDir,
          OPENCLAW_STATE_DIR: undefined,
        },
        async () => {
          readConfigFileSnapshotMock.mockImplementation(async () =>
            process.env.OPENCLAW_CONFIG_PATH === futureConfigPath
              ? {
                  exists: true,
                  valid: true,
                  sourceConfig: { meta: { lastTouchedVersion: "9999.1.1" } },
                }
              : {
                  exists: true,
                  valid: true,
                  sourceConfig: {
                    env: { vars: { OPENCLAW_CONFIG_PATH: futureConfigPath } },
                    gateway: { mode: "local" },
                  },
                },
          );
          const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
          const exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
            throw new Error(`exit:${String(code)}`);
          }) as typeof process.exit);
          try {
            await expect(runCli(["node", "openclaw", "gateway"])).rejects.toThrow("exit:1");
            expect(errorSpy).toHaveBeenCalledWith(
              expect.stringContaining("run automatic gateway startup migrations"),
            );
            expect(process.env.OPENCLAW_ALLOW_OLDER_BINARY_DESTRUCTIVE_ACTIONS).toBeUndefined();
          } finally {
            exitSpy.mockRestore();
            errorSpy.mockRestore();
          }
        },
      );
    } finally {
      await fs.rm(homeDir, { recursive: true, force: true });
    }
  });

  it("does not treat gateway option values as bootstrap command paths", async () => {
    await runCli(["node", "openclaw", "gateway", "--raw-stream-path", "status"]);

    const hooks = addGatewayRunCommandMock.mock.calls[0]?.[1] as
      | { beforeRun?: (opts: { reset?: boolean }) => Promise<void> }
      | undefined;
    await hooks?.beforeRun?.({});

    expect(ensureCliExecutionBootstrapMock).toHaveBeenCalledWith(
      expect.objectContaining({
        commandPath: ["gateway"],
        loadPlugins: false,
      }),
    );
  });

  it("guards then skips state migration before destructive gateway dev resets", async () => {
    await runCli(["node", "openclaw", "gateway", "--dev", "--reset"]);

    const hooks = addGatewayRunCommandMock.mock.calls[0]?.[1] as
      | { beforeRun?: (opts: { reset?: boolean }) => Promise<void> }
      | undefined;
    await hooks?.beforeRun?.({ reset: true });

    expect(readConfigFileSnapshotMock).toHaveBeenCalledWith({ isolateEnv: true, observe: false });
    expect(ensureCliExecutionBootstrapMock).not.toHaveBeenCalled();
  });

  it("retains selected config paths and invocation reset targets", async () => {
    await withEnvAsync(
      {
        OPENCLAW_CONFIG_PATH: "/tmp/openclaw-invocation/openclaw.json",
        OPENCLAW_GATEWAY_TOKEN: undefined,
        OPENCLAW_HOME: "/tmp/openclaw-invocation-home",
        OPENCLAW_INCLUDE_ROOTS: undefined,
        OPENCLAW_PROFILE: undefined,
        OPENCLAW_STATE_DIR: "/tmp/openclaw-invocation-state",
        OPENCLAW_TEST_FAST: "1",
        OPENCLAW_WORKSPACE_DIR: "/tmp/openclaw-invocation-workspace",
      },
      async () => {
        readConfigFileSnapshotMock.mockResolvedValue({
          exists: true,
          valid: true,
          sourceConfig: {
            env: {
              vars: {
                OPENCLAW_CONFIG_PATH: "/tmp/openclaw-reset/openclaw.json",
                OPENCLAW_GATEWAY_TOKEN: "old-token",
                OPENCLAW_HOME: "/tmp/openclaw-reset-home",
                OPENCLAW_INCLUDE_ROOTS: "/tmp/openclaw-reset-includes",
                OPENCLAW_PROFILE: "config-dev",
                OPENCLAW_STATE_DIR: "/tmp/openclaw-reset",
                OPENCLAW_TEST_FAST: "0",
                OPENCLAW_WORKSPACE_DIR: "/tmp/openclaw-reset-workspace",
              },
            },
            gateway: { mode: "local" },
          },
        });
        await runCli(["node", "openclaw", "gateway", "--dev", "--reset"]);

        const hooks = addGatewayRunCommandMock.mock.calls[0]?.[1] as
          | { beforeRun?: (opts: { reset?: boolean }) => Promise<void> }
          | undefined;
        await hooks?.beforeRun?.({ reset: true });

        expect(process.env.OPENCLAW_CONFIG_PATH).toBe("/tmp/openclaw-invocation/openclaw.json");
        expect(process.env.OPENCLAW_HOME).toBe("/tmp/openclaw-invocation-home");
        expect(process.env.OPENCLAW_PROFILE).toBeUndefined();
        expect(process.env.OPENCLAW_STATE_DIR).toBe("/tmp/openclaw-invocation-state");
        expect(process.env.OPENCLAW_TEST_FAST).toBe("1");
        expect(process.env.OPENCLAW_WORKSPACE_DIR).toBe("/tmp/openclaw-invocation-workspace");
        expect(process.env.OPENCLAW_GATEWAY_TOKEN).toBeUndefined();
        expect(process.env.OPENCLAW_INCLUDE_ROOTS).toBeUndefined();
        expect(ensureCliExecutionBootstrapMock).not.toHaveBeenCalled();
      },
    );
  });

  it("does not let config env authorize or retarget an explicit reset", async () => {
    await withEnvAsync(
      { OPENCLAW_PROFILE: undefined, OPENCLAW_WORKSPACE_DIR: undefined },
      async () => {
        readConfigFileSnapshotMock.mockResolvedValue({
          exists: true,
          valid: true,
          sourceConfig: {
            env: {
              vars: {
                OPENCLAW_PROFILE: "dev",
                OPENCLAW_WORKSPACE_DIR: "/tmp/openclaw-config-workspace",
              },
            },
            gateway: { mode: "local" },
          },
        });

        await runCli(["node", "openclaw", "gateway", "--reset"]);

        expect(process.env.OPENCLAW_PROFILE).toBeUndefined();
        expect(process.env.OPENCLAW_WORKSPACE_DIR).toBeUndefined();
      },
    );
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

  it("renders secrets help from startup metadata without building the full program", async () => {
    outputPrecomputedSecretsHelpTextMock.mockReturnValueOnce(true);

    await runCli(["node", "openclaw", "secrets", "--help"]);

    expect(tryRouteCliMock).not.toHaveBeenCalled();
    expect(outputPrecomputedSecretsHelpTextMock).toHaveBeenCalledTimes(1);
    expect(buildProgramMock).not.toHaveBeenCalled();
    expect(registerSubCliByNameMock).not.toHaveBeenCalled();
  });

  it("renders nodes help from startup metadata without building the full program", async () => {
    outputPrecomputedNodesHelpTextMock.mockReturnValueOnce(true);

    await runCli(["node", "openclaw", "nodes", "--help"]);

    expect(tryRouteCliMock).not.toHaveBeenCalled();
    expect(outputPrecomputedNodesHelpTextMock).toHaveBeenCalledTimes(1);
    expect(buildProgramMock).not.toHaveBeenCalled();
    expect(registerSubCliByNameMock).not.toHaveBeenCalled();
  });

  it("defers nodes help startup metadata when plugin config can change command metadata", async () => {
    const argv = ["node", "openclaw", "nodes", "--help"];
    const parseAsync = vi.fn().mockResolvedValueOnce(undefined);
    const program = {
      commands: [{ name: () => "nodes", aliases: () => [] }],
      parseAsync,
    };
    loadRootHelpRenderOptionsForConfigSensitivePluginsMock.mockResolvedValueOnce({ env: {} });
    outputPrecomputedNodesHelpTextMock.mockReturnValueOnce(true);
    buildProgramMock.mockReturnValueOnce(program);

    await runCli(argv);

    expect(loadRootHelpRenderOptionsForConfigSensitivePluginsMock).toHaveBeenCalledTimes(1);
    expect(outputPrecomputedNodesHelpTextMock).not.toHaveBeenCalled();
    expect(registerSubCliByNameMock.mock.calls).toEqual([[program, "nodes", argv]]);
    expect(parseAsync).toHaveBeenCalledWith(argv);
  });

  it("renders selected subcommand help from startup metadata without building the full program", async () => {
    outputPrecomputedSubcommandHelpTextMock.mockReturnValueOnce(true);

    await runCli(["node", "openclaw", "doctor", "--help"]);

    expect(outputPrecomputedSubcommandHelpTextMock).toHaveBeenCalledWith("doctor");
    expect(tryRouteCliMock).not.toHaveBeenCalled();
    expect(buildProgramMock).not.toHaveBeenCalled();
    expect(closeActiveMemorySearchManagersMock).not.toHaveBeenCalled();
  });

  it.each([
    ["plugins install", ["plugins", "install", "--help"]],
    ["plugins list", ["plugins", "list", "--help"]],
    ["gateway status", ["gateway", "status", "--help"]],
  ])("renders %s help without importing the command router", async (_name, args) => {
    const argv = ["node", "openclaw", ...args];
    const parseAsync = vi.fn().mockResolvedValueOnce(undefined);
    const program = {
      commands: [{ name: () => args[0], aliases: () => [] }],
      parseAsync,
    };
    buildProgramMock.mockReturnValueOnce(program);

    await runCli(argv);

    expect(tryRouteCliMock).not.toHaveBeenCalled();
    expect(registerSubCliByNameMock).toHaveBeenCalledWith(program, args[0], argv);
    expect(parseAsync).toHaveBeenCalledWith(argv);
  });

  it("propagates precomputed help metadata failures", async () => {
    outputPrecomputedSecretsHelpTextMock.mockImplementationOnce(() => {
      throw new Error("startup metadata failed");
    });

    await expect(runCli(["node", "openclaw", "secrets", "--help"])).rejects.toThrow(
      "startup metadata failed",
    );
  });

  it("propagates nodes live-config probe failures", async () => {
    loadRootHelpRenderOptionsForConfigSensitivePluginsMock.mockRejectedValueOnce(
      new Error("live config failed"),
    );

    await expect(runCli(["node", "openclaw", "nodes", "--help"])).rejects.toThrow(
      "live config failed",
    );
  });

  it("keeps root help on the precomputed path without proxy bootstrap", async () => {
    outputPrecomputedRootHelpTextMock.mockReturnValueOnce(true);

    await runCli(["node", "openclaw", "--help"]);

    expect(loadRootHelpRenderOptionsForConfigSensitivePluginsMock).toHaveBeenCalledTimes(1);
    expect(outputPrecomputedRootHelpTextMock).toHaveBeenCalledTimes(1);
    expect(hasEnvHttpProxyAgentConfiguredMock).not.toHaveBeenCalled();
    expect(ensureGlobalUndiciEnvProxyDispatcherMock).not.toHaveBeenCalled();
  });

  it("renders setup/onboard/configure help without building the full program", async () => {
    await runCli(["node", "openclaw", "setup", "--help"]);

    expect(tryOutputSetupOnboardConfigureHelpMock).toHaveBeenCalledWith([
      "node",
      "openclaw",
      "setup",
      "--help",
    ]);
    expect(tryRouteCliMock).not.toHaveBeenCalled();
    expect(buildProgramMock).not.toHaveBeenCalled();
    expect(registerPluginCliCommandsFromValidatedConfigMock).not.toHaveBeenCalled();
  });

  it("renders root help without building the full program", async () => {
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`unexpected process.exit(${String(code)})`);
    }) as typeof process.exit);

    await runCli(["node", "openclaw", "--help"]);

    expect(maybeRunCliInContainerMock).toHaveBeenCalledWith(["node", "openclaw", "--help"]);
    expect(tryRouteCliMock).not.toHaveBeenCalled();
    expect(loadRootHelpRenderOptionsForConfigSensitivePluginsMock).toHaveBeenCalledTimes(1);
    expect(outputPrecomputedRootHelpTextMock).toHaveBeenCalledTimes(1);
    expect(outputRootHelpMock).toHaveBeenCalledTimes(1);
    expect(buildProgramMock).not.toHaveBeenCalled();
    expect(closeActiveMemorySearchManagersMock).not.toHaveBeenCalled();
    expect(exitSpy).not.toHaveBeenCalled();
    exitSpy.mockRestore();
  });

  it("renders config-sensitive root help live instead of precomputed metadata", async () => {
    const liveOptions: RootHelpRenderOptions = {
      config: {
        plugins: {
          slots: {
            memory: "memory-lancedb",
          },
        },
      },
      env: process.env,
    };
    loadRootHelpRenderOptionsForConfigSensitivePluginsMock.mockResolvedValueOnce(liveOptions);
    outputPrecomputedRootHelpTextMock.mockReturnValueOnce(true);

    await runCli(["node", "openclaw", "--help"]);

    expect(loadRootHelpRenderOptionsForConfigSensitivePluginsMock).toHaveBeenCalledTimes(1);
    expect(outputPrecomputedRootHelpTextMock).not.toHaveBeenCalled();
    expect(outputRootHelpMock).toHaveBeenCalledWith(liveOptions);
    expect(buildProgramMock).not.toHaveBeenCalled();
  });

  it.each([
    ["local gateway status", ["node", "openclaw", "status"]],
    ["models JSON alias", ["node", "openclaw", "models", "--json"]],
    ["models status JSON alias", ["node", "openclaw", "models", "--status-json"]],
    ["models plain alias", ["node", "openclaw", "models", "--status-plain"]],
  ])("does not start the managed proxy for %s", async (_name, argv) => {
    tryRouteCliMock.mockResolvedValueOnce(true);

    await runCli(argv);

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

  it.each([
    ["worker", { observe: false, pluginValidation: "core-only" }],
    ["run", { skipPluginValidation: true }],
  ])(
    "preserves node %s config ownership when startup tracing is enabled",
    async (subcommand, readOptions) => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-node-timeline-"));
      const timelinePath = path.join(root, "timeline.jsonl");
      tryRouteCliMock.mockResolvedValueOnce(true);
      loadConfigMock.mockResolvedValueOnce({ diagnostics: { flags: ["timeline"] } });
      try {
        await withEnvAsync(
          { OPENCLAW_DIAGNOSTICS: "", OPENCLAW_DIAGNOSTICS_TIMELINE_PATH: timelinePath },
          async () => {
            await runCli(["node", "openclaw", "node", subcommand]);
          },
        );
        expect(loadConfigMock).toHaveBeenCalledWith(readOptions);
        expect(await fs.readFile(timelinePath, "utf8")).toContain("cli.main.argv");
      } finally {
        await fs.rm(root, { recursive: true, force: true });
      }
    },
  );

  it.each([
    ["root command", ["node", "openclaw", "update", "--dry-run", "--json"]],
    ["root shorthand", ["node", "openclaw", "--update", "--dry-run", "--json"]],
  ])("reads source-only proxy config for the update dry-run %s", async (_name, argv) => {
    tryRouteCliMock.mockResolvedValueOnce(true);
    readSourceConfigBestEffortMock.mockResolvedValueOnce({ proxy: { selected: "dry-run" } });

    await runCli(argv);

    expect(readSourceConfigBestEffortMock).toHaveBeenCalledOnce();
    expect(loadConfigMock).not.toHaveBeenCalled();
    expect(startProxyMock).toHaveBeenCalledWith({ selected: "dry-run" });
  });

  it("reads source-only proxy config for mutable updates", async () => {
    tryRouteCliMock.mockResolvedValueOnce(true);

    await runCli(["node", "openclaw", "update"]);

    expect(readSourceConfigBestEffortMock).toHaveBeenCalledOnce();
    expect(loadConfigMock).not.toHaveBeenCalled();
    expect(startProxyMock).toHaveBeenCalledWith(undefined);
  });

  it("reads source-only proxy config before doctor lint owns plugin-aware validation", async () => {
    tryRouteCliMock.mockResolvedValueOnce(true);
    readSourceConfigBestEffortMock.mockResolvedValueOnce({ proxy: { selected: "doctor-lint" } });

    await runCli(["node", "openclaw", "doctor", "--lint", "--json"]);

    expect(readSourceConfigBestEffortMock).toHaveBeenCalledOnce();
    expect(loadConfigMock).not.toHaveBeenCalled();
    expect(startProxyMock).toHaveBeenCalledWith({ selected: "doctor-lint" });
  });

  it.each([
    {
      name: "version-pinned skill install",
      argv: ["node", "openclaw", "skills", "install", "@owner/weather", "--version", "1.2.3"],
    },
    {
      name: "version-pinned skill verification",
      argv: ["node", "openclaw", "skills", "verify", "@owner/weather", "--version", "1.2.3"],
    },
    {
      name: "equals-form version-pinned skill install",
      argv: ["node", "openclaw", "skills", "install", "@owner/weather", "--version=1.2.3"],
    },
    {
      name: "profiled version-pinned skill verification",
      argv: [
        "node",
        "openclaw",
        "--profile",
        "work",
        "skills",
        "verify",
        "@owner/weather",
        "--version",
        "1.2.3",
      ],
    },
  ])("starts the managed proxy for $name", async ({ argv }) => {
    await withEnvAsync(
      {
        OPENCLAW_PROFILE: undefined,
        OPENCLAW_STATE_DIR: undefined,
        OPENCLAW_CONFIG_PATH: undefined,
      },
      async () => {
        hasEnvHttpProxyAgentConfiguredMock.mockReturnValue(true);
        tryRouteCliMock.mockResolvedValueOnce(true);

        await runCli(argv);

        expect(startProxyMock).toHaveBeenCalledWith(undefined);
        expect(ensureGlobalUndiciEnvProxyDispatcherMock).toHaveBeenCalledOnce();
      },
    );
  });

  it("routes managed-proxy startup logs away for JSON output", async () => {
    tryRouteCliMock.mockResolvedValueOnce(true);
    startProxyMock.mockImplementationOnce(async () => {
      expect(loggingState.forceConsoleToStderr).toBe(true);
      return null;
    });

    await runCli(["node", "openclaw", "plugins", "marketplace", "list", "--json"]);

    expect(startProxyMock).toHaveBeenCalledWith(undefined);
    expect(loggingState.forceConsoleToStderr).toBe(false);
  });

  it.each([
    ["cron", ["node", "openclaw", "cron", "status"]],
    ["cron parent timeout", ["node", "openclaw", "cron", "--timeout", "250", "status"]],
    ["automations parent port", ["node", "openclaw", "automations", "--port", "18789", "status"]],
    ["cron alias", ["node", "openclaw", "cron", "create", "daily", "message"]],
    ["cron removal alias", ["node", "openclaw", "cron", "delete", "job"]],
    ["cron scratch equals", ["node", "openclaw", "cron", "scratch", "job", "--set=text"]],
    ["device token", ["node", "openclaw", "devices", "rotate", "--device", "one"]],
    [
      "gateway handoff",
      ["node", "openclaw", "gateway", "--port", "18789", "restart-handoff", "capabilities"],
    ],
    ["node pairing", ["node", "openclaw", "nodes", "approve", "request-one"]],
    ["node invoke", ["node", "openclaw", "nodes", "invoke", "--node", "one"]],
    ["skill verification", ["node", "openclaw", "skills", "verify", "@owner/skill"]],
    [
      "agent-scoped skill verification",
      ["node", "openclaw", "skills", "--agent", "main", "verify", "@owner/skill"],
    ],
    ["system heartbeat", ["node", "openclaw", "system", "heartbeat", "last"]],
    ["system presence", ["node", "openclaw", "system", "presence"]],
    ["doctor lint", ["node", "openclaw", "doctor", "--lint"]],
    ["proxy coverage", ["node", "openclaw", "proxy", "coverage"]],
  ])("routes startup diagnostics for default-machine %s output", async (_name, argv) => {
    tryRouteCliMock.mockImplementationOnce(async () => {
      expect(loggingState.forceConsoleToStderr).toBe(true);
      return true;
    });

    await runCli(argv);

    expect(loggingState.forceConsoleToStderr).toBe(false);
  });

  it("routes managed-proxy startup logs for plugin-declared machine output", async () => {
    tryRouteCliMock.mockResolvedValueOnce(true);
    let observedStdoutIsTTY: boolean | undefined;
    resolvePluginCliRootOwnerIdsMock.mockImplementation(
      ({ primaryCommand }: { primaryCommand?: string }) =>
        primaryCommand === "path" ? ["oc-path"] : [],
    );
    loadPluginCliDescriptorsMock.mockResolvedValueOnce([
      {
        name: "path",
        description: "OC path",
        hasSubcommands: true,
        machineOutput: ({ stdoutIsTTY }: { stdoutIsTTY: boolean }) => {
          observedStdoutIsTTY = stdoutIsTTY;
          return !stdoutIsTTY;
        },
      },
    ]);
    startProxyMock.mockImplementationOnce(async () => {
      expect(loggingState.forceConsoleToStderr).toBe(true);
      return null;
    });

    const stdoutDescriptor = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
    Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: undefined });
    try {
      await runCli(["node", "openclaw", "path", "validate", "oc://AGENTS.md"]);
    } finally {
      if (stdoutDescriptor) {
        Object.defineProperty(process.stdout, "isTTY", stdoutDescriptor);
      } else {
        Reflect.deleteProperty(process.stdout, "isTTY");
      }
    }

    expect(startProxyMock).toHaveBeenCalledWith(undefined);
    expect(observedStdoutIsTTY).toBe(false);
    expect(loggingState.forceConsoleToStderr).toBe(false);
  });

  it.each([
    ["bare gateway fast path", ["node", "openclaw", "gateway"]],
    ["fast path", ["node", "openclaw", "gateway", "run"]],
    [
      "full Commander path with root options",
      ["node", "openclaw", "--log-level", "debug", "gateway", "run"],
    ],
  ])("loads trusted dotenv and isolates %s gateway proxy config reads", async (_name, argv) => {
    existsSyncOverride.value = (target) => target === path.join(process.cwd(), ".env");
    if (_name === "full Commander path with root options") {
      tryRouteCliMock.mockResolvedValueOnce(false);
      buildProgramMock.mockReturnValueOnce({
        commands: [{ name: () => "gateway", aliases: () => [] }],
        parseAsync: commanderParseAsyncMock,
      });
    }
    await runCli(argv);

    expect(loadDotEnvMock).toHaveBeenCalledWith({ loadGlobalEnv: false, quiet: true });
    if (_name === "full Commander path with root options") {
      expect(buildProgramMock).toHaveBeenCalledTimes(1);
      expect(commanderParseAsyncMock).toHaveBeenLastCalledWith(argv);
    }
    expect(loadConfigMock).toHaveBeenCalledWith({
      isolateEnv: true,
      observe: false,
      skipPluginValidation: true,
    });
    expect(startProxyMock).toHaveBeenCalledWith(undefined);
  });

  it("keeps state dotenv loading for non-gateway commands", async () => {
    const stateDir = path.join(os.tmpdir(), "openclaw-run-main-state");
    existsSyncOverride.value = (target) => target === path.join(stateDir, ".env");
    tryRouteCliMock.mockResolvedValueOnce(true);

    await withEnvAsync({ OPENCLAW_STATE_DIR: stateDir }, () =>
      runCli(["node", "openclaw", "status"]),
    );

    expect(loadDotEnvMock).toHaveBeenCalledWith({ loadGlobalEnv: true, quiet: true });
  });

  it("keeps explicit database preflight isolated from default state selection", async () => {
    tryRouteCliMock.mockResolvedValueOnce(true);

    await runCli([
      "node",
      "openclaw",
      "database",
      "preflight",
      "/tmp/openclaw-candidate.sqlite",
      "--json",
    ]);

    expect(loadDotEnvMock).not.toHaveBeenCalled();
    expect(loadConfigMock).not.toHaveBeenCalled();
    expect(startProxyMock).not.toHaveBeenCalled();
  });

  it("keeps agent exec outside the CLI dotenv loader", async () => {
    buildProgramMock.mockReturnValueOnce({ commands: [], parseAsync: vi.fn() });
    await runCli(["node", "openclaw", "agent", "exec", "test prompt"]);

    expect(loadDotEnvMock).not.toHaveBeenCalled();
  });

  it("validates the runtime before selecting gateway config", async () => {
    await runCli(["node", "openclaw", "gateway", "run"]);

    const runtimeGuardOrder = assertRuntimeMock.mock.invocationCallOrder[0] ?? 0;
    const configReadOrder = readConfigFileSnapshotMock.mock.invocationCallOrder[0] ?? 0;
    expect(runtimeGuardOrder).toBeGreaterThan(0);
    expect(configReadOrder).toBeGreaterThan(runtimeGuardOrder);
  });

  it("re-pins runtime paths after selecting gateway config", async () => {
    await runCli(["node", "openclaw", "gateway", "run"]);

    expect(pinRuntimePathsMock).toHaveBeenCalledWith(process.env);
    expect(pinConfigDirMock).toHaveBeenCalledWith(process.env);
    const configReadOrder = readConfigFileSnapshotMock.mock.invocationCallOrder[0] ?? 0;
    const pinOrder = pinRuntimePathsMock.mock.invocationCallOrder[0] ?? 0;
    expect(pinOrder).toBeGreaterThan(configReadOrder);
  });

  it("selects gateway config env before starting its managed proxy", async () => {
    await withEnvAsync({ OPENCLAW_TEST_PROXY_SELECTION: undefined }, async () => {
      readConfigFileSnapshotMock.mockResolvedValue({
        exists: true,
        valid: true,
        sourceConfig: {
          env: { vars: { OPENCLAW_TEST_PROXY_SELECTION: "http://127.0.0.1:19876" } },
          gateway: { mode: "local" },
        },
      });
      loadConfigMock.mockImplementationOnce(() => ({
        proxy: { proxyUrl: process.env.OPENCLAW_TEST_PROXY_SELECTION },
      }));

      await runCli(["node", "openclaw", "gateway", "run"]);

      expect(startProxyMock).toHaveBeenCalledWith({ proxyUrl: "http://127.0.0.1:19876" });
    });
  });

  it("replaces the early managed proxy with the final accepted gateway config", async () => {
    const earlyHandle = makeProxyHandle();
    const finalHandle = makeProxyHandle();
    const earlyProxy = { proxyUrl: "http://127.0.0.1:19876" };
    const finalProxy = { proxyUrl: "http://127.0.0.1:29876" };
    loadConfigMock.mockReturnValueOnce({ proxy: earlyProxy });
    startProxyMock.mockResolvedValueOnce(earlyHandle).mockResolvedValueOnce(finalHandle);
    commanderParseAsyncMock.mockImplementationOnce(async () => {
      const hooks = addGatewayRunCommandMock.mock.calls[0]?.[1] as
        | { beforeRun?: (opts: { force?: boolean }) => Promise<void> }
        | undefined;
      await hooks?.beforeRun?.({});
      await getGatewayRunRuntimeHooks().refreshManagedProxy?.(finalProxy);
    });

    await runCli(["node", "openclaw", "gateway", "run"]);

    expect(startProxyMock).toHaveBeenNthCalledWith(1, earlyProxy);
    expect(startProxyMock).toHaveBeenNthCalledWith(2, finalProxy);
    expect(stopProxyMock).toHaveBeenNthCalledWith(1, earlyHandle);
    expect(stopProxyMock).toHaveBeenNthCalledWith(2, finalHandle);
    const earlyStopOrder = stopProxyMock.mock.invocationCallOrder[0] ?? 0;
    const finalEnvironmentReadOrder = readConfigFileSnapshotMock.mock.invocationCallOrder[1] ?? 0;
    const finalStartOrder = startProxyMock.mock.invocationCallOrder[1] ?? 0;
    expect(finalEnvironmentReadOrder).toBeGreaterThan(earlyStopOrder);
    expect(finalStartOrder).toBeGreaterThan(earlyStopOrder);
  });

  it("removes early proxy signal handlers when the final config disables the proxy", async () => {
    const earlyHandle = makeProxyHandle();
    const earlyProxy = { proxyUrl: "http://127.0.0.1:19876" };
    const finalProxy = undefined;
    loadConfigMock.mockReturnValueOnce({ proxy: earlyProxy });
    startProxyMock.mockResolvedValueOnce(earlyHandle).mockResolvedValueOnce(null);
    const processOnceSpy = vi.spyOn(process, "once");
    const processOffSpy = vi.spyOn(process, "off");
    commanderParseAsyncMock.mockImplementationOnce(async () => {
      const sigtermHandler = processOnceSpy.mock.calls.find(([event]) => event === "SIGTERM")?.[1];
      const sigintHandler = processOnceSpy.mock.calls.find(([event]) => event === "SIGINT")?.[1];
      const exitHandler = processOnceSpy.mock.calls.find(([event]) => event === "exit")?.[1];

      await getGatewayRunRuntimeHooks().refreshManagedProxy?.(finalProxy);

      expect(processOffSpy).toHaveBeenCalledWith("SIGTERM", sigtermHandler);
      expect(processOffSpy).toHaveBeenCalledWith("SIGINT", sigintHandler);
      expect(processOffSpy).toHaveBeenCalledWith("exit", exitHandler);
    });

    try {
      await runCli(["node", "openclaw", "gateway", "run"]);
    } finally {
      processOffSpy.mockRestore();
      processOnceSpy.mockRestore();
    }

    expect(startProxyMock).toHaveBeenNthCalledWith(1, earlyProxy);
    expect(startProxyMock).toHaveBeenNthCalledWith(2, finalProxy);
    expect(stopProxyMock).toHaveBeenCalledOnce();
    expect(stopProxyMock).toHaveBeenCalledWith(earlyHandle);
  });

  it("starts the managed proxy for metadata-owned plugin commands by default", async () => {
    tryRouteCliMock.mockResolvedValueOnce(true);

    await runCli(["node", "openclaw", "googlemeet", "login"]);

    expect(startProxyMock).toHaveBeenCalledWith(undefined);
  });

  it("rejects unowned command roots before proxy and plugin runtime registration", async () => {
    await expect(runCli(["node", "openclaw", "foo"])).rejects.toThrow(
      'OpenClaw does not know the command "foo".',
    );

    expect(startProxyMock).not.toHaveBeenCalled();
    expect(tryRouteCliMock).not.toHaveBeenCalled();
    expect(buildProgramMock).not.toHaveBeenCalled();
    expect(registerPluginCliCommandsFromValidatedConfigMock).not.toHaveBeenCalled();
  });

  it("routes a bare-root Control UI URL directly to the TUI action", async () => {
    const target = "https://gateway.example/dashboard/main/movies-a1166b81";

    await withInteractiveTty(() => runCli(["node", "openclaw", target]));

    expect(runTuiCliActionMock).toHaveBeenCalledWith(target, {});
    expect(buildProgramMock).not.toHaveBeenCalled();
    expect(tryRouteCliMock).not.toHaveBeenCalled();
  });

  it.each(["tui", "attach", "logs"])(
    "leaves an explicit %s URL invocation on the Commander path",
    async (command) => {
      const target = "https://gateway.example/dashboard/main/movies-a1166b81";
      const argv = ["node", "openclaw", command, target];
      buildProgramMock.mockReturnValueOnce({
        commands: [{ name: () => command, aliases: () => [] }],
        parseAsync: commanderParseAsyncMock,
      });

      await runCli(argv);

      expect(runTuiCliActionMock).not.toHaveBeenCalled();
      expect(buildProgramMock).toHaveBeenCalledTimes(1);
      expect(commanderParseAsyncMock).toHaveBeenCalledWith(argv);
    },
  );

  it("leaves plugin-owned URL arguments on the plugin command path", async () => {
    const target = "https://gateway.example/dashboard/main/movies-a1166b81";
    const argv = ["node", "openclaw", "googlemeet", target];
    buildProgramMock.mockReturnValueOnce({ commands: [], parseAsync: commanderParseAsyncMock });

    await runCli(argv);

    expect(runTuiCliActionMock).not.toHaveBeenCalled();
    expect(buildProgramMock).toHaveBeenCalledTimes(1);
    expect(commanderParseAsyncMock).toHaveBeenCalledWith(argv);
  });

  it("does not steal a URL argument from an unowned command", async () => {
    const target = "https://gateway.example/dashboard/main/movies-a1166b81";

    await expect(runCli(["node", "openclaw", "unknown-owner", target])).rejects.toThrow(
      'OpenClaw does not know the command "unknown-owner".',
    );

    expect(runTuiCliActionMock).not.toHaveBeenCalled();
  });

  it.each([
    {
      label: "after the URL",
      args: [
        "https://gateway.example/dashboard/main/movies-a1166b81",
        "--token",
        "direct-token",
        "--password=direct-password",
        "--tls-fingerprint",
        PREFIXED_TLS_FINGERPRINT,
        "--deliver",
        "--message",
        "continue here",
      ],
    },
    {
      label: "before the URL with split values",
      args: [
        "--token",
        "direct-token",
        "--password",
        "direct-password",
        "--tls-fingerprint",
        PREFIXED_TLS_FINGERPRINT,
        "https://gateway.example/dashboard/main/movies-a1166b81",
        "--deliver",
        "--message",
        "continue here",
      ],
    },
    {
      label: "before the URL with inline values",
      args: [
        "--token=direct-token",
        "--password=direct-password",
        `--tls-fingerprint=${PREFIXED_TLS_FINGERPRINT}`,
        "--message=continue here",
        "https://gateway.example/dashboard/main/movies-a1166b81",
        "--deliver",
      ],
    },
  ])("forwards bare-root TUI options $label without an environment handoff", async ({ args }) => {
    const target = "https://gateway.example/dashboard/main/movies-a1166b81";
    await withEnvAsync(
      {
        OPENCLAW_GATEWAY_TOKEN: "ambient-token",
        OPENCLAW_GATEWAY_PASSWORD: "ambient-password",
      },
      () => withInteractiveTty(() => runCli(["node", "openclaw", ...args])),
    );

    expect(runTuiCliActionMock).toHaveBeenCalledWith(target, {
      token: "direct-token",
      password: "direct-password",
      tlsFingerprint: PREFIXED_TLS_FINGERPRINT,
      deliver: true,
      message: "continue here",
    });
  });

  it.each([
    ["unknown inline option", ["--typo=do-not-print-me"]],
    ["unknown split option", ["--typo", "do-not-print-me"]],
    ["option terminator", ["--"]],
  ])("rejects a pre-URL %s without reflecting values", async (_label, prefix) => {
    const target = "https://gateway.example/dashboard/main/movies-a1166b81";
    let error: unknown;
    try {
      await runCli(["node", "openclaw", ...prefix, target]);
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(Error);
    expect(String(error)).not.toContain("do-not-print-me");
    expect(runTuiCliActionMock).not.toHaveBeenCalled();
  });

  it("rejects a missing pre-URL direct option value before command discovery", async () => {
    const target = "https://gateway.example/dashboard/main/movies-a1166b81";

    await expect(runCli(["node", "openclaw", "--token", target])).rejects.toThrow(
      "--token requires a value",
    );
    expect(runTuiCliActionMock).not.toHaveBeenCalled();
  });

  it("does not claim a bare session ref as root-command sugar", async () => {
    await expect(runCli(["node", "openclaw", "movies-a1166b81"])).rejects.toThrow(
      'OpenClaw does not know the command "movies-a1166b81".',
    );

    expect(runTuiCliActionMock).not.toHaveBeenCalled();
  });

  it("does not claim host shorthand as root-command sugar", async () => {
    await expect(runCli(["node", "openclaw", "gateway.example/main/a1166b81"])).rejects.toThrow(
      'OpenClaw does not know the command "gateway.example/main/a1166b81".',
    );

    expect(runTuiCliActionMock).not.toHaveBeenCalled();
  });

  it("suggests close known commands for unowned command roots before proxy startup", async () => {
    const error = await runCli(["node", "openclaw", "upate"]).catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(ExpectedCliError);
    expect((error as ExpectedCliError).humanOutput).toContain(
      "Did you mean this?\n  openclaw update\n",
    );

    expect(startProxyMock).not.toHaveBeenCalled();
    expect(tryRouteCliMock).not.toHaveBeenCalled();
    expect(buildProgramMock).not.toHaveBeenCalled();
    expect(registerPluginCliCommandsFromValidatedConfigMock).not.toHaveBeenCalled();
  });

  it("sanitizes control characters in unowned command diagnostics", async () => {
    const primary = "bad\u001b[31m-red\u001b[0m\nforged\tline";

    await expect(runCli(["node", "openclaw", primary])).rejects.toThrow(
      'OpenClaw does not know the command "bad-red\\nforged\\tline".',
    );

    expect(startProxyMock).not.toHaveBeenCalled();
    expect(tryRouteCliMock).not.toHaveBeenCalled();
    expect(buildProgramMock).not.toHaveBeenCalled();
    expect(registerPluginCliCommandsFromValidatedConfigMock).not.toHaveBeenCalled();
  });

  it("bounds long unowned command diagnostics without splitting Unicode", async () => {
    const primary = "🦞".repeat(1_000);

    let error: unknown;
    try {
      await runCli(["node", "openclaw", primary]);
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(Error);
    const message = (error as Error).message;
    const displayPrimary = `${"🦞".repeat(63)}…`;
    expect(displayPrimary.length).toBeLessThanOrEqual(128);
    expect(message).toContain(`OpenClaw does not know the command "${displayPrimary}".`);
    expect(message).not.toContain("�");
    expect(message.length).toBeLessThan(500);
    expect(startProxyMock).not.toHaveBeenCalled();
    expect(tryRouteCliMock).not.toHaveBeenCalled();
    expect(buildProgramMock).not.toHaveBeenCalled();
    expect(registerPluginCliCommandsFromValidatedConfigMock).not.toHaveBeenCalled();
  });

  it.each([
    {
      label: "plugins.allow exclusion",
      command: "workboard",
      config: { plugins: { allow: ["browser"] } },
      commandAlias: { pluginId: "workboard" },
      expectedText: '`plugins.allow` excludes "workboard"',
    },
    {
      label: "parent plugin allowlist guidance",
      command: "voicecall",
      config: { plugins: { allow: ["voicecall"] } },
      commandAlias: { pluginId: "voice-call" },
      expectedText: 'Add "voice-call" to `plugins.allow` instead of "voicecall"',
    },
    {
      label: "explicit plugin disablement",
      command: "browser",
      config: { plugins: { entries: { browser: { enabled: false } } } },
      commandAlias: { pluginId: "browser", enabledByDefault: true },
      expectedText: "plugins.entries.browser.enabled=false",
    },
    {
      label: "runtime slash command",
      command: "dreaming",
      config: {},
      commandAlias: {
        pluginId: "memory-core",
        kind: "runtime-slash",
        cliCommand: "memory",
      },
      expectedText: "runtime slash command (/dreaming)",
    },
    {
      label: "loaded agent tool",
      command: "lcm_recent",
      config: {},
      toolOwner: {
        toolName: "lcm_recent",
        pluginId: "lossless-claw",
        availability: "loaded",
      },
      expectedText: "is an agent tool available",
    },
    {
      label: "manifest-only agent tool",
      command: "feishu_chat",
      config: {},
      toolOwner: {
        toolName: "feishu_chat",
        pluginId: "feishu",
        availability: "manifest-only",
      },
      expectedText: "may be provided",
    },
  ])(
    "reports $label as an expected condition before proxy startup",
    async ({ command, config, commandAlias, toolOwner, expectedText }) => {
      loadConfigMock.mockReturnValue(config);
      resolveManifestCommandAliasOwnerMock.mockReturnValue(commandAlias);
      resolveManifestToolOwnerMock.mockReturnValue(toolOwner);

      const error = await runCli(["node", "openclaw", command]).catch((cause: unknown) => cause);

      expect(error).toBeInstanceOf(ExpectedCliError);
      expect((error as ExpectedCliError).message).toContain(expectedText);
      expect((error as ExpectedCliError).humanOutput).toBe((error as Error).message);
      expect((error as ExpectedCliError).machineOutput).toBe((error as Error).message);
      expect((error as Error).message).not.toContain("Did you mean this?");
      expect(startProxyMock).not.toHaveBeenCalled();
      expect(tryRouteCliMock).not.toHaveBeenCalled();
      expect(buildProgramMock).not.toHaveBeenCalled();
      expect(registerPluginCliCommandsFromValidatedConfigMock).not.toHaveBeenCalled();
    },
  );

  it("reports disabled-by-default plugin commands as expected after lazy registration", async () => {
    const program = { commands: [], parseAsync: vi.fn() };
    buildProgramMock.mockReturnValueOnce(program);
    tryRouteCliMock.mockResolvedValueOnce(false);
    resolvePluginCliRootOwnerIdsMock.mockReturnValue(["workboard"]);
    resolveManifestCommandAliasOwnerMock.mockReturnValue({
      pluginId: "workboard",
      enabledByDefault: false,
    });

    const error = await runCli(["node", "openclaw", "workboard", "list"]).catch(
      (cause: unknown) => cause,
    );

    expect(error).toBeInstanceOf(ExpectedCliError);
    expect((error as ExpectedCliError).message).toContain(
      'the "workboard" plugin, but that bundled plugin is disabled by default',
    );
    expect((error as ExpectedCliError).humanOutput).toBe((error as Error).message);
    expect((error as ExpectedCliError).machineOutput).toBe((error as Error).message);
    expect(registerPluginCliCommandsFromValidatedConfigMock).toHaveBeenCalledWith(
      program,
      undefined,
      undefined,
      {
        mode: "lazy",
        primary: "workboard",
        skipPluginValidation: false,
        session: createPluginCliLoadSessionMock.mock.results.at(-1)?.value,
      },
    );
    expect(program.parseAsync).not.toHaveBeenCalled();
  });

  it("rejects unowned command roots even when --help is appended (regression for #81077)", async () => {
    await expect(runCli(["node", "openclaw", "foo", "--help"])).rejects.toThrow(
      'OpenClaw does not know the command "foo".',
    );

    expect(startProxyMock).not.toHaveBeenCalled();
    expect(tryRouteCliMock).not.toHaveBeenCalled();
    expect(buildProgramMock).not.toHaveBeenCalled();
    expect(registerPluginCliCommandsFromValidatedConfigMock).not.toHaveBeenCalled();
  });

  it("rejects unowned command roots even when --version is appended", async () => {
    await expect(runCli(["node", "openclaw", "foo", "--version"])).rejects.toThrow(
      'OpenClaw does not know the command "foo".',
    );

    expect(startProxyMock).not.toHaveBeenCalled();
    expect(tryRouteCliMock).not.toHaveBeenCalled();
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
      'OpenClaw does not know the command "totally-unknown".',
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

  it("routes incidental logs to stderr throughout --json startup and dispatch", async () => {
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
      {
        mode: "lazy",
        primary: "memory",
        skipPluginValidation: true,
        session: createPluginCliLoadSessionMock.mock.results.at(-1)?.value,
      },
    );
    expect(stderrDuringPluginRegistration).toBe(true);
    expect(stderrDuringParse).toBe(true);
    expect(loggingState.forceConsoleToStderr).toBe(false);
  });

  it("retains stderr routing for late subsystem logs in one-shot JSON commands", async () => {
    tryRouteCliMock.mockResolvedValueOnce(false);
    const stdout: string[] = [];
    const stderr: string[] = [];
    const previousRawConsole = loggingState.rawConsole;
    const previousOverrideSettings = loggingState.overrideSettings as Parameters<
      typeof setLoggerOverride
    >[0];
    const stdoutWrite = vi.spyOn(process.stdout, "write").mockImplementation(((
      value: string | Uint8Array,
    ) => {
      stdout.push(String(value));
      return true;
    }) as typeof process.stdout.write);
    setLoggerOverride({
      level: "silent",
      consoleLevel: "info",
      consoleStyle: "compact",
    });
    loggingState.rawConsole = {
      log: (value) => stdout.push(String(value)),
      info: (value) => stdout.push(String(value)),
      warn: (value) => stderr.push(String(value)),
      error: (value) => stderr.push(String(value)),
    };
    buildProgramMock.mockReturnValueOnce({
      commands: [],
      parseAsync: vi.fn(async () => {
        process.stdout.write('{"ok":true,"status":"ok"}\n');
      }),
    });

    try {
      await runCli(["node", "openclaw", "agent", "exec", "inspect", "--json"], {
        retainConsoleRoutingUntilProcessExit: true,
      });
      createSubsystemLogger("state/db").info("late migration diagnostic");

      expect(JSON.parse(stdout.join(""))).toEqual({ ok: true, status: "ok" });
      expect(stderr).toEqual([expect.stringContaining("late migration diagnostic")]);
      expect(loggingState.forceConsoleToStderr).toBe(true);
    } finally {
      stdoutWrite.mockRestore();
      loggingState.rawConsole = previousRawConsole;
      setLoggerOverride(previousOverrideSettings);
      loggingState.forceConsoleToStderr = false;
      loggingState.earlyConsoleRoutingRestore = null;
    }
  });

  it("routes plugin registration logs for descriptor-declared machine output", async () => {
    tryRouteCliMock.mockResolvedValueOnce(false);
    resolvePluginCliRootOwnerIdsMock.mockImplementation(
      ({ primaryCommand }: { primaryCommand?: string }) =>
        primaryCommand === "path" ? ["oc-path"] : [],
    );
    loadPluginCliDescriptorsMock.mockResolvedValueOnce([
      {
        name: "path",
        description: "OC path",
        hasSubcommands: true,
        machineOutput: ({ stdoutIsTTY }: { stdoutIsTTY: boolean }) => !stdoutIsTTY,
      },
    ]);
    let stderrDuringPluginRegistration = false;
    registerPluginCliCommandsFromValidatedConfigMock.mockImplementationOnce(async () => {
      stderrDuringPluginRegistration = loggingState.forceConsoleToStderr;
      return {};
    });
    buildProgramMock.mockReturnValueOnce({ commands: [], parseAsync: vi.fn() });

    await runCli(["node", "openclaw", "path", "validate", "oc://AGENTS.md"]);

    expect(stderrDuringPluginRegistration).toBe(true);
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
      {
        mode: "lazy",
        primary: "memory",
        skipPluginValidation: false,
        session: createPluginCliLoadSessionMock.mock.results.at(-1)?.value,
      },
    );
    const session = createPluginCliLoadSessionMock.mock.results.at(-1)?.value;
    expect(session?.close.mock.invocationCallOrder[0]).toBeLessThan(
      parseAsync.mock.invocationCallOrder[0]!,
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
    let finishCompanionCleanup: (() => void) | undefined;
    const unregisterCompanionCleanup = registerSignalExitBarrier(
      () =>
        new Promise<void>((resolve) => {
          finishCompanionCleanup = resolve;
        }),
    );

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
      expect(exitSpy).not.toHaveBeenCalled();
      if (!finishCompanionCleanup) {
        throw new Error("companion signal cleanup did not start");
      }
      finishCompanionCleanup();
      await vi.waitFor(() => {
        expect(exitSpy).toHaveBeenCalledWith(130);
      });

      resolveRoute(true);
      await runPromise;
      expect(stopProxyMock).toHaveBeenCalledTimes(1);
    } finally {
      unregisterCompanionCleanup();
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
      // Only the managed-proxy kill hook registers here: the debug-capture
      // finalize hook stays unloaded unless the capture env requests it.
      await vi.waitFor(() => {
        expect(
          processOnceSpy.mock.calls.reduce(
            (count, [event]) => count + (event === "exit" ? 1 : 0),
            0,
          ),
        ).toBe(1);
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

  it.each([
    {
      name: "starts onboarding for bare root invocations before config exists",
      snapshot: { exists: false, valid: true, sourceConfig: {} },
    },
    {
      name: "starts onboarding for bare root invocations when config is empty",
      snapshot: { exists: true, valid: true, sourceConfig: {} },
    },
    {
      name: "starts onboarding for bare root invocations when config only has metadata",
      snapshot: {
        exists: true,
        valid: true,
        sourceConfig: {
          $schema: "https://openclaw.ai/config.json",
          meta: { updatedBy: "fixture" },
        },
      },
    },
    {
      name: "resumes onboarding when an interrupted first run only persisted risk acknowledgement",
      snapshot: {
        exists: true,
        valid: true,
        sourceConfig: {
          meta: { updatedBy: "fixture" },
          wizard: { securityAcknowledgedAt: "2026-07-13T00:00:00.000Z" },
        },
      },
    },
    {
      name: "resumes onboarding when an interrupted first run also persisted guarded access",
      snapshot: {
        exists: true,
        valid: true,
        sourceConfig: {
          wizard: {
            securityAcknowledgedAt: "2026-07-13T00:00:00.000Z",
            accessMode: "guarded",
          },
        },
      },
    },
  ])("$name", async ({ snapshot }) => {
    readConfigFileSnapshotMock.mockResolvedValueOnce(snapshot);
    await expect(runBareCli()).resolves.toBeUndefined();

    expect(readConfigFileSnapshotMock).toHaveBeenCalledOnce();
    expect(readLocalOnboardingStateMock).not.toHaveBeenCalled();
    expect(setupWizardCommandMock).toHaveBeenCalledWith({});
    expect(tryRouteCliMock).not.toHaveBeenCalled();
    expect(buildProgramMock).not.toHaveBeenCalled();
  });

  it("resumes pending local onboarding after inference persisted its model", async () => {
    const configPath = "/tmp/openclaw.json";
    const securityAcknowledgedAt = "2026-08-02T00:00:00.000Z";
    const sourceConfig = {
      agents: { defaults: { model: { primary: "openai/gpt-5.6-luna" } } },
      wizard: { securityAcknowledgedAt },
    };
    readConfigFileSnapshotMock.mockResolvedValueOnce({
      exists: true,
      valid: true,
      path: configPath,
      sourceConfig,
    });
    readLocalOnboardingStateMock.mockReturnValueOnce({
      version: 1,
      status: "pending",
      runId: "pending-onboarding",
      configPath,
      workspace: "/tmp/workspace",
      securityAcknowledgedAt,
      startedAtMs: 1,
    });

    await runBareCli();

    expect(readLocalOnboardingStateMock).toHaveBeenCalledWith(configPath, sourceConfig);
    expect(setupWizardCommandMock).toHaveBeenCalledWith({});
    expect(probeGatewayConfiguredModelMock).not.toHaveBeenCalled();
    expect(runTuiMock).not.toHaveBeenCalled();
  });

  it("keeps a completed model-only onboarding on its existing local TUI path", async () => {
    const configPath = "/tmp/openclaw.json";
    const securityAcknowledgedAt = "2026-08-02T00:00:00.000Z";
    const sourceConfig = {
      agents: { defaults: { model: { primary: "openai/gpt-5.6-luna" } } },
      wizard: { securityAcknowledgedAt },
    };
    readConfigFileSnapshotMock.mockResolvedValueOnce({
      exists: true,
      valid: true,
      path: configPath,
      sourceConfig,
    });
    readLocalOnboardingStateMock.mockReturnValueOnce({
      version: 1,
      status: "completed",
      runId: "completed-onboarding",
      configPath,
      workspace: "/tmp/workspace",
      securityAcknowledgedAt,
      startedAtMs: 1,
      completedAtMs: 2,
    });
    probeGatewayConfiguredModelMock.mockResolvedValueOnce({ kind: "unreachable" });

    await runBareCli();

    expect(readLocalOnboardingStateMock).toHaveBeenCalledWith(configPath, sourceConfig);
    expect(setupWizardCommandMock).not.toHaveBeenCalled();
    expect(runTuiMock).toHaveBeenCalledWith({
      deliver: false,
      local: true,
      forceProcessExitOnReturn: true,
    });
  });

  it("does not resume a receipt belonging to the config replaced at the same path", async () => {
    const configPath = "/tmp/openclaw.json";
    const sourceConfig = {
      agents: { defaults: { model: { primary: "openai/gpt-5.6-luna" } } },
      wizard: { securityAcknowledgedAt: "2026-08-03T00:00:00.000Z" },
    };
    readConfigFileSnapshotMock.mockResolvedValueOnce({
      exists: true,
      valid: true,
      path: configPath,
      sourceConfig,
    });
    readLocalOnboardingStateMock.mockImplementationOnce((_configPath, config) =>
      config.wizard?.securityAcknowledgedAt === "2026-08-02T00:00:00.000Z"
        ? {
            version: 1,
            status: "pending",
            runId: "stale-onboarding",
            configPath,
            workspace: "/tmp/stale-workspace",
            securityAcknowledgedAt: "2026-08-02T00:00:00.000Z",
            startedAtMs: 1,
          }
        : undefined,
    );
    probeGatewayConfiguredModelMock.mockResolvedValueOnce({ kind: "unreachable" });

    await runBareCli();

    expect(readLocalOnboardingStateMock).toHaveBeenCalledWith(configPath, sourceConfig);
    expect(setupWizardCommandMock).not.toHaveBeenCalled();
    expect(runTuiMock).toHaveBeenCalledWith({
      deliver: false,
      local: true,
      forceProcessExitOnReturn: true,
    });
  });

  it("points noninteractive fresh bare root invocations to onboarding automation", async () => {
    readConfigFileSnapshotMock.mockResolvedValueOnce({
      exists: false,
      valid: true,
      sourceConfig: {},
    });

    await expectNonInteractiveBareCliError(
      "Onboarding needs an interactive TTY. Use `openclaw onboard --non-interactive --accept-risk ...` for automation.",
      () => {
        expect(setupWizardCommandMock).not.toHaveBeenCalled();
        expect(tryRouteCliMock).not.toHaveBeenCalled();
        expect(buildProgramMock).not.toHaveBeenCalled();
      },
    );
  });

  it("starts the gateway-backed TUI for bare root invocations when config already exists", async () => {
    readConfigFileSnapshotMock.mockResolvedValue({
      exists: true,
      valid: true,
      sourceConfig: {
        gateway: {
          mode: "local",
          auth: {
            mode: "password",
            password: {
              source: "env",
              provider: "default",
              id: "OPENCLAW_GATEWAY_PASSWORD",
            },
          },
        },
      },
    });

    await withEnvAsync({ OPENCLAW_GATEWAY_PASSWORD: "gateway-ref-password" }, async () => {
      await runBareCli();
    });

    expect(readConfigFileSnapshotMock).toHaveBeenCalledTimes(1);
    expect(setupWizardCommandMock).not.toHaveBeenCalled();
    expect(readActiveGatewayLockPortMock).toHaveBeenCalledTimes(1);
    expect(probeGatewayConfiguredModelMock).toHaveBeenCalledWith({
      url: "ws://127.0.0.1:18789",
      password: "gateway-ref-password",
    });
    expectBoundTui({
      url: "ws://127.0.0.1:18789",
      password: "gateway-ref-password",
    });
  });

  it.each(["wss://gateway.example/ws", "ws://127.0.0.1:18789"])(
    "configures missing inference on the selected remote Gateway: %s",
    async (url) => {
      const sourceConfig = {
        agents: { defaults: { model: { primary: "openai/local-only-model" } } },
        gateway: {
          mode: "remote",
          remote: {
            url,
            token: "missing-inference-remote-auth",
            tlsFingerprint: `sha256:${TLS_FINGERPRINT.toUpperCase()}`,
          },
        },
      };
      readConfigFileSnapshotMock.mockResolvedValueOnce({
        exists: true,
        valid: true,
        sourceConfig,
      });
      probeGatewayConfiguredModelMock.mockImplementationOnce(async (options) =>
        options.url === "ws://127.0.0.1:18789" && !options.originScopedDeviceAuth
          ? { kind: "reachable-unverified", detail: "missing scope: operator.read" }
          : {
              kind: "missing-configured-model",
              detail: "Gateway default agent has no configured model",
            },
      );

      await runBareCli();

      expect(setupWizardCommandMock).not.toHaveBeenCalled();
      expect(readLocalOnboardingStateMock).not.toHaveBeenCalled();
      expect(runRemoteGatewayInferenceOnboardingMock).toHaveBeenCalledWith({
        config: sourceConfig,
        gatewayUrl: url,
        token: "missing-inference-remote-auth",
        tlsFingerprint: TLS_FINGERPRINT,
      });
      expect(runTuiMock).not.toHaveBeenCalled();
    },
  );

  it("keeps missing inference setup local for a local Gateway", async () => {
    primeBareRootConfig({
      gateway: { mode: "local" },
    });
    probeGatewayConfiguredModelMock.mockResolvedValueOnce({
      kind: "missing-configured-model",
      detail: "Gateway default agent has no configured model",
    });

    await runBareCli();

    expect(setupWizardCommandMock).toHaveBeenCalledWith({});
    expect(runRemoteGatewayInferenceOnboardingMock).not.toHaveBeenCalled();
    expect(runTuiMock).not.toHaveBeenCalled();
  });

  it("does not direct non-interactive remote setup into local onboarding", async () => {
    primeBareRootConfig({
      gateway: {
        mode: "remote",
        remote: { url: "wss://gateway.example/ws", token: "noninteractive-remote-auth" },
      },
    });
    probeGatewayConfiguredModelMock.mockResolvedValueOnce({
      kind: "missing-configured-model",
      detail: "Gateway default agent has no configured model",
    });
    await expectNonInteractiveBareCliError(
      "Remote Gateway inference setup needs an interactive TTY. Re-run `openclaw` in a terminal connected to this Gateway.",
      () => {
        expect(setupWizardCommandMock).not.toHaveBeenCalled();
        expect(runRemoteGatewayInferenceOnboardingMock).not.toHaveBeenCalled();
      },
    );
  });

  it("uses the active local gateway lock port for bare root preflight and TUI handoff", async () => {
    primeBareRootConfig({
      gateway: {
        mode: "local",
        port: 18789,
        auth: { mode: "token", token: "configured-token" },
      },
    });
    readActiveGatewayLockPortMock.mockResolvedValueOnce(48789);

    await runBareCli();

    expect(probeGatewayConfiguredModelMock).toHaveBeenCalledWith({
      url: "ws://127.0.0.1:48789",
      token: "configured-token",
    });
    expectBoundTui({ url: "ws://127.0.0.1:48789", token: "configured-token" });
  });

  it("keeps an explicit gateway port ahead of active local lock metadata", async () => {
    primeBareRootConfig({
      gateway: {
        mode: "local",
        port: 18789,
        auth: { mode: "token", token: "configured-token" },
      },
    });
    readActiveGatewayLockPortMock.mockResolvedValueOnce(48789);

    await withEnvAsync({ OPENCLAW_GATEWAY_PORT: "19001" }, async () => {
      await runBareCli();
    });

    expect(readActiveGatewayLockPortMock).not.toHaveBeenCalled();
    expect(probeGatewayConfiguredModelMock).toHaveBeenCalledWith({
      url: "ws://127.0.0.1:19001",
      token: "configured-token",
    });
  });

  it("carries the canonical local TLS fingerprint through bare root", async () => {
    primeBareRootConfig({
      gateway: {
        mode: "local",
        tls: { enabled: true },
        auth: { mode: "token", token: "configured-token" },
      },
    });
    loadGatewayTlsRuntimeMock.mockResolvedValueOnce({
      enabled: true,
      required: true,
      fingerprintSha256: TLS_FINGERPRINT,
    });

    await runBareCli();

    expect(probeGatewayConfiguredModelMock).toHaveBeenCalledWith({
      url: "wss://127.0.0.1:18789",
      token: "configured-token",
      tlsFingerprint: TLS_FINGERPRINT,
    });
    expectBoundTui({
      url: "wss://127.0.0.1:18789",
      token: "configured-token",
      tlsFingerprint: TLS_FINGERPRINT,
    });
  });

  it("uses gateway env credentials for bare root gateway preflight", async () => {
    primeBareRootConfig({
      gateway: {
        mode: "local",
        auth: { mode: "token" },
      },
    });

    await withEnvAsync({ OPENCLAW_GATEWAY_TOKEN: "bare-root-env-auth" }, async () => {
      await runBareCli();
    });

    expect(probeGatewayConfiguredModelMock).toHaveBeenCalledWith({
      url: "ws://127.0.0.1:18789",
      token: "bare-root-env-auth",
    });
    expectBoundTui({ url: "ws://127.0.0.1:18789", token: "bare-root-env-auth" });
  });

  it("resolves only the configured auth-mode SecretRef for bare root preflight", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-bare-auth-mode-"));
    const tokenMarker = path.join(tempDir, "token-provider-ran");
    const passwordMarker = path.join(tempDir, "password-provider-ran");
    const tokenProgram = [
      "const fs=require('node:fs');",
      `fs.writeFileSync(${JSON.stringify(tokenMarker)},'1');`,
      "process.stdout.write(JSON.stringify({ protocolVersion: 1, values: { TOKEN_SECRET: 'token-from-exec' } }));", // pragma: allowlist secret
    ].join("");
    const passwordProgram = [
      "const fs=require('node:fs');",
      `fs.writeFileSync(${JSON.stringify(passwordMarker)},'1');`,
      "process.stdout.write(JSON.stringify({ protocolVersion: 1, values: { PASSWORD_SECRET: 'password-from-exec' } }));", // pragma: allowlist secret
    ].join("");
    await withSecureTestNodeExecPath(async () => {
      primeBareRootConfig({
        secrets: {
          providers: {
            tokenprovider: {
              source: "exec",
              command: process.execPath,
              args: ["-e", tokenProgram],
              allowInsecurePath: true,
            },
            passwordprovider: {
              source: "exec",
              command: process.execPath,
              args: ["-e", passwordProgram],
              allowInsecurePath: true,
            },
          },
        },
        gateway: {
          mode: "local",
          auth: {
            mode: "password",
            token: { source: "exec", provider: "tokenprovider", id: "TOKEN_SECRET" },
            password: {
              source: "exec",
              provider: "passwordprovider",
              id: "PASSWORD_SECRET",
            },
          },
        },
      });

      try {
        await runBareCli();

        expect(probeGatewayConfiguredModelMock).toHaveBeenCalledWith({
          url: "ws://127.0.0.1:18789",
          password: "password-from-exec",
        });
        await expect(fs.access(tokenMarker)).rejects.toThrow();
        await expect(fs.access(passwordMarker)).resolves.toBeUndefined();
        expectBoundTui({
          url: "ws://127.0.0.1:18789",
          password: "password-from-exec",
        });
      } finally {
        await fs.rm(tempDir, { recursive: true, force: true });
      }
    });
  });

  it("probes local gateways over loopback even when the gateway advertises a LAN bind", async () => {
    primeBareRootConfig({
      gateway: {
        mode: "local",
        bind: "lan",
        auth: {
          mode: "token",
          token: "local-token",
        },
      },
    });

    await runBareCli();

    expect(readActiveGatewayLockPortMock).toHaveBeenCalledTimes(1);
    expect(probeGatewayConfiguredModelMock).toHaveBeenCalledWith({
      url: "ws://127.0.0.1:18789",
      token: "local-token",
    });
    expectBoundTui({ url: "ws://127.0.0.1:18789", token: "local-token" });
  });

  it("falls back to the configured local tailnet gateway URL when loopback is unavailable", async () => {
    primeBareRootConfig({
      gateway: {
        mode: "local",
        bind: "tailnet",
        auth: {
          mode: "token",
          token: "local-token",
        },
      },
    });
    resolveControlUiLinksMock.mockImplementation(({ bind }: { bind?: string } = {}) =>
      bind === "tailnet"
        ? {
            httpUrl: "http://100.64.0.10:18789/",
            wsUrl: "ws://100.64.0.10:18789",
          }
        : {
            httpUrl: "http://127.0.0.1:18789/",
            wsUrl: "ws://127.0.0.1:18789",
          },
    );
    probeGatewayConfiguredModelMock
      .mockResolvedValueOnce({ kind: "unreachable", detail: "loopback offline" })
      .mockResolvedValueOnce({ kind: "configured" });

    await runBareCli();

    expect(probeGatewayConfiguredModelMock).toHaveBeenNthCalledWith(1, {
      url: "ws://127.0.0.1:18789",
      token: "local-token",
    });
    expect(probeGatewayConfiguredModelMock).toHaveBeenNthCalledWith(2, {
      url: "ws://100.64.0.10:18789",
      token: "local-token",
    });
    expectBoundTui({ url: "ws://100.64.0.10:18789", token: "local-token" });
  });

  it("prefers a configured secondary Gateway over a missing-model primary probe", async () => {
    primeBareRootConfig({
      gateway: {
        mode: "local",
        bind: "tailnet",
        auth: { mode: "token", token: "local-token" },
      },
    });
    resolveControlUiLinksMock.mockImplementation(({ bind }: { bind?: string } = {}) =>
      bind === "tailnet"
        ? { httpUrl: "http://100.64.0.10:18789/", wsUrl: "ws://100.64.0.10:18789" }
        : { httpUrl: "http://127.0.0.1:18789/", wsUrl: "ws://127.0.0.1:18789" },
    );
    probeGatewayConfiguredModelMock
      .mockResolvedValueOnce({
        kind: "missing-configured-model",
        detail: "Gateway default agent has no configured model",
      })
      .mockResolvedValueOnce({ kind: "configured" });

    await runBareCli();

    expect(setupWizardCommandMock).not.toHaveBeenCalled();
    expectBoundTui({ url: "ws://100.64.0.10:18789", token: "local-token" });
  });

  it("keeps confirmed missing inference ahead of an unverified secondary Gateway", async () => {
    primeBareRootConfig({
      agents: { defaults: { model: { primary: "openai/local-only-model" } } },
      gateway: {
        mode: "local",
        bind: "tailnet",
        auth: { mode: "token", token: "local-token" },
      },
    });
    resolveControlUiLinksMock.mockImplementation(({ bind }: { bind?: string } = {}) =>
      bind === "tailnet"
        ? { httpUrl: "http://100.64.0.10:18789/", wsUrl: "ws://100.64.0.10:18789" }
        : { httpUrl: "http://127.0.0.1:18789/", wsUrl: "ws://127.0.0.1:18789" },
    );
    probeGatewayConfiguredModelMock
      .mockResolvedValueOnce({
        kind: "reachable-unverified",
        detail: "config.get: unauthorized",
      })
      .mockResolvedValueOnce({
        kind: "missing-configured-model",
        detail: "Gateway default agent has no configured model",
      });

    await runBareCli();

    expect(setupWizardCommandMock).toHaveBeenCalledWith({});
    expect(runTuiMock).not.toHaveBeenCalled();
  });

  it("keeps a reachable unverified Gateway ahead of local inference fallback", async () => {
    const url = "ws://127.0.0.1:18789";
    primeBareRootConfig({
      agents: { defaults: { model: { primary: "openai/local-only-model" } } },
      gateway: { mode: "remote", remote: { url, token: "unverified-remote-auth" } },
    });
    probeGatewayConfiguredModelMock.mockResolvedValueOnce({
      kind: "reachable-unverified",
      detail: "config.get: unauthorized",
    });

    await runBareCli();

    expect(setupWizardCommandMock).not.toHaveBeenCalled();
    expectBoundTui({ url, token: "unverified-remote-auth" });
  });

  it("keeps a configured remote Gateway authoritative across a transient cold-restart probe", async () => {
    const url = "wss://gateway.example/ws";
    primeBareRootConfig({
      gateway: { mode: "remote", remote: { url, token: "restart-remote-auth" } },
    });
    probeGatewayConfiguredModelMock.mockResolvedValueOnce({
      kind: "unreachable",
      detail: "gateway restarting",
    });

    await runBareCli();

    expect(setupWizardCommandMock).not.toHaveBeenCalled();
    expect(runRemoteGatewayInferenceOnboardingMock).not.toHaveBeenCalled();
    expectBoundTui({ url, token: "restart-remote-auth" });
  });

  it("keeps a configured local Gateway authoritative across a transient cold-restart probe", async () => {
    primeBareRootConfig({
      gateway: { mode: "local", auth: { mode: "token", token: "local-token" } },
    });
    probeGatewayConfiguredModelMock.mockResolvedValueOnce({
      kind: "unreachable",
      detail: "offline",
    });

    await runBareCli();

    expect(setupWizardCommandMock).not.toHaveBeenCalled();
    expectBoundTui({ url: "ws://127.0.0.1:18789", token: "local-token" });
  });

  it("starts the local TUI when no Gateway is configured and the default probe is unavailable", async () => {
    primeBareRootConfig({
      agents: { defaults: { model: { primary: "openai/gpt-5.5" } } },
    });
    probeGatewayConfiguredModelMock.mockResolvedValueOnce({
      kind: "unreachable",
      detail: "offline",
    });

    await runBareCli();

    expect(runTuiMock).toHaveBeenCalledWith({
      deliver: false,
      local: true,
      forceProcessExitOnReturn: true,
    });
  });

  it("starts the local TUI when any explicit-roster agent has inference configured", async () => {
    primeBareRootConfig({
      agents: {
        ownership: "explicit",
        entries: {
          alpha: { model: "openai/gpt-5.6-luna" },
          beta: { model: "openai/gpt-5.6-sol" },
        },
      },
    });
    probeGatewayConfiguredModelMock.mockResolvedValueOnce({
      kind: "unreachable",
      detail: "offline",
    });

    await runBareCli();

    expect(runTuiMock).toHaveBeenCalledWith({
      deliver: false,
      local: true,
      forceProcessExitOnReturn: true,
    });
  });

  it("routes an explicit roster with no configured inference to onboarding", async () => {
    primeBareRootConfig({
      agents: {
        ownership: "explicit",
        entries: { alpha: {}, beta: {} },
      },
    });
    probeGatewayConfiguredModelMock.mockResolvedValueOnce({
      kind: "unreachable",
      detail: "offline",
    });

    await runBareCli();

    expect(setupWizardCommandMock).toHaveBeenCalledWith({});
    expect(runTuiMock).not.toHaveBeenCalled();
  });

  it.each([
    { label: "LAN IP", url: "ws://192.168.1.10:18789" },
    { label: "mDNS", url: "ws://gateway.local:18789" },
    { label: "Tailnet DNS", url: "ws://machine.tail123.ts.net:18789" },
  ])("does not probe a plaintext remote gateway over $label without opt-in", async ({ url }) => {
    primeBareRootConfig({
      gateway: {
        mode: "remote",
        remote: {
          url,
          token: "unsafe-remote-auth",
        },
      },
    });

    await withEnvAsync({ OPENCLAW_ALLOW_INSECURE_PRIVATE_WS: undefined }, async () => {
      await runBareCli();
    });

    expect(probeGatewayConfiguredModelMock).not.toHaveBeenCalled();
    expect(setupWizardCommandMock).toHaveBeenCalledWith({});
    expect(runTuiMock).not.toHaveBeenCalled();
  });

  it("probes a plaintext remote loopback gateway", async () => {
    const url = "ws://127.0.0.1:18789";
    primeBareRootConfig({
      gateway: {
        mode: "remote",
        remote: {
          url,
          token: "loopback-remote-auth",
        },
      },
    });

    await withEnvAsync({ OPENCLAW_ALLOW_INSECURE_PRIVATE_WS: undefined }, async () => {
      await runBareCli();
    });

    expect(probeGatewayConfiguredModelMock).toHaveBeenCalledWith({
      url,
      originScopedDeviceAuth: true,
      token: "loopback-remote-auth",
    });
    expect(setupWizardCommandMock).not.toHaveBeenCalled();
    expectBoundTui({ url, token: "loopback-remote-auth" });
  });

  it("passes configured remote edge auth into the bare-root onboarding probe", async () => {
    const url = "wss://gateway.example/ws";
    const config: OpenClawConfig = {
      gateway: {
        mode: "remote",
        remote: {
          url,
          token: "test-token",
          edgeAuth: { "X-Edge-Auth": "test-secret" },
        },
      },
    };
    primeBareRootConfig(config);

    await runBareCli();

    expect(probeGatewayConfiguredModelMock).toHaveBeenCalledWith({
      url,
      originScopedDeviceAuth: true,
      config,
      token: "test-token",
    });
    expectBoundTui({ url, token: "test-token" });
  });

  it("keeps configured remote password authoritative from preflight through TUI launch", async () => {
    const url = "ws://127.0.0.1:18789";
    primeBareRootConfig({
      gateway: {
        mode: "remote",
        remote: {
          url,
          password: "configured-remote-password", // pragma: allowlist secret
        },
      },
    });

    await withEnvAsync({ OPENCLAW_GATEWAY_PASSWORD: "obsolete-shell-pass-value" }, async () => {
      await runBareCli();
    });

    expect(probeGatewayConfiguredModelMock).toHaveBeenCalledWith({
      url,
      originScopedDeviceAuth: true,
      password: "configured-remote-password",
    });
    expectBoundTui({ url, password: "configured-remote-password" });
  });

  it("does not replace unresolved remote SecretRefs with gateway env auth", async () => {
    const url = "ws://127.0.0.1:18789";
    primeBareRootConfig({
      gateway: {
        mode: "remote",
        remote: {
          url,
          token: {
            source: "env",
            provider: "default",
            id: "MISSING_REMOTE_GATEWAY_TOKEN",
          },
          password: {
            source: "env",
            provider: "default",
            id: "MISSING_REMOTE_GATEWAY_PASSWORD",
          },
        },
      },
    });

    await withEnvAsync(
      {
        MISSING_REMOTE_GATEWAY_TOKEN: undefined,
        MISSING_REMOTE_GATEWAY_PASSWORD: undefined,
        OPENCLAW_GATEWAY_TOKEN: "shell-fallback-auth-value",
        OPENCLAW_GATEWAY_PASSWORD: "env-remote-password",
      },
      async () => {
        await runBareCli();
      },
    );

    expect(probeGatewayConfiguredModelMock).toHaveBeenCalledWith({
      url,
      originScopedDeviceAuth: true,
    });
    expect(setupWizardCommandMock).not.toHaveBeenCalled();
    expectBoundTui({ url });
  });

  it("probes an explicitly allowed plaintext private remote gateway", async () => {
    const url = "ws://192.168.1.10:18789";
    primeBareRootConfig({
      gateway: {
        mode: "remote",
        remote: {
          url,
          token: "private-remote-auth",
        },
      },
    });

    await withEnvAsync({ OPENCLAW_ALLOW_INSECURE_PRIVATE_WS: "1" }, async () => {
      await runBareCli();
    });

    expect(probeGatewayConfiguredModelMock).toHaveBeenCalledWith({
      url,
      originScopedDeviceAuth: true,
      token: "private-remote-auth",
    });
    expect(setupWizardCommandMock).not.toHaveBeenCalled();
    expectBoundTui({ url, token: "private-remote-auth" });
  });

  it("forwards the configured TLS pin when probing a remote gateway", async () => {
    primeBareRootConfig({
      gateway: {
        mode: "remote",
        remote: {
          url: "wss://gateway.example.com:18789",
          token: "tls-remote-auth",
          tlsFingerprint: `sha256:${TLS_FINGERPRINT.toUpperCase()}`,
        },
      },
    });

    await runBareCli();

    expect(probeGatewayConfiguredModelMock).toHaveBeenCalledWith({
      url: "wss://gateway.example.com:18789",
      originScopedDeviceAuth: true,
      token: "tls-remote-auth",
      tlsFingerprint: TLS_FINGERPRINT,
    });
    expectBoundTui({
      url: "wss://gateway.example.com:18789",
      token: "tls-remote-auth",
      tlsFingerprint: TLS_FINGERPRINT,
    });
  });

  it("routes to inference onboarding without probing a public plaintext remote gateway", async () => {
    primeBareRootConfig({
      gateway: {
        mode: "remote",
        remote: {
          url: "ws://gateway.example.com:18789",
          token: "public-remote-auth",
        },
      },
    });

    await withEnvAsync({ OPENCLAW_ALLOW_INSECURE_PRIVATE_WS: undefined }, async () => {
      await runBareCli();
    });

    expect(probeGatewayConfiguredModelMock).not.toHaveBeenCalled();
    expect(setupWizardCommandMock).toHaveBeenCalledWith({});
    expect(runTuiMock).not.toHaveBeenCalled();
  });

  it("rejects configured bare root TUI startup without an interactive TTY", async () => {
    const previousExitCode = process.exitCode;
    const stdinDescriptor = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
    const stdoutDescriptor = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    process.exitCode = undefined;
    Object.defineProperty(process.stdin, "isTTY", { configurable: true, value: false });
    Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: false });

    try {
      await runCli(["node", "openclaw"]);

      expect(process.exitCode).toBe(1);
      expect(errorSpy).toHaveBeenCalledWith(
        "OpenClaw TUI needs an interactive TTY. Use `openclaw agent --local ...` for automation.",
      );
      expect(runTuiMock).not.toHaveBeenCalled();
    } finally {
      errorSpy.mockRestore();
      process.exitCode = previousExitCode;
      if (stdinDescriptor) {
        Object.defineProperty(process.stdin, "isTTY", stdinDescriptor);
      } else {
        Reflect.deleteProperty(process.stdin, "isTTY");
      }
      if (stdoutDescriptor) {
        Object.defineProperty(process.stdout, "isTTY", stdoutDescriptor);
      } else {
        Reflect.deleteProperty(process.stdout, "isTTY");
      }
    }
  });

  it("routes invalid configured bare root invocations to classic doctor guidance", async () => {
    readConfigFileSnapshotMock.mockResolvedValueOnce({
      exists: true,
      valid: false,
      sourceConfig: { gateway: { mode: "local" } },
    });

    await runBareCli();

    expect(readLocalOnboardingStateMock).not.toHaveBeenCalled();
    expect(setupWizardCommandMock).toHaveBeenCalledWith({ classic: true });
    expect(runTuiMock).not.toHaveBeenCalled();
  });

  it("points noninteractive invalid config to doctor before onboarding", async () => {
    readConfigFileSnapshotMock.mockResolvedValueOnce({
      exists: true,
      valid: false,
      sourceConfig: { gateway: { mode: "local" } },
    });
    await expectNonInteractiveBareCliError(
      "OpenClaw config is invalid. Run `openclaw doctor --fix` before onboarding.",
      () => expect(setupWizardCommandMock).not.toHaveBeenCalled(),
    );
  });

  it("bootstraps env proxy before bare TUI startup", async () => {
    hasEnvHttpProxyAgentConfiguredMock.mockReturnValue(true);

    await runBareCli();

    expect(ensureGlobalUndiciEnvProxyDispatcherMock).toHaveBeenCalledTimes(1);
    expect(runTuiMock).toHaveBeenCalledOnce();
    expect(ensureGlobalUndiciEnvProxyDispatcherMock.mock.invocationCallOrder[0]).toBeLessThan(
      expectDefined(
        probeGatewayConfiguredModelMock.mock.invocationCallOrder[0],
        "probeGatewayConfiguredModelMock.mock.invocationCallOrder[0] test invariant",
      ),
    );
    expect(ensureGlobalUndiciEnvProxyDispatcherMock.mock.invocationCallOrder[0]).toBeLessThan(
      expectDefined(
        runTuiMock.mock.invocationCallOrder[0],
        "runTuiMock.mock.invocationCallOrder[0] test invariant",
      ),
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
    expect(enableConsoleCaptureMock).toHaveBeenCalledTimes(1);
    const captureOrder = enableConsoleCaptureMock.mock.invocationCallOrder[0] ?? 0;
    const containerOrder = maybeRunCliInContainerMock.mock.invocationCallOrder[0] ?? 0;
    expect(captureOrder).toBeGreaterThan(0);
    expect(containerOrder).toBeGreaterThan(captureOrder);
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

  it("requests a flushed one-shot exit after Commander renders help", async () => {
    const exitCode = process.exitCode;
    const program = {
      commands: [{ name: () => "security" }],
      parseAsync: vi
        .fn()
        .mockRejectedValueOnce(new CommanderError(0, "commander.helpDisplayed", "help displayed")),
    };
    buildProgramMock.mockReturnValueOnce(program);

    await runCli(["node", "openclaw", "security", "--help"]);

    expect(requestExitAfterOneShotOutputMock).toHaveBeenCalledOnce();
    expect(flushExitAfterOneShotOutputMock).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(0);
    process.exitCode = exitCode;
  });

  it("requests a flushed one-shot exit when plugin group help returns normally", async () => {
    const program = {
      commands: [{ name: () => "memory" }],
      parseAsync: vi.fn().mockResolvedValueOnce(undefined),
    };
    buildProgramMock.mockReturnValueOnce(program);
    resolvePluginCliRootOwnerIdsMock.mockReturnValueOnce(["memory-core"]);

    await runCli(["node", "openclaw", "memory", "--help"]);

    expect(requestExitAfterOneShotOutputMock).toHaveBeenCalledOnce();
    expect(flushExitAfterOneShotOutputMock).not.toHaveBeenCalled();
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

  it.each([false, true])(
    "restores terminal state before uncaught CLI exits (machine output: %s)",
    async (machineOutput) => {
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
        loggingState.forceConsoleToStderr = machineOutput;
        expect(() => handler(new Error("boom"))).toThrow("process.exit(1)");
        expect(consoleErrorSpy).toHaveBeenCalledWith(
          "[openclaw] OpenClaw hit an unexpected runtime error.",
        );
        expect(consoleErrorSpy).toHaveBeenCalledWith("[openclaw] Reason: boom");
        expect(restoreRuntimeTerminalStateMock).toHaveBeenCalledWith("uncaught exception", {
          resumeStdinIfPaused: false,
        });
      } finally {
        loggingState.forceConsoleToStderr = false;
        if (typeof handler === "function") {
          process.off("uncaughtException", handler);
        }
        consoleErrorSpy.mockRestore();
        exitSpy.mockRestore();
        processOnSpy.mockRestore();
      }
    },
  );

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
      expect(restoreRuntimeTerminalStateMock).not.toHaveBeenCalled();
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
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
