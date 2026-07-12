#!/usr/bin/env node

// Executed directly via Node.js native type stripping in the release workflow.

import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  appendFileSync,
  chmodSync,
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  closeSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  type WriteStream,
  writeFileSync,
} from "node:fs";
import { mkdtempSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { createConnection as createNetConnection, createServer as createNetServer } from "node:net";
import type { Socket } from "node:net";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve, win32 as pathWin32 } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isLocalBuildMetadataDistPath } from "./lib/local-build-metadata-paths.mjs";
import { resolveWindowsTaskkillPath } from "./lib/windows-taskkill.mjs";
import { buildCmdExeCommandLine, resolveWindowsCmdExePath } from "./windows-cmd-helpers.mjs";

type CrossOsSuite = "packaged-fresh" | "installer-fresh" | "packaged-upgrade" | "dev-update";
type CrossOsMode = "fresh" | "upgrade" | "both";
type CrossOsOsId = "ubuntu" | "windows" | "macos";
type ProviderId = "openai" | "anthropic" | "minimax";
type ProviderConfig = {
  extensionId: string;
  secretEnv: string;
  authChoice: string;
  model: string;
  baseUrl?: string;
  timeoutSeconds?: number;
};
type ParsedArgs = Record<string, string>;
type LaneResult = { status: string; error?: string } & Record<string, unknown>;
type CandidateBuild = {
  candidateTgz: string;
  candidateVersion: string;
  candidateFileName: string;
  sourceDir: string;
  sourceSha: string;
};
type PackageJson = {
  name?: string;
  version?: string;
  scripts?: Record<string, string>;
  openclaw?: { commit?: string };
};
type LaneState = {
  name: string;
  rootDir: string;
  prefixDir: string;
  homeDir: string;
  stateDir: string;
  appDataDir: string;
  gatewayPort: number;
  phaseTimings: Array<{ name: string; status: "pass" | "fail"; durationMs: number }>;
};
type GatewayHandle = {
  child: ChildProcess;
  closeLog: () => Promise<void>;
  logPath: string;
};
type CommandResult = { exitCode: number; stdout: string; stderr: string };
type AgentTurnResult = CommandResult | { status: number; stdout: string; stderr: string };
type CommandOptions = {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  logPath: string;
  timeoutMs?: number;
  check?: boolean;
  maxOutputBytes?: number;
};
type CommandInvocation = {
  command: string;
  args: string[];
  shell?: boolean | string;
  windowsVerbatimArguments?: boolean;
};
type Cleanup = () => Promise<void> | void;
type LaneBaseParams = {
  logsDir: string;
  providerConfig: ProviderConfig;
  providerSecretValue: string;
};
type LaneCommandParams = {
  lane: LaneState;
  env: NodeJS.ProcessEnv;
  logPath: string;
};
type AgentOutputOptions = { logText?: string; logPath?: string };
type SummaryPayload = {
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

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const PUBLISHED_INSTALLER_BASE_URL = "https://openclaw.ai";

const SUPPORTED_MODES = new Set<CrossOsMode>(["fresh", "upgrade", "both"]);
const SUPPORTED_SUITES = new Set<CrossOsSuite>([
  "packaged-fresh",
  "installer-fresh",
  "packaged-upgrade",
  "dev-update",
]);
const SUPPORTED_OS_IDS = new Set<CrossOsOsId>(["ubuntu", "windows", "macos"]);

const CROSS_OS_SIGNAL_EXIT_CODES: Partial<Record<NodeJS.Signals, number>> = {
  SIGHUP: 129,
  SIGINT: 130,
  SIGTERM: 143,
};
const CROSS_OS_ACTIVE_CHILD_TREE_KILLERS = new Set<(signal: NodeJS.Signals) => void>();
let forwardedSignalExitCode: number | undefined;
let forwardedSignalForceKillTimer: NodeJS.Timeout | undefined;

export const CROSS_OS_AGENT_TURN_TIMEOUT_SECONDS = parsePositiveIntegerEnv(
  "OPENCLAW_CROSS_OS_AGENT_TURN_TIMEOUT_SECONDS",
  600,
);
export const CROSS_OS_COMMAND_CAPTURE_TAIL_BYTES = 16 * 1024 * 1024;
const CROSS_OS_AGENT_LOG_FALLBACK_TAIL_BYTES = 2 * 1024 * 1024;
const CROSS_OS_NPM_DEBUG_LOG_TAIL_BYTES = 256 * 1024;
const CROSS_OS_PROCESS_TREE_KILL_AFTER_MS = parsePositiveIntegerEnv(
  "OPENCLAW_CROSS_OS_PROCESS_TREE_KILL_AFTER_MS",
  15_000,
);
const CROSS_OS_AGENT_TURN_OPTIONAL = resolveCrossOsAgentTurnOptional();

for (const signal of Object.keys(CROSS_OS_SIGNAL_EXIT_CODES) as NodeJS.Signals[]) {
  process.on(signal, () => {
    forwardedSignalExitCode ??= CROSS_OS_SIGNAL_EXIT_CODES[signal];
    if (forwardedSignalExitCode === undefined) {
      return;
    }
    if (CROSS_OS_ACTIVE_CHILD_TREE_KILLERS.size === 0) {
      process.exit(forwardedSignalExitCode);
    }
    const activeKillers = Array.from(CROSS_OS_ACTIVE_CHILD_TREE_KILLERS);
    for (const killChildTree of activeKillers) {
      killChildTree(signal);
    }
    forwardedSignalForceKillTimer ??= setTimeout(() => {
      for (const killChildTree of activeKillers) {
        killChildTree("SIGKILL");
      }
      process.exit(forwardedSignalExitCode);
    }, CROSS_OS_PROCESS_TREE_KILL_AFTER_MS);
  });
}

function exitForwardedSignalWhenChildTreesDone() {
  if (forwardedSignalExitCode === undefined || CROSS_OS_ACTIVE_CHILD_TREE_KILLERS.size > 0) {
    return;
  }
  if (forwardedSignalForceKillTimer) {
    clearTimeout(forwardedSignalForceKillTimer);
    forwardedSignalForceKillTimer = undefined;
  }
  process.exit(forwardedSignalExitCode);
}

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

function buildReleaseProviderConfigOverride(providerMeta: ProviderConfig) {
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

const PACKAGE_DIST_INVENTORY_RELATIVE_PATH = "dist/postinstall-inventory.json";
const INSTALL_STAGE_DEBRIS_DIR_PATTERN = /^\.openclaw-install-stage(?:-[^/]+)?$/iu;
const OMITTED_QA_EXTENSION_PREFIXES = [
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

if (isMainModule()) {
  try {
    await main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${formatError(error)}\n`);
    process.exit(1);
  }
}

function isMainModule() {
  const invokedPath = process.argv[1]?.trim();
  if (!invokedPath) {
    return false;
  }
  return resolve(invokedPath) === SCRIPT_PATH;
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

async function main(argv: string[]) {
  const args = parseArgs(argv);

  if (args["resolve-matrix"] === "true") {
    const mode = args["mode"] ?? "both";
    const ref = args["ref"]?.trim() || "main";
    const runnerOverrideEnv = readRunnerOverrideEnv(process.env);
    process.stdout.write(
      `${JSON.stringify(
        resolveRunnerMatrix({
          mode,
          ref,
          ubuntuRunner: args["ubuntu-runner"],
          windowsRunner: args["windows-runner"],
          macosRunner: args["macos-runner"],
          suiteFilter: args["suite-filter"],
          ...runnerOverrideEnv,
        }),
      )}\n`,
    );
    return;
  }

  const outputDir = resolve(requireArg(args, "output-dir"));
  const prepareOnly = args["prepare-only"] === "true";
  const sourceDir = args["source-dir"]?.trim() ? resolve(args["source-dir"].trim()) : "";
  const provider = args["provider"]?.trim() || "";
  const suite = args["suite"]?.trim() || "";
  const mode = args["mode"] ?? "both";
  const inputRef = args["ref"]?.trim() || "";
  const previousVersion = args["previous-version"]?.trim() || "";
  const baselineSpec =
    args["baseline-spec"]?.trim() ||
    (previousVersion ? `openclaw@${previousVersion}` : "openclaw@latest");
  const providedBaselineTgz = args["baseline-tgz"]?.trim()
    ? resolve(args["baseline-tgz"].trim())
    : "";
  const providedCandidateTgz = args["candidate-tgz"]?.trim()
    ? resolve(args["candidate-tgz"].trim())
    : "";
  const providedCandidateVersion = args["candidate-version"]?.trim() || "";
  const providedSourceSha = args["source-sha"]?.trim() || "";
  const runDiscordRoundtrip = args["run-discord-roundtrip"] === "true";

  mkdirSync(outputDir, { recursive: true });
  const logsDir = join(outputDir, "logs");
  mkdirSync(logsDir, { recursive: true });

  if (prepareOnly) {
    if (!sourceDir) {
      throw new Error("--prepare-only requires --source-dir.");
    }
    const build = await prepareCandidate({
      outputDir,
      sourceDir,
      logsDir,
    });
    writeCandidateManifest(outputDir, build);
    return;
  }

  if (!SUPPORTED_SUITES.has(suite as CrossOsSuite)) {
    throw new Error(`Unsupported suite "${suite}".`);
  }
  if (!Object.hasOwn(providerConfig, provider)) {
    throw new Error(`Unsupported provider "${provider}".`);
  }

  const selectedProvider = resolveProviderConfig(provider);
  if (!selectedProvider) {
    throw new Error(`Unsupported provider "${provider}".`);
  }
  const providerSecretValue = process.env[selectedProvider.secretEnv]?.trim();
  if (!providerSecretValue) {
    throw new Error(`Missing ${selectedProvider.secretEnv}.`);
  }

  const summary = {
    platform: process.platform,
    runnerOs: process.env.OPENCLAW_RELEASE_CHECK_OS ?? "",
    runnerLabel: process.env.OPENCLAW_RELEASE_CHECK_RUNNER ?? "",
    provider,
    mode,
    suite,
    ref: inputRef || null,
    previousVersion: previousVersion || null,
    sourceDir,
    sourceSha: "",
    candidateVersion: "",
    candidateTgz: "",
    baselineSpec,
    result: {
      status: "pending",
    } as LaneResult,
    discordRoundtrip: runDiscordRoundtrip,
  };

  let build: CandidateBuild;
  try {
    build = sourceDir
      ? await prepareCandidate({
          outputDir,
          sourceDir,
          logsDir,
        })
      : readProvidedCandidate({
          candidateTgz: providedCandidateTgz,
          candidateVersion: providedCandidateVersion,
          sourceSha: providedSourceSha,
        });
    summary.sourceSha = build.sourceSha;
    summary.candidateVersion = build.candidateVersion;
    summary.candidateTgz = build.candidateTgz;

    if (suite === "packaged-fresh") {
      summary.result = await runFreshLane({
        build,
        logsDir,
        providerConfig: selectedProvider,
        providerSecretValue,
      });
    } else if (suite === "packaged-upgrade") {
      const tgzServer = await startStaticFileServer({
        filePath: build.candidateTgz,
        logPath: join(logsDir, "candidate-http-server.log"),
      });
      try {
        summary.result = await runUpgradeLane({
          baselineSpec,
          baselineTgz: providedBaselineTgz,
          build,
          candidateUrl: tgzServer.url,
          logsDir,
          providerConfig: selectedProvider,
          providerSecretValue,
        });
      } finally {
        await tgzServer.close();
      }
    } else if (suite === "installer-fresh") {
      summary.result = await runInstallerFreshSuite({
        build,
        logsDir,
        providerConfig: selectedProvider,
        providerSecretValue,
        runDiscordRoundtrip,
      });
    } else {
      summary.result = await runDevUpdateSuite({
        baselineSpec,
        logsDir,
        providerConfig: selectedProvider,
        providerSecretValue,
        ref: inputRef || "main",
        sourceSha: build.sourceSha,
        runDiscordRoundtrip,
      });
    }
  } catch (error) {
    summary.result = {
      status: "fail",
      error: formatError(error),
    };
  }

  writeSummary(outputDir, summary);

  if (summary.result.status !== "pass") {
    process.exit(1);
  }
}

async function prepareCandidate(params: {
  outputDir: string;
  sourceDir: string;
  logsDir: string;
}): Promise<CandidateBuild> {
  logPhase("prepare", "resolve-source-sha");
  const packageJson = readPackageJson(params.sourceDir);
  const hasUiBuildScript = packageJsonHasScript(packageJson, "ui:build");
  const sourceSha = (
    await runCommand(gitCommand(), ["rev-parse", "HEAD"], {
      cwd: params.sourceDir,
      logPath: join(params.logsDir, "git-rev-parse.log"),
    })
  ).stdout.trim();

  const buildEnv = {
    ...process.env,
    NODE_OPTIONS: "--max-old-space-size=8192",
  };

  logPhase("prepare", "pnpm-install");
  await runCommand(pnpmCommand(), ["install", "--frozen-lockfile"], {
    cwd: params.sourceDir,
    env: buildEnv,
    logPath: join(params.logsDir, "pnpm-install.log"),
    timeoutMs: 45 * 60 * 1000,
  });

  logPhase("prepare", "pnpm-build");
  await runCommand(pnpmCommand(), ["build"], {
    cwd: params.sourceDir,
    env: buildEnv,
    logPath: join(params.logsDir, "pnpm-build.log"),
    timeoutMs: 45 * 60 * 1000,
  });

  if (hasUiBuildScript) {
    // pnpm build does not regenerate dist/control-ui, and checked-in bundles can
    // otherwise leak into npm pack when a ref changes UI assets.
    logPhase("prepare", "pnpm-ui-build");
    await runCommand(pnpmCommand(), ["ui:build"], {
      cwd: params.sourceDir,
      env: buildEnv,
      logPath: join(params.logsDir, "pnpm-ui-build.log"),
      timeoutMs: 30 * 60 * 1000,
    });
  }

  const packDir = join(params.outputDir, "package");
  mkdirSync(packDir, { recursive: true });
  const packJsonPath = join(packDir, "pack.json");
  logPhase("prepare", "package-dist-inventory");
  await writePackageDistInventoryForCandidate({
    sourceDir: params.sourceDir,
    logPath: join(params.logsDir, "pnpm-pack-dry-run.log"),
  });
  const packCommand = resolvePackageCandidatePackCommand(params.sourceDir, packDir);
  logPhase("prepare", packCommand.phase);
  const packResult = await runCommand(packCommand.command, packCommand.args, {
    cwd: params.sourceDir,
    logPath: join(params.logsDir, packCommand.logFileName),
    timeoutMs: 15 * 60 * 1000,
  });
  const packedCandidate = resolvePackedCandidateFromOutput({
    output: packResult.stdout,
    packDir,
    packageJson,
    packCommand,
  });
  writeFileSync(packJsonPath, packedCandidate.packJson, "utf8");

  return {
    sourceDir: params.sourceDir,
    sourceSha,
    candidateVersion: packedCandidate.version,
    candidateTgz: packedCandidate.path,
    candidateFileName: packedCandidate.fileName,
  };
}

export function resolvePackageCandidatePackCommand(sourceDir: string, packDir: string) {
  const packageHelper = join(sourceDir, "scripts", "package-openclaw-for-docker.mjs");
  if (existsSync(packageHelper)) {
    return {
      args: [packageHelper, "--skip-build", "--output-dir", packDir],
      command: process.execPath,
      kind: "docker-helper",
      logFileName: "package-candidate.log",
      phase: "package-candidate",
    };
  }

  return {
    args: ["pack", "--config.ignore-scripts=true", "--json", "--pack-destination", packDir],
    command: pnpmCommand(),
    kind: "pnpm-pack",
    logFileName: "pnpm-pack.log",
    phase: "pnpm-pack",
  };
}

function resolvePackedCandidateFromOutput(params: {
  output: string;
  packDir: string;
  packageJson: PackageJson;
  packCommand: ReturnType<typeof resolvePackageCandidatePackCommand>;
}) {
  if (params.packCommand.kind === "docker-helper") {
    const packOutputLines = params.output.trim().split(/\r?\n/u).filter(Boolean);
    const packedTarball = resolvePackDestinationTarball(
      packOutputLines.at(-1),
      params.packDir,
      "package-openclaw-for-docker",
    );
    return {
      fileName: packedTarball.fileName,
      packJson: `${JSON.stringify(
        {
          filename: packedTarball.fileName,
          path: packedTarball.path,
          version: params.packageJson.version,
        },
        null,
        2,
      )}\n`,
      path: packedTarball.path,
      version: (params.packageJson.version ?? "").trim(),
    };
  }

  const parsedPack = JSON.parse(params.output) as
    | { filename?: string; version?: string }
    | Array<{ filename?: string; version?: string }>;
  const lastPack = Array.isArray(parsedPack) ? parsedPack.at(-1) : parsedPack;
  const packedTarball = resolvePackDestinationTarball(
    lastPack?.filename,
    params.packDir,
    "pnpm pack",
  );
  return {
    fileName: packedTarball.fileName,
    packJson: params.output,
    path: packedTarball.path,
    version: (lastPack?.version ?? params.packageJson.version ?? "").trim(),
  };
}

function normalizeRelativePath(value: string) {
  return value.replace(/\\/gu, "/");
}

function isNotFoundError(error: unknown) {
  return error !== null && typeof error === "object" && "code" in error && error.code === "ENOENT";
}

function isInstallStageDirName(value: string) {
  return INSTALL_STAGE_DEBRIS_DIR_PATTERN.test(value);
}

function collectLegacyPluginDependencyStagingDebrisPaths(packageRoot: string) {
  const rootEntries = readdirSync(packageRoot, { withFileTypes: true });
  const debris: string[] = [];
  for (const rootEntry of rootEntries) {
    if (!rootEntry.isDirectory() || rootEntry.name.toLowerCase() !== "dist") {
      continue;
    }
    const distDir = join(packageRoot, rootEntry.name);
    let distEntries;
    try {
      distEntries = readdirSync(distDir, { withFileTypes: true });
    } catch (error) {
      if (isNotFoundError(error)) {
        continue;
      }
      throw error;
    }
    for (const distEntry of distEntries) {
      if (!distEntry.isDirectory() || distEntry.name.toLowerCase() !== "extensions") {
        continue;
      }
      const extensionsDir = join(distDir, distEntry.name);
      let extensionEntries;
      try {
        extensionEntries = readdirSync(extensionsDir, { withFileTypes: true });
      } catch (error) {
        if (isNotFoundError(error)) {
          continue;
        }
        throw error;
      }

      for (const extensionEntry of extensionEntries) {
        if (!extensionEntry.isDirectory()) {
          continue;
        }
        const extensionPath = join(extensionsDir, extensionEntry.name);
        let stagingEntries;
        try {
          stagingEntries = readdirSync(extensionPath, { withFileTypes: true });
        } catch (error) {
          if (isNotFoundError(error)) {
            continue;
          }
          throw error;
        }
        for (const stagingEntry of stagingEntries) {
          if (isInstallStageDirName(stagingEntry.name)) {
            debris.push(
              normalizeRelativePath(relative(packageRoot, join(extensionPath, stagingEntry.name))),
            );
          }
        }
      }
    }
  }
  return debris.toSorted((left, right) => left.localeCompare(right));
}

function assertNoLegacyPluginDependencyStagingDebris(packageRoot: string) {
  const debris = collectLegacyPluginDependencyStagingDebrisPaths(packageRoot);
  if (debris.length === 0) {
    return;
  }
  throw new Error(
    `unexpected legacy plugin dependency staging debris in package dist: ${debris.join(", ")}`,
  );
}

function isPackagedDistPath(relativePath: string) {
  if (!relativePath.startsWith("dist/")) {
    return false;
  }
  if (relativePath === PACKAGE_DIST_INVENTORY_RELATIVE_PATH) {
    return false;
  }
  if (isLocalBuildMetadataDistPath(relativePath)) {
    return false;
  }
  if (relativePath.endsWith(".map")) {
    return false;
  }
  if (relativePath === "dist/plugin-sdk/.tsbuildinfo") {
    return false;
  }
  if (OMITTED_QA_EXTENSION_PREFIXES.some((prefix) => relativePath.startsWith(prefix))) {
    return false;
  }
  return true;
}

export async function writePackageDistInventoryForCandidate(params: {
  sourceDir: string;
  logPath: string;
}) {
  assertNoLegacyPluginDependencyStagingDebris(params.sourceDir);
  const dryRun = await runCommand(
    pnpmCommand(),
    ["pack", "--dry-run", "--config.ignore-scripts=true", "--json"],
    {
      cwd: params.sourceDir,
      logPath: params.logPath,
      timeoutMs: 5 * 60 * 1000,
    },
  );
  const parsedPack = JSON.parse(dryRun.stdout) as
    | { files?: Array<{ path?: string }> }
    | Array<{ files?: Array<{ path?: string }> }>;
  const lastPack = Array.isArray(parsedPack) ? parsedPack.at(-1) : parsedPack;
  const files = Array.isArray(lastPack?.files) ? lastPack.files : [];
  if (files.length === 0) {
    throw new Error(
      "pnpm pack --dry-run did not report package files for dist inventory generation.",
    );
  }
  const inventory = files
    .flatMap((entry) => {
      const relativePath = normalizeRelativePath((entry.path ?? "").trim());
      return isPackagedDistPath(relativePath) ? [relativePath] : [];
    })
    .toSorted((left, right) => left.localeCompare(right));
  const inventoryPath = join(params.sourceDir, PACKAGE_DIST_INVENTORY_RELATIVE_PATH);
  mkdirSync(dirname(inventoryPath), { recursive: true });
  writeFileSync(inventoryPath, `${JSON.stringify(inventory, null, 2)}\n`, "utf8");
}

function readProvidedCandidate(params: {
  candidateTgz: string;
  candidateVersion: string;
  sourceSha: string;
}): CandidateBuild {
  if (!params.candidateTgz) {
    throw new Error("Missing required --candidate-tgz argument when --source-dir is not provided.");
  }
  if (!existsSync(params.candidateTgz)) {
    throw new Error(`Candidate package not found: ${params.candidateTgz}`);
  }
  if (!params.candidateVersion) {
    throw new Error(
      "Missing required --candidate-version argument when --source-dir is not provided.",
    );
  }
  if (!params.sourceSha) {
    throw new Error("Missing required --source-sha argument when --source-dir is not provided.");
  }
  return {
    sourceDir: "",
    sourceSha: params.sourceSha,
    candidateVersion: params.candidateVersion,
    candidateTgz: params.candidateTgz,
    candidateFileName: params.candidateTgz.split(/[/\\]/u).at(-1) ?? "",
  };
}

async function runFreshLane(params: LaneBaseParams & { build: CandidateBuild }) {
  const lane = createLaneState("fresh");
  const cleanup: Cleanup[] = [];
  try {
    const env = buildLaneEnv(lane, params.providerConfig, params.providerSecretValue);
    await runTimedLanePhase(lane, "install-candidate", async () => {
      await installTarballPackage({
        lane,
        env,
        tgzPath: params.build.candidateTgz,
        logPath: join(params.logsDir, "fresh-install.log"),
        restoreBundledPluginPostinstall: false,
      });
    });
    const installed = readInstalledMetadata(lane.prefixDir);
    verifyInstalledCandidate(installed, params.build);
    await runTimedLanePhase(lane, "run-bundled-plugin-postinstall", async () => {
      await runBundledPluginPostinstall({
        lane,
        env,
        logPath: join(params.logsDir, "fresh-install.log"),
      });
    });

    let browserOverrideImportStatus = "skipped";
    if (shouldRunWindowsInstalledBrowserOverrideImportSmoke()) {
      browserOverrideImportStatus = await runTimedLanePhase(
        lane,
        "windows-browser-override-import",
        async () =>
          runInstalledBrowserOverrideImportSmoke({
            lane,
            env,
            prefixDir: lane.prefixDir,
            logPath: join(params.logsDir, "fresh-windows-browser-override-import.log"),
          }),
      );
    }

    await runTimedLanePhase(lane, "onboard", async () => {
      await runOnboard({
        lane,
        env,
        providerConfig: params.providerConfig,
        logPath: join(params.logsDir, "fresh-onboard.log"),
      });
    });

    await runTimedLanePhase(lane, "models-set", async () => {
      await runModelsSet({
        lane,
        env,
        providerConfig: params.providerConfig,
        logPath: join(params.logsDir, "fresh-models-set.log"),
      });
    });

    const gateway = await runTimedLanePhase(lane, "start-gateway", async () =>
      startGateway({
        lane,
        env,
        logPath: join(params.logsDir, "fresh-gateway.log"),
      }),
    );
    cleanup.push(() => stopGateway(gateway));

    await runTimedLanePhase(lane, "wait-gateway", async () => {
      await waitForGateway({
        lane,
        env,
        logPath: join(params.logsDir, "fresh-gateway-status.log"),
      });
    });

    await runTimedLanePhase(lane, "dashboard", async () => {
      await runDashboardSmoke({
        lane,
        logPath: join(params.logsDir, "fresh-dashboard.log"),
      });
    });

    const agent = await runTimedLanePhase(lane, "agent-turn", async () =>
      runAgentTurn({
        lane,
        env,
        label: "fresh",
        logPath: join(params.logsDir, "fresh-agent.log"),
      }),
    );

    return {
      status: "pass",
      installedVersion: installed.version,
      installedCommit: installed.commit,
      dashboardStatus: "pass",
      gatewayPort: lane.gatewayPort,
      browserOverrideImportStatus,
      agentOutput: trimForSummary(agent.stdout),
      phaseTimings: lane.phaseTimings,
    };
  } finally {
    await runCleanup(cleanup);
  }
}

async function runUpgradeLane(
  params: LaneBaseParams & {
    baselineSpec: string;
    baselineTgz: string;
    build: CandidateBuild;
    candidateUrl: string;
  },
) {
  if (!params.baselineTgz && !params.baselineSpec) {
    throw new Error("Missing required --baseline-tgz argument for upgrade mode.");
  }
  if (!params.candidateUrl) {
    throw new Error("Missing candidate package URL for upgrade mode.");
  }
  const lane = createLaneState("upgrade");
  const cleanup: Cleanup[] = [];
  try {
    const env = buildLaneEnv(lane, params.providerConfig, params.providerSecretValue);
    await runTimedLanePhase(lane, "install-baseline", async () => {
      if (!params.baselineTgz && params.baselineSpec) {
        await installPackageSpec({
          lane,
          env,
          packageSpec: params.baselineSpec,
          logPath: join(params.logsDir, "upgrade-install-baseline.log"),
          ignoreScripts: true,
        });
      } else {
        await installTarballPackage({
          lane,
          env,
          tgzPath: params.baselineTgz,
          logPath: join(params.logsDir, "upgrade-install-baseline.log"),
          ignoreScripts: true,
          restoreBundledPluginPostinstall: false,
        });
      }
    });
    await runTimedLanePhase(lane, "run-baseline-bundled-plugin-postinstall", async () => {
      await runBundledPluginPostinstall({
        lane,
        env,
        logPath: join(params.logsDir, "upgrade-install-baseline.log"),
      });
    });

    const baseline = {
      version: readInstalledVersion(lane.prefixDir),
    };

    const updateEnv = buildRealUpdateEnv(env);
    const updateArgs = buildPackagedUpgradeUpdateArgs(params.candidateUrl);
    const updateLogPath = join(params.logsDir, "upgrade-update.log");
    let updateResult: CommandResult | undefined;
    let usedWindowsPackagedUpgradeTimeoutFallback = false;
    await runTimedLanePhase(lane, "update", async () => {
      try {
        updateResult = await runOpenClaw({
          lane,
          env: updateEnv,
          args: updateArgs,
          logPath: updateLogPath,
          timeoutMs: updateTimeoutMs(),
          check: false,
        });
      } catch (error) {
        if (!isRecoverableWindowsPackagedUpgradeTimeoutError(error, process.platform)) {
          throw error;
        }
        usedWindowsPackagedUpgradeTimeoutFallback = true;
        appendFileSync(
          updateLogPath,
          `\n[release-checks] Windows baseline updater timed out after fetching candidate; falling back to direct candidate install: ${formatError(error)}\n`,
        );
        updateResult = {
          exitCode: 124,
          stdout: "",
          stderr: formatError(error),
        };
      }
    });
    if (!updateResult) {
      throw new Error("Packaged update completed without a command result.");
    }
    const usedWindowsPackagedUpgradeFallback =
      usedWindowsPackagedUpgradeTimeoutFallback ||
      isRecoverableWindowsPackagedUpgradeSwapCleanupFailure(updateResult, process.platform);
    if (usedWindowsPackagedUpgradeFallback) {
      await runTimedLanePhase(lane, "update-fallback-install", async () => {
        await installPackageSpec({
          lane,
          env,
          packageSpec: params.candidateUrl,
          logPath: join(params.logsDir, "upgrade-update-fallback-install.log"),
          ignoreScripts: true,
        });
        const fallbackInstalledVersion = readInstalledVersion(lane.prefixDir);
        verifyWindowsPackagedUpgradeFallbackInstall({
          installedVersion: fallbackInstalledVersion,
          candidateVersion: params.build.candidateVersion,
        });
        appendFileSync(
          updateLogPath,
          `\n[release-checks] Windows fallback install verified candidate version ${fallbackInstalledVersion}\n`,
        );
      });
    } else {
      verifyPackagedUpgradeUpdateResult(updateResult, {
        candidateVersion: params.build.candidateVersion,
      });
    }

    if (
      shouldRunPackagedUpgradeStatusProbe({
        platform: process.platform,
        usedWindowsPackagedUpgradeFallback,
      })
    ) {
      await runTimedLanePhase(lane, "update-status", async () => {
        await runOpenClaw({
          lane,
          env: updateEnv,
          args: ["update", "status", "--json"],
          logPath: join(params.logsDir, "upgrade-update-status.log"),
          timeoutMs: 2 * 60 * 1000,
        });
      });
    }
    await runTimedLanePhase(lane, "run-bundled-plugin-postinstall", async () => {
      await runBundledPluginPostinstall({
        lane,
        env,
        logPath: join(params.logsDir, "upgrade-bundled-plugin-postinstall.log"),
      });
    });

    const installed = readInstalledMetadata(lane.prefixDir);
    verifyInstalledCandidate(installed, params.build);

    await runTimedLanePhase(lane, "onboard", async () => {
      await runOnboard({
        lane,
        env,
        providerConfig: params.providerConfig,
        logPath: join(params.logsDir, "upgrade-onboard.log"),
      });
    });

    await runTimedLanePhase(lane, "models-set", async () => {
      await runModelsSet({
        lane,
        env,
        providerConfig: params.providerConfig,
        logPath: join(params.logsDir, "upgrade-models-set.log"),
      });
    });

    const gateway = await runTimedLanePhase(lane, "start-gateway", async () =>
      startGateway({
        lane,
        env,
        logPath: join(params.logsDir, "upgrade-gateway.log"),
      }),
    );
    cleanup.push(() => stopGateway(gateway));

    await runTimedLanePhase(lane, "wait-gateway", async () => {
      await waitForGateway({
        lane,
        env,
        logPath: join(params.logsDir, "upgrade-gateway-status.log"),
      });
    });

    await runTimedLanePhase(lane, "dashboard", async () => {
      await runDashboardSmoke({
        lane,
        logPath: join(params.logsDir, "upgrade-dashboard.log"),
      });
    });

    const agent = await runTimedLanePhase(lane, "agent-turn", async () =>
      runAgentTurn({
        lane,
        env,
        label: "upgrade",
        logPath: join(params.logsDir, "upgrade-agent.log"),
      }),
    );

    return {
      status: "pass",
      baselineVersion: baseline.version,
      installedVersion: installed.version,
      installedCommit: installed.commit,
      dashboardStatus: "pass",
      gatewayPort: lane.gatewayPort,
      agentOutput: trimForSummary(agent.stdout),
      phaseTimings: lane.phaseTimings,
    };
  } finally {
    await runCleanup(cleanup);
  }
}

async function runInstallerFreshSuite(
  params: LaneBaseParams & { build: CandidateBuild; runDiscordRoundtrip: boolean },
) {
  const lane = createLaneState("installer-fresh");
  const cleanup: Cleanup[] = [];
  const usesManagedGateway = shouldUseManagedGatewayService();
  const useManagedGatewayAfterInstall = shouldUseManagedGatewayForInstallerRuntime();
  const manualGateway: { current: GatewayHandle | null } = { current: null };
  try {
    const env = buildInstallerEnv(lane, params.providerConfig, params.providerSecretValue);
    // Drive the public installer against the exact candidate artifact built from the requested ref.
    const candidateServer = await startStaticFileServer({
      filePath: params.build.candidateTgz,
      logPath: join(params.logsDir, "installer-candidate-http-server.log"),
    });
    cleanup.push(() => candidateServer.close());
    const installTarget = candidateServer.url;
    const installerUrl = resolvePublishedInstallerUrl();

    logLanePhase(lane, "installer-run");
    await runInstallerSmoke({
      lane,
      env,
      installerUrl,
      installTarget,
      logPath: join(params.logsDir, "installer-fresh-install.log"),
    });

    logLanePhase(lane, "fresh-shell");
    const freshShell = await verifyFreshShellCommand({
      lane,
      env,
      expectedNeedle: params.build.candidateVersion,
      logPath: join(params.logsDir, "installer-fresh-shell.log"),
    });
    const installed = readInstalledMetadataFromCliPath(freshShell.cliPath);
    verifyInstalledCandidate(installed, params.build);

    let browserOverrideImportStatus = "skipped";
    if (shouldRunWindowsInstalledBrowserOverrideImportSmoke()) {
      logLanePhase(lane, "windows-browser-override-import");
      browserOverrideImportStatus = await runInstalledBrowserOverrideImportSmoke({
        lane,
        env,
        prefixDir: resolveInstalledPrefixDirFromCliPath(freshShell.cliPath),
        logPath: join(params.logsDir, "installer-fresh-windows-browser-override-import.log"),
      });
    }

    logLanePhase(lane, "onboard");
    await runOnboardWithInstalledCli({
      lane,
      cliPath: freshShell.cliPath,
      env,
      providerConfig: params.providerConfig,
      installDaemon: usesManagedGateway,
      logPath: join(params.logsDir, "installer-fresh-onboard.log"),
    });

    if (shouldExerciseManagedGatewayLifecycleAfterInstall()) {
      await exerciseManagedGatewayLifecycle({
        lane,
        cliPath: freshShell.cliPath,
        env,
        logPrefix: join(params.logsDir, "installer-fresh-gateway"),
      });
    }

    logLanePhase(lane, "models-set");
    await runInstalledModelsSet({
      cliPath: freshShell.cliPath,
      env,
      providerConfig: params.providerConfig,
      cwd: lane.homeDir,
      logPath: join(params.logsDir, "installer-fresh-models-set.log"),
    });

    if (!useManagedGatewayAfterInstall) {
      // Keep the Windows installer lane validating Scheduled Task registration during
      // onboarding and lifecycle commands, but use a manual gateway for the runtime
      // checks after that so the installer validation does not depend on the more
      // failure-prone managed Windows session state for the remainder of the lane.
      if (shouldStopManagedGatewayBeforeManualFallback()) {
        logLanePhase(lane, "gateway-stop-managed");
        await runInstalledCli({
          cliPath: freshShell.cliPath,
          args: ["gateway", "stop"],
          env,
          cwd: lane.homeDir,
          logPath: join(params.logsDir, "installer-fresh-gateway-stop-managed.log"),
          timeoutMs: 2 * 60 * 1000,
          check: false,
        });
        await waitForInstalledGatewayToStop({
          lane,
          cliPath: freshShell.cliPath,
          env,
          logPath: join(params.logsDir, "installer-fresh-gateway-stop-managed-status.log"),
        });
      }
      logLanePhase(lane, "gateway-start");
      const gateway = await startManualGatewayFromInstalledCli({
        lane,
        cliPath: freshShell.cliPath,
        env,
        logPath: join(params.logsDir, "installer-fresh-gateway.log"),
      });
      manualGateway.current = gateway;
      cleanup.push(() => stopGateway(manualGateway.current));
      logLanePhase(lane, "gateway-status");
      await waitForInstalledGateway({
        lane,
        cliPath: freshShell.cliPath,
        env,
        logPath: join(params.logsDir, "installer-fresh-gateway-status.log"),
      });
    }

    logLanePhase(lane, "dashboard");
    await runDashboardSmoke({
      lane,
      logPath: join(params.logsDir, "installer-fresh-dashboard.log"),
    });

    logLanePhase(lane, "agent-turn");
    const agent = await runInstalledAgentTurn({
      cliPath: freshShell.cliPath,
      env,
      cwd: lane.homeDir,
      label: "installer-fresh",
      logPath: join(params.logsDir, "installer-fresh-agent.log"),
    });

    let discordStatus = "skipped";
    if (params.runDiscordRoundtrip && process.platform === "darwin") {
      logLanePhase(lane, "discord-roundtrip");
      discordStatus = await maybeRunDiscordRoundtrip({
        lane,
        cliPath: freshShell.cliPath,
        env,
        gatewayHolder: manualGateway,
        logPath: join(params.logsDir, "installer-fresh-discord.log"),
      });
    }

    return {
      status: "pass",
      installTarget,
      installVersion: installed.version,
      cliPath: freshShell.cliPath,
      installedVersion: installed.version,
      installedCommit: installed.commit,
      gatewayPort: lane.gatewayPort,
      dashboardStatus: "pass",
      browserOverrideImportStatus,
      discordStatus,
      agentOutput: trimForSummary(agent.stdout),
    };
  } finally {
    await runCleanup(cleanup);
  }
}

async function runDevUpdateSuite(
  params: LaneBaseParams & {
    baselineSpec: string;
    ref: string;
    sourceSha: string;
    runDiscordRoundtrip: boolean;
  },
) {
  const lane = createLaneState("dev-update");
  const cleanup: Cleanup[] = [];
  const installTarget = await resolveInstallerTargetVersion({
    baselineSpec: params.baselineSpec,
    logsDir: params.logsDir,
    suiteName: "dev-update",
  });
  const usesManagedGateway = shouldUseManagedGatewayService();
  // Keep dev-update on a manual gateway even on Windows. The packaged lanes
  // already cover the Scheduled Task path, while repaired git installs live in
  // an ephemeral checkout that has proven flaky as a managed service in CI.
  const useManagedGatewayAfterDevUpdate = usesManagedGateway && process.platform !== "win32";
  const requestedRef = resolveExpectedDevUpdateRef(params.ref);
  if (!shouldRunMainChannelDevUpdate(requestedRef)) {
    throw new Error(
      `The dev-update suite only supports main. Received ${normalizeRequestedRef(params.ref) || "<empty>"}.`,
    );
  }
  const verificationRef = resolveDevUpdateVerificationRef(params.ref, params.sourceSha);
  const manualGateway: { current: GatewayHandle | null } = { current: null };
  try {
    const env = buildInstallerEnv(lane, params.providerConfig, params.providerSecretValue);
    const installerUrl = resolvePublishedInstallerUrl();

    logLanePhase(lane, "installer-baseline");
    await runInstallerSmoke({
      lane,
      env,
      installerUrl,
      installTarget,
      logPath: join(params.logsDir, "dev-update-install.log"),
    });

    logLanePhase(lane, "fresh-shell-baseline");
    const baselineShell = await verifyFreshShellCommand({
      lane,
      env,
      expectedNeedle: installTarget,
      logPath: join(params.logsDir, "dev-update-baseline-shell.log"),
    });

    logLanePhase(lane, "update-dev");
    await runInstalledCli({
      cliPath: baselineShell.cliPath,
      args: ["update", "--channel", "dev", "--yes", "--json"],
      env: {
        ...buildRealUpdateEnv(env),
        OPENCLAW_UPDATE_DEV_TARGET_REF: verificationRef,
      },
      cwd: lane.homeDir,
      logPath: join(params.logsDir, "dev-update.log"),
      timeoutMs: updateTimeoutMs(),
    });

    logLanePhase(lane, "fresh-shell-updated");
    const updatedShell = await verifyFreshShellCommand({
      lane,
      env,
      expectedNeedle: "OpenClaw",
      logPath: join(params.logsDir, "dev-update-shell.log"),
    });

    logLanePhase(lane, "update-status");
    const verifiedShell = await ensureDevUpdateGitInstall({
      lane,
      env,
      cliPath: updatedShell.cliPath,
      logsDir: params.logsDir,
      requestedRef: verificationRef,
    });

    if (process.platform === "win32") {
      logLanePhase(lane, "windows-toolchain");
      await verifyWindowsDevUpdateToolchain({
        lane,
        env,
        logPath: join(params.logsDir, "dev-update-windows-toolchain.log"),
      });
    }

    logLanePhase(lane, "onboard");
    await runOnboardWithInstalledCli({
      lane,
      cliPath: verifiedShell.cliPath,
      env,
      providerConfig: params.providerConfig,
      installDaemon: useManagedGatewayAfterDevUpdate,
      logPath: join(params.logsDir, "dev-update-onboard.log"),
    });

    logLanePhase(lane, "models-set");
    await runInstalledModelsSet({
      cliPath: verifiedShell.cliPath,
      env,
      providerConfig: params.providerConfig,
      cwd: lane.homeDir,
      logPath: join(params.logsDir, "dev-update-models-set.log"),
    });

    if (!useManagedGatewayAfterDevUpdate) {
      logLanePhase(lane, "gateway-start");
      const gateway = await startManualGatewayFromInstalledCli({
        lane,
        cliPath: verifiedShell.cliPath,
        env,
        logPath: join(params.logsDir, "dev-update-gateway.log"),
      });
      manualGateway.current = gateway;
      cleanup.push(() => stopGateway(manualGateway.current));
      logLanePhase(lane, "gateway-status");
      await waitForInstalledGateway({
        lane,
        cliPath: verifiedShell.cliPath,
        env,
        logPath: join(params.logsDir, "dev-update-gateway-status.log"),
      });
    } else {
      logLanePhase(lane, "gateway-ready");
      await ensureManagedGatewayReady({
        lane,
        cliPath: verifiedShell.cliPath,
        env,
        logPath: join(params.logsDir, "dev-update-gateway-ready.log"),
      });
    }

    logLanePhase(lane, "dashboard");
    await runDashboardSmoke({
      lane,
      logPath: join(params.logsDir, "dev-update-dashboard.log"),
    });

    logLanePhase(lane, "agent-turn");
    const agent = await runInstalledAgentTurn({
      cliPath: verifiedShell.cliPath,
      env,
      cwd: lane.homeDir,
      label: "dev-update",
      logPath: join(params.logsDir, "dev-update-agent.log"),
    });

    let discordStatus = "skipped";
    if (params.runDiscordRoundtrip && process.platform === "darwin") {
      logLanePhase(lane, "discord-roundtrip");
      discordStatus = await maybeRunDiscordRoundtrip({
        lane,
        cliPath: verifiedShell.cliPath,
        env,
        gatewayHolder: manualGateway,
        logPath: join(params.logsDir, "dev-update-discord.log"),
      });
    }

    return {
      status: "pass",
      installVersion: installTarget,
      cliPath: updatedShell.cliPath,
      gatewayPort: lane.gatewayPort,
      dashboardStatus: "pass",
      discordStatus,
      agentOutput: trimForSummary(agent.stdout),
    };
  } finally {
    await runCleanup(cleanup);
  }
}

function createLaneState(name: string): LaneState {
  const rootDir = mkdtempSync(join(tmpdir(), `openclaw-${name}-`));
  const prefixDir = join(rootDir, "prefix");
  const homeDir = join(rootDir, "home");
  const stateDir = join(homeDir, ".openclaw");
  const appDataDir = process.platform === "win32" ? join(homeDir, "AppData", "Roaming") : stateDir;
  mkdirSync(prefixDir, { recursive: true });
  mkdirSync(homeDir, { recursive: true });
  mkdirSync(stateDir, { recursive: true });
  mkdirSync(appDataDir, { recursive: true });
  if (process.platform !== "win32") {
    writeFileSync(join(homeDir, ".bashrc"), "", "utf8");
    writeFileSync(join(homeDir, ".zshrc"), "", "utf8");
  }
  return {
    name,
    rootDir,
    prefixDir,
    homeDir,
    stateDir,
    appDataDir,
    gatewayPort: 0,
    phaseTimings: [],
  };
}

function buildLaneEnv(
  lane: LaneState,
  providerMeta: ProviderConfig,
  providerSecretValue: string,
): NodeJS.ProcessEnv {
  ensureLocalNpmShim(lane);
  return {
    ...process.env,
    HOME: lane.homeDir,
    USERPROFILE: lane.homeDir,
    APPDATA: lane.appDataDir,
    LOCALAPPDATA: join(lane.homeDir, "AppData", "Local"),
    OPENCLAW_HOME: lane.homeDir,
    OPENCLAW_STATE_DIR: lane.stateDir,
    OPENCLAW_CONFIG_PATH: join(lane.stateDir, "openclaw.json"),
    OPENCLAW_DISABLE_BONJOUR: "1",
    OPENCLAW_DISABLE_BUNDLED_PLUGIN_POSTINSTALL: "1",
    NPM_CONFIG_PREFIX: lane.prefixDir,
    PATH: `${binDirForPrefix(lane.prefixDir)}${process.platform === "win32" ? ";" : ":"}${process.env.PATH ?? ""}`,
    [providerMeta.secretEnv]: providerSecretValue,
  };
}

function buildInstallerEnv(
  lane: LaneState,
  providerMeta: ProviderConfig,
  providerSecretValue: string,
): NodeJS.ProcessEnv {
  const localAppData = join(lane.homeDir, "AppData", "Local");
  mkdirSync(localAppData, { recursive: true });
  return {
    ...process.env,
    HOME: lane.homeDir,
    USERPROFILE: lane.homeDir,
    APPDATA: lane.appDataDir,
    LOCALAPPDATA: localAppData,
    OPENCLAW_HOME: lane.homeDir,
    OPENCLAW_STATE_DIR: lane.stateDir,
    OPENCLAW_CONFIG_PATH: join(lane.stateDir, "openclaw.json"),
    OPENCLAW_DISABLE_BONJOUR: "1",
    OPENCLAW_NO_ONBOARD: "1",
    OPENCLAW_NO_PROMPT: "1",
    CI: "1",
    NODE_OPTIONS: "--max-old-space-size=8192",
    [providerMeta.secretEnv]: providerSecretValue,
  };
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

function shouldRunBundledPluginPostinstall(_options?: { lane?: LaneState }) {
  return true;
}

function looksLikeCommitSha(ref: string) {
  return /^[0-9a-f]{7,40}$/iu.test(ref.trim());
}

function resolveExpectedDevUpdateRef(ref?: string) {
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

async function resolveInstallerTargetVersion(params: {
  baselineSpec: string;
  logsDir: string;
  suiteName: string;
}) {
  const resolvedVersion = resolveExplicitBaselineVersion(params.baselineSpec);
  if (resolvedVersion) {
    return resolvedVersion;
  }
  const latestResult = await runCommand(npmCommand(), ["view", "openclaw@latest", "version"], {
    logPath: join(params.logsDir, `${params.suiteName}-latest-version.log`),
    timeoutMs: 2 * 60 * 1000,
  });
  const latestVersion = latestResult.stdout.trim();
  if (!latestVersion) {
    throw new Error("npm view openclaw@latest version did not return a version.");
  }
  return latestVersion;
}

function powerShellSingleQuote(value: string) {
  return value.replace(/'/gu, "''");
}

function readPackageJson(packageRoot: string): PackageJson {
  return JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")) as PackageJson;
}

function packageJsonHasScript(packageJson: PackageJson, scriptName: string) {
  return typeof packageJson?.scripts?.[scriptName] === "string";
}

export function packageHasScript(packageRoot: string, scriptName: string) {
  try {
    return packageJsonHasScript(readPackageJson(packageRoot), scriptName);
  } catch {
    return false;
  }
}

function parseMarkerLine(output: string, marker: string) {
  return output
    .split(/\r?\n/gu)
    .find((line) => line.startsWith(marker))
    ?.slice(marker.length)
    .trim();
}

export function normalizeWindowsInstalledCliPath(cliPath: string) {
  return normalizeWindowsCommandShimPath(cliPath);
}

export function normalizeWindowsCommandShimPath(commandPath: string) {
  if (typeof commandPath !== "string") {
    return commandPath;
  }
  return commandPath.replace(/\.ps1$/iu, ".cmd");
}

export function resolveInstalledPrefixDirFromCliPath(cliPath: string, platform = process.platform) {
  const resolvedCliPath =
    platform === "win32" ? normalizeWindowsInstalledCliPath(cliPath) : cliPath;
  if (!resolvedCliPath?.trim()) {
    throw new Error("Missing installed CLI path.");
  }
  if (platform === "win32") {
    return pathWin32.dirname(resolvedCliPath);
  }
  return dirname(dirname(resolvedCliPath));
}

function readInstalledMetadataFromCliPath(cliPath: string, platform = process.platform) {
  return readInstalledMetadataFromPackageRoot(
    resolveInstalledPackageRootFromCliPath(cliPath, platform),
  );
}

export function resolveCommandSpawnInvocation(
  command: string,
  args: string[],
  options: { platform?: NodeJS.Platform; comSpec?: string; env?: NodeJS.ProcessEnv } = {
    platform: process.platform,
  },
) {
  const platform = options.platform ?? process.platform;
  if (platform === "win32" && /\.(cmd|bat)$/iu.test(command)) {
    return {
      command: options.comSpec ?? resolveWindowsCmdExePath(options.env ?? process.env),
      args: ["/d", "/s", "/c", buildCmdExeCommandLine(command, args)],
      shell: false,
      windowsVerbatimArguments: true,
    };
  }
  return { command, args, shell: false };
}

export function resolveInstalledCliInvocation(
  cliPath: string,
  args: string[] = [],
  options: { platform?: NodeJS.Platform; comSpec?: string; env?: NodeJS.ProcessEnv } = {
    platform: process.platform,
  },
) {
  const platform = options.platform ?? process.platform;
  if (platform !== "win32") {
    return { command: cliPath, args, shell: false };
  }
  const normalizedCliPath = normalizeWindowsInstalledCliPath(cliPath);
  if (!/\.cmd$/iu.test(normalizedCliPath)) {
    return { command: normalizedCliPath, args, shell: false };
  }
  const entryPath = installedEntryPath(
    resolveInstalledPrefixDirFromCliPath(normalizedCliPath, platform),
  );
  if (existsSync(entryPath)) {
    return {
      command: process.execPath,
      args: [entryPath, ...args],
      shell: false,
    };
  }
  return resolveCommandSpawnInvocation(normalizedCliPath, args, {
    comSpec: options.comSpec,
    env: options.env,
    platform,
  });
}

async function runPosixShellScript(script: string, options: CommandOptions) {
  return runCommand("/bin/bash", ["-lc", script], options);
}

async function runPowerShellScript(script: string, options: CommandOptions) {
  return runCommand(
    "powershell.exe",
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script],
    options,
  );
}

async function runInstallerSmoke(params: {
  lane: LaneState;
  env: NodeJS.ProcessEnv;
  installerUrl: string;
  installTarget: string;
  logPath: string;
}) {
  if (process.platform === "win32") {
    const script = `
$response = Invoke-WebRequest -UseBasicParsing '${powerShellSingleQuote(params.installerUrl)}'
$content = $response.Content
if ($content -is [byte[]]) {
  $content = [System.Text.Encoding]::UTF8.GetString($content)
}
& ([scriptblock]::Create([string]$content)) -Tag '${powerShellSingleQuote(params.installTarget)}' -NoOnboard
`;
    await runPowerShellScript(script, {
      cwd: params.lane.homeDir,
      env: params.env,
      logPath: params.logPath,
      timeoutMs: installTimeoutMs(),
    });
    return;
  }

  const script = [
    "set -euo pipefail",
    `curl -fsSL '${shellEscapeForSh(params.installerUrl)}' | bash -s -- --version '${shellEscapeForSh(params.installTarget)}' --no-onboard`,
  ].join("\n");
  await runPosixShellScript(script, {
    cwd: params.lane.homeDir,
    env: params.env,
    logPath: params.logPath,
    timeoutMs: installTimeoutMs(),
  });
}

export function buildWindowsPathBootstrapScript(
  options: { includeCurrentProcessPath?: boolean } = {},
) {
  const includeCurrentProcessPath = options.includeCurrentProcessPath !== false;
  const pathCandidates = includeCurrentProcessPath
    ? "@($userPath, $machinePath, $env:Path)"
    : "@($userPath, $machinePath)";
  return `
$machinePath = [Environment]::GetEnvironmentVariable('Path', 'Machine')
$userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
$segments = New-Object System.Collections.Generic.List[string]
foreach ($candidate in ${pathCandidates}) {
  foreach ($segment in ($candidate -split ';')) {
    if ([string]::IsNullOrWhiteSpace($segment)) {
      continue
    }
    if (-not $segments.Contains($segment)) {
      $segments.Add($segment)
    }
  }
}
$env:Path = [string]::Join(';', $segments)
`.trim();
}

export function buildWindowsFreshShellVersionCheckScript(params: { expectedNeedle?: string } = {}) {
  const expectedNeedle = powerShellSingleQuote(params.expectedNeedle ?? "");
  return `
${buildWindowsPathBootstrapScript()}
$commandPath = $null
$npmCommand = Get-Command npm.cmd -ErrorAction SilentlyContinue
if ($null -eq $npmCommand) {
  $npmCommand = Get-Command npm -ErrorAction SilentlyContinue
}
if ($null -ne $npmCommand) {
  $npmPrefix = (& $npmCommand.Source config get prefix 2>$null | Out-String).Trim()
  if (-not [string]::IsNullOrWhiteSpace($npmPrefix)) {
    $env:Path = "$npmPrefix;$env:Path"
    foreach ($candidate in @(
      (Join-Path $npmPrefix 'openclaw.cmd'),
      (Join-Path $npmPrefix 'openclaw.ps1')
    )) {
      if (Test-Path -LiteralPath $candidate) {
        $commandPath = $candidate
        break
      }
    }
  }
}
if ([string]::IsNullOrWhiteSpace($commandPath)) {
  $cmd = Get-Command openclaw -ErrorAction Stop
  $commandPath = $cmd.Source
}
if ($commandPath -match '(?i)\\.ps1$') {
  $cmdPath = [System.IO.Path]::ChangeExtension($commandPath, '.cmd')
  if (Test-Path -LiteralPath $cmdPath) {
    $commandPath = $cmdPath
  }
}
$version = (& $commandPath --version 2>&1 | Out-String).Trim()
Write-Output "__OPENCLAW_PATH__=$commandPath"
Write-Output $version
if ('${expectedNeedle}'.Length -gt 0 -and $version -notmatch [regex]::Escape('${expectedNeedle}')) {
  throw "version mismatch: expected substring ${expectedNeedle}"
}
`.trim();
}

export function buildWindowsDevUpdateToolchainCheckScript() {
  return `
${buildWindowsPathBootstrapScript()}
function Resolve-CommandPath([string]$Name) {
  $command = Get-Command $Name -ErrorAction SilentlyContinue
  if ($null -eq $command) {
    return $null
  }
  $commandPath = $command.Source
  if ($commandPath -match '(?i)\\.ps1$') {
    $cmdPath = [System.IO.Path]::ChangeExtension($commandPath, '.cmd')
    if (Test-Path -LiteralPath $cmdPath) {
      $commandPath = $cmdPath
    }
  }
  return $commandPath
}
$pnpmPath = Resolve-CommandPath 'pnpm'
if ($null -ne $pnpmPath) {
  Write-Output "__UPDATE_TOOL__=pnpm"
  Write-Output "__UPDATE_TOOL_PATH__=$pnpmPath"
  & $pnpmPath --version
  return
}
$corepackPath = Resolve-CommandPath 'corepack'
if ($null -ne $corepackPath) {
  Write-Output "__UPDATE_TOOL__=corepack"
  Write-Output "__UPDATE_TOOL_PATH__=$corepackPath"
  & $corepackPath --version
  return
}
$npmPath = Resolve-CommandPath 'npm'
if ($null -ne $npmPath) {
  Write-Output "__UPDATE_TOOL__=npm"
  Write-Output "__UPDATE_TOOL_PATH__=$npmPath"
  & $npmPath --version
  return
}
throw 'Neither pnpm, corepack, nor npm is discoverable from the reconstructed Windows PATH.'
`.trim();
}

async function verifyFreshShellCommand(params: {
  lane: LaneState;
  env: NodeJS.ProcessEnv;
  expectedNeedle: string;
  logPath: string;
}) {
  if (process.platform === "win32") {
    const script = buildWindowsFreshShellVersionCheckScript({
      expectedNeedle: params.expectedNeedle,
    });
    const result = await runPowerShellScript(script, {
      cwd: params.lane.homeDir,
      env: params.env,
      logPath: params.logPath,
      timeoutMs: 2 * 60 * 1000,
    });
    const cliPath = normalizeWindowsInstalledCliPath(
      parseMarkerLine(result.stdout, "__OPENCLAW_PATH__=") ?? "",
    );
    if (!cliPath) {
      throw new Error("Failed to resolve installed openclaw path from fresh Windows shell.");
    }
    return {
      cliPath,
      versionOutput: `${result.stdout}\n${result.stderr}`.trim(),
    };
  }

  const script = [
    "set -euo pipefail",
    'if [ -f "$HOME/.bashrc" ]; then . "$HOME/.bashrc"; fi',
    "command -v openclaw >/dev/null 2>&1",
    'printf "__OPENCLAW_PATH__=%s\\n" "$(command -v openclaw)"',
    "openclaw --version",
  ].join("\n");
  const result = await runPosixShellScript(script, {
    cwd: params.lane.homeDir,
    env: params.env,
    logPath: params.logPath,
    timeoutMs: 2 * 60 * 1000,
  });
  const cliPath = parseMarkerLine(result.stdout, "__OPENCLAW_PATH__=");
  const versionOutput = `${result.stdout}\n${result.stderr}`.trim();
  if (!cliPath) {
    throw new Error("Failed to resolve installed openclaw path from fresh POSIX shell.");
  }
  if (params.expectedNeedle && !versionOutput.includes(params.expectedNeedle)) {
    throw new Error(
      `Installed CLI version did not contain expected substring ${params.expectedNeedle}.`,
    );
  }
  return { cliPath, versionOutput };
}

async function runInstalledCli(params: {
  cliPath: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  logPath: string;
  timeoutMs?: number;
  check?: boolean;
}) {
  const invocation = resolveInstalledCliInvocation(params.cliPath, params.args, {
    env: params.env,
    platform: process.platform,
  });
  return runCommandInvocation(invocation, {
    cwd: params.cwd,
    env: params.env,
    logPath: params.logPath,
    timeoutMs: params.timeoutMs,
    check: params.check ?? true,
  });
}

async function readInstalledUpdateStatus(params: {
  cliPath: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  logPath: string;
}) {
  return runInstalledCli({
    cliPath: params.cliPath,
    args: ["update", "status", "--json"],
    cwd: params.cwd,
    env: params.env,
    logPath: params.logPath,
    timeoutMs: 2 * 60 * 1000,
  });
}

async function ensureDevUpdateGitInstall(params: {
  lane: LaneState;
  env: NodeJS.ProcessEnv;
  cliPath: string;
  logsDir: string;
  requestedRef: string;
}) {
  const updateStatus = await readInstalledUpdateStatus({
    cliPath: params.cliPath,
    cwd: params.lane.homeDir,
    env: params.env,
    logPath: join(params.logsDir, "dev-update-status.log"),
  });
  // The dev-update lane must prove that `openclaw update --channel dev` landed on
  // the expected git checkout. Falling back to a manual repair here would hide
  // updater regressions and turn the suite into a false green.
  verifyDevUpdateStatus(updateStatus.stdout, { ref: params.requestedRef });
  return { cliPath: params.cliPath };
}

async function runOnboardWithInstalledCli(params: {
  lane: LaneState;
  cliPath: string;
  env: NodeJS.ProcessEnv;
  providerConfig: ProviderConfig;
  installDaemon: boolean;
  logPath: string;
}) {
  await withAllocatedGatewayPort(params.lane, async () => {
    const args = buildReleaseOnboardArgs({
      authChoice: params.providerConfig.authChoice,
      gatewayPort: params.lane.gatewayPort,
      installDaemon: params.installDaemon,
      skipHealth: !params.installDaemon || shouldSkipInstallerDaemonHealthCheck(),
    });
    await runInstalledCli({
      cliPath: params.cliPath,
      args,
      cwd: params.lane.homeDir,
      env: params.env,
      logPath: params.logPath,
      timeoutMs: 10 * 60 * 1000,
    });
  });
}

export function buildReleaseOnboardArgs(params: {
  authChoice: string;
  gatewayPort: number;
  installDaemon?: boolean;
  skipHealth?: boolean;
}) {
  const args: string[] = [
    "onboard",
    "--non-interactive",
    "--mode",
    "local",
    "--auth-choice",
    params.authChoice,
    "--secret-input-mode",
    "ref",
    "--gateway-port",
    String(params.gatewayPort),
    "--gateway-bind",
    "loopback",
    "--skip-skills",
    "--skip-bootstrap",
    "--accept-risk",
    "--json",
  ];
  if (params.installDaemon) {
    args.push("--install-daemon");
  }
  if (params.skipHealth) {
    args.push("--skip-health");
  }
  return args;
}

async function startManualGatewayFromInstalledCli(params: {
  lane: LaneState;
  cliPath: string;
  env: NodeJS.ProcessEnv;
  logPath: string;
}): Promise<GatewayHandle> {
  mkdirSync(dirname(params.logPath), { recursive: true });
  const gatewayLog = createWriteStream(params.logPath, { flags: "a" });
  const invocation = resolveInstalledCliInvocation(
    params.cliPath,
    ["gateway", "run", "--bind", "loopback", "--port", String(params.lane.gatewayPort), "--force"],
    {
      env: params.env,
      platform: process.platform,
    },
  );
  const child = spawn(invocation.command, invocation.args, {
    cwd: params.lane.homeDir,
    env: params.env,
    shell: invocation.shell,
    stdio: ["ignore", "pipe", "pipe"],
    windowsVerbatimArguments: invocation.windowsVerbatimArguments,
    windowsHide: true,
  });
  child.stdout?.on("data", (chunk) => {
    gatewayLog.write(chunk);
  });
  child.stderr?.on("data", (chunk) => {
    gatewayLog.write(chunk);
  });
  let logClosed = false;
  const closeLog = async () => {
    if (logClosed) {
      return;
    }
    logClosed = true;
    await new Promise<void>((resolvePromise) => {
      gatewayLog.once("error", () => resolvePromise());
      gatewayLog.end(() => resolvePromise());
    });
  };
  child.once("close", () => {
    void closeLog();
  });
  child.once("error", () => {
    void closeLog();
  });
  return { child, closeLog, logPath: params.logPath };
}

async function resolveInstalledGatewayStatusArgs(params: {
  cliPath: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  logPath: string;
  requireRpc?: boolean;
}) {
  const requireRpc = params.requireRpc !== false;
  try {
    const help = await runInstalledCli({
      cliPath: params.cliPath,
      args: ["gateway", "status", "--help"],
      cwd: params.cwd,
      env: params.env,
      logPath: params.logPath,
      timeoutMs: 15_000,
      check: false,
    });
    return buildGatewayStatusArgsFromHelpText(`${help.stdout}\n${help.stderr}`, { requireRpc });
  } catch (error) {
    appendGatewayStatusHelpProbeFallback(params.logPath, error);
    return buildGatewayStatusArgsFromHelpText("--require-rpc", { requireRpc });
  }
}

export function buildGatewayStatusArgsFromHelpText(
  helpText: string,
  options: { requireRpc?: boolean } = {},
) {
  const requireRpc = options.requireRpc !== false;
  if (requireRpc && helpText.includes("--require-rpc")) {
    return [
      "gateway",
      "status",
      "--require-rpc",
      "--timeout",
      String(CROSS_OS_GATEWAY_STATUS_RPC_TIMEOUT_MS),
    ];
  }
  return ["gateway", "status"];
}

function appendGatewayStatusHelpProbeFallback(logPath: string, error: unknown) {
  appendFileSync(
    logPath,
    `${new Date().toISOString()} gateway status help probe failed; assuming current --require-rpc support: ${formatError(error)}\n`,
  );
}

export async function canConnectToLoopbackPort(port: number, timeoutMs = 1_000) {
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    return false;
  }
  return await new Promise<boolean>((resolvePromise) => {
    let settled = false;
    const socket = createNetConnection({
      host: "127.0.0.1",
      port,
    });
    const settle = (value: boolean) => {
      if (settled) {
        return;
      }
      settled = true;
      socket.destroy();
      resolvePromise(value);
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => settle(true));
    socket.once("timeout", () => settle(false));
    socket.once("error", () => settle(false));
  });
}

async function waitForInstalledGateway(params: {
  lane: LaneState;
  cliPath: string;
  env: NodeJS.ProcessEnv;
  logPath: string;
}) {
  const statusArgs = await resolveInstalledGatewayStatusArgs({
    cliPath: params.cliPath,
    cwd: params.lane.homeDir,
    env: params.env,
    logPath: params.logPath,
  });
  const deadline = Date.now() + gatewayReadyDeadlineMs();
  while (Date.now() < deadline) {
    const result = await runInstalledCli({
      cliPath: params.cliPath,
      args: statusArgs,
      cwd: params.lane.homeDir,
      env: params.env,
      logPath: params.logPath,
      timeoutMs: CROSS_OS_GATEWAY_STATUS_COMMAND_TIMEOUT_MS,
      check: false,
    });
    if (result.exitCode === 0) {
      return;
    }
    await sleep(2_000);
  }
  throw new Error(`Gateway did not become ready on port ${params.lane.gatewayPort}.`);
}

async function waitForInstalledGatewayToStop(params: {
  lane: LaneState;
  cliPath: string;
  env: NodeJS.ProcessEnv;
  logPath: string;
}) {
  const statusArgs = await resolveInstalledGatewayStatusArgs({
    cliPath: params.cliPath,
    cwd: params.lane.homeDir,
    env: params.env,
    logPath: params.logPath,
    requireRpc: false,
  });
  const deadline = Date.now() + gatewayReadyDeadlineMs();
  while (Date.now() < deadline) {
    await runInstalledCli({
      cliPath: params.cliPath,
      args: statusArgs,
      cwd: params.lane.homeDir,
      env: params.env,
      logPath: params.logPath,
      timeoutMs: CROSS_OS_GATEWAY_STATUS_COMMAND_TIMEOUT_MS,
      check: false,
    });
    const portReachable = await canConnectToLoopbackPort(params.lane.gatewayPort);
    if (!portReachable) {
      return;
    }
    await sleep(2_000);
  }
  throw new Error(
    `Managed gateway did not stop on port ${params.lane.gatewayPort} before manual fallback.`,
  );
}

async function ensureManagedGatewayReady(params: {
  lane: LaneState;
  cliPath: string;
  env: NodeJS.ProcessEnv;
  logPath: string;
}) {
  try {
    await waitForInstalledGateway(params);
    return;
  } catch {
    await runInstalledCli({
      cliPath: params.cliPath,
      args: ["gateway", "start"],
      cwd: params.lane.homeDir,
      env: params.env,
      logPath: params.logPath,
      timeoutMs: 2 * 60 * 1000,
      check: false,
    });
  }
  await waitForInstalledGateway(params);
}

async function runInstalledModelsSet(params: {
  cliPath: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  providerConfig: ProviderConfig;
  logPath: string;
}) {
  await runInstalledCli({
    cliPath: params.cliPath,
    args: ["models", "set", params.providerConfig.model],
    cwd: params.cwd,
    env: params.env,
    logPath: params.logPath,
    timeoutMs: 2 * 60 * 1000,
  });
  const providerConfigOverride = buildReleaseProviderConfigOverride(params.providerConfig);
  if (providerConfigOverride) {
    await runInstalledCli({
      cliPath: params.cliPath,
      args: [
        "config",
        "set",
        `models.providers.${params.providerConfig.extensionId}`,
        JSON.stringify(providerConfigOverride),
        "--strict-json",
        "--merge",
      ],
      cwd: params.cwd,
      env: params.env,
      logPath: params.logPath,
      timeoutMs: 2 * 60 * 1000,
    });
  }
  await runInstalledCli({
    cliPath: params.cliPath,
    args: [
      "config",
      "set",
      "plugins.allow",
      JSON.stringify(buildCrossOsReleaseSmokePluginAllowlist(params.providerConfig)),
      "--strict-json",
    ],
    cwd: params.cwd,
    env: params.env,
    logPath: params.logPath,
    timeoutMs: 2 * 60 * 1000,
  });
  await runInstalledCli({
    cliPath: params.cliPath,
    args: buildCrossOsReleaseSmokeMemorySlotConfigArgs(),
    cwd: params.cwd,
    env: params.env,
    logPath: params.logPath,
    timeoutMs: 2 * 60 * 1000,
  });
  await runInstalledCli({
    cliPath: params.cliPath,
    args: ["config", "set", "agents.defaults.skipBootstrap", "true", "--strict-json"],
    cwd: params.cwd,
    env: params.env,
    logPath: params.logPath,
    timeoutMs: 2 * 60 * 1000,
  });
  await runInstalledCli({
    cliPath: params.cliPath,
    args: ["config", "set", "tools.profile", CROSS_OS_RELEASE_SMOKE_TOOLS_PROFILE],
    cwd: params.cwd,
    env: params.env,
    logPath: params.logPath,
    timeoutMs: 2 * 60 * 1000,
  });
}

async function runInstalledAgentTurn(params: {
  cliPath: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  label: string;
  logPath: string;
}): Promise<AgentTurnResult> {
  let lastError;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const sessionId = buildCrossOsReleaseAgentSessionId(params.label, attempt);
    try {
      const logOffset = readLogFileSize(params.logPath);
      const result = await runInstalledCli({
        cliPath: params.cliPath,
        args: buildReleaseAgentTurnArgs(sessionId),
        cwd: params.cwd,
        env: params.env,
        logPath: params.logPath,
        timeoutMs: (CROSS_OS_AGENT_TURN_TIMEOUT_SECONDS + 60) * 1000,
      });
      const logText = readLogTextSince(params.logPath, logOffset);
      if (!agentOutputHasExpectedOkMarker(result.stdout, { logText })) {
        throw new Error("Agent output did not contain the expected OK marker.");
      }
      if (agentTurnUsedEmbeddedFallback(result, { logText })) {
        throw new Error("Agent turn used embedded fallback instead of gateway.");
      }
      return result;
    } catch (error) {
      lastError = error;
      const skipped = maybeBuildOptionalAgentTurnSkipResult(error, params.logPath, {
        attempt,
        maxAttempts: 2,
      });
      if (skipped) {
        return skipped;
      }
      if (attempt >= 2 || !shouldRetryCrossOsAgentTurnError(error)) {
        throw error;
      }
      appendFileSync(
        params.logPath,
        `\n[release-checks] retrying installed agent turn after retryable live failure: ${
          error instanceof Error ? error.message : String(error)
        }\n`,
      );
    }
  }
  throw lastError;
}

export function verifyDevUpdateStatus(stdout: string, options: { ref?: string } = {}) {
  let payload;
  try {
    payload = JSON.parse(stdout) as {
      update?: { installKind?: string; git?: { branch?: string; sha?: string } };
      channel?: { value?: string; channel?: string };
      installKind?: string;
      git?: { branch?: string; sha?: string };
    };
  } catch {
    payload = null;
  }
  const expectedRef = resolveExpectedDevUpdateRef(options.ref);
  const update = payload?.update ?? payload;
  const installKind = update?.installKind ?? null;
  const branch = update?.git?.branch ?? null;
  const sha = update?.git?.sha ?? null;
  const channelValue = payload?.channel?.value ?? payload?.channel?.channel ?? null;
  if (installKind !== "git") {
    throw new Error(
      `Dev update did not land on a git install. Found ${installKind ?? "<missing>"}.`,
    );
  }
  if (channelValue !== "dev") {
    throw new Error(
      `Dev update status did not report channel=dev. Found ${channelValue ?? "<missing>"}.`,
    );
  }
  if (looksLikeCommitSha(expectedRef)) {
    const normalizedSha = typeof sha === "string" ? sha.toLowerCase() : "";
    const normalizedExpectedRef = expectedRef.toLowerCase();
    if (!normalizedSha || !normalizedSha.startsWith(normalizedExpectedRef)) {
      throw new Error(
        `Dev update status did not report sha=${expectedRef}. Found ${sha ?? "<missing>"}.`,
      );
    }
    return;
  }
  if (branch !== expectedRef) {
    throw new Error(
      `Dev update status did not report branch=${expectedRef}. Found ${branch ?? "<missing>"}.`,
    );
  }
}

async function verifyWindowsDevUpdateToolchain(params: {
  lane: LaneState;
  env: NodeJS.ProcessEnv;
  logPath: string;
}) {
  const script = buildWindowsDevUpdateToolchainCheckScript();
  const result = await runPowerShellScript(script, {
    cwd: params.lane.homeDir,
    env: params.env,
    logPath: params.logPath,
    timeoutMs: 2 * 60 * 1000,
  });
  if (!parseMarkerLine(result.stdout, "__UPDATE_TOOL__=")) {
    throw new Error(
      "No Windows update bootstrap tool (pnpm, corepack, or npm) was discoverable after the dev update.",
    );
  }
}

export function buildDiscordSmokeGuildsConfig(guildId: string, channelId: string) {
  return {
    [guildId]: {
      channels: {
        [channelId]: {
          enabled: true,
          requireMention: false,
        },
      },
    },
  };
}

async function configureDiscordSmoke(params: {
  lane: LaneState;
  cliPath: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  gatewayHolder?: { current: GatewayHandle | null };
  logPath: string;
  token: string;
  guildId: string;
  channelId: string;
}) {
  const guildsJson = JSON.stringify(
    buildDiscordSmokeGuildsConfig(params.guildId, params.channelId),
  );
  await runInstalledCli({
    cliPath: params.cliPath,
    args: [
      "config",
      "set",
      "channels.discord.token",
      "--ref-provider",
      "default",
      "--ref-source",
      "env",
      "--ref-id",
      "DISCORD_BOT_TOKEN",
    ],
    cwd: params.cwd,
    env: { ...params.env, DISCORD_BOT_TOKEN: params.token },
    logPath: params.logPath,
    timeoutMs: 2 * 60 * 1000,
  });
  await runInstalledCli({
    cliPath: params.cliPath,
    args: ["config", "set", "channels.discord.enabled", "true"],
    cwd: params.cwd,
    env: params.env,
    logPath: params.logPath,
    timeoutMs: 2 * 60 * 1000,
  });
  await runInstalledCli({
    cliPath: params.cliPath,
    args: ["config", "set", "channels.discord.groupPolicy", "allowlist"],
    cwd: params.cwd,
    env: params.env,
    logPath: params.logPath,
    timeoutMs: 2 * 60 * 1000,
  });
  await runInstalledCli({
    cliPath: params.cliPath,
    args: ["config", "set", "channels.discord.guilds", guildsJson, "--strict-json"],
    cwd: params.cwd,
    env: params.env,
    logPath: params.logPath,
    timeoutMs: 2 * 60 * 1000,
  });
  if (!shouldUseManagedGatewayService()) {
    const gatewayEnv = { ...params.env, DISCORD_BOT_TOKEN: params.token };
    if (params.gatewayHolder?.current) {
      await stopGateway(params.gatewayHolder.current);
      params.gatewayHolder.current = null;
    }
    const gateway = await startManualGatewayFromInstalledCli({
      lane: params.lane,
      cliPath: params.cliPath,
      env: gatewayEnv,
      logPath: join(params.cwd, `.openclaw/logs/${params.lane.name}-discord-gateway.log`),
    });
    if (params.gatewayHolder) {
      params.gatewayHolder.current = gateway;
    }
    await waitForInstalledGateway({
      lane: params.lane,
      cliPath: params.cliPath,
      env: gatewayEnv,
      logPath: params.logPath,
    });
    return;
  }
  await runInstalledCli({
    cliPath: params.cliPath,
    args: ["gateway", "restart"],
    cwd: params.cwd,
    env: { ...params.env, DISCORD_BOT_TOKEN: params.token },
    logPath: params.logPath,
    timeoutMs: 2 * 60 * 1000,
    check: false,
  });
  await ensureManagedGatewayReady({
    lane: params.lane,
    cliPath: params.cliPath,
    env: { ...params.env, DISCORD_BOT_TOKEN: params.token },
    logPath: params.logPath,
  });
}

export async function readBoundedCrossOsResponseText(
  response: Response,
  maxChars = CROSS_OS_FETCH_BODY_MAX_CHARS,
  options: { signal?: AbortSignal | null } = {},
): Promise<string> {
  if (!response.body) {
    return "";
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  let truncated = false;
  let aborted = false;

  try {
    while (text.length <= maxChars) {
      const { done, value } = await readCrossOsResponseChunk(reader, options.signal);
      if (done) {
        text += decoder.decode();
        break;
      }

      text += decoder.decode(value, { stream: true });
      if (text.length > maxChars) {
        text = text.slice(0, maxChars);
        truncated = true;
        break;
      }
    }
  } catch (error) {
    aborted = options.signal?.aborted === true;
    throw error;
  } finally {
    if (truncated || aborted) {
      await reader.cancel().catch(() => undefined);
    } else {
      reader.releaseLock();
    }
  }

  return truncated ? `${text}\n[truncated]` : text;
}

function readCrossOsResponseChunk(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  signal?: AbortSignal | null,
): Promise<ReadableStreamReadResult<Uint8Array>> {
  if (!signal) {
    return reader.read();
  }
  if (signal.aborted) {
    throw crossOsAbortReason(signal);
  }
  return new Promise((resolveRead, rejectRead) => {
    const onAbort = () => rejectRead(crossOsAbortReason(signal));
    signal.addEventListener("abort", onAbort, { once: true });
    reader
      .read()
      .then(resolveRead, rejectRead)
      .finally(() => {
        signal.removeEventListener("abort", onAbort);
      });
  });
}

function crossOsAbortReason(signal: AbortSignal): Error {
  const reason = signal.reason;
  if (reason instanceof Error) {
    return reason;
  }
  return new Error(typeof reason === "string" ? reason : "The operation was aborted.");
}

export function dashboardHtmlMarkerStatus(html: string): {
  app: boolean;
  ready: boolean;
  title: boolean;
} {
  const title = html.includes("<title>OpenClaw Control</title>");
  const app = html.includes("<openclaw-app></openclaw-app>");
  return { app, ready: title && app, title };
}

export function resolveDashboardAssetUrls(dashboardUrl: string, html: string): string[] {
  const baseUrl = new URL(dashboardUrl);
  const assetUrls = new Set<string>();
  const assetAttributePattern = /<(?:script|link)\b[^>]*(?:src|href)\s*=\s*(["'])([^"']+)\1/giu;
  for (const match of html.matchAll(assetAttributePattern)) {
    const rawUrl = match[2]?.trim();
    if (!rawUrl) {
      continue;
    }
    const assetUrl = new URL(rawUrl, baseUrl);
    if (assetUrl.origin === baseUrl.origin && assetUrl.pathname.includes("/assets/")) {
      assetUrls.add(assetUrl.href);
    }
  }
  return [...assetUrls].toSorted();
}

export async function verifyDashboardAssetUrls(
  assetUrls: string[],
  fetchAsset: typeof fetch = fetch,
): Promise<{ failures: string[]; ok: boolean }> {
  if (assetUrls.length === 0) {
    return { failures: ["no dashboard asset URLs found"], ok: false };
  }
  const failures: string[] = [];
  for (const assetUrl of assetUrls) {
    try {
      const response = await fetchAsset(assetUrl, {
        signal: AbortSignal.timeout(CROSS_OS_DASHBOARD_FETCH_TIMEOUT_MS),
      });
      await response.body?.cancel().catch(() => undefined);
      if (!response.ok) {
        failures.push(`${assetUrl} status=${response.status}`);
      }
    } catch (error) {
      failures.push(`${assetUrl} ${formatError(error)}`);
    }
  }
  return { failures, ok: failures.length === 0 };
}

async function waitForDiscordMessage(params: { token: string; channelId: string; needle: string }) {
  const deadline = Date.now() + 3 * 60 * 1000;
  while (Date.now() < deadline) {
    let response;
    let text;
    try {
      const init = buildDiscordFetchInit(params.token);
      response = await fetch(
        `https://discord.com/api/v10/channels/${params.channelId}/messages?limit=20`,
        init,
      );
      text = await readBoundedCrossOsResponseText(response, undefined, { signal: init.signal });
    } catch {
      await sleep(2_000);
      continue;
    }
    if (!response.ok) {
      await sleep(2_000);
      continue;
    }
    if (text.includes(params.needle)) {
      return;
    }
    await sleep(2_000);
  }
  throw new Error(`Discord host-side visibility check timed out for ${params.needle}.`);
}

export function buildDiscordFetchInit(
  token: string,
  init: RequestInit = {},
): RequestInit & { signal: AbortSignal } {
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bot ${token}`);
  return {
    ...init,
    signal: init.signal ?? AbortSignal.timeout(CROSS_OS_DISCORD_FETCH_TIMEOUT_MS),
    headers,
  };
}

async function postDiscordMessage(params: {
  token: string;
  channelId: string;
  content: string;
}): Promise<string | null> {
  const init = buildDiscordFetchInit(params.token, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      content: params.content,
      flags: 4096,
    }),
  });
  const response = await fetch(
    `https://discord.com/api/v10/channels/${params.channelId}/messages`,
    init,
  );
  const text = await readBoundedCrossOsResponseText(response, undefined, { signal: init.signal });
  if (!response.ok) {
    throw new Error(`Failed to post Discord smoke message: ${text}`);
  }
  try {
    const payload = JSON.parse(text) as { id?: string };
    return payload.id ?? null;
  } catch {
    return null;
  }
}

