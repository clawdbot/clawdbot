// Main CLI entry orchestration: fast paths, env setup, plugin aliases, and Commander dispatch.
import { existsSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import type { Command as CommanderCommand, Option as CommanderOption } from "commander";
import { sanitizeTerminalText } from "../../packages/terminal-core/src/safe-text.js";
import { resolveStateDir } from "../config/paths.js";
import type { ConfigFileSnapshot, OpenClawConfig } from "../config/types.openclaw.js";
import { isLoopbackAddress, isSecureWebSocketUrl } from "../gateway/net.js";
import { normalizeWebSocketProtocol } from "../gateway/websocket-protocol.js";
import {
  consumeRootOptionToken,
  FLAG_TERMINATOR,
  isValueToken,
} from "../infra/cli-root-options.js";
import { isTruthyEnvValue, normalizeEnv } from "../infra/env.js";
import type { ProxyHandle } from "../infra/net/proxy/proxy-lifecycle.js";
import { ensureOpenClawCliOnPath } from "../infra/path-env.js";
import { assertSupportedRuntime } from "../infra/runtime-guard.js";
import { tryProcessCwd } from "../infra/safe-cwd.js";
import { resolveCliArgvInvocation } from "./argv-invocation.js";
import {
  hasFlag,
  normalizeGeneratedHelpCommandArgv,
  normalizeRootHelpTargetArgv,
  normalizeRootLogLevelArgv,
  normalizeRootNoColorArgv,
} from "./argv.js";
import {
  isReservedNonPluginCommandRoot,
  shouldRegisterPrimaryCommandOnly,
  shouldSkipPluginCommandRegistration,
} from "./command-registration-policy.js";
import { resolveCliStartupPolicy as resolveCliStartupPolicyForArgv } from "./command-startup-policy.js";
import { maybeRunCliInContainer, parseCliContainerArgs } from "./container-target.js";
import { isUnconfiguredConfigSource } from "./fresh-install-config.js";
import {
  consumeGatewayFastPathRootOptionToken,
  consumeGatewayRunOptionToken,
  resolveGatewayCatalogCommandPath,
  resolveGatewayRunPreBootstrapOptions,
} from "./gateway-run-argv.js";
import {
  hasJsonOutputFlag,
  isJsonOutputModeActive,
  withConsoleLogsRoutedToStderr,
  withConsoleLogsRoutedToStderrForJson,
} from "./json-output-mode.js";
import { isMachineOutputStdoutTTY } from "./machine-output-argv.js";
import { requestExitAfterOneShotOutput } from "./one-shot-exit.js";
import { tryOutputPrecomputedCommandHelp } from "./precomputed-help.js";
import { applyCliProfileEnv, parseCliProfileArgs } from "./profile.js";
import {
  getCoreCliCommandDescriptors,
  getCoreCliCommandNamesCore,
} from "./program/core-command-descriptors.js";
import { getSubCliEntriesCore } from "./program/subcli-descriptors.js";
import {
  resolveMissingPluginCommandMessage,
  rewriteUpdateFlagArgv,
  shouldHandleBareRoot,
  shouldEnsureCliPath,
  shouldStartProxyForCli,
  shouldUseRootHelpFastPath,
  shouldUseSetupOnboardConfigureHelpFastPath,
} from "./run-main-policy.js";
import { registerSignalExitBarrier, waitForSignalExitBarriers } from "./signal-exit-barrier.js";
import {
  configureGatewayStartupTraceConsoleFormatting,
  createGatewayDispatchStartupTrace,
} from "./startup-trace.js";
import { normalizeWindowsArgv } from "./windows-argv.js";

export {
  rewriteUpdateFlagArgv,
  shouldHandleBareRoot,
  shouldEnsureCliPath,
  shouldStartProxyForCli,
  shouldUseRootHelpFastPath,
  shouldUseSetupOnboardConfigureHelpFastPath,
} from "./run-main-policy.js";

const CLI_PROXY_ENV_KEYS = [
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "http_proxy",
  "https_proxy",
  "all_proxy",
] as const;
const UNKNOWN_COMMAND_DISPLAY_LIMIT = 128;

const loadRootHelpLiveConfigModule = async () => await import("./root-help-live-config.js");
const loadRootHelpMetadataModule = async () => await import("./root-help-metadata.js");
const loadLoggingModule = async () => await import("../logging.js");
const loadCliRegistryLoaderModule = async () => await import("../plugins/cli-registry-loader.js");
const loadManifestCommandAliasesRuntimeModule = async () =>
  await import("../plugins/manifest-command-aliases.runtime.js");
const loadProxyLifecycleModule = async () => await import("../infra/net/proxy/proxy-lifecycle.js");
const loadProgressModule = async () => await import("./progress.js");

function isRemoteAgentDispatchInvocation(argv: string[], primary: string | null): boolean {
  return primary === "agent" && !argv.includes("--local");
}

export function isGatewayRunFastPathArgv(argv: string[]): boolean {
  const invocation = resolveCliArgvInvocation(argv);
  if (invocation.hasHelpOrVersion) {
    return false;
  }
  const args = argv.slice(2);
  let sawGateway = false;
  let sawRun = false;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg || arg === "--") {
      return false;
    }
    if (!sawGateway) {
      const consumed = consumeGatewayFastPathRootOptionToken(args, index);
      if (consumed > 0) {
        index += consumed - 1;
        continue;
      }
      if (arg !== "gateway") {
        return false;
      }
      sawGateway = true;
      continue;
    }

    const rootConsumed = consumeRootOptionToken(args, index);
    if (rootConsumed > 0) {
      index += rootConsumed - 1;
      continue;
    }
    const consumed = consumeGatewayRunOptionToken(args, index);
    if (consumed > 0) {
      index += consumed - 1;
      continue;
    }
    if (!sawRun && arg === "run") {
      sawRun = true;
      continue;
    }
    return false;
  }

  return sawGateway;
}

function isGatewayRunInvocationArgv(argv: string[]): boolean {
  const commandPath = resolveGatewayCatalogCommandPath(argv);
  return (
    commandPath?.length === 1 ||
    (commandPath?.length === 2 && commandPath[0] === "gateway" && commandPath[1] === "run")
  );
}

