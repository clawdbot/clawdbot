// Main CLI entry orchestration: fast paths, env setup, plugin aliases, and Commander dispatch.
import { existsSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { Command as CommanderCommand, Option as CommanderOption } from "commander";
import { resolveStateDir } from "../config/paths.js";
import type { ConfigFileSnapshot, OpenClawConfig } from "../config/types.openclaw.js";
import { isLoopbackAddress, isSecureWebSocketUrl } from "../gateway/net.js";
import { FLAG_TERMINATOR, isValueToken } from "../infra/cli-root-options.js";
import { isTruthyEnvValue, normalizeEnv } from "../infra/env.js";
import type { ProxyHandle } from "../infra/net/proxy/proxy-lifecycle.js";
import { ensureOpenClawCliOnPath } from "../infra/path-env.js";
import { assertSupportedRuntime } from "../infra/runtime-guard.js";
import { tryProcessCwd } from "../infra/safe-cwd.js";
import type { PluginManifestCommandAliasRegistry } from "../plugins/manifest-command-aliases.js";
import { resolveCliArgvInvocation } from "./argv-invocation.js";
import {
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
import { maybeRunCliInContainer, parseCliContainerArgs } from "./container-target.js";
import { isUnconfiguredConfigSource } from "./fresh-install-config.js";
import {
  consumeGatewayFastPathRootOptionToken,
  consumeGatewayRunOptionToken,
  resolveGatewayCatalogCommandPath,
  resolveGatewayRunPreBootstrapOptions,
} from "./gateway-run-argv.js";
import { hasJsonOutputFlag, withConsoleLogsRoutedToStderrForJson } from "./json-output-mode.js";
import { flushExitAfterOneShotOutput, requestExitAfterOneShotOutput } from "./one-shot-exit.js";
import { tryOutputPrecomputedCommandHelp } from "./precomputed-help.js";
import { applyCliProfileEnv, parseCliProfileArgs } from "./profile.js";
import { formatCliCommandSuggestions } from "./program/command-suggestions.js";
import { getCoreCliCommandNames } from "./program/core-command-descriptors.js";
import { getSubCliEntries } from "./program/subcli-descriptors.js";
import {
  resolveMissingPluginCommandMessage as resolveMissingPluginCommandMessageFromPolicy,
  rewriteUpdateFlagArgv,
  shouldHandleBareRoot,
  shouldEnsureCliPath,
  shouldStartProxyForCli,
  shouldUseRootHelpFastPath,
  shouldUseSetupOnboardConfigureHelpFastPath,
} from "./run-main-policy.js";
import { registerSignalExitBarrier, waitForSignalExitBarriers } from "./signal-exit-barrier.js";
import { createGatewayStartupTrace } from "./startup-trace.js";
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
  startupTrace: ReturnType<typeof createGatewayStartupTrace>,
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
    { enableConsoleCapture },
    { ensureCliExecutionBootstrap },
    { defaultRuntime },
  ] = await startupTrace.measure("gateway-run-imports", () =>
    Promise.all([
      import("commander"),
      import("./gateway-cli/run-command.js"),
      import("../version.js"),
      import("./banner.js"),
      import("./command-startup-policy.js"),
      loadLoggingModule(),
      import("./command-execution-startup.js"),
      import("../runtime.js"),
    ]),
  );
  const commandPath = resolveGatewayCatalogCommandPath(argv) ?? ["gateway"];
  const startupPolicy = resolveCliStartupPolicy({
    argv,
    commandPath,
    jsonOutputMode: hasJsonOutputFlag(argv),
    routeMode: true,
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
  enableConsoleCapture();
  try {
    await startupTrace.measure("gateway-run-parse", () => program.parseAsync(argv));
  } catch (error) {
    if (!isCommanderParseExit(error)) {
      throw error;
    }
    process.exitCode = error.exitCode;
  }
  return true;
}

async function closeCliMemoryManagers(): Promise<void> {
  try {
    const { hasMemoryRuntime } = await import("../plugins/memory-state.js");
    if (!hasMemoryRuntime()) {
      return;
    }
    const { closeActiveMemorySearchManagers } = await import("../plugins/memory-runtime.js");
    await closeActiveMemorySearchManagers();
  } catch {
    // Best-effort teardown for short-lived CLI processes. Package updates can
    // replace hashed chunks before this finalizer runs.
  }
}

async function disposeCliAgentHarnesses(): Promise<void> {
  try {
    const { listRegisteredAgentHarnesses, disposeRegisteredAgentHarnesses } =
      await import("../agents/harness/registry.js");
    if (listRegisteredAgentHarnesses().length === 0) {
      return;
    }
    await disposeRegisteredAgentHarnesses();
  } catch {
    // Best-effort teardown for short-lived CLI commands. Harness plugins may
    // own subprocesses, but cleanup must not hide the command's real outcome.
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

export async function shouldStartOnboardingForFreshInstall(argv: string[]): Promise<boolean> {
  if (!shouldHandleBareRoot(argv)) {
    return false;
  }
  const { readConfigFileSnapshot } = await import("../config/config.js");
  const snapshot = await readConfigFileSnapshot();
  return isUnconfiguredConfigSnapshot(snapshot);
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
  | {
      kind: "tui";
      local: boolean;
      gatewayUrl?: string;
      authSource?: "config";
      tlsFingerprint?: string;
    };

async function resolveBareRootLaunchTarget(argv: string[]): Promise<BareRootLaunchTarget | null> {
  if (!shouldHandleBareRoot(argv)) {
    return null;
  }
  const { readConfigFileSnapshot } = await import("../config/config.js");
  const snapshot = await readConfigFileSnapshot();
  if (isUnconfiguredConfigSnapshot(snapshot)) {
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
    const target: BareRootLaunchTarget = { kind: "tui", local: false, gatewayUrl: gateway.url };
    if (gateway.authSource) {
      target.authSource = gateway.authSource;
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
  auth: "local" | "remote";
  scope: "local-loopback" | "local-configured" | "remote";
  tlsFingerprint?: string;
  preauthHandshakeTimeoutMs?: number;
};

type ReachableGateway = {
  url: string;
  remote: boolean;
  authSource?: "config";
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
  authSource?: "config";
};

function toReachableGateway(target: GatewayProbeTarget, auth: GatewayProbeAuth): ReachableGateway {
  return {
    url: target.url,
    remote: target.scope === "remote",
    ...(auth.authSource ? { authSource: auth.authSource } : {}),
    ...(auth.token ? { token: auth.token } : {}),
    ...(auth.password ? { password: auth.password } : {}),
    ...(target.tlsFingerprint ? { tlsFingerprint: target.tlsFingerprint } : {}),
  };
}

async function resolveReachableGateway(
  config: OpenClawConfig,
  options: { hasConfiguredGateway: boolean },
): Promise<GatewayResolution> {
  const targets = await resolveGatewayProbeTargets(config);
  if (targets.length === 0) {
    return { kind: "unreachable" };
  }
  const usesRemoteAuth = targets.some((target) => target.auth === "remote");
  const auth = await resolveGatewayProbeAuth(config, usesRemoteAuth ? "remote" : "local");
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

async function resolveGatewayProbeAuth(
  config: OpenClawConfig,
  auth: "local" | "remote",
): Promise<GatewayProbeAuth> {
  const { resolveGatewayProbeSurfaceAuth } = await import("../gateway/auth-surface-resolution.js");
  const authResolution = await resolveGatewayProbeSurfaceAuth({
    config,
    surface: auth,
  });
  const resolved: GatewayProbeAuth = {};
  if (authResolution.token) {
    resolved.token = authResolution.token;
  }
  if (authResolution.password) {
    resolved.password = authResolution.password;
  }
  if (authResolution.source === "config") {
    resolved.authSource = "config";
  }
  return resolved;
}

async function resolveGatewayProbeTargets(config: OpenClawConfig): Promise<GatewayProbeTarget[]> {
  const remoteUrl = normalizeOptionalString(config.gateway?.remote?.url);
  if (normalizeOptionalString(config.gateway?.mode) === "remote" && remoteUrl) {
    const url = await resolveValidatedRemoteGatewayUrl(config);
    const tlsFingerprint = normalizeOptionalString(config.gateway?.remote?.tlsFingerprint);
    return url
      ? [
          {
            url,
            auth: "remote",
            scope: "remote",
            ...(tlsFingerprint ? { tlsFingerprint } : {}),
          },
        ]
      : [];
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
  const protocol =
    parsed.protocol === "https:" ? "wss:" : parsed.protocol === "http:" ? "ws:" : parsed.protocol;
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

async function resolveValidatedRemoteGatewayUrl(config: OpenClawConfig): Promise<string | null> {
  try {
    const { buildGatewayConnectionDetailsWithResolvers } =
      await import("../gateway/connection-details.js");
    return buildGatewayConnectionDetailsWithResolvers({
      config,
      ignoreEnvUrlOverride: true,
    }).url;
  } catch {
    return null;
  }
}

async function resolveLocalGatewayProbeTargets(
  config: OpenClawConfig,
): Promise<GatewayProbeTarget[]> {
  const [
    { resolveGatewayPort },
    { resolveControlUiLinks },
    { buildGatewayProbeConnectionDetails },
    { readActiveGatewayLockPort },
  ] = await Promise.all([
    import("../config/paths.js"),
    import("../gateway/control-ui-links.js"),
    import("../gateway/call.js"),
    import("../infra/gateway-lock.js"),
  ]);
  const gateway = config.gateway;
  const configuredPort = resolveGatewayPort(config);
  const hasExplicitPort = Boolean(normalizeOptionalString(process.env.OPENCLAW_GATEWAY_PORT));
  const activePort = hasExplicitPort ? undefined : await readActiveGatewayLockPort();
  const port = activePort ?? configuredPort;
  // Supplying the selected local port keeps inherited remote URL overrides out
  // of bare-root routing while reusing canonical local TLS/fingerprint logic.
  const connection = await buildGatewayProbeConnectionDetails({
    config,
    localPortOverride: port,
  });
  const baseParams = {
    port,
    basePath: gateway?.controlUi?.basePath,
    tlsEnabled: gateway?.tls?.enabled === true,
  };
  const sharedTarget = {
    auth: "local" as const,
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
    return [loopbackTarget];
  }
  const configuredLinks = resolveControlUiLinks({
    ...baseParams,
    bind,
    customBindHost: gateway?.customBindHost,
  });
  return configuredLinks.wsUrl === connection.url
    ? [loopbackTarget]
    : [
        loopbackTarget,
        {
          ...sharedTarget,
          url: configuredLinks.wsUrl,
          scope: "local-configured",
        },
      ];
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

export function resolveMissingPluginCommandMessage(
  pluginId: string,
  config?: OpenClawConfig,
  options?: { registry?: PluginManifestCommandAliasRegistry },
): string | null {
  return resolveMissingPluginCommandMessageFromPolicy(
    pluginId,
    config,
    options?.registry ? { registry: options.registry } : undefined,
  );
}

function shouldLoadCliDotEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  const cwd = tryProcessCwd();
  if (cwd && existsSync(path.join(cwd, ".env"))) {
    return true;
  }
  return existsSync(path.join(resolveStateDir(env), ".env"));
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
    getCoreCliCommandNames().includes(primary) ||
    getSubCliEntries().some((entry) => entry.name === primary)
  );
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

async function resolveUnownedCliPrimaryMessage(params: {
  primary: string;
  config: OpenClawConfig;
}): Promise<string> {
  const { resolveManifestCommandAliasOwner, resolveManifestToolOwner } =
    await loadManifestCommandAliasesRuntimeModule();
  const cliCommandSurfaceOwner = await resolveCliCommandSurfaceOwner(params);
  const pluginPolicyMessage = resolveMissingPluginCommandMessageFromPolicy(
    params.primary,
    params.config,
    {
      resolveCommandAliasOwner: resolveManifestCommandAliasOwner,
      resolveToolOwner: resolveManifestToolOwner,
      resolveCliCommandSurfaceOwner: () => cliCommandSurfaceOwner,
    },
  );
  if (pluginPolicyMessage) {
    return pluginPolicyMessage;
  }
  const suggestion = formatCliCommandSuggestions(params.primary);
  return [
    `Unknown command: openclaw ${params.primary}. No built-in command or plugin CLI metadata owns "${params.primary}".`,
    suggestion,
  ]
    .filter(Boolean)
    .join("\n");
}

async function bootstrapCliProxyCaptureAndDispatcher(
  startupTrace: ReturnType<typeof createGatewayStartupTrace>,
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
  maybeWarnAboutDebugProxyCoverage();
}

export async function runCli(argv: string[] = process.argv) {
  const originalArgv = normalizeWindowsArgv(argv);
  const startupTrace = createGatewayStartupTrace(originalArgv, "cli.main");
  const parsedContainer = parseCliContainerArgs(originalArgv);
  if (!parsedContainer.ok) {
    throw new Error(parsedContainer.error);
  }
  const parsedProfile = parseCliProfileArgs(parsedContainer.argv);
  if (!parsedProfile.ok) {
    throw new Error(parsedProfile.error);
  }
  if (parsedProfile.profile) {
    applyCliProfileEnv({ profile: parsedProfile.profile });
  }
  const containerTargetName =
    parsedContainer.container ?? normalizeOptionalString(process.env.OPENCLAW_CONTAINER) ?? null;
  if (containerTargetName && parsedProfile.profile) {
    throw new Error("--container cannot be combined with --profile/--dev");
  }

  const containerTarget = maybeRunCliInContainer(originalArgv);
  if (containerTarget.handled) {
    if (containerTarget.exitCode !== 0) {
      process.exitCode = containerTarget.exitCode;
    }
    return;
  }
  const normalizedArgv = normalizeRootHelpTargetArgv(normalizeRootNoColorArgv(parsedProfile.argv));
  const normalizedInvocation = resolveCliArgvInvocation(normalizedArgv);
  const isHelpOrVersionInvocation = normalizedInvocation.hasHelpOrVersion;
  const isGatewayRunInvocation = isGatewayRunInvocationArgv(normalizedArgv);
  startupTrace.mark("argv");

  // Enforce the minimum supported runtime before gateway selection can read or recover config.
  assertSupportedRuntime();

  if (!isHelpOrVersionInvocation && (isGatewayRunInvocation || shouldLoadCliDotEnv())) {
    await startupTrace.measure("dotenv", async () => {
      if (isRemoteAgentDispatchInvocation(normalizedArgv, normalizedInvocation.primary)) {
        const { loadGatewayDispatchCliDotEnv } = await import("./gateway-dispatch-dotenv.js");
        await loadGatewayDispatchCliDotEnv({ quiet: true });
      } else {
        const { loadCliDotEnv } = await import("./dotenv.js");
        loadCliDotEnv({ loadGlobalEnv: !isGatewayRunInvocation, quiet: true });
      }
    });
  }
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
  const readBestEffortCliConfig = async (): Promise<OpenClawConfig> => {
    if (!bestEffortConfigPromise) {
      bestEffortConfigPromise = import("../config/io.js").then(({ readBestEffortConfig }) =>
        readBestEffortConfig(
          isolateProxyConfigEnv ? { isolateEnv: true, observe: false } : undefined,
        ),
      );
    }
    return await bestEffortConfigPromise;
  };
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
    const config = await readBestEffortCliConfig();
    const unownedPrimary = await resolveUnownedCliPrimary({ argv: normalizedArgv, config });
    if (unownedPrimary) {
      throw new Error(await resolveUnownedCliPrimaryMessage({ primary: unownedPrimary, config }));
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

  let flushedHelpExit = false;
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
          throw new Error(
            await resolveUnownedCliPrimaryMessage({ primary: unownedPrimary, config }),
          );
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
        const { launchTuiCli } = await import("../tui/tui-launch.js");
        const tuiOptions = bareRootLaunchTarget.local
          ? { deliver: false, local: true }
          : {
              deliver: false,
              ...(bareRootLaunchTarget.tlsFingerprint
                ? { tlsFingerprint: bareRootLaunchTarget.tlsFingerprint }
                : {}),
            };
        const tuiLaunchOptions: { gatewayUrl?: string; authSource?: "config" } = {};
        if (bareRootLaunchTarget.gatewayUrl) {
          tuiLaunchOptions.gatewayUrl = bareRootLaunchTarget.gatewayUrl;
        }
        if (bareRootLaunchTarget.authSource) {
          tuiLaunchOptions.authSource = bareRootLaunchTarget.authSource;
        }
        await launchTuiCli(tuiOptions, tuiLaunchOptions);
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

    if (!isHelpOrVersionInvocation) {
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
    if (await startupTrace.measure("route", () => tryRouteCli(normalizedArgv))) {
      return;
    }

    let parseArgv = normalizeGeneratedHelpCommandArgv(rewriteUpdateFlagArgv(normalizedArgv));
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
      // Capture all console output into structured logs while keeping stdout/stderr behavior.
      const { enableConsoleCapture } = await loadLoggingModule();
      enableConsoleCapture();

      const [
        { buildProgram },
        { formatUncaughtError },
        { formatCliFailureLines },
        { runFatalErrorHooks },
        {
          installUnhandledRejectionHandler,
          isBenignUncaughtExceptionError,
          isUncaughtExceptionHandled,
        },
        { restoreTerminalState },
      ] = await startupTrace.measure("core-imports", () =>
        Promise.all([
          import("./program.js"),
          import("../infra/errors.js"),
          import("./failure-output.js"),
          import("../infra/fatal-error-hooks.js"),
          import("../infra/unhandled-rejections.js"),
          import("../../packages/terminal-core/src/restore.js"),
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
        restoreTerminalState("uncaught exception", { resumeStdinIfPaused: false });
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
          const { registerPluginCliCommandsFromValidatedConfig } =
            await import("../plugins/cli.js");
          return await withConsoleLogsRoutedToStderrForJson(parseArgv, () =>
            registerPluginCliCommandsFromValidatedConfig(program, undefined, undefined, {
              mode: "lazy",
              primary,
            }),
          );
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
            const missingPluginCommandMessage = resolveMissingPluginCommandMessageFromPolicy(
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
        await startupTrace.measure("parse", () => program.parseAsync(parseArgv));
        completedHelpOrVersion = isHelpOrVersionInvocation;
      } catch (error) {
        if (!isCommanderParseExit(error)) {
          throw error;
        }
        process.exitCode = error.exitCode;
        completedHelpOrVersion = isHelpOrVersionInvocation && error.exitCode === 0;
      }
      if (completedHelpOrVersion) {
        // Lazy command-group registrars can import native/runtime resources solely to
        // render complete help. Exit after Commander has rendered and streams flush.
        requestExitAfterOneShotOutput();
        flushExitAfterOneShotOutput();
        flushedHelpExit = true;
      }
    } finally {
      stopStartupProgress();
    }
  } finally {
    uninstallGatewayRunRuntimeHooks?.();
    await stopStartedProxy();
    await disposeCliAgentHarnesses();
    await closeCliMemoryManagers();
    pauseNonTtyStdinForCliExit();
    if (!flushedHelpExit) {
      flushExitAfterOneShotOutput();
    }
  }
}
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