export async function deleteDiscordMessage(params: {
  token: string;
  channelId: string;
  messageId: string | null;
}) {
  if (!params.messageId) {
    return;
  }
  try {
    const response = await fetch(
      `https://discord.com/api/v10/channels/${params.channelId}/messages/${params.messageId}`,
      buildDiscordFetchInit(params.token, {
        method: "DELETE",
      }),
    );
    await response.body?.cancel?.().catch(() => undefined);
  } catch {
    // Cleanup is best-effort; the smoke result should not fail after readback succeeds.
  }
}

async function waitForInstalledDiscordReadback(params: {
  cliPath: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  logPath: string;
  channelId: string;
  needle: string;
}) {
  const deadline = Date.now() + 3 * 60 * 1000;
  while (Date.now() < deadline) {
    const response = await runInstalledCli({
      cliPath: params.cliPath,
      args: [
        "message",
        "read",
        "--channel",
        "discord",
        "--target",
        `channel:${params.channelId}`,
        "--limit",
        "20",
        "--json",
      ],
      cwd: params.cwd,
      env: params.env,
      logPath: params.logPath,
      timeoutMs: 60_000,
      check: false,
    });
    if (response.exitCode === 0 && response.stdout.includes(params.needle)) {
      return;
    }
    await sleep(3_000);
  }
  throw new Error(`Discord guest readback timed out for ${params.needle}.`);
}