async function tryRunGatewayRunFastPath(
  argv: string[],
  startupTrace: ReturnType<typeof createGatewayDispatchStartupTrace>,
): Promise<boolean> {
  if (!isGatewayRunFastPathArgv(argv)) {
    return false;
  }
  const [
    { Command },
    { addGatewayRunCommand },
    { VERSION },
    { emitCliBanner },
    { resolveCliStartupPolicy },
    { ensureCliExecutionBootstrap },
    { defaultRuntime },
  ] = await startupTrace.measure("gateway-run-imports", () =>
    Promise.all([
      import("commander"),
      import("./gateway-cli/run-command.js"),
      import("../version.js"),
      import("./banner.js"),
      import("./command-startup-policy.js"),
      import("./command-execution-startup.js"),
      import("../runtime.js"),
    ]),
  );
  const commandPath = resolveGatewayCatalogCommandPath(argv) ?? ["gateway"];
  const startupPolicy = resolveCliStartupPolicy({
    argv,
    commandPath,
    jsonOutputMode: hasJsonOutputFlag(argv),
  });
  if (!startupPolicy.hideBanner) {
    emitCliBanner(VERSION, { argv });
  }
  const program = new Command();
  program.name("openclaw");
  program.enablePositionalOptions();
  program.option("--no-color", "Disable ANSI colors", false);
  program.exitOverride((err) => {
    process.exitCode = typeof err.exitCode === "number" ? err.exitCode : 1;
    throw err;
  });
  const beforeRun = async (opts: { force?: boolean; reset?: boolean }) => {
    let beforeStateMigrations: ((snapshot?: ConfigFileSnapshot) => Promise<boolean>) | undefined;
    let skipPristineStartupStateMigrations = false;
    let skipPristineCoreStateMigrations = false;
    const shouldBootstrap = await startupTrace.measure("gateway-run-pre-bootstrap", async () => {
      const {
        prepareGatewayRunBootstrap,
        recheckGatewayRunBootstrap,
        wasPreparedGatewayRunCoreStatePristine,
        wasPreparedGatewayRunStatePristine,
      } = await import("./gateway-cli/pre-bootstrap.js");
      const prepared = await prepareGatewayRunBootstrap({ opts, runtime: defaultRuntime });
      if (prepared) {
        skipPristineStartupStateMigrations = wasPreparedGatewayRunStatePristine();
        skipPristineCoreStateMigrations = wasPreparedGatewayRunCoreStatePristine();
        beforeStateMigrations = (snapshot) =>
          recheckGatewayRunBootstrap({
            opts,
            runtime: defaultRuntime,
            ...(snapshot ? { snapshot } : {}),
          });
      }
      return prepared;
    });
    if (!shouldBootstrap) {
      return;
    }
    await startupTrace.measure("gateway-run-bootstrap", async () => {
      await ensureCliExecutionBootstrap({
        runtime: defaultRuntime,
        commandPath,
        startupPolicy,
        loadPlugins: false,
        ...(beforeStateMigrations ? { beforeStateMigrations } : {}),
        ...(skipPristineStartupStateMigrations ? { skipPristineStartupStateMigrations: true } : {}),
        ...(skipPristineCoreStateMigrations ? { skipPristineCoreStateMigrations: true } : {}),
      });
      const { reloadTrustedGatewayRunEnvironment } = await import("./gateway-cli/pre-bootstrap.js");
      await reloadTrustedGatewayRunEnvironment({ runtime: defaultRuntime });
    });
  };
  const gateway = addGatewayRunCommand(
    program.command("gateway").description("Run, inspect, and query the WebSocket Gateway"),
    { beforeRun },
  );
  addGatewayRunCommand(
    gateway.command("run").description("Run the WebSocket Gateway (foreground)"),
    { beforeRun },
  );
  try {
    await startupTrace.measure("gateway-run-parse", () => program.parseAsync(argv), {
      timeline: false,
    });
  } catch (error) {
    if (!isCommanderParseExit(error)) {
      throw error;
    }
    process.exitCode = error.exitCode;
  }
  return true;
}

async function closeCliResources(): Promise<void> {
  const finalizers = [
    async () => {
      const { listRegisteredAgentHarnesses, disposeRegisteredAgentHarnesses } =
        await import("../agents/harness/registry.js");
      if (listRegisteredAgentHarnesses().length > 0) {
        await disposeRegisteredAgentHarnesses();
      }
    },
    async () => {
      const { hasManagedProviderLocalServices } =
        await import("../agents/provider-runtime-lifecycle.js");
      if (hasManagedProviderLocalServices()) {
        const { stopManagedProviderLocalServices } =
          await import("../agents/provider-local-service.js");
        stopManagedProviderLocalServices();
      }
    },
    async () => {
      const { hasProviderTransportDispatcherPool } =
        await import("../agents/provider-runtime-lifecycle.js");
      if (hasProviderTransportDispatcherPool()) {
        const { closeProviderTransportDispatcherPool } =
          await import("../agents/provider-transport-dispatcher-pool.js");
        await closeProviderTransportDispatcherPool();
      }
    },
    async () => {
      const { getActiveMcpLoopbackRuntime } =
        await import("../gateway/mcp-http.loopback-runtime.js");
      if (getActiveMcpLoopbackRuntime()) {
        const { closeMcpLoopbackServer } = await import("../gateway/mcp-http.js");
        await closeMcpLoopbackServer();
      }
    },
    async () => {
      const { hasMemoryRuntime } = await import("../plugins/memory-state.js");
      if (hasMemoryRuntime()) {
        const { closeActiveMemorySearchManagersCore } =
          await import("../plugins/memory-runtime.js");
        await closeActiveMemorySearchManagersCore();
      }
    },
  ];
  // Teardown is sequential and best-effort so one stale lazy chunk or plugin
  // failure cannot mask the CLI command's result or skip later resources.
  for (const finalize of finalizers) {
    await finalize().catch(() => undefined);
  }
}

function isUnconfiguredConfigSnapshot(
  snapshot: Pick<ConfigFileSnapshot, "exists" | "valid" | "sourceConfig">,
): boolean {
  if (!snapshot.exists) {
    return true;
  }
  if (!snapshot.valid) {
    return false;
  }
  return isUnconfiguredConfigSource(snapshot.sourceConfig);
}

async function shouldStartLocalOnboarding(
  snapshot: Pick<ConfigFileSnapshot, "exists" | "valid" | "sourceConfig" | "path">,
): Promise<boolean> {
  if (isUnconfiguredConfigSnapshot(snapshot)) {
    return true;
  }
  if (!snapshot.valid || snapshot.sourceConfig.gateway?.mode === "remote") {
    return false;
  }
  // Inference persists before setup finishes; only its owning receipt can
  // distinguish interrupted local onboarding from an authored model-only config.
  const { readLocalOnboardingStateForConfig } = await import("../state/local-onboarding-state.js");
  return (
    readLocalOnboardingStateForConfig(snapshot.path, snapshot.sourceConfig)?.status === "pending"
  );
}

export async function shouldStartOnboardingForFreshInstall(argv: string[]): Promise<boolean> {
  if (!shouldHandleBareRoot(argv)) {
    return false;
  }
  const { readConfigFileSnapshot } = await import("../config/config.js");
  const snapshot = await readConfigFileSnapshot();
  return shouldStartLocalOnboarding(snapshot);
}

type BareRootLaunchTarget =
  | { kind: "onboarding"; classic?: boolean }
  | {
      kind: "remote-gateway-inference";
      target: {
        config: OpenClawConfig;
        gatewayUrl: string;
        token?: string;
        password?: string;
        tlsFingerprint?: string;
      };
    }
  | { kind: "tui"; local: true }
  | {
      kind: "tui";
      local: false;
      config: OpenClawConfig;
      gatewayUrl: string;
      token?: string;
      password?: string;
      tlsFingerprint?: string;
    };

async function resolveBareRootLaunchTarget(argv: string[]): Promise<BareRootLaunchTarget | null> {
  if (!shouldHandleBareRoot(argv)) {
    return null;
  }
  const { readConfigFileSnapshot } = await import("../config/config.js");
  const snapshot = await readConfigFileSnapshot();
  if (await shouldStartLocalOnboarding(snapshot)) {
    return { kind: "onboarding" };
  }
  if (!snapshot.valid) {
    return { kind: "onboarding", classic: true };
  }
  return resolveConfiguredTuiLaunchTarget(snapshot.config ?? snapshot.sourceConfig, {
    hasConfiguredGateway: snapshot.sourceConfig.gateway !== undefined,
  });
}

