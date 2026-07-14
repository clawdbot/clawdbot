import type { ChildProcess } from "node:child_process";
import { basename, dirname, resolve, win32 as pathWin32 } from "node:path";
import { trimForSummary } from "./shared.ts";

export type CrossOsSuite = "packaged-fresh" | "installer-fresh" | "packaged-upgrade" | "dev-update";
export type CrossOsMode = "fresh" | "upgrade" | "both";
export type CrossOsOsId = "ubuntu" | "windows" | "macos";
export type ProviderId = "openai" | "anthropic" | "minimax";
export type ProviderConfig = {
  extensionId: string;
  secretEnv: string;
  authChoice: string;
  model: string;
  baseUrl?: string;
  timeoutSeconds?: number;
};
export type ParsedArgs = Record<string, string>;
export type LaneResult = { status: string; error?: string } & Record<string, unknown>;
export type CandidateBuild = {
  candidateTgz: string;
  candidateVersion: string;
  candidateFileName: string;
  sourceDir: string;
  sourceSha: string;
};
export type PackageJson = {
  name?: string;
  version?: string;
  scripts?: Record<string, string>;
  openclaw?: { commit?: string };
};
export type LaneState = {
  name: string;
  rootDir: string;
  prefixDir: string;
  homeDir: string;
  stateDir: string;
  appDataDir: string;
  gatewayPort: number;
  phaseTimings: Array<{ name: string; status: "pass" | "fail"; durationMs: number }>;
};
export type GatewayHandle = {
  child: ChildProcess;
  closeLog: () => Promise<void>;
  logPath: string;
};
export type CommandResult = { exitCode: number; stdout: string; stderr: string };
export type AgentTurnResult = CommandResult | { status: number; stdout: string; stderr: string };
export type CommandOptions = {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  logPath: string;
  timeoutMs?: number;
  check?: boolean;
  maxOutputBytes?: number;
};
export type CommandInvocation = {
  command: string;
  args: string[];
  shell?: boolean | string;
  windowsVerbatimArguments?: boolean;
};
export type Cleanup = () => Promise<void> | void;
export type LaneBaseParams = {
  logsDir: string;
  providerConfig: ProviderConfig;
  providerSecretValue: string;
};
export type LaneCommandParams = {
  lane: LaneState;
  env: NodeJS.ProcessEnv;
  logPath: string;
};
export type AgentOutputOptions = { logText?: string; logPath?: string };
export type SummaryPayload = {
  provider: string;
  suite: string;
  mode: string;
  sourceSha?: string;
  candidateVersion?: string;
  baselineSpec: string;
  result?: {
    status?: string;
    installTarget?: string;
    installVersion?: string;
    baselineVersion?: string;
    installedVersion?: string;
    installedCommit?: string;
    cliPath?: string;
    gatewayPort?: number;
    dashboardStatus?: string;
    discordStatus?: string;
    agentOutput?: string;
    error?: string;
    phaseTimings?: LaneState["phaseTimings"];
  };
};

export const PUBLISHED_INSTALLER_BASE_URL = "https://openclaw.ai";

const SUPPORTED_MODES = new Set<CrossOsMode>(["fresh", "upgrade", "both"]);
const SUPPORTED_SUITES = new Set<CrossOsSuite>([
  "packaged-fresh",
  "installer-fresh",
  "packaged-upgrade",
  "dev-update",
]);
const SUPPORTED_OS_IDS = new Set<CrossOsOsId>(["ubuntu", "windows", "macos"]);

export const CROSS_OS_AGENT_TURN_TIMEOUT_SECONDS = parsePositiveIntegerEnv(
  "OPENCLAW_CROSS_OS_AGENT_TURN_TIMEOUT_SECONDS",
  600,
);
export const CROSS_OS_COMMAND_CAPTURE_TAIL_BYTES = 16 * 1024 * 1024;
export const CROSS_OS_AGENT_LOG_FALLBACK_TAIL_BYTES = 2 * 1024 * 1024;
export const CROSS_OS_NPM_DEBUG_LOG_TAIL_BYTES = 256 * 1024;
export const CROSS_OS_PROCESS_TREE_KILL_AFTER_MS = parsePositiveIntegerEnv(
  "OPENCLAW_CROSS_OS_PROCESS_TREE_KILL_AFTER_MS",
  15_000,
);
export const CROSS_OS_AGENT_TURN_OPTIONAL = resolveCrossOsAgentTurnOptional();