async function maybeRunDiscordRoundtrip(params: {
  lane: LaneState;
  cliPath: string;
  env: NodeJS.ProcessEnv;
  gatewayHolder: { current: GatewayHandle | null };
  logPath: string;
}) {
  const token =
    process.env.OPENCLAW_DISCORD_SMOKE_BOT_TOKEN?.trim() ||
    process.env.DISCORD_BOT_TOKEN?.trim() ||
    "";
  const guildId = process.env.OPENCLAW_DISCORD_SMOKE_GUILD_ID?.trim() || "";
  const channelId = process.env.OPENCLAW_DISCORD_SMOKE_CHANNEL_ID?.trim() || "";
  if (!token || !guildId || !channelId) {
    return "skipped-missing-config";
  }

  const { outboundNonce, inboundNonce } = buildCrossOsDiscordRoundtripNonces();
  let sentMessageId: string | null = null;
  let hostMessageId: string | null = null;
  try {
    await configureDiscordSmoke({
      lane: params.lane,
      cliPath: params.cliPath,
      cwd: params.lane.homeDir,
      env: params.env,
      gatewayHolder: params.gatewayHolder,
      logPath: params.logPath,
      token,
      guildId,
      channelId,
    });

    const sendResult = await runInstalledCli({
      cliPath: params.cliPath,
      args: [
        "message",
        "send",
        "--channel",
        "discord",
        "--target",
        `channel:${channelId}`,
        "--message",
        outboundNonce,
        "--silent",
        "--json",
      ],
      cwd: params.lane.homeDir,
      env: { ...params.env, DISCORD_BOT_TOKEN: token },
      logPath: params.logPath,
      timeoutMs: 2 * 60 * 1000,
    });
    let parsedSendResult: {
      payload?: { messageId?: string; result?: { messageId?: string } };
    } | null;
    try {
      parsedSendResult = JSON.parse(sendResult.stdout) as {
        payload?: { messageId?: string; result?: { messageId?: string } };
      };
    } catch {
      parsedSendResult = null;
    }
    sentMessageId =
      parsedSendResult?.payload?.messageId ?? parsedSendResult?.payload?.result?.messageId ?? null;
    await waitForDiscordMessage({
      token,
      channelId,
      needle: outboundNonce,
    });
    hostMessageId = await postDiscordMessage({
      token,
      channelId,
      content: inboundNonce,
    });
    await waitForInstalledDiscordReadback({
      cliPath: params.cliPath,
      cwd: params.lane.homeDir,
      env: { ...params.env, DISCORD_BOT_TOKEN: token },
      logPath: params.logPath,
      channelId,
      needle: inboundNonce,
    });
    return "pass";
  } finally {
    await deleteDiscordMessage({ token, channelId, messageId: sentMessageId });
    await deleteDiscordMessage({ token, channelId, messageId: hostMessageId });
  }
}