async function resolveConfiguredTuiLaunchTarget(
  config: OpenClawConfig,
  options: { hasConfiguredGateway: boolean },
): Promise<BareRootLaunchTarget> {
  const gatewayResolution = await resolveReachableGateway(config, options);
  if (
    gatewayResolution.kind === "configured" ||
    gatewayResolution.kind === "reachable-unverified" ||
    gatewayResolution.kind === "configured-unreachable"
  ) {
    const gateway = gatewayResolution.gateway;
    const target: BareRootLaunchTarget = {
      kind: "tui",
      local: false,
      config,
      gatewayUrl: gateway.url,
    };
    if (gateway.token) {
      target.token = gateway.token;
    }
    if (gateway.password) {
      target.password = gateway.password;
    }
    if (gateway.tlsFingerprint) {
      target.tlsFingerprint = gateway.tlsFingerprint;
    }
    return target;
  }
  if (gatewayResolution.kind === "missing-configured-model") {
    // The connected Gateway is authoritative. Never fall back to a model in
    // this client's local config when that server still needs inference.
    if (gatewayResolution.gateway.remote) {
      const target: Extract<BareRootLaunchTarget, { kind: "remote-gateway-inference" }> = {
        kind: "remote-gateway-inference",
        target: {
          config,
          gatewayUrl: gatewayResolution.gateway.url,
          ...(gatewayResolution.gateway.token ? { token: gatewayResolution.gateway.token } : {}),
          ...(gatewayResolution.gateway.password
            ? { password: gatewayResolution.gateway.password }
            : {}),
          ...(gatewayResolution.gateway.tlsFingerprint
            ? { tlsFingerprint: gatewayResolution.gateway.tlsFingerprint }
            : {}),
        },
      };
      return target;
    }
    return { kind: "onboarding" };
  }
  const { resolveAgentEffectiveModelPrimary, resolveDefaultAgentId } =
    await import("../agents/agent-scope.js");
  if (!resolveAgentEffectiveModelPrimary(config, resolveDefaultAgentId(config))) {
    return { kind: "onboarding" };
  }
  return { kind: "tui", local: true };
}

type GatewayProbeTarget = {
  url: string;
  scope: "local-loopback" | "local-configured" | "remote";
  tlsFingerprint?: string;
  preauthHandshakeTimeoutMs?: number;
};

type ReachableGateway = {
  url: string;
  remote: boolean;
  token?: string;
  password?: string;
  tlsFingerprint?: string;
};

type GatewayResolution =
  | { kind: "configured"; gateway: ReachableGateway }
  | { kind: "missing-configured-model"; gateway: ReachableGateway }
  | { kind: "reachable-unverified"; gateway: ReachableGateway }
  | { kind: "configured-unreachable"; gateway: ReachableGateway }
  | { kind: "unreachable" };

type GatewayProbeAuth = {
  token?: string;
  password?: string;
};

function toReachableGateway(target: GatewayProbeTarget, auth: GatewayProbeAuth): ReachableGateway {
  return {
    url: target.url,
    remote: target.scope === "remote",
    ...(auth.token ? { token: auth.token } : {}),
    ...(auth.password ? { password: auth.password } : {}),
    ...(target.tlsFingerprint ? { tlsFingerprint: target.tlsFingerprint } : {}),
  };
}

async function resolveReachableGateway(
  config: OpenClawConfig,
  options: { hasConfiguredGateway: boolean },
): Promise<GatewayResolution> {
  const { targets, auth } = await resolveGatewayProbePlan(config);
  if (targets.length === 0) {
    return { kind: "unreachable" };
  }
  const { probeGatewayConfiguredModel } = await import("../commands/onboard-helpers.js");
  let missingModelGateway: ReachableGateway | undefined;
  let reachableUnverifiedGateway: ReachableGateway | undefined;
  let configuredGateway: ReachableGateway | undefined;
  for (const target of targets) {
    if (!isSafeGatewayProbeTarget(target)) {
      continue;
    }
    // A cold-restarting configured Gateway remains the authoritative route.
    // Keep its safe endpoint so one failed probe cannot reopen local onboarding.
    if (options.hasConfiguredGateway && !configuredGateway) {
      configuredGateway = toReachableGateway(target, auth);
    }
    const probeOptions: {
      url: string;
      token?: string;
      password?: string;
      tlsFingerprint?: string;
      preauthHandshakeTimeoutMs?: number;
    } = { url: target.url };
    if (auth.token) {
      probeOptions.token = auth.token;
    }
    if (auth.password) {
      probeOptions.password = auth.password;
    }
    if (target.tlsFingerprint) {
      probeOptions.tlsFingerprint = target.tlsFingerprint;
    }
    if (target.preauthHandshakeTimeoutMs) {
      probeOptions.preauthHandshakeTimeoutMs = target.preauthHandshakeTimeoutMs;
    }
    const probe = await probeGatewayConfiguredModel(probeOptions);
    if (probe.kind === "configured") {
      return { kind: "configured", gateway: toReachableGateway(target, auth) };
    }
    if (probe.kind === "missing-configured-model") {
      missingModelGateway ??= toReachableGateway(target, auth);
      continue;
    }
    if (probe.kind === "reachable-unverified" && !reachableUnverifiedGateway) {
      reachableUnverifiedGateway = toReachableGateway(target, auth);
    }
  }
  if (missingModelGateway) {
    return { kind: "missing-configured-model", gateway: missingModelGateway };
  }
  if (reachableUnverifiedGateway) {
    return { kind: "reachable-unverified", gateway: reachableUnverifiedGateway };
  }
  if (configuredGateway) {
    return { kind: "configured-unreachable", gateway: configuredGateway };
  }
  return { kind: "unreachable" };
}

async function resolveGatewayProbePlan(
  config: OpenClawConfig,
): Promise<{ targets: GatewayProbeTarget[]; auth: GatewayProbeAuth }> {
  const remoteUrl = normalizeOptionalString(config.gateway?.remote?.url);
  if (normalizeOptionalString(config.gateway?.mode) === "remote" && remoteUrl) {
    try {
      const { resolveGatewayClientBootstrap } = await import("../gateway/client-bootstrap.js");
      const bootstrap = await resolveGatewayClientBootstrap({
        config,
        authPolicy: "probe",
        modeOverride: "remote",
        ignoreEnvUrlOverride: true,
      });
      return {
        targets: [
          {
            url: bootstrap.url,
            scope: "remote",
            ...(bootstrap.tlsFingerprint ? { tlsFingerprint: bootstrap.tlsFingerprint } : {}),
          },
        ],
        auth: bootstrap.auth,
      };
    } catch {
      return { targets: [], auth: {} };
    }
  }
  return resolveLocalGatewayProbeTargets(config);
}

function isSafeGatewayProbeTarget(target: GatewayProbeTarget): boolean {
  if (target.scope === "remote") {
    return isSafeRemoteGatewayProbeUrl(target.url);
  }
  return isSecureWebSocketUrl(target.url, {
    allowPrivateWs: process.env.OPENCLAW_ALLOW_INSECURE_PRIVATE_WS === "1",
  });
}

function isSafeRemoteGatewayProbeUrl(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  const protocol = normalizeWebSocketProtocol(parsed.protocol);
  if (protocol === "wss:") {
    return true;
  }
  if (protocol !== "ws:") {
    return false;
  }
  if (isLoopbackGatewayHost(parsed.hostname)) {
    return true;
  }
  return (
    process.env.OPENCLAW_ALLOW_INSECURE_PRIVATE_WS === "1" &&
    isSecureWebSocketUrl(url, { allowPrivateWs: true })
  );
}

function isLoopbackGatewayHost(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/\.+$/, "");
  if (normalized === "localhost") {
    return true;
  }
  const hostForIpCheck =
    normalized.startsWith("[") && normalized.endsWith("]") ? normalized.slice(1, -1) : normalized;
  return isLoopbackAddress(hostForIpCheck);
}