const providerConfig = {
  openai: {
    extensionId: "openai",
    secretEnv: "OPENAI_API_KEY",
    authChoice: "openai-api-key",
    model: "openai/gpt-5.6-luna",
    baseUrl: "https://api.openai.com/v1",
    timeoutSeconds: CROSS_OS_AGENT_TURN_TIMEOUT_SECONDS,
  },
  anthropic: {
    extensionId: "anthropic",
    secretEnv: "ANTHROPIC_API_KEY",
    authChoice: "apiKey",
    model: "anthropic/claude-sonnet-4-6",
  },
  minimax: {
    extensionId: "minimax",
    secretEnv: "MINIMAX_API_KEY",
    authChoice: "minimax-global-api",
    model: "minimax/MiniMax-M2.7",
  },
} satisfies Record<ProviderId, ProviderConfig>;

export function resolveProviderConfig(provider: string, env = process.env): ProviderConfig | null {
  if (!Object.hasOwn(providerConfig, provider)) {
    return null;
  }
  const config: ProviderConfig = providerConfig[provider as ProviderId];
  const providerEnvKey = `OPENCLAW_CROSS_OS_${provider.toUpperCase().replace(/[^A-Z0-9]+/gu, "_")}_MODEL`;
  const model = env[providerEnvKey]?.trim() || env.OPENCLAW_CROSS_OS_MODEL?.trim() || config.model;
  return { ...config, model };
}

const RELEASE_SMOKE_PLUGIN_ALLOWLIST_BASE = [
  "acpx",
  "bonjour",
  "browser",
  "device-pair",
  "phone-control",
  "talk-voice",
];

export function buildCrossOsReleaseSmokePluginAllowlist(
  providerMeta: Pick<ProviderConfig, "extensionId">,
) {
  return [...new Set([providerMeta.extensionId, ...RELEASE_SMOKE_PLUGIN_ALLOWLIST_BASE])];
}

export function buildCrossOsReleaseSmokeMemorySlotConfigArgs() {
  return ["config", "set", "plugins.slots.memory", JSON.stringify("none"), "--strict-json"];
}

function shouldSeedProviderConfigModels(providerMeta: ProviderConfig) {
  return (
    typeof providerMeta.baseUrl === "string" || typeof providerMeta.timeoutSeconds === "number"
  );
}

export function buildReleaseProviderConfigOverride(providerMeta: ProviderConfig) {
  if (!shouldSeedProviderConfigModels(providerMeta)) {
    return null;
  }
  return {
    ...(typeof providerMeta.baseUrl === "string" ? { baseUrl: providerMeta.baseUrl } : {}),
    ...(providerMeta.extensionId === "openai" ? { agentRuntime: { id: "openclaw" } } : {}),
    models: [],
    ...(typeof providerMeta.timeoutSeconds === "number"
      ? { timeoutSeconds: providerMeta.timeoutSeconds }
      : {}),
  };
}

export const PACKAGE_DIST_INVENTORY_RELATIVE_PATH = "dist/postinstall-inventory.json";
export const INSTALL_STAGE_DEBRIS_DIR_PATTERN = /^\.openclaw-install-stage(?:-[^/]+)?$/iu;
export const OMITTED_QA_EXTENSION_PREFIXES = [
  "dist/extensions/qa-channel/",
  "dist/extensions/qa-lab/",
  "dist/extensions/qa-matrix/",
];
export const CROSS_OS_DASHBOARD_SMOKE_TIMEOUT_MS = 120_000;
export const CROSS_OS_DASHBOARD_FETCH_TIMEOUT_MS = 10_000;
export const CROSS_OS_DISCORD_FETCH_TIMEOUT_MS = parsePositiveIntegerEnv(
  "OPENCLAW_CROSS_OS_DISCORD_FETCH_TIMEOUT_MS",
  10_000,
);
export const CROSS_OS_FETCH_BODY_MAX_CHARS = 1024 * 1024;
export const CROSS_OS_GATEWAY_STATUS_RPC_TIMEOUT_MS = 30_000;
export const CROSS_OS_GATEWAY_STATUS_COMMAND_TIMEOUT_MS =
  CROSS_OS_GATEWAY_STATUS_RPC_TIMEOUT_MS + 45_000;