async function installTarballPackage(params: {
  lane: LaneState;
  env: NodeJS.ProcessEnv;
  tgzPath: string;
  logPath: string;
  timeoutMs?: number;
  ignoreScripts?: boolean;
  restoreBundledPluginPostinstall?: boolean;
}) {
  await installPackageSpec({
    lane: params.lane,
    env: params.env,
    packageSpec: params.tgzPath,
    logPath: params.logPath,
    timeoutMs: params.timeoutMs,
    ignoreScripts: params.ignoreScripts,
  });
  if (
    params.restoreBundledPluginPostinstall !== false &&
    shouldRunBundledPluginPostinstall({ lane: params.lane })
  ) {
    await runBundledPluginPostinstall({
      lane: params.lane,
      env: params.env,
      logPath: params.logPath,
    });
  }
}

async function installPackageSpec(params: {
  lane: LaneState;
  env: NodeJS.ProcessEnv;
  packageSpec: string;
  logPath: string;
  timeoutMs?: number;
  ignoreScripts?: boolean;
}) {
  const installEnv = {
    ...params.env,
    npm_config_global: "true",
    npm_config_location: "global",
    npm_config_prefix: params.lane.prefixDir,
  };
  rmSync(installedPackageRoot(params.lane.prefixDir), { force: true, recursive: true });
  try {
    await runCommand(
      npmCommand(),
      buildNpmGlobalInstallArgs(params.packageSpec, { ignoreScripts: params.ignoreScripts }),
      {
        cwd: params.lane.homeDir,
        env: installEnv,
        logPath: params.logPath,
        timeoutMs: params.timeoutMs ?? installTimeoutMs(),
      },
    );
  } catch (error) {
    const debugTail = appendLatestNpmDebugLogTail(params.lane.homeDir, params.logPath, installEnv);
    if (!debugTail) {
      throw error;
    }
    throw new Error(`${formatError(error)}\n\nnpm debug log tail:\n${debugTail}`, { cause: error });
  }
}