async function resolveLocalGatewayProbeTargets(
  config: OpenClawConfig,
): Promise<{ targets: GatewayProbeTarget[]; auth: GatewayProbeAuth }> {
  const [
    { resolveGatewayPort },
    { resolveControlUiLinks },
    { resolveGatewayClientBootstrap },
    { readActiveGatewayLockPort },
  ] = await Promise.all([
    import("../config/paths.js"),
    import("../gateway/control-ui-links.js"),
    import("../gateway/client-bootstrap.js"),
    import("../infra/gateway-lock.js"),
  ]);
  const gateway = config.gateway;
  const configuredPort = resolveGatewayPort(config);
  const hasExplicitPort = Boolean(normalizeOptionalString(process.env.OPENCLAW_GATEWAY_PORT));
  const activePort = hasExplicitPort ? undefined : await readActiveGatewayLockPort();
  const port = activePort ?? configuredPort;
  // Supplying the selected local port keeps inherited remote URL overrides out
  // of bare-root routing while reusing canonical local TLS/fingerprint logic.
  const connection = await resolveGatewayClientBootstrap({
    config,
    authPolicy: "probe",
    modeOverride: "local",
    ignoreEnvUrlOverride: true,
    localPortOverride: port,
  });
  const baseParams = {
    port,
    basePath: gateway?.controlUi?.basePath,
    tlsEnabled: gateway?.tls?.enabled === true,
  };
  const sharedTarget = {
    ...(connection.tlsFingerprint ? { tlsFingerprint: connection.tlsFingerprint } : {}),
    ...(connection.preauthHandshakeTimeoutMs
      ? { preauthHandshakeTimeoutMs: connection.preauthHandshakeTimeoutMs }
      : {}),
  };
  const loopbackTarget: GatewayProbeTarget = {
    ...sharedTarget,
    url: connection.url,
    scope: "local-loopback",
  };
  const bind = gateway?.bind;
  if (bind !== "tailnet" && bind !== "custom") {
    return { targets: [loopbackTarget], auth: connection.auth };
  }
  const configuredLinks = resolveControlUiLinks({
    ...baseParams,
    bind,
    customBindHost: gateway?.customBindHost,
  });
  const targets =
    configuredLinks.wsUrl === connection.url
      ? [loopbackTarget]
      : [
          loopbackTarget,
          {
            ...sharedTarget,
            url: configuredLinks.wsUrl,
            scope: "local-configured" as const,
          },
        ];
  return { targets, auth: connection.auth };
}

function pauseNonTtyStdinForCliExit(): void {
  const stdin = process.stdin;
  if (stdin.isTTY) {
    return;
  }
  try {
    stdin.pause();
  } catch {
    // Best-effort cleanup for command paths that only inspected stdin.
  }
}

function shouldLoadCliDotEnv(
  loadGlobalEnv: boolean,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const cwd = tryProcessCwd();
  if (cwd && existsSync(path.join(cwd, ".env"))) {
    return true;
  }
  return loadGlobalEnv && existsSync(path.join(resolveStateDir(env), ".env"));
}

function isAgentExecInvocation(commandPath: string[]): boolean {
  return commandPath[0] === "agent" && commandPath[1] === "exec";
}

function isCommanderParseExit(error: unknown): error is { exitCode: number } {
  if (!error || typeof error !== "object") {
    return false;
  }
  const candidate = error as { code?: unknown; exitCode?: unknown };
  return (
    typeof candidate.exitCode === "number" &&
    Number.isInteger(candidate.exitCode) &&
    typeof candidate.code === "string" &&
    candidate.code.startsWith("commander.")
  );
}

function findCommandOption(command: CommanderCommand, token: string): CommanderOption | undefined {
  const equalsIndex = token.indexOf("=");
  const flag = equalsIndex === -1 ? token : token.slice(0, equalsIndex);
  return command.options.find((option) => option.long === flag || option.short === flag);
}

function findSubcommand(command: CommanderCommand, name: string): CommanderCommand | undefined {
  return command.commands.find(
    (subcommand) => subcommand.name() === name || subcommand.aliases().includes(name),
  );
}

function shouldOptionConsumeFollowingToken(
  option: CommanderOption | undefined,
  token: string,
  next: string | undefined,
): boolean {
  if (!option || token.includes("=")) {
    return false;
  }
  if (option.required) {
    return true;
  }
  return option.optional && isValueToken(next);
}

function isNoColorConsumedAsCommandOptionValue(
  program: CommanderCommand,
  remainingArgs: readonly string[],
  noColorIndex: number,
): boolean {
  let command = program;
  let pendingValue = false;
  for (let index = 0; index < noColorIndex; index += 1) {
    const arg = remainingArgs[index];
    if (!arg || arg === FLAG_TERMINATOR) {
      return false;
    }
    if (pendingValue) {
      pendingValue = false;
      continue;
    }
    if (arg.startsWith("-")) {
      const option = findCommandOption(command, arg);
      if (!option && index === noColorIndex - 1 && !arg.includes("=")) {
        // Unknown option surfaces may allow arbitrary flags; keep the value-safe behavior there.
        return true;
      }
      pendingValue = shouldOptionConsumeFollowingToken(option, arg, remainingArgs[index + 1]);
      continue;
    }
    command = findSubcommand(command, arg) ?? command;
  }
  return pendingValue;
}

function isLogLevelConsumedAsCommandOption(
  program: CommanderCommand,
  remainingArgs: readonly string[],
  logLevelIndex: number,
): boolean {
  let command = program;
  let pendingValue = false;
  for (let index = 0; index < logLevelIndex; index += 1) {
    const arg = remainingArgs[index];
    if (!arg || arg === FLAG_TERMINATOR) {
      return false;
    }
    if (pendingValue) {
      pendingValue = false;
      continue;
    }
    if (arg.startsWith("-")) {
      const option = findCommandOption(command, arg);
      if (!option && index === logLevelIndex - 1 && !arg.includes("=")) {
        return true;
      }
      pendingValue = shouldOptionConsumeFollowingToken(option, arg, remainingArgs[index + 1]);
      continue;
    }
    command = findSubcommand(command, arg) ?? command;
  }

  if (pendingValue) {
    return true;
  }

  const arg = remainingArgs[logLevelIndex];
  return command !== program && arg !== undefined && findCommandOption(command, arg) !== undefined;
}

function normalizeRootNoColorArgvForProgram(argv: string[], program: CommanderCommand): string[] {
  return normalizeRootNoColorArgv(argv, {
    shouldPreserveNoColor: ({ remainingArgs, noColorIndex }) =>
      isNoColorConsumedAsCommandOptionValue(program, remainingArgs, noColorIndex),
  });
}

function normalizeRootLogLevelArgvForProgram(argv: string[], program: CommanderCommand): string[] {
  return normalizeRootLogLevelArgv(argv, {
    shouldPreserveLogLevel: ({ remainingArgs, logLevelIndex }) =>
      isLogLevelConsumedAsCommandOption(program, remainingArgs, logLevelIndex),
  });
}

async function ensureCliEnvProxyDispatcher(): Promise<void> {
  try {
    const { hasEnvHttpProxyAgentConfigured } = await import("../infra/net/proxy-env.js");
    if (!hasEnvHttpProxyAgentConfigured()) {
      return;
    }
    const { ensureGlobalUndiciEnvProxyDispatcher } =
      await import("../infra/net/undici-global-dispatcher.js");
    ensureGlobalUndiciEnvProxyDispatcher();
  } catch {
    // Best-effort proxy bootstrap; CLI startup should continue without it.
  }
}

function shouldBootstrapCliProxyBeforeFastPath(env: NodeJS.ProcessEnv = process.env): boolean {
  if (
    isTruthyEnvValue(env.OPENCLAW_DEBUG_PROXY_ENABLED) ||
    isTruthyEnvValue(env.OPENCLAW_DEBUG_PROXY_REQUIRE)
  ) {
    return true;
  }
  return CLI_PROXY_ENV_KEYS.some((key) => {
    const value = env[key];
    return typeof value === "string" && value.trim().length > 0;
  });
}

function isKnownBuiltInCommandRoot(primary: string): boolean {
  return (
    getCoreCliCommandNamesCore().includes(primary) ||
    getSubCliEntriesCore().some((entry) => entry.name === primary)
  );
}

