import { existsSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { resolveStateDir } from "../config/paths.js";
import type { ConfigFileSnapshot, OpenClawConfig } from "../config/types.openclaw.js";
import { isTruthyEnvValue, normalizeEnv } from "../infra/env.js";
import { isMainModule } from "../infra/is-main.js";
import type { ProxyHandle } from "../infra/net/proxy/proxy-lifecycle.js";
import { ensureOpenClawCliOnPath } from "../infra/path-env.js";
import { assertSupportedRuntime } from "../infra/runtime-guard.js";
import type { PluginManifestCommandAliasRegistry } from "../plugins/manifest-command-aliases.js";
import { resolveCliArgvInvocation } from "./argv-invocation.js";
import { normalizeGeneratedHelpCommandArgv, normalizeRootHelpTargetArgv } from "./argv.js";
import {
  isReservedNonPluginCommandRoot,
  shouldRegisterPrimaryCommandOnly,
  shouldSkipPluginCommandRegistration,
} from "./command-registration-policy.js";
import { maybeRunCliInContainer, parseCliContainerArgs } from "./container-target.js";
import {
  consumeGatewayFastPathRootOptionToken,
  consumeGatewayRunOptionToken,
} from "./gateway-run-argv.js";
import { hasJsonOutputFlag, withConsoleLogsRoutedToStderrForJson } from "./json-output-mode.js";
import { applyCliProfileEnv, parseCliProfileArgs } from "./profile.js";
import { getCoreCliCommandNames } from "./program/core-command-descriptors.js";
import { getSubCliEntries } from "./program/subcli-descriptors.js";
import {
  resolvePrecomputedSubcommandHelpFastPath,
  resolveMissingPluginCommandMessage as resolveMissingPluginCommandMessageFromPolicy,
  rewriteUpdateFlagArgv,
  shouldEnsureCliPath,
  shouldStartCrestodianForBareRoot,
  shouldStartCrestodianForModernOnboard,
  shouldStartProxyForCli,
  shouldUseBrowserHelpFastPath,
  shouldUseNodesHelpFastPath,
  shouldUseRootHelpFastPath,
  shouldUseSecretsHelpFastPath,
  shouldUseSetupOnboardConfigureHelpFastPath,
} from "./run-main-policy.js";
import { normalizeWindowsArgv } from "./windows-argv.js";

export {
  resolvePrecomputedSubcommandHelpFastPath,
  rewriteUpdateFlagArgv,
  shouldEnsureCliPath,
  shouldStartCrestodianForBareRoot,
  shouldStartCrestodianForModernOnboard,
  shouldStartProxyForCli,
  shouldUseBrowserHelpFastPath,
  shouldUseNodesHelpFastPath,
  shouldUseRootHelpFastPath,
  shouldUseSecretsHelpFastPath,
  shouldUseSetupOnboardConfigureHelpFastPath,
} from "./run-main-policy.js";

type Awaitable<T> = T | Promise<T>;

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
const loadCrestodianModule = async () => await import("../crestodian/crestodian.js");
const loadProgressModule = async () => await import("./progress.js");

function createGatewayCliMainStartupTrace(argv: string[]) {
  const enabled =
    isTruthyEnvValue(process.env.OPENCLAW_GATEWAY_STARTUP_TRACE) &&
    argv.slice(2).includes("gateway");
  const started = performance.now();
  let last = started;
  const emit = (name: string, durationMs: number, totalMs: number) => {
    if (!enabled) {
      return;
    }
    process.stderr.write(
      `[gateway] startup trace: cli.main.${name} ${durationMs.toFixed(1)}ms total=${totalMs.toFixed(1)}ms\n`,
    );
  };
  return {
    mark(name: string) {
      const now = performance.now();
      emit(name, now - last, now - started);
      last = now;
    },
    async measure<T>(name: string, run: () => Awaitable<T>): Promise<T> {
      const before = performance.now();
      try {
        return await run();
      } finally {
        const now = performance.now();
        emit(name, now - before, now - started);
        last = now;
      }
    },
  };
}

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

async function tryRunGatewayRunFastPath(
  argv: string[],
  startupTrace: ReturnType<typeof createGatewayCliMainStartupTrace>,
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
  ] = await startupTrace.measure("gateway-run-imports", () =>
    Promise.all([
      import("commander"),
      import("./gateway-cli/run-command.js"),
      import("../version.js"),
      import("./banner.js"),
      import("./command-startup-policy.js"),
      loadLoggingModule(),
    ]),
  );
  const invocation = resolveCliArgvInvocation(argv);
  const startupPolicy = resolveCliStartupPolicy({
    commandPath: invocation.commandPath,
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
  const gateway = addGatewayRunCommand(
    program.command("gateway").description("Run, inspect, and query the WebSocket Gateway"),
  );
  addGatewayRunCommand(
    gateway.command("run").description("Run the WebSocket Gateway (foreground)"),
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
    const { listAgentHarnessIds, disposeRegisteredAgentHarnesses } =
      await import("../agents/harness/registry.js");
    if (listAgentHarnessIds().length === 0) {
      return;
    }
    await disposeRegisteredAgentHarnesses();
  } catch {
    // Best-effort teardown for short-lived CLI commands. Harness plugins may
    // own subprocesses, but cleanup must not hide the command's real outcome.
  }
}

const UNCONFIGURED_CONFIG_IGNORED_KEYS = new Set(["$schema", "meta"]);

function isUnconfiguredConfigSnapshot(
  snapshot: Pick<ConfigFileSnapshot, "exists" | "valid" | "sourceConfig">,
): boolean {
  if (!snapshot.exists) {
    return true;
  }
  if (!snapshot.valid) {
    return false;
  }
  return Object.keys(snapshot.sourceConfig).every((key) =>
    UNCONFIGURED_CONFIG_IGNORED_KEYS.has(key),
  );
}

export async function shouldStartOnboardingForFreshInstall(argv: string[]): Promise<boolean> {
  if (!shouldStartCrestodianForBareRoot(argv)) {
    return false;
  }
  const { readConfigFileSnapshot } = await import("../config/config.js");
  const snapshot = await readConfigFileSnapshot();
  return isUnconfiguredConfigSnapshot(snapshot);
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
  if (existsSync(path.join(process.cwd(), ".env"))) {
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
  return (
    resolveMissingPluginCommandMessageFromPolicy(params.primary, params.config, {
      resolveCommandAliasOwner: resolveManifestCommandAliasOwner,
      resolveToolOwner: resolveManifestToolOwner,
      resolveCliCommandSurfaceOwner: () => cliCommandSurfaceOwner,
    }) ??
    `Unknown command: openclaw ${params.primary}. No built-in command or plugin CLI metadata owns "${params.primary}".`
  );
}

async function bootstrapCliProxyCaptureAndDispatcher(
  startupTrace: ReturnType<typeof createGatewayCliMainStartupTrace>,
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
  const startupTrace = createGatewayCliMainStartupTrace(originalArgv);
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
  const normalizedArgv = normalizeRootHelpTargetArgv(parsedProfile.argv);
  const normalizedInvocation = resolveCliArgvInvocation(normalizedArgv);
  const isHelpOrVersionInvocation = normalizedInvocation.hasHelpOrVersion;
  startupTrace.mark("argv");

  if (!isHelpOrVersionInvocation && shouldLoadCliDotEnv()) {
    await startupTrace.measure("dotenv", async () => {
      if (isRemoteAgentDispatchInvocation(normalizedArgv, normalizedInvocation.primary)) {
        const { loadGatewayDispatchCliDotEnv } = await import("./gateway-dispatch-dotenv.js");
        await loadGatewayDispatchCliDotEnv({ quiet: true });
      } else {
        const { loadCliDotEnv } = await import("./dotenv.js");
        loadCliDotEnv({ quiet: true });
      }
    });
  }
  normalizeEnv();
  if (shouldEnsureCliPath(normalizedArgv)) {
    ensureOpenClawCliOnPath();
  }

  // Enforce the minimum supported runtime before doing any work.
  assertSupportedRuntime();

  // Activate operator-managed proxy routing for network-capable commands.
  // Local Gateway/control-plane commands keep direct loopback access while
  // runtime, provider, plugin, update, and manifest/metadata-owned plugin commands route egress.
  let proxyHandle: ProxyHandle | null = null;
  let bestEffortConfigPromise: Promise<OpenClawConfig> | null = null;
  const readBestEffortCliConfig = async (): Promise<OpenClawConfig> => {
    if (!bestEffortConfigPromise) {
      bestEffortConfigPromise = import("../config/io.js").then(({ readBestEffortConfig }) =>
        readBestEffortConfig(),
      );
    }
    return await bestEffortConfigPromise;
  };
  const stopStartedProxy = async () => {
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
  if (!isHelpOrVersionInvocation && shouldStartProxyForCli(normalizedArgv)) {
    const config = await readBestEffortCliConfig();
    const unownedPrimary = await resolveUnownedCliPrimary({ argv: normalizedArgv, config });
    if (unownedPrimary) {
      throw new Error(await resolveUnownedCliPrimaryMessage({ primary: unownedPrimary, config }));
    }
    const { startProxy } = await loadProxyLifecycleModule();
    proxyHandle = await startProxy(config?.proxy ?? undefined);
  }

  let onSigterm: (() => void) | null = null;
  let onSigint: (() => void) | null = null;
  let onExit: (() => void) | null = null;
  if (proxyHandle) {
    const shutdown = (exitCode: number) => {
      if (onSigterm) {
        process.off("SIGTERM", onSigterm);
      }
      if (onSigint) {
        process.off("SIGINT", onSigint);
      }
      void stopStartedProxy().finally(() => {
        process.exit(exitCode);
      });
    };
    onSigterm = () => shutdown(143);
    onSigint = () => shutdown(130);
    onExit = () => killStartedProxy();
    process.once("SIGTERM", onSigterm);
    process.once("SIGINT", onSigint);
    process.once("exit", onExit);
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

    if (shouldUseBrowserHelpFastPath(normalizedArgv)) {
      const { outputPrecomputedBrowserHelpText } = await loadRootHelpMetadataModule();
      if (outputPrecomputedBrowserHelpText()) {
        return;
      }
    }

    if (shouldUseSetupOnboardConfigureHelpFastPath(normalizedArgv)) {
      const { tryOutputSetupOnboardConfigureHelp } =
        await import("./setup-onboard-configure-help-fast-path.js");
      if (await tryOutputSetupOnboardConfigureHelp(normalizedArgv)) {
        return;
      }
    }

    if (shouldUseSecretsHelpFastPath(normalizedArgv)) {
      const { outputPrecomputedSecretsHelpText } = await loadRootHelpMetadataModule();
      if (outputPrecomputedSecretsHelpText()) {
        return;
      }
    }

    const precomputedSubcommandHelp = resolvePrecomputedSubcommandHelpFastPath(normalizedArgv);
    if (precomputedSubcommandHelp) {
      const { outputPrecomputedSubcommandHelpText } = await loadRootHelpMetadataModule();
      if (outputPrecomputedSubcommandHelpText(precomputedSubcommandHelp)) {
        return;
      }
    }

    if (shouldUseNodesHelpFastPath(normalizedArgv)) {
      const { loadRootHelpRenderOptionsForConfigSensitivePlugins } =
        await loadRootHelpLiveConfigModule();
      const liveRootHelpOptions = await loadRootHelpRenderOptionsForConfigSensitivePlugins(
        process.env,
      );
      if (!liveRootHelpOptions) {
        const { outputPrecomputedNodesHelpText } = await loadRootHelpMetadataModule();
        if (outputPrecomputedNodesHelpText()) {
          return;
        }
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

    const shouldRunBareRootCrestodian = shouldStartCrestodianForBareRoot(normalizedArgv);
    const shouldRunModernOnboardCrestodian = shouldStartCrestodianForModernOnboard(normalizedArgv);
    if (shouldRunBareRootCrestodian || shouldRunModernOnboardCrestodian) {
      await ensureCliEnvProxyDispatcher();
    }

    if (shouldRunBareRootCrestodian) {
      if (await shouldStartOnboardingForFreshInstall(normalizedArgv)) {
        if (!process.stdin.isTTY || !process.stdout.isTTY) {
          console.error(
            "Onboarding needs an interactive TTY. Use `openclaw onboard --non-interactive --accept-risk ...` for automation.",
          );
          process.exitCode = 1;
          return;
        }
        const { setupWizardCommand } = await import("../commands/onboard.js");
        await setupWizardCommand({});
        return;
      }
      if (!process.stdin.isTTY || !process.stdout.isTTY) {
        console.error(
          'Crestodian needs an interactive TTY. Use `openclaw crestodian --message "status"` for one command.',
        );
        process.exitCode = 1;
        return;
      }
      const { runCrestodian } = await loadCrestodianModule();
      const { createCliProgress } = await loadProgressModule();
      const progress = createCliProgress({
        label: "Starting Crestodian…",
        indeterminate: true,
        delayMs: 0,
        fallback: "none",
      });
      let progressStopped = false;
      const stopProgress = () => {
        if (progressStopped) {
          return;
        }
        progressStopped = true;
        progress.done();
      };
      try {
        await runCrestodian({ onReady: stopProgress });
      } finally {
        stopProgress();
      }
      return;
    }

    if (shouldRunModernOnboardCrestodian) {
      const { runCrestodian } = await loadCrestodianModule();
      const nonInteractive = normalizedArgv.includes("--non-interactive");
      await runCrestodian({
        message: nonInteractive ? "overview" : undefined,
        yes: false,
        json: normalizedArgv.includes("--json"),
        interactive: !nonInteractive,
      });
      return;
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

    const parseArgv = normalizeGeneratedHelpCommandArgv(rewriteUpdateFlagArgv(normalizedArgv));
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

      stopStartupProgress();

      try {
        await startupTrace.measure("parse", () => program.parseAsync(parseArgv));
      } catch (error) {
        if (!isCommanderParseExit(error)) {
          throw error;
        }
        process.exitCode = error.exitCode;
      }
    } finally {
      stopStartupProgress();
    }
  } finally {
    if (onSigterm) {
      process.off("SIGTERM", onSigterm);
    }
    if (onSigint) {
      process.off("SIGINT", onSigint);
    }
    if (onExit) {
      process.off("exit", onExit);
    }
    await stopStartedProxy();
    await disposeCliAgentHarnesses();
    await closeCliMemoryManagers();
    pauseNonTtyStdinForCliExit();
  }
}

export function isCliMainModule(): boolean {
  return isMainModule({ currentFile: fileURLToPath(import.meta.url) });
}