export function appendLatestNpmDebugLogTail(
  homeDir: string,
  logPath: string,
  env = process.env,
  platform = process.platform,
) {
  try {
    const candidates = resolveNpmDebugLogDirs(homeDir, env, platform)
      .flatMap(findNpmDebugLogs)
      .toSorted((left, right) => left.mtimeMs - right.mtimeMs);
    const latest = candidates.at(-1);
    if (!latest) {
      return "";
    }

    const tail = readLogTextWindow(latest.path, { maxBytes: CROSS_OS_NPM_DEBUG_LOG_TAIL_BYTES });
    if (!tail.trim()) {
      return "";
    }

    appendFileSync(
      logPath,
      `\n${new Date().toISOString()} npm-debug-log path=${latest.path}\n${tail}\n`,
      "utf8",
    );
    return tail;
  } catch {
    return "";
  }
}

export function resolveNpmDebugLogDirs(
  homeDir: string,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
) {
  const configuredLogsDir = resolveNpmConfiguredPath(
    homeDir,
    env.npm_config_logs_dir ?? env.NPM_CONFIG_LOGS_DIR,
    platform,
  );
  const configuredCache = resolveNpmConfiguredPath(
    homeDir,
    env.npm_config_cache ?? env.NPM_CONFIG_CACHE,
    platform,
  );
  const localAppData = (env.LOCALAPPDATA ?? "").trim();
  const logDirs = [
    configuredLogsDir,
    configuredCache ? normalizeNpmCacheLogDir(configuredCache) : "",
    platform === "win32" && localAppData ? join(localAppData, "npm-cache", "_logs") : "",
    join(homeDir, ".npm", "_logs"),
  ].filter(Boolean);
  return [...new Set(logDirs)];
}