function resolvesMachineOutput(
  descriptor: {
    machineOutput?: (params: { argv: readonly string[]; stdoutIsTTY: boolean }) => boolean;
  },
  argv: readonly string[],
): boolean {
  return descriptor.machineOutput?.({ argv, stdoutIsTTY: isMachineOutputStdoutTTY() }) ?? false;
}

function resolveBuiltInMachineOutput(argv: string[]): boolean {
  const { primary } = resolveCliArgvInvocation(argv);
  if (!primary) {
    return false;
  }
  const descriptor = [...getCoreCliCommandDescriptors(), ...getSubCliEntriesCore()].find(
    (entry) => entry.name === primary,
  );
  return descriptor ? resolvesMachineOutput(descriptor, argv) : false;
}

async function resolvePluginMachineOutput(params: {
  argv: string[];
  config: OpenClawConfig;
}): Promise<boolean> {
  const { primary } = resolveCliArgvInvocation(params.argv);
  if (!primary || isKnownBuiltInCommandRoot(primary)) {
    return false;
  }
  const { loadPluginCliDescriptors } = await loadCliRegistryLoaderModule();
  const descriptors = await loadPluginCliDescriptors({
    cfg: params.config,
    env: process.env,
    primaryCommand: primary,
  });
  const descriptor = descriptors.find((entry) => entry.name === primary);
  return descriptor ? resolvesMachineOutput(descriptor, params.argv) : false;
}

async function isPluginCliRoot(params: {
  primary: string;
  config: OpenClawConfig;
}): Promise<boolean | null> {
  try {
    const { resolvePluginCliRootOwnerIds } = await loadCliRegistryLoaderModule();
    const ownerIds = await resolvePluginCliRootOwnerIds({
      cfg: params.config,
      env: process.env,
      primaryCommand: params.primary,
    });
    return ownerIds === null ? null : ownerIds.length > 0;
  } catch {
    return null;
  }
}

function createAllowlistAgnosticCliLookupConfig(config: OpenClawConfig): OpenClawConfig {
  if (!Array.isArray(config.plugins?.allow) || config.plugins.allow.length === 0) {
    return config;
  }
  return {
    ...config,
    plugins: {
      ...config.plugins,
      allow: [],
    },
  };
}

async function resolveCliCommandSurfaceOwner(params: {
  primary: string;
  config: OpenClawConfig;
}): Promise<string | undefined> {
  const { resolveManifestCliCommandSurfaceOwner } = await loadManifestCommandAliasesRuntimeModule();
  const manifestOwner = resolveManifestCliCommandSurfaceOwner({
    command: params.primary,
    config: params.config,
    env: process.env,
  });
  if (manifestOwner) {
    return manifestOwner;
  }
  try {
    const { resolvePluginCliRootOwnerIds } = await loadCliRegistryLoaderModule();
    return (
      await resolvePluginCliRootOwnerIds({
        cfg: createAllowlistAgnosticCliLookupConfig(params.config),
        env: process.env,
        primaryCommand: params.primary,
      })
    )?.[0];
  } catch {
    return undefined;
  }
}

function resolveUnownedCliPrimaryCandidate(argv: string[]): string | null {
  const invocation = resolveCliArgvInvocation(rewriteUpdateFlagArgv(argv));
  const { primary } = invocation;
  if (
    !primary ||
    primary === "help" ||
    isReservedNonPluginCommandRoot(primary) ||
    isKnownBuiltInCommandRoot(primary)
  ) {
    return null;
  }
  return primary;
}

async function resolveUnownedCliPrimary(params: {
  argv: string[];
  config: OpenClawConfig;
}): Promise<string | null> {
  const primary = resolveUnownedCliPrimaryCandidate(params.argv);
  if (!primary) {
    return null;
  }
  const pluginRoot = await isPluginCliRoot({ primary, config: params.config });
  if (pluginRoot !== false) {
    return null;
  }
  return primary;
}

async function resolveUnownedCliPrimaryError(params: {
  argv: string[];
  primary: string;
  config: OpenClawConfig;
}): Promise<Error> {
  const { resolveManifestCommandAliasOwner, resolveManifestToolOwner } =
    await loadManifestCommandAliasesRuntimeModule();
  const cliCommandSurfaceOwner = await resolveCliCommandSurfaceOwner(params);
  const pluginPolicyMessage = resolveMissingPluginCommandMessage(params.primary, params.config, {
    resolveCommandAliasOwner: resolveManifestCommandAliasOwner,
    resolveToolOwner: resolveManifestToolOwner,
    resolveCliCommandSurfaceOwner: () => cliCommandSurfaceOwner,
  });
  if (pluginPolicyMessage) {
    return new Error(pluginPolicyMessage);
  }
  const sanitizedPrimary = sanitizeTerminalText(params.primary);
  const displayPrimary =
    sanitizedPrimary.length <= UNKNOWN_COMMAND_DISPLAY_LIMIT
      ? sanitizedPrimary
      : `${truncateUtf16Safe(sanitizedPrimary, UNKNOWN_COMMAND_DISPLAY_LIMIT - 1)}…`;
  const { createCliUnknownCommandError } = await import("./program/error-output.js");
  return createCliUnknownCommandError(displayPrimary, {
    argv: params.argv,
    ...(displayPrimary === params.primary ? {} : { commandNames: [] }),
  });
}

async function bootstrapCliProxyCaptureAndDispatcher(
  startupTrace: ReturnType<typeof createGatewayDispatchStartupTrace>,
  options: { ensureDispatcher?: boolean } = {},
): Promise<void> {
  const [
    { initializeDebugProxyCapture, finalizeDebugProxyCapture },
    { maybeWarnAboutDebugProxyCoverage },
  ] = await startupTrace.measure("proxy-imports", () =>
    Promise.all([import("../proxy-capture/runtime.js"), import("../proxy-capture/coverage.js")]),
  );
  initializeDebugProxyCapture("cli");
  process.once("exit", () => {
    finalizeDebugProxyCapture();
  });
  if (options.ensureDispatcher !== false) {
    await startupTrace.measure("proxy-dispatcher", () => ensureCliEnvProxyDispatcher());
  }
  maybeWarnAboutDebugProxyCoverage(undefined, (message) => console.warn(message));
}

export async function runCli(
  argv: string[] = process.argv,
  options: {
    additionalStartupTrace?: ReturnType<typeof createGatewayDispatchStartupTrace>;
    retainConsoleRoutingUntilProcessExit?: boolean;
  } = {},
) {
  const originalArgv = normalizeWindowsArgv(argv);
  const builtInMachineOutput = resolveBuiltInMachineOutput(originalArgv);
  return await withConsoleLogsRoutedToStderrForJson(
    originalArgv,
    () => runCliWithPreparedOutputMode(originalArgv, { ...options, builtInMachineOutput }),
    {
      machineOutput: builtInMachineOutput,
      restoreChanges: true,
      retainRoutingUntilProcessExit: options.retainConsoleRoutingUntilProcessExit,
    },
  );
}