export const CROSS_OS_GATEWAY_READY_TIMEOUT_MS = 3 * 60_000;
export const CROSS_OS_WINDOWS_GATEWAY_READY_TIMEOUT_MS = 5 * 60_000;
export const CROSS_OS_RELEASE_SMOKE_TOOLS_PROFILE = "minimal";
export const CROSS_OS_WINDOWS_PACKAGED_UPGRADE_STEP_TIMEOUT_SECONDS = 10 * 60;
export const CROSS_OS_WINDOWS_PACKAGED_UPGRADE_WRAPPER_TIMEOUT_MS =
  (CROSS_OS_WINDOWS_PACKAGED_UPGRADE_STEP_TIMEOUT_SECONDS + 2 * 60) * 1000;
export const CROSS_OS_COMMAND_HEARTBEAT_SECONDS = parsePositiveIntegerEnv(
  "OPENCLAW_CROSS_OS_COMMAND_HEARTBEAT_SECONDS",
  60,
);

export function gatewayReadyDeadlineMs(platform = process.platform) {
  return platform === "win32"
    ? CROSS_OS_WINDOWS_GATEWAY_READY_TIMEOUT_MS
    : CROSS_OS_GATEWAY_READY_TIMEOUT_MS;
}

export function resolveNpmPackTarballFileName(value: unknown, label = "npm pack") {
  const filename = typeof value === "string" ? value.trim() : "";
  if (
    !filename.endsWith(".tgz") ||
    filename.includes("\0") ||
    filename !== basename(filename) ||
    filename !== pathWin32.basename(filename)
  ) {
    throw new Error(`${label} did not report a safe .tgz filename.`);
  }
  return filename;
}

export function resolvePackDestinationTarball(
  value: unknown,
  packDestination: string,
  label = "package pack",
) {
  const filename = typeof value === "string" ? value.trim() : "";
  const fileName = basename(filename);
  const destinationDir = resolve(packDestination);
  const tarballPath = resolve(destinationDir, filename);
  if (
    !filename.endsWith(".tgz") ||
    filename.includes("\0") ||
    !fileName ||
    fileName !== pathWin32.basename(filename) ||
    dirname(tarballPath) !== destinationDir
  ) {
    throw new Error(`${label} did not report a safe .tgz filename.`);
  }
  return { fileName, path: tarballPath };
}

export function parseArgs(argv: string[]): ParsedArgs {
  const parsed: ParsedArgs = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === undefined) {
      throw new Error(`Missing cross-OS release argument at index ${index}`);
    }
    if (!token.startsWith("--")) {
      continue;
    }
    const key = token.slice(2);
    const next = argv[index + 1];
    if (next === undefined || next.startsWith("--")) {
      parsed[key] = "true";
      continue;
    }
    parsed[key] = next;
    index += 1;
  }
  return parsed;
}