function resolveNpmConfiguredPath(
  homeDir: string,
  value: string | undefined,
  platform: NodeJS.Platform,
) {
  const raw = (value ?? "").trim();
  if (!raw) {
    return "";
  }
  return platform === "win32" ? pathWin32.resolve(homeDir, raw) : resolve(homeDir, raw);
}

function normalizeNpmCacheLogDir(logDir: string) {
  return logDir.endsWith("/_logs") || logDir.endsWith("\\_logs") ? logDir : join(logDir, "_logs");
}

function findNpmDebugLogs(logsDir: string) {
  if (!existsSync(logsDir)) {
    return [];
  }

  return readdirSync(logsDir)
    .flatMap((fileName) => {
      if (!fileName.endsWith("-debug-0.log")) {
        return [];
      }
      const path = join(logsDir, fileName);
      try {
        const stat = statSync(path);
        return stat.isFile() ? [{ path, mtimeMs: stat.mtimeMs }] : [];
      } catch {
        return [];
      }
    })
    .toSorted((left, right) => left.mtimeMs - right.mtimeMs);
}

export function buildNpmGlobalInstallArgs(
  packageSpec: string,
  options: { ignoreScripts?: boolean } = {},
) {
  return [
    "install",
    "-g",
    packageSpec,
    "--omit=dev",
    "--no-fund",
    "--no-audit",
    ...(options.ignoreScripts ? ["--ignore-scripts"] : []),
    "--loglevel=notice",
  ];
}

function installTimeoutMs() {
  return process.platform === "win32" ? 45 * 60 * 1000 : 20 * 60 * 1000;
}

function updateTimeoutMs() {
  return process.platform === "win32"
    ? CROSS_OS_WINDOWS_PACKAGED_UPGRADE_WRAPPER_TIMEOUT_MS
    : 20 * 60 * 1000;
}

function updateStepTimeoutSeconds() {
  return process.platform === "win32"
    ? CROSS_OS_WINDOWS_PACKAGED_UPGRADE_STEP_TIMEOUT_SECONDS
    : 1200;
}

async function runBundledPluginPostinstall(params: LaneCommandParams) {
  const packageRoot = installedPackageRoot(params.lane.prefixDir);
  const scriptPath = join(packageRoot, "scripts", "postinstall-bundled-plugins.mjs");
  if (!existsSync(scriptPath)) {
    return;
  }
  const installEnv = {
    ...params.env,
  };
  delete installEnv.OPENCLAW_DISABLE_BUNDLED_PLUGIN_POSTINSTALL;
  delete installEnv.NPM_CONFIG_PREFIX;
  delete installEnv.npm_config_global;
  delete installEnv.npm_config_location;
  delete installEnv.npm_config_prefix;

  await runCommand(process.execPath, [scriptPath], {
    cwd: packageRoot,
    env: installEnv,
    logPath: params.logPath,
    timeoutMs: 20 * 60 * 1000,
  });
}

export function shouldRunWindowsInstalledBrowserOverrideImportSmoke(platform = process.platform) {
  return platform === "win32";
}

export function buildInstalledBrowserOverrideImportProbeScript(
  runtimeModuleSpecifier = "openclaw/plugin-sdk/plugin-runtime",
) {
  return `
import { existsSync } from "node:fs";
import { startLazyPluginServiceModule } from ${JSON.stringify(runtimeModuleSpecifier)};

const startedPath = process.env.OPENCLAW_BROWSER_OVERRIDE_STARTED_PATH;
const stoppedPath = process.env.OPENCLAW_BROWSER_OVERRIDE_STOPPED_PATH;

if (!process.env.OPENCLAW_BROWSER_CONTROL_MODULE) {
  throw new Error("Missing OPENCLAW_BROWSER_CONTROL_MODULE.");
}
if (!startedPath || !stoppedPath) {
  throw new Error("Missing browser override sentinel path env.");
}

const handle = await startLazyPluginServiceModule({
  overrideEnvVar: "OPENCLAW_BROWSER_CONTROL_MODULE",
  validateOverrideSpecifier: (specifier) => specifier,
  loadDefaultModule: async () => {
    throw new Error("Default browser control service should not load during override probe.");
  },
  startExportNames: ["startBrowserControlService"],
  stopExportNames: ["stopBrowserControlService"],
});

if (!handle) {
  throw new Error("Browser control override probe did not return a service handle.");
}
if (!existsSync(startedPath)) {
  throw new Error("Browser control override start sentinel was not written.");
}

await handle.stop();

if (!existsSync(stoppedPath)) {
  throw new Error("Browser control override stop sentinel was not written.");
}

console.log("windows browser override import OK");
`.trim();
}

function buildBrowserOverrideProbeServiceModule() {
  return `
import { writeFileSync } from "node:fs";

export async function startBrowserControlService() {
  writeFileSync(process.env.OPENCLAW_BROWSER_OVERRIDE_STARTED_PATH, "started\\n", "utf8");
}

export async function stopBrowserControlService() {
  writeFileSync(process.env.OPENCLAW_BROWSER_OVERRIDE_STOPPED_PATH, "stopped\\n", "utf8");
}
`.trim();
}

async function runInstalledBrowserOverrideImportSmoke(
  params: LaneCommandParams & { prefixDir: string },
) {
  if (!shouldRunWindowsInstalledBrowserOverrideImportSmoke()) {
    return "skipped";
  }

  const probeDir = join(params.lane.rootDir, "browser override import probe");
  mkdirSync(probeDir, { recursive: true });
  const overridePath = join(probeDir, "browser override #module.mjs");
  const probePath = join(probeDir, "run browser override probe.mjs");
  const startedPath = join(probeDir, "started.txt");
  const stoppedPath = join(probeDir, "stopped.txt");
  const packageRoot = installedPackageRoot(params.prefixDir);
  const runtimeModulePath = join(packageRoot, "dist", "plugin-sdk", "plugin-runtime.js");
  if (!existsSync(runtimeModulePath)) {
    throw new Error(`Installed browser runtime module not found: ${runtimeModulePath}`);
  }

  writeFileSync(overridePath, `${buildBrowserOverrideProbeServiceModule()}\n`, "utf8");
  writeFileSync(
    probePath,
    `${buildInstalledBrowserOverrideImportProbeScript(pathToFileURL(runtimeModulePath).href)}\n`,
    "utf8",
  );

  await runCommand(process.execPath, [probePath], {
    cwd: packageRoot,
    env: {
      ...params.env,
      OPENCLAW_BROWSER_CONTROL_MODULE: pathToFileURL(overridePath).href,
      OPENCLAW_BROWSER_OVERRIDE_STARTED_PATH: startedPath,
      OPENCLAW_BROWSER_OVERRIDE_STOPPED_PATH: stoppedPath,
    },
    logPath: params.logPath,
    timeoutMs: 60_000,
  });

  if (!existsSync(startedPath) || !existsSync(stoppedPath)) {
    throw new Error("Browser control override import probe did not write both sentinels.");
  }

  return "pass";
}

function ensureLocalNpmShim(lane: LaneState) {
  const shimPath = npmShimPath(lane.prefixDir);
  if (existsSync(shimPath)) {
    return;
  }
  mkdirSync(dirname(shimPath), { recursive: true });
  const resolvedNpm = resolveCommandPath(npmCommand());
  if (!resolvedNpm) {
    throw new Error(`Failed to resolve ${npmCommand()} on PATH.`);
  }
  if (process.platform === "win32") {
    writeFileSync(
      shimPath,
      `@echo off\r\nset "NPM_CONFIG_PREFIX=${lane.prefixDir}"\r\n"${resolvedNpm}" %*\r\n`,
      "utf8",
    );
    return;
  }
  writeFileSync(
    shimPath,
    `#!/bin/sh\nexport NPM_CONFIG_PREFIX='${shellEscapeForSh(lane.prefixDir)}'\nexec '${shellEscapeForSh(resolvedNpm)}' "$@"\n`,
    "utf8",
  );
  chmodSync(shimPath, 0o755);
}

async function runOnboard(params: LaneCommandParams & { providerConfig: ProviderConfig }) {
  await withAllocatedGatewayPort(params.lane, async () => {
    await runOpenClaw({
      lane: params.lane,
      env: params.env,
      args: buildReleaseOnboardArgs({
        authChoice: params.providerConfig.authChoice,
        gatewayPort: params.lane.gatewayPort,
        skipHealth: true,
      }),
      logPath: params.logPath,
      timeoutMs: 10 * 60 * 1000,
    });
  });
}

async function exerciseManagedGatewayLifecycle(
  params: Pick<LaneCommandParams, "lane" | "env"> & { cliPath: string; logPrefix: string },
) {
  logLanePhase(params.lane, "gateway-ready");
  await ensureManagedGatewayReady({
    lane: params.lane,
    cliPath: params.cliPath,
    env: params.env,
    logPath: `${params.logPrefix}-ready.log`,
  });

  logLanePhase(params.lane, "gateway-restart");
  await runInstalledCli({
    cliPath: params.cliPath,
    args: ["gateway", "restart"],
    env: params.env,
    cwd: params.lane.homeDir,
    logPath: `${params.logPrefix}-restart.log`,
    timeoutMs: 2 * 60 * 1000,
  });
  await ensureManagedGatewayReady({
    lane: params.lane,
    cliPath: params.cliPath,
    env: params.env,
    logPath: `${params.logPrefix}-ready-after-restart.log`,
  });

  logLanePhase(params.lane, "gateway-stop");
  await runInstalledCli({
    cliPath: params.cliPath,
    args: ["gateway", "stop"],
    env: params.env,
    cwd: params.lane.homeDir,
    logPath: `${params.logPrefix}-stop.log`,
    timeoutMs: 2 * 60 * 1000,
  });

  logLanePhase(params.lane, "gateway-start");
  await runInstalledCli({
    cliPath: params.cliPath,
    args: ["gateway", "start"],
    env: params.env,
    cwd: params.lane.homeDir,
    logPath: `${params.logPrefix}-start.log`,
    timeoutMs: 2 * 60 * 1000,
  });
  await ensureManagedGatewayReady({
    lane: params.lane,
    cliPath: params.cliPath,
    env: params.env,
    logPath: `${params.logPrefix}-ready-after-start.log`,
  });
}

async function startGateway(params: LaneCommandParams): Promise<GatewayHandle> {
  const gatewayLog = createWriteStream(params.logPath, { flags: "a" });
  const useProcessGroup = process.platform !== "win32";
  const child = spawn(
    process.execPath,
    [
      installedEntryPath(params.lane.prefixDir),
      "gateway",
      "run",
      "--bind",
      "loopback",
      "--port",
      String(params.lane.gatewayPort),
      "--force",
    ],
    {
      cwd: params.lane.homeDir,
      env: params.env,
      stdio: ["ignore", "pipe", "pipe"],
      detached: useProcessGroup,
      windowsHide: true,
    },
  );
  const activeChildTree = registerActiveChildProcessTree(child);
  child.stdout?.on("data", (chunk) => {
    gatewayLog.write(chunk);
  });
  child.stderr?.on("data", (chunk) => {
    gatewayLog.write(chunk);
  });
  let logClosed = false;
  const closeLog = async () => {
    if (logClosed) {
      return;
    }
    logClosed = true;
    await new Promise<void>((resolvePromise) => {
      gatewayLog.once("error", () => resolvePromise());
      gatewayLog.end(() => resolvePromise());
    });
  };
  child.once("close", () => {
    activeChildTree.unregister();
    void closeLog();
  });
  child.once("error", () => {
    activeChildTree.unregister();
    void closeLog();
  });
  return { child, closeLog, logPath: params.logPath };
}

async function waitForGateway(params: LaneCommandParams) {
  const statusArgs = await resolveGatewayStatusArgs(params.lane, params.env, params.logPath);
  const deadline = Date.now() + gatewayReadyDeadlineMs();
  while (Date.now() < deadline) {
    let result;
    try {
      result = await runOpenClaw({
        lane: params.lane,
        env: params.env,
        args: statusArgs,
        logPath: params.logPath,
        timeoutMs: CROSS_OS_GATEWAY_STATUS_COMMAND_TIMEOUT_MS,
        check: false,
      });
    } catch {
      await sleep(2_000);
      continue;
    }
    if (result.exitCode === 0) {
      return;
    }
    await sleep(2_000);
  }
  throw new Error(`Gateway did not become ready on port ${params.lane.gatewayPort}.`);
}

function gatewayReadyDeadlineMs() {
  return process.platform === "win32"
    ? CROSS_OS_WINDOWS_GATEWAY_READY_TIMEOUT_MS
    : CROSS_OS_GATEWAY_READY_TIMEOUT_MS;
}

async function resolveGatewayStatusArgs(lane: LaneState, env: NodeJS.ProcessEnv, logPath: string) {
  try {
    const help = await runOpenClaw({
      lane,
      env,
      args: ["gateway", "status", "--help"],
      logPath,
      timeoutMs: 15_000,
      check: false,
    });
    return buildGatewayStatusArgsFromHelpText(`${help.stdout}\n${help.stderr}`);
  } catch (error) {
    appendGatewayStatusHelpProbeFallback(logPath, error);
    return buildGatewayStatusArgsFromHelpText("--require-rpc");
  }
}

async function runModelsSet(params: LaneCommandParams & { providerConfig: ProviderConfig }) {
  await runOpenClaw({
    lane: params.lane,
    env: params.env,
    args: ["models", "set", params.providerConfig.model],
    logPath: params.logPath,
    timeoutMs: 2 * 60 * 1000,
  });
  const providerConfigOverride = buildReleaseProviderConfigOverride(params.providerConfig);
  if (providerConfigOverride) {
    await runOpenClaw({
      lane: params.lane,
      env: params.env,
      args: [
        "config",
        "set",
        `models.providers.${params.providerConfig.extensionId}`,
        JSON.stringify(providerConfigOverride),
        "--strict-json",
        "--merge",
      ],
      logPath: params.logPath,
      timeoutMs: 2 * 60 * 1000,
    });
  }
  await runOpenClaw({
    lane: params.lane,
    env: params.env,
    args: [
      "config",
      "set",
      "plugins.allow",
      JSON.stringify(buildCrossOsReleaseSmokePluginAllowlist(params.providerConfig)),
      "--strict-json",
    ],
    logPath: params.logPath,
    timeoutMs: 2 * 60 * 1000,
  });
  await runOpenClaw({
    lane: params.lane,
    env: params.env,
    args: buildCrossOsReleaseSmokeMemorySlotConfigArgs(),
    logPath: params.logPath,
    timeoutMs: 2 * 60 * 1000,
  });
  await runOpenClaw({
    lane: params.lane,
    env: params.env,
    args: ["config", "set", "agents.defaults.skipBootstrap", "true", "--strict-json"],
    logPath: params.logPath,
    timeoutMs: 2 * 60 * 1000,
  });
  await runOpenClaw({
    lane: params.lane,
    env: params.env,
    args: ["config", "set", "tools.profile", CROSS_OS_RELEASE_SMOKE_TOOLS_PROFILE],
    logPath: params.logPath,
    timeoutMs: 2 * 60 * 1000,
  });
}