async function runCliWithPreparedOutputMode(
  originalArgv: string[],
  options: {
    additionalStartupTrace?: ReturnType<typeof createGatewayDispatchStartupTrace>;
    builtInMachineOutput: boolean;
  },
) {
  const startupTrace = createGatewayDispatchStartupTrace(originalArgv, "cli.main");
  const earlyProfile = parseCliProfileArgs(originalArgv);
  if (earlyProfile.ok && earlyProfile.profile) {
    applyCliProfileEnv({ profile: earlyProfile.profile });
  }
  const originalInvocation = resolveCliArgvInvocation(originalArgv);
  let consoleCaptureInstalled = false;
  const installConsoleCapture = async () => {
    if (consoleCaptureInstalled) {
      return;
    }
    const { enableConsoleCapture } = await loadLoggingModule();
    enableConsoleCapture();
    consoleCaptureInstalled = true;
  };
  const configureStartupTraces = async () => {
    await configureGatewayStartupTraceConsoleFormatting(startupTrace);
    if (options.additionalStartupTrace) {
      await configureGatewayStartupTraceConsoleFormatting(options.additionalStartupTrace);
    }
  };
  const parsedContainer = parseCliContainerArgs(originalArgv);
  if (!parsedContainer.ok) {
    await installConsoleCapture();
    await configureStartupTraces();
    throw new Error(parsedContainer.error);
  }
  const parsedProfile = parseCliProfileArgs(parsedContainer.argv);
  const containerTargetName =
    parsedContainer.container ?? normalizeOptionalString(process.env.OPENCLAW_CONTAINER) ?? null;
  const hasPreHelpValidationError =
    !parsedProfile.ok || (containerTargetName !== null && parsedProfile.profile !== null);
  // Console formatting is a process-wide invariant. Install capture before
  // container dispatch or validation can bypass the pure help/version path.
  if (
    !originalInvocation.hasHelpOrVersion ||
    containerTargetName !== null ||
    hasPreHelpValidationError
  ) {
    await installConsoleCapture();
  }
  if (!parsedProfile.ok) {
    await configureStartupTraces();
    throw new Error(parsedProfile.error);
  }
  if (parsedProfile.profile) {
    applyCliProfileEnv({ profile: parsedProfile.profile });
  }
  if (containerTargetName && parsedProfile.profile) {
    await configureStartupTraces();
    throw new Error("--container cannot be combined with --profile/--dev");
  }

  let containerTarget: ReturnType<typeof maybeRunCliInContainer>;
  try {
    containerTarget = maybeRunCliInContainer(originalArgv);
  } catch (error) {
    await configureStartupTraces();
    throw error;
  }
  if (containerTarget.handled) {
    await configureStartupTraces();
    if (containerTarget.exitCode !== 0) {
      process.exitCode = containerTarget.exitCode;
    }
    return;
  }
  const normalizedArgv = rewriteUpdateFlagArgv(
    normalizeRootHelpTargetArgv(normalizeRootNoColorArgv(parsedProfile.argv)),
  );
  const normalizedInvocation = resolveCliArgvInvocation(normalizedArgv);
  const isHelpOrVersionInvocation = normalizedInvocation.hasHelpOrVersion;
  const isGatewayRunInvocation = isGatewayRunInvocationArgv(normalizedArgv);
  const isDatabaseInvocation = normalizedInvocation.commandPath[0] === "database";
  // Gateway pre-bootstrap owns state/config dotenv selection. This phase only
  // needs the workspace file, so avoid importing the loader when it is absent.
  const loadGlobalEnv = !isGatewayRunInvocation;
  startupTrace.mark("argv");

  // Enforce the minimum supported runtime before gateway selection can read or recover config.
  assertSupportedRuntime();

  if (
    !isHelpOrVersionInvocation &&
    !isDatabaseInvocation &&
    !isAgentExecInvocation(normalizedInvocation.commandPath) &&
    shouldLoadCliDotEnv(loadGlobalEnv)
  ) {
    await startupTrace.measure("dotenv", async () => {
      if (isRemoteAgentDispatchInvocation(normalizedArgv, normalizedInvocation.primary)) {
        const { loadGatewayDispatchCliDotEnv } = await import("./gateway-dispatch-dotenv.js");
        await loadGatewayDispatchCliDotEnv({ quiet: true });
      } else {
        const { loadCliDotEnv } = await import("./dotenv.js");
        loadCliDotEnv({ loadGlobalEnv, quiet: true });
      }
    });
  }
  await configureStartupTraces();
  if (!isHelpOrVersionInvocation && isGatewayRunInvocation) {
    await startupTrace.measure("gateway-run-select-environment", async () => {
      const [{ selectGatewayRunEnvironment }, { defaultRuntime }] = await Promise.all([
        import("./gateway-cli/pre-bootstrap.js"),
        import("../runtime.js"),
      ]);
      const opts = resolveGatewayRunPreBootstrapOptions(normalizedArgv) ?? {};
      await selectGatewayRunEnvironment({ opts, runtime: defaultRuntime });
    });
  }
  normalizeEnv();
  if (shouldEnsureCliPath(normalizedArgv)) {
    ensureOpenClawCliOnPath();
  }
  // Cheap import gate only. Session-ref owns the authoritative URL/options parse.
  const mayContainBareSessionUrl = normalizedArgv.slice(2).some((arg) => arg.includes("://"));
  const bareSessionInvocation =
    !isHelpOrVersionInvocation && mayContainBareSessionUrl
      ? (await import("./session-ref.js")).parseBareSessionInvocation(normalizedArgv)
      : null;

  // Activate operator-managed proxy routing for network-capable commands.
  // Local Gateway/control-plane commands keep direct loopback access while
  // runtime, provider, plugin, update, and manifest/metadata-owned plugin commands route egress.
  let proxyHandle: ProxyHandle | null = null;
  let onSigterm: (() => void) | null = null;
  let onSigint: (() => void) | null = null;
  let onExit: (() => void) | null = null;
  let unregisterProxySignalExitBarrier: (() => void) | null = null;
  let bestEffortConfigPromise: Promise<OpenClawConfig> | null = null;
  const isolateProxyConfigEnv = isGatewayRunInvocation;
  const skipBestEffortConfigObservation = resolveCliStartupPolicyForArgv({
    argv: normalizedArgv,
    commandPath: normalizedInvocation.commandPath,
    jsonOutputMode: options.builtInMachineOutput || hasJsonOutputFlag(normalizedArgv),
    env: process.env,
  }).skipConfigGuard;
  const useSourceOnlyBestEffortConfig =
    normalizedInvocation.primary === "update" ||
    (normalizedInvocation.primary === "doctor" && hasFlag(normalizedArgv, "--lint"));
  const readBestEffortCliConfig = async (): Promise<OpenClawConfig> => {
    if (!bestEffortConfigPromise) {
      bestEffortConfigPromise = import("../config/io.js").then((configIo) =>
        useSourceOnlyBestEffortConfig
          ? configIo.readSourceConfigBestEffort()
          : configIo.readBestEffortConfig({
              ...(isolateProxyConfigEnv ? { isolateEnv: true, observe: false } : {}),
              ...(skipBestEffortConfigObservation ? { observe: false } : {}),
              skipPluginValidation: true,
            }),
      );
    }
    return await bestEffortConfigPromise;
  };
  const startupTraces = [startupTrace, options.additionalStartupTrace].filter(
    (trace): trace is ReturnType<typeof createGatewayDispatchStartupTrace> => Boolean(trace),
  );
  if (
    !isDatabaseInvocation &&
    (await Promise.all(startupTraces.map((trace) => trace.requiresDiagnosticsConfig()))).some(
      Boolean,
    )
  ) {
    const config = await withConsoleLogsRoutedToStderr(readBestEffortCliConfig);
    await Promise.all(startupTraces.map((trace) => trace.configureDiagnosticsTimeline(config)));
  }
  if (
    !isHelpOrVersionInvocation &&
    !bareSessionInvocation &&
    normalizedInvocation.primary &&
    !isKnownBuiltInCommandRoot(normalizedInvocation.primary)
  ) {
    const config = await withConsoleLogsRoutedToStderr(readBestEffortCliConfig);
    if (
      await withConsoleLogsRoutedToStderr(() =>
        resolvePluginMachineOutput({ argv: normalizedArgv, config }),
      )
    ) {
      const { routeLogsToStderr } = await loadLoggingModule();
      routeLogsToStderr();
    }
  }
  const uninstallProxySignalHandlers = () => {
    if (onSigterm) {
      process.off("SIGTERM", onSigterm);
      onSigterm = null;
    }
    if (onSigint) {
      process.off("SIGINT", onSigint);
      onSigint = null;
    }
    if (onExit) {
      process.off("exit", onExit);
      onExit = null;
    }
  };
  const stopStartedProxy = async () => {
    unregisterProxySignalExitBarrier?.();
    unregisterProxySignalExitBarrier = null;
    uninstallProxySignalHandlers();
    const handle = proxyHandle;
    proxyHandle = null;
    if (handle) {
      const { stopProxy } = await loadProxyLifecycleModule();
      await stopProxy(handle);
    }
  };
  const killStartedProxy = () => {
    const handle = proxyHandle;
    proxyHandle = null;
    handle?.kill("SIGTERM");
  };
  const installProxySignalHandlers = () => {
    if (!proxyHandle || onSigterm || onSigint || onExit) {
      return;
    }
    unregisterProxySignalExitBarrier = registerSignalExitBarrier(stopStartedProxy);
    const shutdown = (exitCode: number) => {
      void waitForSignalExitBarriers().finally(() => {
        process.exit(exitCode);
      });
    };
    onSigterm = () => shutdown(143);
    onSigint = () => shutdown(130);
    onExit = () => killStartedProxy();
    process.once("SIGTERM", onSigterm);
    process.once("SIGINT", onSigint);
    process.once("exit", onExit);
  };
  const replaceStartedProxy = async (config: OpenClawConfig["proxy"]) => {
    await stopStartedProxy();
    const { startProxy } = await loadProxyLifecycleModule();
    proxyHandle = await startProxy(config);
    installProxySignalHandlers();
  };
  if (!isHelpOrVersionInvocation && shouldStartProxyForCli(normalizedArgv)) {
    const config = await withConsoleLogsRoutedToStderr(readBestEffortCliConfig);
    if (!bareSessionInvocation) {
      const unownedPrimary = await resolveUnownedCliPrimary({ argv: normalizedArgv, config });
      if (unownedPrimary) {
        throw await resolveUnownedCliPrimaryError({
          argv: normalizedArgv,
          primary: unownedPrimary,
          config,
        });
      }
    }
    await replaceStartedProxy(config?.proxy ?? undefined);
  }

  let uninstallGatewayRunRuntimeHooks: (() => void) | null = null;
  if (!isHelpOrVersionInvocation && isGatewayRunInvocation) {
    const { installGatewayRunRuntimeHooks } = await import("./gateway-cli/runtime-hooks.js");
    uninstallGatewayRunRuntimeHooks = installGatewayRunRuntimeHooks({
      releaseManagedProxy: stopStartedProxy,
      refreshManagedProxy: replaceStartedProxy,
    });
  }

  try {
    if (shouldUseRootHelpFastPath(normalizedArgv)) {
      const { loadRootHelpRenderOptionsForConfigSensitivePlugins } =
        await loadRootHelpLiveConfigModule();
      const liveRootHelpOptions = await loadRootHelpRenderOptionsForConfigSensitivePlugins(
        process.env,
      );
      if (!liveRootHelpOptions) {
        const { outputPrecomputedRootHelpText } = await loadRootHelpMetadataModule();
        if (outputPrecomputedRootHelpText()) {
          return;
        }
      }
      const { outputRootHelp } = await import("./program/root-help.js");
      await outputRootHelp(liveRootHelpOptions ?? undefined);
      return;
    }

    if (await tryOutputPrecomputedCommandHelp(normalizedArgv)) {
      return;
    }

    if (shouldUseSetupOnboardConfigureHelpFastPath(normalizedArgv)) {
      const { tryOutputSetupOnboardConfigureHelp } =
        await import("./setup-onboard-configure-help-fast-path.js");
      if (await tryOutputSetupOnboardConfigureHelp(normalizedArgv)) {
        return;
      }
    }

    // Genuine help fast paths have returned. Any remaining help/version-shaped
    // invocation can still fail validation and must honor the console style.
    await installConsoleCapture();

    if (bareSessionInvocation) {
      if (!process.stdin.isTTY || !process.stdout.isTTY) {
        console.error(
          "OpenClaw TUI needs an interactive TTY. Use `openclaw agent --local ...` for automation.",
        );
        process.exitCode = 1;
        return;
      }
      const { runTuiCliAction } = await import("./tui-cli.js");
      await runTuiCliAction(bareSessionInvocation.target, bareSessionInvocation.options);
      return;
    }

    // Reject unowned command roots before help/version routing, so that
    // `openclaw <typo> --help` surfaces the same Unknown command error as
    // `openclaw <typo>` instead of silently showing generic top-level help.
    // Runs after legitimate precomputed help fast paths so known help commands
    // still dispatch normally. See #81077.
    {
      const unownedPrimaryCandidate = resolveUnownedCliPrimaryCandidate(normalizedArgv);
      if (unownedPrimaryCandidate) {
        const config = await readBestEffortCliConfig();
        const unownedPrimary = await resolveUnownedCliPrimary({ argv: normalizedArgv, config });
        if (unownedPrimary) {
          throw await resolveUnownedCliPrimaryError({
            argv: normalizedArgv,
            primary: unownedPrimary,
            config,
          });
        }
      }
    }

    const shouldRunBareRootCommand = shouldHandleBareRoot(normalizedArgv);
    if (shouldRunBareRootCommand) {
      await ensureCliEnvProxyDispatcher();
    }
    const bareRootLaunchTarget = shouldRunBareRootCommand
      ? await resolveBareRootLaunchTarget(normalizedArgv)
      : null;

    if (bareRootLaunchTarget) {
      if (bareRootLaunchTarget.kind === "remote-gateway-inference") {
        if (!process.stdin.isTTY || !process.stdout.isTTY) {
          console.error(
            "Remote Gateway inference setup needs an interactive TTY. Re-run `openclaw` in a terminal connected to this Gateway.",
          );
          process.exitCode = 1;
          return;
        }
        const { runRemoteGatewayInferenceOnboarding } =
          await import("../commands/onboard-remote-gateway.js");
        await runRemoteGatewayInferenceOnboarding(bareRootLaunchTarget.target);
        return;
      }
      if (bareRootLaunchTarget.kind === "onboarding") {
        if (!process.stdin.isTTY || !process.stdout.isTTY) {
          console.error(
            bareRootLaunchTarget.classic
              ? "OpenClaw config is invalid. Run `openclaw doctor --fix` before onboarding."
              : "Onboarding needs an interactive TTY. Use `openclaw onboard --non-interactive --accept-risk ...` for automation.",
          );
          process.exitCode = 1;
          return;
        }
        const { setupWizardCommand } = await import("../commands/onboard.js");
        await setupWizardCommand(bareRootLaunchTarget.classic ? { classic: true } : {});
        return;
      }
      if (bareRootLaunchTarget.kind === "tui") {
        if (!process.stdin.isTTY || !process.stdout.isTTY) {
          console.error(
            "OpenClaw TUI needs an interactive TTY. Use `openclaw agent --local ...` for automation.",
          );
          process.exitCode = 1;
          return;
        }
        const { runTui } = await import("../tui/tui.js");
        // This TUI now shares the CLI process, so keep its final exit fallback armed
        // in case imported runtime handles survive the normal teardown.
        await runTui({
          ...(bareRootLaunchTarget.local
            ? { deliver: false, local: true }
            : {
                deliver: false,
                config: bareRootLaunchTarget.config,
                boundGateway: {
                  url: bareRootLaunchTarget.gatewayUrl,
                  ...(bareRootLaunchTarget.token ? { token: bareRootLaunchTarget.token } : {}),
                  ...(bareRootLaunchTarget.password
                    ? { password: bareRootLaunchTarget.password }
                    : {}),
                  ...(bareRootLaunchTarget.tlsFingerprint
                    ? { tlsFingerprint: bareRootLaunchTarget.tlsFingerprint }
                    : {}),
                },
              }),
          forceProcessExitOnReturn: true,
        });
        return;
      }
    }

    const shouldUseCliEnvProxy =
      !isHelpOrVersionInvocation && shouldStartProxyForCli(normalizedArgv);
    const bootstrapProxyBeforeFastPath =
      shouldUseCliEnvProxy && shouldBootstrapCliProxyBeforeFastPath();
    if (
      !bootstrapProxyBeforeFastPath &&
      (await tryRunGatewayRunFastPath(normalizedArgv, startupTrace))
    ) {
      return;
    }

    if (!isHelpOrVersionInvocation && !isDatabaseInvocation) {
      await bootstrapCliProxyCaptureAndDispatcher(startupTrace, {
        ensureDispatcher: shouldUseCliEnvProxy,
      });
    }

    if (
      bootstrapProxyBeforeFastPath &&
      (await tryRunGatewayRunFastPath(normalizedArgv, startupTrace))
    ) {
      return;
    }

    const { tryRouteCli } = await startupTrace.measure("route-import", () => import("./route.js"));
    const routed = await startupTrace.measure(
      "route",
      () =>
        options.builtInMachineOutput
          ? tryRouteCli(normalizedArgv, { machineOutput: true })
          : tryRouteCli(normalizedArgv),
      { timeline: false },
    );
    if (routed) {
      return;
    }

    let parseArgv = normalizeGeneratedHelpCommandArgv(normalizedArgv);
    const suppressStartupProgress = hasJsonOutputFlag(parseArgv);
    const { createCliProgress } = await loadProgressModule();
    const startupProgress = createCliProgress({
      label: "Loading OpenClaw CLI…",
      indeterminate: true,
      delayMs: 0,
      ...(suppressStartupProgress ? { enabled: false } : {}),
    });
    let startupProgressStopped = false;
    const stopStartupProgress = () => {
      if (startupProgressStopped) {
        return;
      }
      startupProgressStopped = true;
      startupProgress.done();
    };

    try {
      const [
        { buildProgram },
        { formatUncaughtError },
        { formatCliFailureLines, formatCliJsonFailure },
        { runFatalErrorHooks },
        {
          installUnhandledRejectionHandler,
          isBenignUncaughtExceptionError,
          isUncaughtExceptionHandled,
        },
        { defaultRuntime, restoreRuntimeTerminalState },
      ] = await startupTrace.measure("core-imports", () =>
        Promise.all([
          import("./program.js"),
          import("../infra/errors.js"),
          import("./failure-output.js"),
          import("../infra/fatal-error-hooks.js"),
          import("../infra/unhandled-rejections.js"),
          import("../runtime.js"),
        ]),
      );
      const program = await startupTrace.measure("build-program", () => buildProgram());

      // Global error handlers to prevent silent crashes from unhandled rejections/exceptions.
      // These log the error and exit gracefully instead of crashing without trace.
      installUnhandledRejectionHandler();

      process.on("uncaughtException", (error) => {
        if (isUncaughtExceptionHandled(error)) {
          return;
        }
        if (isBenignUncaughtExceptionError(error)) {
          console.warn(
            "[openclaw] Non-fatal uncaught exception (continuing):",
            formatUncaughtError(error),
          );
          return;
        }
        if (isJsonOutputModeActive(normalizedArgv)) {
          defaultRuntime.writeJson(formatCliJsonFailure(error));
        }
        for (const line of formatCliFailureLines({
          title: "OpenClaw hit an unexpected runtime error.",
          error,
          argv: normalizedArgv,
        })) {
          console.error(line);
        }
        for (const message of runFatalErrorHooks({ reason: "uncaught_exception", error })) {
          console.error("[openclaw]", message);
        }
        restoreRuntimeTerminalState("uncaught exception", { resumeStdinIfPaused: false });
        process.exit(1);
      });

      const invocation = resolveCliArgvInvocation(parseArgv);
      // Register the primary command (builtin or subcli) so help and command parsing
      // are correct even with lazy command registration.
      const { primary } = invocation;
      if (primary && shouldRegisterPrimaryCommandOnly(parseArgv)) {
        await startupTrace.measure("register-primary", async () => {
          const { getProgramContext } = await import("./program/program-context.js");
          const ctx = getProgramContext(program);
          if (ctx) {
            const { registerCoreCliByName } = await import("./program/command-registry.js");
            await registerCoreCliByName(program, ctx, primary, parseArgv);
          }
          const { registerSubCliByName } = await import("./program/register.subclis.js");
          await registerSubCliByName(program, primary, parseArgv);
        });
      }

      const hasBuiltinPrimary =
        primary !== null &&
        program.commands.some(
          (command) => command.name() === primary || command.aliases().includes(primary),
        );
      const shouldSkipPluginRegistration = shouldSkipPluginCommandRegistration({
        argv: parseArgv,
        primary,
        hasBuiltinPrimary,
      });
      if (!shouldSkipPluginRegistration) {
        const config = await startupTrace.measure("register-plugin-commands", async () => {
          const [{ registerPluginCliCommandsFromValidatedConfig }, { resolveCliStartupPolicy }] =
            await Promise.all([import("../plugins/cli.js"), import("./command-startup-policy.js")]);
          const startupPolicy = resolveCliStartupPolicy({
            argv: parseArgv,
            commandPath: invocation.commandPath,
            jsonOutputMode: suppressStartupProgress,
          });
          return await registerPluginCliCommandsFromValidatedConfig(program, undefined, undefined, {
            mode: "lazy",
            primary,
            skipPluginValidation: startupPolicy.skipConfigGuard,
          });
        });
        if (config) {
          if (
            primary &&
            !program.commands.some(
              (command) => command.name() === primary || command.aliases().includes(primary),
            )
          ) {
            const { resolveManifestCommandAliasOwner, resolveManifestToolOwner } =
              await loadManifestCommandAliasesRuntimeModule();
            const cliCommandSurfaceOwner = await resolveCliCommandSurfaceOwner({
              primary,
              config,
            });
            const missingPluginCommandMessage = resolveMissingPluginCommandMessage(
              primary,
              config,
              {
                resolveCommandAliasOwner: resolveManifestCommandAliasOwner,
                resolveToolOwner: resolveManifestToolOwner,
                resolveCliCommandSurfaceOwner: () => cliCommandSurfaceOwner,
              },
            );
            if (missingPluginCommandMessage) {
              throw new Error(missingPluginCommandMessage);
            }
          }
        }
      }

      parseArgv = normalizeRootLogLevelArgvForProgram(
        normalizeRootNoColorArgvForProgram(parseArgv, program),
        program,
      );
      stopStartupProgress();

      let completedHelpOrVersion = false;
      try {
        await startupTrace.measure("parse", () => program.parseAsync(parseArgv), {
          timeline: false,
        });
        completedHelpOrVersion = isHelpOrVersionInvocation;
      } catch (error) {
        if (!isCommanderParseExit(error)) {
          throw error;
        }
        if (isJsonOutputModeActive(parseArgv) && error.exitCode !== 0) {
          throw error;
        }
        process.exitCode = error.exitCode;
        completedHelpOrVersion = isHelpOrVersionInvocation && error.exitCode === 0;
      }
      if (completedHelpOrVersion) {
        // Lazy command-group registrars can import native/runtime resources solely to
        // render complete help. Request an exit now; the top-level finally flushes it
        // after shared async teardown completes.
        requestExitAfterOneShotOutput();
      }
    } finally {
      stopStartupProgress();
    }
  } finally {
    uninstallGatewayRunRuntimeHooks?.();
    await stopStartedProxy();
    await closeCliResources();
    pauseNonTtyStdinForCliExit();
  }
}
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