export function parsePositiveIntegerEnv(name: string, fallback: number, env = process.env): number {
  const raw = env[name]?.trim();
  if (!raw) {
    return fallback;
  }
  if (!/^\d+$/u.test(raw)) {
    throw new Error(`${name} must be a positive integer. Got: ${JSON.stringify(raw)}`);
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer. Got: ${JSON.stringify(raw)}`);
  }
  return value;
}

function parseBooleanEnv(name: string, fallback: boolean, env = process.env): boolean {
  const raw = env[name]?.trim();
  if (!raw) {
    return fallback;
  }
  if (/^(1|true|yes|on)$/iu.test(raw)) {
    return true;
  }
  if (/^(0|false|no|off)$/iu.test(raw)) {
    return false;
  }
  throw new Error(`${name} must be a boolean. Got: ${JSON.stringify(raw)}`);
}

export function resolveCrossOsAgentTurnOptional(env = process.env) {
  return parseBooleanEnv("OPENCLAW_CROSS_OS_AGENT_TURN_OPTIONAL", false, env);
}

export function looksLikeReleaseVersionRef(ref: string) {
  const trimmed = normalizeRequestedRef(ref);
  return /^v?[0-9]{4}\.[0-9]+\.[0-9]+(?:-(?:[1-9][0-9]*)|[-.](?:alpha|beta|rc)[-.]?[0-9]+)?$/iu.test(
    trimmed,
  );
}

export function normalizeRequestedRef(ref?: string) {
  const trimmed = ref?.trim() || "";
  if (!trimmed) {
    return "";
  }
  if (trimmed.startsWith("refs/heads/")) {
    return trimmed.slice("refs/heads/".length);
  }
  if (trimmed.startsWith("refs/tags/")) {
    return trimmed.slice("refs/tags/".length);
  }
  return trimmed;
}

export function isImmutableReleaseRef(ref?: string) {
  const trimmed = ref?.trim() || "";
  return trimmed.startsWith("refs/tags/") || looksLikeReleaseVersionRef(trimmed);
}

export function resolveRequestedSuites(mode: string, ref: string): CrossOsSuite[] {
  if (!SUPPORTED_MODES.has(mode as CrossOsMode)) {
    throw new Error(`Unsupported mode "${mode}".`);
  }
  const suites: CrossOsSuite[] = [];
  if (mode === "fresh" || mode === "both") {
    suites.push("packaged-fresh", "installer-fresh");
  }
  if (mode === "upgrade" || mode === "both") {
    suites.push("packaged-upgrade");
    if (shouldRunMainChannelDevUpdate(ref)) {
      suites.push("dev-update");
    }
  }
  return suites;
}

export function resolveRunnerMatrix(params: {
  mode: string;
  ref: string;
  suiteFilter?: string;
  ubuntuRunner?: string;
  windowsRunner?: string;
  macosRunner?: string;
  varUbuntuRunner?: string;
  varWindowsRunner?: string;
  varMacosRunner?: string;
}) {
  const pick = (...values: Array<string | undefined>) =>
    values.find((value) => typeof value === "string" && value.trim().length > 0)?.trim();
  const suites = resolveRequestedSuites(params.mode, params.ref);
  const suiteFilter = parseCrossOsSuiteFilter(params.suiteFilter ?? "");
  const runners = [
    {
      os_id: "ubuntu",
      display_name: "Linux",
      runner: pick(params.ubuntuRunner, params.varUbuntuRunner, "blacksmith-8vcpu-ubuntu-2404"),
      artifact_name: "linux",
    },
    {
      os_id: "windows",
      display_name: "Windows",
      runner: pick(params.windowsRunner, params.varWindowsRunner, "blacksmith-32vcpu-windows-2025"),
      artifact_name: "windows",
    },
    {
      os_id: "macos",
      display_name: "macOS",
      runner: pick(params.macosRunner, params.varMacosRunner, "blacksmith-6vcpu-macos-15"),
      artifact_name: "macos",
    },
  ];
  const include = runners.flatMap((runner) =>
    suites
      .filter((suite) => suiteFilter.matches(runner.os_id as CrossOsOsId, suite))
      .map((suite) =>
        Object.assign({}, runner, {
          suite,
          suite_label: formatSuiteLabel(suite),
          lane: suite.includes(`upgrade`) || suite === `dev-update` ? `upgrade` : `fresh`,
        }),
      ),
  );
  if (include.length === 0) {
    throw new Error(
      `cross_os_suite_filter ${JSON.stringify(params.suiteFilter ?? "")} did not match any ${params.mode} suite.`,
    );
  }
  return {
    include,
  };
}

export function parseCrossOsSuiteFilter(rawFilter: string) {
  const tokens = rawFilter
    .split(/[, ]+/u)
    .map((token) => normalizeCrossOsSuiteFilterToken(token))
    .filter(Boolean);
  if (tokens.length === 0) {
    return {
      matches: () => true,
      tokens,
    };
  }

  const matchers = tokens.map((token) => {
    if (SUPPORTED_SUITES.has(token as CrossOsSuite)) {
      return { osId: "", suite: token as CrossOsSuite };
    }
    if (SUPPORTED_OS_IDS.has(token as CrossOsOsId)) {
      return { osId: token as CrossOsOsId, suite: "" };
    }
    for (const separator of ["/", ":", "-"]) {
      const matchedOs = [...SUPPORTED_OS_IDS].find((osId) =>
        token.startsWith(`${osId}${separator}`),
      );
      if (!matchedOs) {
        continue;
      }
      const suite = token.slice(matchedOs.length + separator.length);
      if (!SUPPORTED_SUITES.has(suite as CrossOsSuite)) {
        break;
      }
      return { osId: matchedOs, suite: suite as CrossOsSuite };
    }
    throw new Error(
      `Unsupported cross_os_suite_filter token ${JSON.stringify(token)}. Use an OS id, suite id, or os/suite pair such as windows/packaged-upgrade.`,
    );
  });

  return {
    matches: (osId: CrossOsOsId, suite: CrossOsSuite) =>
      matchers.some((matcher) => {
        const osMatches = !matcher.osId || matcher.osId === osId;
        const suiteMatches = !matcher.suite || matcher.suite === suite;
        return osMatches && suiteMatches;
      }),
    tokens,
  };
}

function normalizeCrossOsSuiteFilterToken(token: string) {
  return token
    .trim()
    .toLowerCase()
    .replace(/_/gu, "-")
    .replace(/\s*[/:-]\s*/gu, (separator) => separator.trim())
    .replace(/\s+/gu, "-");
}

export function readRunnerOverrideEnv(env = process.env) {
  const preferNonEmptyEnv = (primary: string | undefined, legacy: string | undefined) => {
    const primaryValue = primary?.trim();
    if (primaryValue) {
      return primaryValue;
    }
    const legacyValue = legacy?.trim();
    return legacyValue || "";
  };

  return {
    varUbuntuRunner: preferNonEmptyEnv(
      env.VAR_UBUNTU_RUNNER,
      env.OPENCLAW_RELEASE_CHECKS_UBUNTU_RUNNER,
    ),
    varWindowsRunner: preferNonEmptyEnv(
      env.VAR_WINDOWS_RUNNER,
      env.OPENCLAW_RELEASE_CHECKS_WINDOWS_RUNNER,
    ),
    varMacosRunner: preferNonEmptyEnv(
      env.VAR_MACOS_RUNNER,
      env.OPENCLAW_RELEASE_CHECKS_MACOS_RUNNER,
    ),
  };
}

function formatSuiteLabel(suite: CrossOsSuite) {
  if (suite === "packaged-fresh") {
    return "packaged fresh";
  }
  if (suite === "installer-fresh") {
    return "installer fresh";
  }
  if (suite === "packaged-upgrade") {
    return "packaged upgrade";
  }
  return "dev update";
}

export function shouldUseManagedGatewayService(platform = process.platform) {
  return platform === "win32";
}

export function shouldUseManagedGatewayForInstallerRuntime(platform = process.platform) {
  return shouldUseManagedGatewayService(platform) && platform !== "win32";
}

export function shouldExerciseManagedGatewayLifecycleAfterInstall(platform = process.platform) {
  return shouldUseManagedGatewayService(platform);
}

export function shouldStopManagedGatewayBeforeManualFallback(platform = process.platform) {
  return shouldUseManagedGatewayService(platform);
}

export function shouldRunBundledPluginPostinstall(_options?: { lane?: LaneState }) {
  return true;
}

export function looksLikeCommitSha(ref: string) {
  return /^[0-9a-f]{7,40}$/iu.test(ref.trim());
}

export function resolveExpectedDevUpdateRef(ref?: string) {
  const trimmed = normalizeRequestedRef(ref) || "main";
  return trimmed || "main";
}

export function resolveDevUpdateVerificationRef(ref: string, sourceSha?: string) {
  if (resolveExpectedDevUpdateRef(ref) === "main" && looksLikeCommitSha(sourceSha ?? "")) {
    return sourceSha!.trim();
  }
  return resolveExpectedDevUpdateRef(ref);
}

export function shouldRunMainChannelDevUpdate(ref: string) {
  if (isImmutableReleaseRef(ref)) {
    return false;
  }
  return resolveExpectedDevUpdateRef(ref) === "main";
}

export function shouldSkipInstallerDaemonHealthCheck(platform = process.platform) {
  return platform === "win32";
}

export function buildRealUpdateEnv(env: NodeJS.ProcessEnv) {
  const updateEnv: NodeJS.ProcessEnv = {
    ...env,
    OPENCLAW_ALLOW_OLDER_BINARY_DESTRUCTIVE_ACTIONS: "1",
    NODE_DISABLE_COMPILE_CACHE: "1",
  };
  delete updateEnv.OPENCLAW_DISABLE_BUNDLED_PLUGIN_POSTINSTALL;
  delete updateEnv.NODE_COMPILE_CACHE;
  return updateEnv;
}

export function verifyPackagedUpgradeUpdateResult(
  result: CommandResult,
  _options?: { candidateVersion?: string },
) {
  if (result.exitCode === 0) {
    return;
  }

  throw new Error(
    `Packaged upgrade failed (${result.exitCode}): ${trimForSummary(
      `${result.stdout}\n${result.stderr}`,
    )}`,
  );
}

export function buildPackagedUpgradeUpdateArgs(candidateUrl: string) {
  return [
    "update",
    "--tag",
    candidateUrl,
    "--yes",
    "--json",
    "--no-restart",
    "--timeout",
    String(updateStepTimeoutSeconds()),
  ];
}

export function isRecoverableWindowsPackagedUpgradeSwapCleanupFailure(
  result: CommandResult | undefined,
  platform = process.platform,
) {
  if (platform !== "win32" || !result || result.exitCode === 0) {
    return false;
  }
  const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  return (
    /\bglobal install swap\b/iu.test(output) &&
    /\bEPERM\b/iu.test(output) &&
    /\bunlink\b/iu.test(output) &&
    /[/\\]\.openclaw-\d+-\d+[/\\]/u.test(output) &&
    /\.node['"]?/iu.test(output)
  );
}

export function isRecoverableWindowsPackagedUpgradeTimeoutError(
  error: unknown,
  platform = process.platform,
) {
  if (platform !== "win32") {
    return false;
  }
  const message = error instanceof Error ? error.message : String(error);
  return (
    /\bCommand timed out:/u.test(message) &&
    /[/\\]openclaw\.mjs update --tag http:\/\/127\.0\.0\.1:\d+\/openclaw[^/\s]*\.tgz --yes --json(?: --no-restart)? --timeout \d+/u.test(
      message,
    )
  );
}

export function shouldRunPackagedUpgradeStatusProbe({
  platform = process.platform,
  usedWindowsPackagedUpgradeFallback,
}: { platform?: NodeJS.Platform; usedWindowsPackagedUpgradeFallback?: boolean } = {}) {
  return !(platform === "win32" && usedWindowsPackagedUpgradeFallback);
}

export function verifyWindowsPackagedUpgradeFallbackInstall({
  installedVersion,
  candidateVersion,
}: {
  installedVersion: string;
  candidateVersion: string;
}) {
  if (installedVersion !== candidateVersion) {
    throw new Error(
      `Windows packaged upgrade fallback installed ${installedVersion || "unknown"}, expected ${candidateVersion}`,
    );
  }
}

export function resolveExplicitBaselineVersion(baselineSpec: string) {
  const trimmed = baselineSpec.trim();
  if (!trimmed || trimmed === "openclaw@latest") {
    return "";
  }
  if (trimmed.startsWith("openclaw@")) {
    return trimmed.slice("openclaw@".length);
  }
  return trimmed;
}

export function installTimeoutMs() {
  return process.platform === "win32" ? 45 * 60 * 1000 : 20 * 60 * 1000;
}

export function updateTimeoutMs() {
  return process.platform === "win32"
    ? CROSS_OS_WINDOWS_PACKAGED_UPGRADE_WRAPPER_TIMEOUT_MS
    : 20 * 60 * 1000;
}

export function updateStepTimeoutSeconds() {
  return process.platform === "win32"
    ? CROSS_OS_WINDOWS_PACKAGED_UPGRADE_STEP_TIMEOUT_SECONDS
    : 1200;
}

export function isSupportedCrossOsSuite(value: string): value is CrossOsSuite {
  return SUPPORTED_SUITES.has(value as CrossOsSuite);
}