async function runAgentTurn(
  params: LaneCommandParams & { label: string },
): Promise<AgentTurnResult> {
  let lastError;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const sessionId = buildCrossOsReleaseAgentSessionId(params.label, attempt);
    try {
      const logOffset = readLogFileSize(params.logPath);
      const result = await runOpenClaw({
        lane: params.lane,
        env: params.env,
        args: buildReleaseAgentTurnArgs(sessionId),
        logPath: params.logPath,
        timeoutMs: (CROSS_OS_AGENT_TURN_TIMEOUT_SECONDS + 60) * 1000,
      });
      const logText = readLogTextSince(params.logPath, logOffset);
      if (!agentOutputHasExpectedOkMarker(result.stdout, { logText })) {
        throw new Error("Agent output did not contain the expected OK marker.");
      }
      if (agentTurnUsedEmbeddedFallback(result, { logText })) {
        throw new Error("Agent turn used embedded fallback instead of gateway.");
      }
      return result;
    } catch (error) {
      lastError = error;
      const skipped = maybeBuildOptionalAgentTurnSkipResult(error, params.logPath, {
        attempt,
        maxAttempts: 2,
      });
      if (skipped) {
        return skipped;
      }
      if (attempt >= 2 || !shouldRetryCrossOsAgentTurnError(error)) {
        throw error;
      }
      appendFileSync(
        params.logPath,
        `\n[release-checks] retrying agent turn after retryable live failure: ${
          error instanceof Error ? error.message : String(error)
        }\n`,
      );
    }
  }
  throw lastError;
}

export function maybeBuildOptionalAgentTurnSkipResult(
  error: unknown,
  logPath: string,
  options: { attempt?: number; maxAttempts?: number; optional?: boolean } = {},
) {
  const attempt = options.attempt ?? 1;
  const maxAttempts = options.maxAttempts ?? 2;
  const optional = options.optional ?? CROSS_OS_AGENT_TURN_OPTIONAL;
  if (
    attempt < maxAttempts ||
    !optional ||
    !shouldSkipOptionalCrossOsAgentTurnError(error, logPath)
  ) {
    return null;
  }
  const message = error instanceof Error ? error.message : String(error);
  appendFileSync(
    logPath,
    `\n[release-checks] skipping optional cross-OS live agent turn after retryable failure: ${message}\n`,
  );
  return {
    status: 0,
    stdout: JSON.stringify({
      status: "skipped",
      reason: "cross-os live agent turn unavailable after retry",
    }),
    stderr: "",
  };
}

export function shouldSkipOptionalCrossOsAgentTurnError(error: unknown, logPath: string) {
  const message = error instanceof Error ? error.message : String(error);
  if (
    /model idle timeout|did not produce a response before the model idle timeout|gateway request timeout for agent|Command timed out|timed out and could not be terminated cleanly/u.test(
      message,
    )
  ) {
    return true;
  }
  if (!/Agent output did not contain the expected OK marker/u.test(message)) {
    return false;
  }
  const log = readLogTextTail(logPath);
  return /"status"\s*:\s*"timeout"|Request timed out before a response was generated/u.test(log);
}

export function buildCrossOsReleaseAgentSessionId(label: string, attempt: number) {
  return `cross-os-release-check-${label}-${randomUUID()}-${attempt}`;
}

export function buildCrossOsDiscordRoundtripNonces() {
  return {
    outboundNonce: `native-cross-os-outbound-${randomUUID()}`,
    inboundNonce: `native-cross-os-inbound-${randomUUID()}`,
  };
}

function buildReleaseAgentTurnArgs(sessionId: string) {
  return [
    "agent",
    "--agent",
    "main",
    "--session-id",
    sessionId,
    "--message",
    "Reply with exact ASCII text OK only.",
    "--thinking",
    "off",
    "--timeout",
    String(CROSS_OS_AGENT_TURN_TIMEOUT_SECONDS),
    "--json",
  ];
}

export function shouldRetryCrossOsAgentTurnError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return /Agent output did not contain the expected OK marker|Agent turn used embedded fallback instead of gateway|model idle timeout|did not produce a response before the model idle timeout|gateway request timeout for agent|Command timed out|timed out and could not be terminated cleanly|rate limit reached|rate_limit_exceeded|HTTP 429|HTTP 503|upstream connect error|disconnect\/reset before headers|connection timeout/u.test(
    message,
  );
}

export function agentTurnUsedEmbeddedFallback(
  result: Pick<AgentTurnResult, "stdout" | "stderr">,
  options: AgentOutputOptions = {},
) {
  const logText =
    typeof options.logText === "string"
      ? options.logText
      : typeof options.logPath === "string"
        ? readLogTextTail(options.logPath)
        : "";
  return /EMBEDDED FALLBACK:/u.test(`${result.stdout ?? ""}\n${result.stderr ?? ""}\n${logText}`);
}

export function agentOutputHasExpectedOkMarker(stdout: string, options: AgentOutputOptions = {}) {
  const payloadTexts = parseAgentPayloadTexts(stdout);
  if (payloadTexts.some((text) => text.trim() === "OK")) {
    return true;
  }
  if (typeof options.logText === "string") {
    const logTexts = parseAgentPayloadTexts(options.logText);
    return logTexts.some((text) => text.trim() === "OK");
  }
  if (typeof options.logPath !== "string") {
    return false;
  }
  const logTexts = parseAgentPayloadTexts(readLogTextTail(options.logPath));
  return logTexts.some((text) => text.trim() === "OK");
}

function readLogFileSize(logPath: string) {
  try {
    return statSync(logPath).size;
  } catch {
    return 0;
  }
}

function readLogTextSince(logPath: string, offsetBytes: number) {
  return readLogTextWindow(logPath, {
    offsetBytes,
    maxBytes: CROSS_OS_AGENT_LOG_FALLBACK_TAIL_BYTES,
  });
}

function readLogTextTail(logPath: string) {
  return readLogTextWindow(logPath, {
    maxBytes: CROSS_OS_AGENT_LOG_FALLBACK_TAIL_BYTES,
  });
}

function readLogTextWindow(
  logPath: string,
  options: { maxBytes?: number; offsetBytes?: number } = {},
) {
  const maxBytes = Math.max(
    1,
    Math.floor(options.maxBytes ?? CROSS_OS_AGENT_LOG_FALLBACK_TAIL_BYTES),
  );
  const offsetBytes =
    typeof options.offsetBytes === "number" && Number.isFinite(options.offsetBytes)
      ? Math.max(0, Math.floor(options.offsetBytes))
      : 0;
  let stat;
  try {
    stat = statSync(logPath);
  } catch {
    return "";
  }
  if (!stat.isFile() || stat.size <= 0) {
    return "";
  }

  const tailStart = Math.max(0, stat.size - maxBytes);
  const start = Math.min(stat.size, Math.max(offsetBytes, tailStart));
  const length = stat.size - start;
  if (length <= 0) {
    return "";
  }

  const fd = openSync(logPath, "r");
  try {
    const buffer = Buffer.alloc(length);
    const bytesRead = readSync(fd, buffer, 0, length, start);
    return buffer.subarray(0, bytesRead).toString("utf8");
  } finally {
    closeSync(fd);
  }
}

function parseAgentPayloadTexts(stdout: string) {
  try {
    type AgentPayload = {
      text?: string;
      finalAssistantVisibleText?: string;
      finalAssistantRawText?: string;
      meta?: AgentPayload;
      result?: AgentPayload;
      payloads?: AgentPayload[];
    };
    const payload = JSON.parse(stdout) as AgentPayload;
    const directTexts = [
      payload?.finalAssistantVisibleText,
      payload?.finalAssistantRawText,
      payload?.meta?.finalAssistantVisibleText,
      payload?.meta?.finalAssistantRawText,
      payload?.result?.finalAssistantVisibleText,
      payload?.result?.finalAssistantRawText,
      payload?.result?.meta?.finalAssistantVisibleText,
      payload?.result?.meta?.finalAssistantRawText,
    ].filter((text): text is string => typeof text === "string");
    const entries = Array.isArray(payload?.payloads)
      ? payload.payloads
      : Array.isArray(payload?.result?.payloads)
        ? payload.result.payloads
        : [];
    const payloadTexts = entries.flatMap((entry) =>
      typeof entry?.text === "string" ? [entry.text] : [],
    );
    return [...directTexts, ...payloadTexts];
  } catch {
    const finalTextMatches = [
      ...stdout.matchAll(
        /"(?:finalAssistantVisibleText|finalAssistantRawText|text)"\s*:\s*"([^"]*)"/gu,
      ),
    ].flatMap((match) => (match[1] === undefined ? [] : [match[1]]));
    return finalTextMatches.length > 0 ? finalTextMatches : stdout.trim() ? [stdout] : [];
  }
}

async function runDashboardSmoke(params: Pick<LaneCommandParams, "lane" | "logPath">) {
  const dashboardUrl = `http://127.0.0.1:${params.lane.gatewayPort}/`;
  const logStream = createWriteStream(params.logPath, { flags: "a" });
  const deadline = Date.now() + CROSS_OS_DASHBOARD_SMOKE_TIMEOUT_MS;
  let attempt = 0;
  try {
    while (Date.now() < deadline) {
      attempt += 1;
      logStream.write(`${new Date().toISOString()} attempt=${attempt} url=${dashboardUrl}\n`);
      try {
        const signal = AbortSignal.timeout(CROSS_OS_DASHBOARD_FETCH_TIMEOUT_MS);
        const response = await fetch(dashboardUrl, {
          signal,
        });
        const html = await readBoundedCrossOsResponseText(response, undefined, { signal });
        const markers = dashboardHtmlMarkerStatus(html);
        const assetUrls = resolveDashboardAssetUrls(dashboardUrl, html);
        if (response.ok && markers.ready) {
          const assets = await verifyDashboardAssetUrls(assetUrls);
          if (assets.ok) {
            logStream.write(
              `${new Date().toISOString()} dashboard-ready status=${response.status} assets=${assetUrls.length}\n`,
            );
            return;
          }
          logStream.write(
            `${new Date().toISOString()} dashboard-assets-not-ready status=${response.status} assets=${assetUrls.length} failures=${assets.failures.join(" | ")}\n`,
          );
        }
        logStream.write(
          `${new Date().toISOString()} dashboard-not-ready status=${response.status} title=${markers.title} app=${markers.app} assets=${assetUrls.length}\n`,
        );
      } catch (error) {
        logStream.write(
          `${new Date().toISOString()} dashboard-fetch-error ${formatError(error)}\n`,
        );
      }
      await sleep(1_000);
    }
  } finally {
    logStream.end();
  }
  throw new Error(`Dashboard HTML did not become ready at ${dashboardUrl}.`);
}

function hasChildExited(child: ChildProcess) {
  return child.exitCode !== null || (child.signalCode ?? null) !== null;
}

async function stopGateway(gateway: GatewayHandle | null) {
  try {
    if (!gateway?.child?.pid) {
      return;
    }
    if (process.platform === "win32") {
      await runCommand(
        resolveWindowsTaskkillPath(),
        ["/PID", String(gateway.child.pid), "/T", "/F"],
        {
          logPath: gateway.logPath,
          check: false,
          timeoutMs: 30_000,
        },
      );
      const exited = await waitForChildExit(gateway.child, 10_000);
      if (!exited) {
        gateway.child.stdout?.destroy();
        gateway.child.stderr?.destroy();
      }
      return;
    }
    if (hasChildExited(gateway.child)) {
      signalChildProcessTree(gateway.child, "SIGTERM");
      await sleep(2_000);
      signalChildProcessTree(gateway.child, "SIGKILL");
      return;
    }
    signalChildProcessTree(gateway.child, "SIGTERM");
    const exitedAfterTerm = await waitForChildExit(gateway.child, 2_000);
    if (!exitedAfterTerm && !hasChildExited(gateway.child)) {
      signalChildProcessTree(gateway.child, "SIGKILL");
      await waitForChildExit(gateway.child, 5_000);
    }
  } finally {
    await gateway?.closeLog?.();
  }
}

function signalChildProcessTree(child: ChildProcess, signal: NodeJS.Signals) {
  if (process.platform !== "win32" && child.pid) {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {
      // The child may have exited before its process group was signaled.
    }
  }
  child.kill(signal);
}

function registerActiveChildProcessTree(child: ChildProcess) {
  const killChildTree = (signal: NodeJS.Signals) => signalChildProcessTree(child, signal);
  CROSS_OS_ACTIVE_CHILD_TREE_KILLERS.add(killChildTree);
  return {
    killChildTree,
    unregister: () => {
      CROSS_OS_ACTIVE_CHILD_TREE_KILLERS.delete(killChildTree);
    },
  };
}

async function waitForChildExit(child: ChildProcess, timeoutMs: number) {
  if (hasChildExited(child)) {
    return true;
  }
  return new Promise<boolean>((resolvePromise) => {
    let settled = false;
    const finish = (didExit: boolean) => {
      if (settled) {
        return;
      }
      settled = true;
      if (timer) {
        clearTimeout(timer);
      }
      child.off("exit", onExit);
      child.off("close", onClose);
      child.off("error", onError);
      resolvePromise(didExit);
    };
    const onExit = () => finish(true);
    const onClose = () => finish(true);
    const onError = () => finish(true);
    const timer =
      timeoutMs > 0
        ? setTimeout(() => {
            finish(false);
          }, timeoutMs)
        : null;

    child.once("exit", onExit);
    child.once("close", onClose);
    child.once("error", onError);
  });
}

async function runCleanup(cleanupFns: Cleanup[]) {
  for (const cleanupFn of cleanupFns.toReversed()) {
    try {
      await cleanupFn();
    } catch {
      // Ignore cleanup failures so the main failure surface stays visible.
    }
  }
}

async function runOpenClaw(params: {
  lane: LaneState;
  args: string[];
  env: NodeJS.ProcessEnv;
  logPath: string;
  timeoutMs?: number;
  check?: boolean;
}) {
  return runCommand(process.execPath, [installedEntryPath(params.lane.prefixDir), ...params.args], {
    cwd: params.lane.homeDir,
    env: params.env,
    logPath: params.logPath,
    timeoutMs: params.timeoutMs,
    check: params.check ?? true,
  });
}

function readInstalledPackageManifest(prefixDir: string) {
  const packageRoot = installedPackageRoot(prefixDir);
  return readInstalledPackageManifestFromPackageRoot(packageRoot);
}

function readInstalledPackageManifestFromPackageRoot(packageRoot: string) {
  const packageJsonPath = join(packageRoot, "package.json");
  if (!existsSync(packageJsonPath)) {
    throw new Error(`Installed package manifest missing: ${packageJsonPath}`);
  }
  const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8")) as PackageJson;
  return { packageJson, packageRoot };
}

export function readInstalledVersion(prefixDir: string) {
  const { packageJson } = readInstalledPackageManifest(prefixDir);
  return typeof packageJson.version === "string" ? packageJson.version.trim() : "";
}

function readInstalledMetadata(prefixDir: string) {
  const { packageJson, packageRoot } = readInstalledPackageManifest(prefixDir);
  return readInstalledMetadataFromManifest(packageJson, packageRoot);
}

function readInstalledMetadataFromPackageRoot(packageRoot: string) {
  const { packageJson } = readInstalledPackageManifestFromPackageRoot(packageRoot);
  return readInstalledMetadataFromManifest(packageJson, packageRoot);
}

function readInstalledMetadataFromManifest(packageJson: PackageJson, packageRoot: string) {
  const buildInfoPath = join(packageRoot, "dist", "build-info.json");
  if (!existsSync(buildInfoPath)) {
    throw new Error(`Installed build info missing: ${buildInfoPath}`);
  }
  const buildInfo = JSON.parse(readFileSync(buildInfoPath, "utf8")) as {
    commit?: unknown;
  };
  return {
    version: typeof packageJson.version === "string" ? packageJson.version.trim() : "",
    commit: typeof buildInfo.commit === "string" ? buildInfo.commit.trim() : "",
  };
}

function verifyInstalledCandidate(
  installed: { version: string; commit: string },
  build: CandidateBuild,
) {
  if (installed.version !== build.candidateVersion) {
    throw new Error(
      `Installed version mismatch. Expected ${build.candidateVersion}, found ${installed.version || "<missing>"}.`,
    );
  }
  if (installed.commit !== build.sourceSha) {
    throw new Error(
      `Installed build commit mismatch. Expected ${build.sourceSha}, found ${installed.commit || "<missing>"}.`,
    );
  }
}

export function resolveInstalledPackageRootFromCliPath(
  cliPath: string,
  platform = process.platform,
  env = process.env,
) {
  const prefixDir = resolveInstalledPrefixDirFromCliPath(cliPath, platform);
  const candidates = [installedPackageRoot(prefixDir, platform)];

  if (platform !== "win32") {
    const resolvedCliPath = cliPath.trim();
    if (resolvedCliPath) {
      try {
        const realCliPath = realpathSync(resolvedCliPath);
        candidates.push(dirname(realCliPath));
        candidates.push(dirname(dirname(realCliPath)));
      } catch {
        // Some installer shims are shell wrappers, not symlinks. Fall through to
        // common user-local npm prefixes below.
      }
    }

    for (const prefix of [
      env.NPM_CONFIG_PREFIX,
      env.npm_config_prefix,
      env.HOME && join(env.HOME, ".npm-global"),
      env.HOME && join(env.HOME, ".local"),
    ]) {
      if (typeof prefix === "string" && prefix.trim()) {
        candidates.push(installedPackageRoot(prefix, platform));
      }
    }
  }

  const checked: string[] = [];
  for (const candidate of candidates) {
    if (!candidate || checked.includes(candidate)) {
      continue;
    }
    checked.push(candidate);
    if (existsSync(join(candidate, "package.json"))) {
      return candidate;
    }
  }

  throw new Error(`Installed package manifest missing. Checked: ${checked.join(", ")}`);
}

function installedPackageRoot(prefixDir: string, platform = process.platform) {
  return platform === "win32"
    ? join(prefixDir, "node_modules", "openclaw")
    : join(prefixDir, "lib", "node_modules", "openclaw");
}

function installedEntryPath(prefixDir: string) {
  return join(installedPackageRoot(prefixDir), "openclaw.mjs");
}

function npmShimPath(prefixDir: string) {
  return process.platform === "win32" ? join(prefixDir, "npm.cmd") : join(prefixDir, "bin", "npm");
}

function binDirForPrefix(prefixDir: string) {
  return process.platform === "win32" ? prefixDir : join(prefixDir, "bin");
}

function pnpmCommand() {
  return process.platform === "win32" ? "pnpm.cmd" : "pnpm";
}

function npmCommand() {
  return process.platform === "win32" ? "npm.cmd" : "npm";
}

function gitCommand() {
  return process.platform === "win32" ? "git.exe" : "git";
}

function resolveCommandCaptureLimit(options: CommandOptions) {
  const value = options.maxOutputBytes;
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return CROSS_OS_COMMAND_CAPTURE_TAIL_BYTES;
  }
  return Math.max(1, Math.floor(value));
}

function appendBoundedCommandOutput(current: string, chunk: Uint8Array | string, maxBytes: number) {
  const chunkBuffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
  if (chunkBuffer.byteLength >= maxBytes) {
    return chunkBuffer.subarray(chunkBuffer.byteLength - maxBytes).toString("utf8");
  }

  const currentBuffer = Buffer.from(current);
  const nextBytes = currentBuffer.byteLength + chunkBuffer.byteLength;
  if (nextBytes <= maxBytes) {
    return `${current}${chunkBuffer.toString("utf8")}`;
  }

  const currentTailBytes = maxBytes - chunkBuffer.byteLength;
  const currentTail = currentBuffer.subarray(currentBuffer.byteLength - currentTailBytes);
  return Buffer.concat([currentTail, chunkBuffer], maxBytes).toString("utf8");
}

export async function runCommand(
  command: string,
  args: string[],
  options: CommandOptions,
): Promise<CommandResult> {
  const invocation = resolveCommandSpawnInvocation(command, args, {
    env: options.env,
    platform: process.platform,
  });
  return runCommandInvocation(invocation, options);
}

async function runCommandInvocation(
  invocation: CommandInvocation,
  options: CommandOptions,
): Promise<CommandResult> {
  return new Promise<CommandResult>((resolvePromise, rejectPromise) => {
    const commandLabel = `${invocation.command} ${invocation.args.join(" ")}`;
    const useProcessGroup = process.platform !== "win32";
    const child = spawn(invocation.command, invocation.args, {
      cwd: options.cwd,
      env: options.env,
      shell: invocation.shell,
      stdio: ["ignore", "pipe", "pipe"],
      detached: useProcessGroup,
      windowsVerbatimArguments: invocation.windowsVerbatimArguments,
      windowsHide: true,
    });
    const activeChildTree = registerActiveChildProcessTree(child);
    const logStream = createWriteStream(options.logPath, { flags: "a" });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;
    const startedAt = Date.now();
    let killWaitTimer: NodeJS.Timeout | null = null;
    let timer: NodeJS.Timeout | null = null;
    let heartbeatTimer: NodeJS.Timeout | null = null;
    const maxCapturedOutputBytes = resolveCommandCaptureLimit(options);

    const clearTimers = () => {
      if (timer) {
        clearTimeout(timer);
      }
      if (killWaitTimer) {
        clearTimeout(killWaitTimer);
      }
      if (heartbeatTimer) {
        clearInterval(heartbeatTimer);
      }
    };

    const finishLogStream = (callback: (error?: Error | null) => void) => {
      let completed = false;
      const finish = (error?: Error | null) => {
        if (completed) {
          return;
        }
        completed = true;
        callback(error);
      };
      logStream.once("finish", finish);
      logStream.once("error", finish);
      logStream.end();
    };

    const finalize = (callback: () => void) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimers();
      finishLogStream((logError) => {
        if (logError) {
          rejectPromise(new Error(`Command log write failed: ${formatError(logError)}`));
          return;
        }
        callback();
      });
    };

    const requestKill = () => {
      if (process.platform === "win32" && child.pid) {
        try {
          const killer = spawn(
            resolveWindowsTaskkillPath(),
            ["/PID", String(child.pid), "/T", "/F"],
            {
              stdio: "ignore",
              windowsHide: true,
            },
          );
          killer.on("error", () => {
            child.kill();
          });
          return;
        } catch {
          child.kill();
          return;
        }
      }
      activeChildTree.killChildTree("SIGKILL");
    };

    timer =
      options.timeoutMs && Number.isFinite(options.timeoutMs)
        ? setTimeout(() => {
            timedOut = true;
            logStream.write(`${new Date().toISOString()} timeout command=${commandLabel}\n`);
            requestKill();
            killWaitTimer = setTimeout(() => {
              finalize(() => {
                rejectPromise(
                  new Error(
                    `Command timed out and could not be terminated cleanly: ${commandLabel}`,
                  ),
                );
              });
            }, 15_000);
          }, options.timeoutMs)
        : null;
    heartbeatTimer =
      CROSS_OS_COMMAND_HEARTBEAT_SECONDS > 0
        ? setInterval(() => {
            const elapsedSeconds = Math.floor((Date.now() - startedAt) / 1000);
            const message = `${new Date().toISOString()} still running after ${elapsedSeconds}s: ${commandLabel}\n`;
            logStream.write(message);
            process.stdout.write(`[release-checks] ${message}`);
          }, CROSS_OS_COMMAND_HEARTBEAT_SECONDS * 1000)
        : null;
    heartbeatTimer?.unref?.();

    logStream.write(`${new Date().toISOString()} start command=${commandLabel}\n`);

    child.stdout?.on("data", (chunk) => {
      const text = chunk.toString();
      stdout = appendBoundedCommandOutput(stdout, chunk, maxCapturedOutputBytes);
      logStream.write(text);
    });
    child.stderr?.on("data", (chunk) => {
      const text = chunk.toString();
      stderr = appendBoundedCommandOutput(stderr, chunk, maxCapturedOutputBytes);
      logStream.write(text);
    });

    child.on("error", (error) => {
      if (forwardedSignalExitCode !== undefined) {
        activeChildTree.killChildTree("SIGKILL");
      }
      activeChildTree.unregister();
      finalize(() => rejectPromise(error));
    });

    child.on("close", (exitCode) => {
      if (forwardedSignalExitCode !== undefined) {
        // The leader can exit on SIGTERM while descendants remain in its group.
        // Kill the group before unregistering so signal forwarding cannot leave them running.
        activeChildTree.killChildTree("SIGKILL");
        activeChildTree.unregister();
        finalize(exitForwardedSignalWhenChildTreesDone);
        return;
      }
      activeChildTree.unregister();
      finalize(() => {
        const result = {
          exitCode: exitCode ?? 1,
          stdout,
          stderr,
        };
        if (timedOut) {
          rejectPromise(new Error(`Command timed out: ${commandLabel}`));
          return;
        }
        if ((options.check ?? true) && result.exitCode !== 0) {
          rejectPromise(
            new Error(
              `Command failed (${result.exitCode}): ${commandLabel}\n${trimForSummary(
                `${stdout}\n${stderr}`,
              )}`,
            ),
          );
          return;
        }
        resolvePromise(result);
      });
    });
  });
}

export async function startStaticFileServer(params: {
  filePath: string;
  logPath: string;
}): Promise<{ url: string; close: () => Promise<void> }> {
  mkdirSync(dirname(params.logPath), { recursive: true });
  const logStream = createWriteStream(params.logPath, { flags: "a" });
  let logStreamError: Error | null = null;
  logStream.on("error", (error) => {
    logStreamError ??= error;
  });
  const fileName = params.filePath.split(/[/\\]/u).at(-1) ?? "artifact";
  const fileStat = statSync(params.filePath);
  const sockets = new Set<Socket>();
  const server = createServer((request, response) => {
    logStream.write(`${new Date().toISOString()} ${request.method} ${request.url}\n`);
    response.setHeader("connection", "close");
    if (request.url !== `/${fileName}`) {
      response.statusCode = 404;
      response.end("not found");
      return;
    }
    response.statusCode = 200;
    response.setHeader("content-type", resolveStaticFileContentType(params.filePath));
    response.setHeader("content-length", String(fileStat.size));
    const fileStream = createReadStream(params.filePath);
    fileStream.once("error", (error) => {
      logStream.write(`${new Date().toISOString()} static-file-read-error ${formatError(error)}\n`);
      if (response.headersSent) {
        response.destroy(error);
        return;
      }
      response.removeHeader("content-length");
      response.statusCode = 500;
      response.end("failed to read file");
    });
    fileStream.pipe(response);
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => {
      sockets.delete(socket);
    });
  });
  await new Promise<void>((resolvePromise, rejectPromise) => {
    server.once("error", rejectPromise);
    server.listen(0, "127.0.0.1", () => resolvePromise());
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Failed to bind static file server.");
  }
  const port = address.port;
  let closePromise: Promise<void> | undefined;
  return {
    url: `http://127.0.0.1:${port}/${fileName}`,
    close: () => {
      closePromise ??= new Promise<void>((resolvePromise, rejectPromise) => {
        closeStaticFileServerConnections(server, sockets);
        server.close((error) => {
          void (async () => {
            const closeLogError = await finishStaticFileServerLog(logStream, logStreamError).catch(
              (logError: unknown): Error =>
                logError instanceof Error ? logError : new Error(String(logError)),
            );
            if (error) {
              rejectPromise(error);
              return;
            }
            if (closeLogError) {
              rejectPromise(
                closeLogError instanceof Error
                  ? closeLogError
                  : new Error(formatError(closeLogError)),
              );
              return;
            }
            resolvePromise();
          })();
        });
        closeStaticFileServerConnections(server, sockets);
      });
      return closePromise;
    },
  };
}

function closeStaticFileServerConnections(server: Server, sockets: Set<Socket>) {
  for (const socket of sockets) {
    socket.destroy();
  }
  if (typeof server.closeAllConnections === "function") {
    server.closeAllConnections();
  }
}

function finishStaticFileServerLog(logStream: WriteStream, pendingError: Error | null) {
  return new Promise<void>((resolvePromise, rejectPromise) => {
    if (pendingError) {
      logStream.destroy();
      rejectPromise(new Error(`Static file server log write failed: ${formatError(pendingError)}`));
      return;
    }
    let completed = false;
    const finish = () => {
      if (completed) {
        return;
      }
      completed = true;
      resolvePromise();
    };
    const fail = (error: unknown) => {
      if (completed) {
        return;
      }
      completed = true;
      rejectPromise(new Error(`Static file server log write failed: ${formatError(error)}`));
    };
    logStream.once("finish", finish);
    logStream.once("error", fail);
    logStream.end();
  });
}

export function resolveStaticFileContentType(filePath: string) {
  if (filePath.endsWith(".sh") || filePath.endsWith(".ps1")) {
    return "text/plain; charset=utf-8";
  }
  return "application/octet-stream";
}

export function resolvePublishedInstallerUrl(platform = process.platform) {
  if (platform === "win32") {
    return `${PUBLISHED_INSTALLER_BASE_URL}/install.ps1`;
  }
  return `${PUBLISHED_INSTALLER_BASE_URL}/install.sh`;
}

function writeSummary(baseDir: string, summaryPayload: SummaryPayload) {
  const summaryJsonPath = join(baseDir, "summary.json");
  const summaryMarkdownPath = join(baseDir, "summary.md");
  writeFileSync(summaryJsonPath, `${JSON.stringify(summaryPayload, null, 2)}\n`, "utf8");
  const result = summaryPayload.result ?? {};

  const lines = [
    `## ${platformLabel()}`,
    "",
    `- Provider: \`${summaryPayload.provider}\``,
    `- Suite: \`${summaryPayload.suite}\``,
    `- Mode: \`${summaryPayload.mode}\``,
    `- Source SHA: \`${summaryPayload.sourceSha || "unknown"}\``,
    `- Candidate version: \`${summaryPayload.candidateVersion || "unknown"}\``,
    `- Baseline spec: \`${summaryPayload.baselineSpec}\``,
    result.status ? `- Result: \`${result.status}\`` : "",
    result.installTarget ? `- Install target: \`${result.installTarget}\`` : "",
    result.installVersion ? `- Install version: \`${result.installVersion}\`` : "",
    result.baselineVersion ? `- Baseline version: \`${result.baselineVersion}\`` : "",
    result.installedVersion ? `- Installed version: \`${result.installedVersion}\`` : "",
    result.installedCommit ? `- Installed commit: \`${result.installedCommit}\`` : "",
    result.cliPath ? `- CLI path: \`${result.cliPath}\`` : "",
    result.gatewayPort ? `- Gateway port: \`${result.gatewayPort}\`` : "",
    result.dashboardStatus ? `- Dashboard: \`${result.dashboardStatus}\`` : "",
    result.discordStatus ? `- Discord: \`${result.discordStatus}\`` : "",
    result.agentOutput ? `- Agent output: \`${trimForSummary(result.agentOutput)}\`` : "",
    result.error ? `- Error: \`${trimForSummary(result.error)}\`` : "",
  ].filter(Boolean);
  if (Array.isArray(result.phaseTimings) && result.phaseTimings.length > 0) {
    lines.push("", "### Phase timings");
    for (const phase of result.phaseTimings) {
      const suffix = phase.status === "pass" ? "" : ` (${phase.status})`;
      lines.push(`- \`${phase.name}\`: ${Math.round(phase.durationMs / 1000)}s${suffix}`);
    }
  }
  writeFileSync(summaryMarkdownPath, `${lines.join("\n")}\n`, "utf8");
}

function writeCandidateManifest(baseDir: string, build: CandidateBuild) {
  const manifestPath = join(baseDir, "candidate.json");
  writeFileSync(
    manifestPath,
    `${JSON.stringify(
      {
        sourceSha: build.sourceSha,
        candidateVersion: build.candidateVersion,
        candidateFileName: build.candidateFileName,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
}

function platformLabel() {
  if (process.platform === "darwin") {
    return "macOS Release Checks";
  }
  if (process.platform === "win32") {
    return "Windows Release Checks";
  }
  return "Linux Release Checks";
}

function requireArg(argsMap: ParsedArgs, key: string) {
  const value = argsMap[key]?.trim();
  if (!value) {
    throw new Error(`Missing required --${key} argument.`);
  }
  return value;
}

function resolveCommandPath(command: string) {
  const pathValue = process.env.PATH ?? "";
  const pathEntries = pathValue.split(process.platform === "win32" ? ";" : ":").filter(Boolean);
  const candidates =
    process.platform === "win32" && !command.toLowerCase().endsWith(".cmd")
      ? [`${command}.cmd`, `${command}.exe`, command]
      : [command];
  for (const entry of pathEntries) {
    for (const candidate of candidates) {
      const fullPath = join(entry, candidate);
      if (existsSync(fullPath)) {
        return fullPath;
      }
    }
  }
  return null;
}

function shellEscapeForSh(value: string) {
  return value.replace(/'/gu, `'"'"'`);
}

function logPhase(scope: string, phase: string) {
  process.stdout.write(`[release-checks] ${scope}: ${phase}\n`);
}

function logLanePhase(lane: LaneState, phase: string) {
  logPhase(`lane.${lane.name}`, phase);
}

async function runTimedLanePhase<T>(lane: LaneState, phase: string, callback: () => Promise<T>) {
  const startedAt = Date.now();
  logLanePhase(lane, phase);
  try {
    const result = await callback();
    const durationMs = Date.now() - startedAt;
    lane.phaseTimings.push({ name: phase, status: "pass", durationMs });
    logPhase(`lane.${lane.name}`, `${phase}: done in ${Math.round(durationMs / 1000)}s`);
    return result;
  } catch (error) {
    const durationMs = Date.now() - startedAt;
    lane.phaseTimings.push({ name: phase, status: "fail", durationMs });
    logPhase(`lane.${lane.name}`, `${phase}: failed in ${Math.round(durationMs / 1000)}s`);
    throw error;
  }
}

function trimForSummary(value: string) {
  const trimmed = value.trim();
  if (trimmed.length <= 600) {
    return trimmed;
  }
  return `${trimmed.slice(0, 600)}...`;
}

function formatError(error: unknown) {
  if (error instanceof Error) {
    return error.stack || error.message;
  }
  return String(error);
}

function sleep(ms: number) {
  return new Promise<void>((resolvePromise) => {
    setTimeout(resolvePromise, ms);
  });
}

async function withAllocatedGatewayPort<T>(lane: LaneState, callback: () => Promise<T>) {
  let lastError = null;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const reservation = await reservePort();
    lane.gatewayPort = reservation.port;
    await reservation.release();
    try {
      return await callback();
    } catch (error) {
      lastError = error;
      if (!isAddressInUseError(error) || attempt === 3) {
        throw error;
      }
      await sleep(250 * attempt);
    }
  }
  throw toLintErrorObject(
    lastError ?? new Error("Failed to allocate a gateway port."),
    "Non-Error thrown",
  );
}

function reservePort(): Promise<{ port: number; release: () => Promise<void> }> {
  return new Promise((resolvePromise, rejectPromise) => {
    const server = createNetServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        rejectPromise(new Error("Failed to allocate a TCP port."));
        return;
      }
      resolvePromise({
        port: address.port,
        release: () =>
          new Promise<void>((releaseResolve, releaseReject) => {
            server.close((error) => {
              if (error) {
                releaseReject(error);
                return;
              }
              releaseResolve();
            });
          }),
      });
    });
    server.once("error", rejectPromise);
  });
}

function isAddressInUseError(error: unknown) {
  const message = formatError(error);
  return message.includes("EADDRINUSE") || /address.+in use/iu.test(message);
}

function toLintErrorObject(value: unknown, fallbackMessage: string): Error {
  if (value instanceof Error) {
    return value;
  }
  if (typeof value === "string") {
    return new Error(value);
  }
  const error = new Error(fallbackMessage, { cause: value });
  if ((typeof value === "object" && value !== null) || typeof value === "function") {
    Object.assign(error, value);
  }
  return error;
}
