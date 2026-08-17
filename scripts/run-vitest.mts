// Runs Vitest through repo project selection, local scheduling policy, output
// watchdogs, and process-group cleanup.
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import { constants as osConstants } from "node:os";
import path from "node:path";
import {
  agentVitestProjectOwners,
  embeddedAgentVitestProjectOwners,
} from "../test/vitest/vitest.agents-paths.mjs";
import { toolingIsolatedTestFiles } from "../test/vitest/vitest.tooling-isolated-paths.mjs";
import { isUiTestTarget } from "../test/vitest/vitest.ui-paths.mjs";
import { boundaryTestFiles } from "../test/vitest/vitest.unit-paths.mjs";
import { parsePermissiveBooleanToken } from "./lib/arg-utils.mts";
import { resolveExtensionTestConfig } from "./lib/extension-test-plan.mts";
import { runWithFailedTrailer, writeFailedTrailer } from "./lib/failed-trailer.mts";
import { createGatewayServerTestTargetChunks } from "./lib/gateway-server-test-plan.mts";
import { signalExitCode } from "./lib/managed-child-process.mts";
import { resolveRepoRoot } from "./lib/repo-root.mjs";
import { spawnTestProjectsRunner } from "./lib/test-projects-delegation.mts";
import { resolveVitestProcessEnv } from "./lib/vitest-process-env.mts";
import { spawnPnpmRunner, type PnpmRunnerParams } from "./pnpm-runner.mts";
import {
  createVitestProcessCompletion,
  forwardSignalToVitestProcessGroup,
  installVitestProcessGroupCleanup,
  shouldUseDetachedVitestProcessGroup,
} from "./vitest-process-group.mts";

type VitestFs = {
  existsSync(path: string): boolean;
  symlinkSync?(target: string, path: string, type: "dir" | "junction"): void;
};
type VitestPathFs = Pick<typeof fs, "existsSync" | "statSync">;
type VitestProcessHandle = Omit<ReturnType<typeof spawnWatchedVitestProcess>, "teardown">;
type WatchdogStream = {
  on(event: string, listener: (...args: unknown[]) => void): unknown;
  off(event: string, listener: (...args: unknown[]) => void): unknown;
};
type NodeSignal = keyof typeof osConstants.signals;
type VitestOutputStream = {
  setEncoding(encoding: "utf8"): unknown;
  on(event: "data", listener: (chunk: string) => void): unknown;
  on(event: "end", listener: () => void): unknown;
};
type VitestOutputTarget = {
  write(chunk: string): unknown;
};

const ANSI_CSI_PREFIX = `${String.fromCharCode(27)}[`;
const ANSI_CSI_SUFFIX_RE = /^[0-?]*[ -/]*[@-~]/u;
const SUPPRESSED_VITEST_STDERR_PATTERNS = ["[PLUGIN_TIMINGS]"];
/** Default watchdog timeout for Vitest runs that stop producing output. */
const DEFAULT_VITEST_NO_OUTPUT_TIMEOUT_MS = 120_000;
/** Default heartbeat interval while waiting on silent Vitest output. */
export const DEFAULT_VITEST_NO_OUTPUT_HEARTBEAT_MS = 30_000;
/** Longer watchdog timeout for known long-running Vitest configs. */
export const DEFAULT_LONG_RUNNING_VITEST_NO_OUTPUT_TIMEOUT_MS = 300_000;
/** Extra-long watchdog timeout for broad configs that can stay silent on macOS. */
export const DEFAULT_EXTRA_LONG_RUNNING_VITEST_NO_OUTPUT_TIMEOUT_MS = 2_400_000;
const VITEST_NO_OUTPUT_TIMEOUT_ENV_KEY = "OPENCLAW_VITEST_NO_OUTPUT_TIMEOUT_MS";
const VITEST_NO_OUTPUT_HEARTBEAT_ENV_KEY = "OPENCLAW_VITEST_NO_OUTPUT_HEARTBEAT_MS";
const UI_VITEST_CONFIG = "test/vitest/vitest.ui.config.ts";
const TOOLING_DOCKER_VITEST_CONFIG = "test/vitest/vitest.tooling-docker.config.ts";
const TOOLING_VITEST_CONFIG = "test/vitest/vitest.tooling.config.ts";
const GATEWAY_CORE_VITEST_CONFIG = "test/vitest/vitest.gateway-core.config.ts";
const GATEWAY_SERVER_VITEST_CONFIG = "test/vitest/vitest.gateway-server.config.ts";
const GATEWAY_VITEST_CONFIG = "test/vitest/vitest.gateway.config.ts";
export const VITEST_CONFIG_NO_OUTPUT_TIMEOUT_MS = new Map([
  ["test/vitest/vitest.e2e.config.ts", DEFAULT_LONG_RUNNING_VITEST_NO_OUTPUT_TIMEOUT_MS],
  ["test/vitest/vitest.tui-pty.config.ts", DEFAULT_LONG_RUNNING_VITEST_NO_OUTPUT_TIMEOUT_MS],
  [GATEWAY_VITEST_CONFIG, DEFAULT_LONG_RUNNING_VITEST_NO_OUTPUT_TIMEOUT_MS],
  ["test/vitest/vitest.ui-e2e.config.ts", DEFAULT_LONG_RUNNING_VITEST_NO_OUTPUT_TIMEOUT_MS],
  ["test/vitest/vitest.full-agentic.config.ts", DEFAULT_LONG_RUNNING_VITEST_NO_OUTPUT_TIMEOUT_MS],
  [
    "test/vitest/vitest.full-core-contracts.config.ts",
    DEFAULT_LONG_RUNNING_VITEST_NO_OUTPUT_TIMEOUT_MS,
  ],
  [
    "test/vitest/vitest.contracts-plugin.config.ts",
    DEFAULT_EXTRA_LONG_RUNNING_VITEST_NO_OUTPUT_TIMEOUT_MS,
  ],
  ["test/vitest/vitest.infra.config.ts", DEFAULT_EXTRA_LONG_RUNNING_VITEST_NO_OUTPUT_TIMEOUT_MS],
  [GATEWAY_CORE_VITEST_CONFIG, DEFAULT_EXTRA_LONG_RUNNING_VITEST_NO_OUTPUT_TIMEOUT_MS],
  [GATEWAY_SERVER_VITEST_CONFIG, DEFAULT_EXTRA_LONG_RUNNING_VITEST_NO_OUTPUT_TIMEOUT_MS],
]);
for (const owner of embeddedAgentVitestProjectOwners) {
  VITEST_CONFIG_NO_OUTPUT_TIMEOUT_MS.set(
    owner.config,
    DEFAULT_LONG_RUNNING_VITEST_NO_OUTPUT_TIMEOUT_MS,
  );
}
export const TOOLING_EXCLUDED_TESTS = new Set([
  ...boundaryTestFiles,
  "test/scripts/docker-build-helper.test.ts",
  ...toolingIsolatedTestFiles,
]);
const EXPLICIT_FILE_TARGET_RE = /\.(?:[cm]?[jt]sx?)$/u;
const EXPLICIT_TEST_FILE_RE = /\.(?:test|e2e|live)\.(?:[cm]?[jt]sx?)$/u;
const GLOB_PATTERN_CHARS_RE = /[*?[\]{}]/u;
const NON_RUN_VITEST_SUBCOMMANDS = new Set(["bench", "list", "related"]);
const VITEST_OPTIONS_WITH_VALUE = new Set([
  "--attachmentsDir",
  "--bail",
  "--browser",
  "--config",
  "--configLoader",
  "-c",
  "--changed",
  "--dir",
  "--diff",
  "--environment",
  "--exclude",
  "--execArgv",
  "--hookTimeout",
  "--inspect",
  "--inspect-brk",
  "--listTags",
  "--maxConcurrency",
  "--maxWorkers",
  "--mergeReports",
  "--mode",
  "--outputFile",
  "--pool",
  "--project",
  "--reporter",
  "--reporters",
  "--retry",
  "--root",
  "-r",
  "--sequence",
  "--sequence.hooks",
  "--sequence.seed",
  "--sequence.setupFiles",
  "--shard",
  "--silent",
  "--slowTestThreshold",
  "--tagsFilter",
  "--teardownTimeout",
  "--testNamePattern",
  "-t",
  "--testTimeout",
  "--update",
  "-u",
  "--vmMemoryLimit",
]);
const VITEST_DOTTED_OPTIONS_WITH_VALUE_PREFIXES = [
  "--browser.",
  "--coverage.",
  "--diff.",
  "--expect.",
  "--experimental.",
  "--outputFile.",
  "--retry.",
  "--typecheck.",
];
const UNBOUNDED_CONFIG_ONLY_OPTIONS = [
  "--changed",
  "--coverage",
  "--dir",
  "--mergeReports",
  "--outputFile",
  "--project",
  "--root",
  "--shard",
];
const require = createRequire(import.meta.url);
const repoRoot = resolveRepoRoot(import.meta.url);

function parsePositiveInt(value: string | undefined): number | null {
  const text = value?.trim();
  if (!text || !/^\d+$/u.test(text)) {
    return null;
  }
  const parsed = Number(text);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

/**
 * Resolves default Node flags for Vitest, including the local Maglev opt-in.
 */
export function resolveVitestNodeArgs(env: NodeJS.ProcessEnv = process.env): string[] {
  if (parsePermissiveBooleanToken(env.OPENCLAW_VITEST_ENABLE_MAGLEV) === true) {
    return [];
  }

  return ["--no-maglev"];
}

function isErrorWithCode(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === code;
}

function isNodeSignal(signal: string): signal is NodeSignal {
  return Object.hasOwn(osConstants.signals, signal);
}

function normalizeNodeSignal(signal: string | null): NodeSignal | null {
  if (!signal) {
    return null;
  }
  const unknownSignalMessage = `child process exited with unknown signal: ${signal}`;
  if (!isNodeSignal(signal)) {
    throw new Error(unknownSignalMessage);
  }
  return signal;
}

function isMissingVitestResolveError(error: unknown): error is NodeJS.ErrnoException {
  return (
    isErrorWithCode(error, "MODULE_NOT_FOUND") && error.message.includes("vitest/package.json")
  );
}

/**
 * Builds the actionable dependency-install message when Vitest is unavailable.
 */
export function resolveMissingVitestDependencyMessage(
  baseDir = repoRoot,
  fsImpl: Pick<VitestFs, "existsSync"> = fs,
): string {
  const hasNodeModules = fsImpl.existsSync(path.join(baseDir, "node_modules"));
  const reason = hasNodeModules
    ? "[vitest] Vitest is not installed in node_modules."
    : "[vitest] node_modules is missing; Vitest cannot be resolved.";
  return [
    reason,
    "Install dependencies before running scripts/run-vitest.mjs:",
    "  pnpm install --frozen-lockfile",
    "For raw Crabbox/AWS macOS source syncs, hydrate or install dependencies before this runner.",
  ].join("\n");
}

function resolvePathFromBase(value: string, baseDir: string): string {
  return path.isAbsolute(value) ? value : path.resolve(baseDir, value);
}

function resolvePnpmModulesDir(env: NodeJS.ProcessEnv): string {
  return env.PNPM_CONFIG_MODULES_DIR?.trim() || env.npm_config_modules_dir?.trim() || "";
}

function resolveHydratedVitestPackageJson({
  baseDir,
  env,
  fsImpl,
}: {
  baseDir: string;
  env: NodeJS.ProcessEnv;
  fsImpl: Pick<VitestFs, "existsSync">;
}): string | null {
  const modulesDir = resolvePnpmModulesDir(env);
  if (!modulesDir) {
    return null;
  }
  const packageJsonPath = path.join(
    resolvePathFromBase(modulesDir, baseDir),
    "vitest",
    "package.json",
  );
  return fsImpl.existsSync(packageJsonPath) ? packageJsonPath : null;
}

function ensureHydratedNodeModulesSelfLink({
  hydratedNodeModulesPath,
  fsImpl,
  platform,
}: {
  hydratedNodeModulesPath: string;
  fsImpl: VitestFs;
  platform: NodeJS.Platform;
}): boolean {
  if (platform !== "win32") {
    return true;
  }
  const selfLinkPath = path.join(hydratedNodeModulesPath, "node_modules");
  if (fsImpl.existsSync(selfLinkPath)) {
    return true;
  }
  if (!fsImpl.symlinkSync) {
    return false;
  }
  try {
    fsImpl.symlinkSync(hydratedNodeModulesPath, selfLinkPath, "junction");
    return true;
  } catch {
    return false;
  }
}

function resolveHydratedVitestCliEntry({
  baseDir,
  env,
  fsImpl,
  platform,
}: {
  baseDir: string;
  env: NodeJS.ProcessEnv;
  fsImpl: VitestFs;
  platform: NodeJS.Platform;
}): string | null {
  const hydratedVitestPackageJson = resolveHydratedVitestPackageJson({ baseDir, env, fsImpl });
  if (!hydratedVitestPackageJson) {
    return null;
  }
  const hydratedNodeModulesPath = path.dirname(path.dirname(hydratedVitestPackageJson));
  if (!ensureHydratedNodeModulesSelfLink({ hydratedNodeModulesPath, fsImpl, platform })) {
    return null;
  }
  const nodeModulesPath = path.join(baseDir, "node_modules");
  if (fsImpl.existsSync(nodeModulesPath)) {
    const workspaceVitestCliEntry = path.join(nodeModulesPath, "vitest", "vitest.mjs");
    return fsImpl.existsSync(workspaceVitestCliEntry) ? workspaceVitestCliEntry : null;
  }
  if (!fsImpl.symlinkSync) {
    return null;
  }
  try {
    fsImpl.symlinkSync(
      hydratedNodeModulesPath,
      nodeModulesPath,
      platform === "win32" ? "junction" : "dir",
    );
  } catch {
    return null;
  }
  return path.join(nodeModulesPath, "vitest", "vitest.mjs");
}

/**
 * Resolves the Vitest CLI entry from normal or hydrated node_modules layouts.
 */
export function resolveVitestCliEntry({
  baseDir = repoRoot,
  env = process.env,
  fsImpl = fs,
  platform = process.platform,
  requireResolve = require.resolve.bind(require),
}: {
  baseDir?: string;
  env?: NodeJS.ProcessEnv;
  fsImpl?: VitestFs;
  platform?: NodeJS.Platform;
  requireResolve?: (specifier: string, options?: { paths?: string[] }) => string;
} = {}): string {
  const hydratedVitestCliEntry = resolveHydratedVitestCliEntry({
    baseDir,
    env,
    fsImpl,
    platform,
  });
  if (hydratedVitestCliEntry) {
    return hydratedVitestCliEntry;
  }

  let vitestPackageJson: string;
  try {
    vitestPackageJson = requireResolve("vitest/package.json");
  } catch (error) {
    if (isMissingVitestResolveError(error)) {
      const wrappedError: NodeJS.ErrnoException = new Error(
        resolveMissingVitestDependencyMessage(baseDir, fsImpl),
      );
      wrappedError.code = "OPENCLAW_MISSING_VITEST";
      throw wrappedError;
    }
    throw error;
  }
  return path.join(path.dirname(vitestPackageJson), "vitest.mjs");
}

/**
 * Reads the explicit no-output watchdog timeout, if configured.
 */
export function resolveVitestNoOutputTimeoutMs(
  env: NodeJS.ProcessEnv = process.env,
): number | null {
  return parsePositiveInt(env[VITEST_NO_OUTPUT_TIMEOUT_ENV_KEY]);
}

/**
 * Reads the explicit no-output heartbeat interval, if configured.
 */
export function resolveVitestNoOutputHeartbeatMs(
  env: NodeJS.ProcessEnv = process.env,
): number | null {
  return parsePositiveInt(env[VITEST_NO_OUTPUT_HEARTBEAT_ENV_KEY]);
}

function resolveBooleanModeFlag(
  argv: string[],
  index: number,
  longName: string,
  shortName: string | null = null,
): { value: boolean; consumedNext: boolean } | null {
  const arg = argv[index];
  if (arg === undefined) {
    return null;
  }
  const parseValue = (rawValue: string): boolean => rawValue !== "false";
  const flags = shortName === null ? [`--${longName}`] : [`--${longName}`, shortName];
  for (const flag of flags) {
    if (arg === `--no-${longName}`) {
      return { value: false, consumedNext: false };
    }
    if (arg === flag) {
      const next = argv[index + 1];
      if (next !== undefined && !next.startsWith("-")) {
        return { value: parseValue(next), consumedNext: true };
      }
      return { value: true, consumedNext: false };
    }
    if (arg.startsWith(`${flag}=`)) {
      return { value: parseValue(arg.slice(flag.length + 1)), consumedNext: false };
    }
  }
  return null;
}

function resolveExplicitVitestMode(argv: string[]): "run" | "watch" | null {
  let mode: "run" | "watch" | null = null;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === undefined) {
      break;
    }
    if (arg === "--") {
      break;
    }
    const watchFlag = resolveBooleanModeFlag(argv, index, "watch", "-w");
    if (watchFlag) {
      if (watchFlag.consumedNext) {
        index += 1;
      }
      if (watchFlag.value) {
        return "watch";
      }
      mode = "run";
      continue;
    }
    const runFlag = resolveBooleanModeFlag(argv, index, "run");
    if (runFlag) {
      if (runFlag.consumedNext) {
        index += 1;
      }
      if (runFlag.value) {
        mode = "run";
      }
      continue;
    }
    if (optionConsumesNextArg(arg)) {
      index += 1;
      continue;
    }
    if (arg.startsWith("-")) {
      continue;
    }
    if (mode !== null) {
      continue;
    }
    if (arg === "watch" || arg === "dev") {
      return "watch";
    }
    if (arg === "run") {
      mode = "run";
      continue;
    }
    return null;
  }
  return mode;
}

function resolveVitestCompileCacheSafeEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  if (!env.NODE_COMPILE_CACHE && !env.NODE_COMPILE_CACHE_PORTABLE) {
    return env;
  }
  // Coverage can be enabled inside a dynamic Vitest config, which this wrapper
  // cannot know before spawning. Keep the cache for orchestration/build tools,
  // but never let a Vitest child deserialize bytecode into V8 coverage.
  const spawnEnv: NodeJS.ProcessEnv = { ...env, NODE_DISABLE_COMPILE_CACHE: "1" };
  delete spawnEnv.NODE_COMPILE_CACHE;
  delete spawnEnv.NODE_COMPILE_CACHE_PORTABLE;
  return spawnEnv;
}

/**
 * Adds default watchdog env for non-watch Vitest runs.
 */
export function resolveRunVitestSpawnEnv(
  env: NodeJS.ProcessEnv = process.env,
  argv: string[] = [],
): NodeJS.ProcessEnv {
  const baseEnv = resolveVitestCompileCacheSafeEnv(env);
  const explicitMode = resolveExplicitVitestMode(argv);
  if (explicitMode === "watch") {
    return baseEnv;
  }
  if (explicitMode !== "run" && parsePermissiveBooleanToken(baseEnv.CI) !== true) {
    return baseEnv;
  }
  const defaultTimeoutMs = resolveDefaultVitestNoOutputTimeoutMs(argv);
  const hasTimeout = Object.hasOwn(baseEnv, VITEST_NO_OUTPUT_TIMEOUT_ENV_KEY);
  const timeoutMs = hasTimeout
    ? parsePositiveInt(baseEnv[VITEST_NO_OUTPUT_TIMEOUT_ENV_KEY])
    : defaultTimeoutMs;
  const hasHeartbeat = Object.hasOwn(baseEnv, VITEST_NO_OUTPUT_HEARTBEAT_ENV_KEY);
  return {
    ...baseEnv,
    ...(!hasTimeout ? { [VITEST_NO_OUTPUT_TIMEOUT_ENV_KEY]: String(defaultTimeoutMs) } : {}),
    ...(!hasHeartbeat && timeoutMs !== null && DEFAULT_VITEST_NO_OUTPUT_HEARTBEAT_MS < timeoutMs
      ? { [VITEST_NO_OUTPUT_HEARTBEAT_ENV_KEY]: String(DEFAULT_VITEST_NO_OUTPUT_HEARTBEAT_MS) }
      : {}),
  };
}

/**
 * Chooses the default watchdog timeout from the selected Vitest config.
 */
export function resolveDefaultVitestNoOutputTimeoutMs(argv: string[] = []): number {
  const config = resolveVitestConfigArg(argv);
  return config === null
    ? DEFAULT_VITEST_NO_OUTPUT_TIMEOUT_MS
    : (resolveVitestConfigNoOutputTimeoutMs(config) ?? DEFAULT_VITEST_NO_OUTPUT_TIMEOUT_MS);
}

function resolveVitestConfigArg(argv: string[]): string | null {
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === undefined) {
      break;
    }
    if (arg === "--") {
      return null;
    }
    if (arg === "--config" || arg === "-c") {
      return argv[index + 1] ?? null;
    }
    if (arg.startsWith("--config=")) {
      return arg.slice("--config=".length);
    }
  }
  return null;
}

function resolveVitestConfigNoOutputTimeoutMs(config: string): number | null {
  const normalized = normalizeVitestConfigPath(config);
  for (const [candidate, timeoutMs] of VITEST_CONFIG_NO_OUTPUT_TIMEOUT_MS) {
    if (matchesVitestConfigPath(normalized, candidate)) {
      return timeoutMs;
    }
  }
  return null;
}

function normalizeVitestConfigPath(config: string): string {
  return path.normalize(config).replaceAll(path.sep, "/").replace(/^\.\//u, "");
}

function matchesVitestConfigPath(normalized: string, candidate: string): boolean {
  return normalized === candidate || normalized.endsWith("/" + candidate);
}

function hasVitestOption(argv: string[], option: string): boolean {
  for (const arg of argv) {
    if (arg === "--") {
      return false;
    }
    if (arg === option || arg.startsWith(option + "=") || arg.startsWith(option + ".")) {
      return true;
    }
  }
  return false;
}

function insertVitestTargets(argv: string[], targets: string[]): string[] {
  const separatorIndex = argv.indexOf("--");
  const insertionIndex = separatorIndex < 0 ? argv.length : separatorIndex;
  return [...argv.slice(0, insertionIndex), ...targets, ...argv.slice(insertionIndex)];
}

/**
 * Splits config-only Gateway server runs into fresh processes before the
 * non-isolated module graph reaches the worker heap limit.
 */
export function resolveBoundedVitestInvocations(
  argv: string[],
  options: {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    gatewayServerTargetChunks?: string[][];
  } = {},
): string[][] {
  const config = resolveVitestConfigArg(argv);
  const normalizedConfig = config === null ? "" : normalizeVitestConfigPath(config);
  const env = options.env ?? process.env;
  const cwd = options.cwd ?? process.cwd();
  const mode = resolveExplicitVitestMode(argv);
  if (
    !matchesVitestConfigPath(normalizedConfig, GATEWAY_SERVER_VITEST_CONFIG) ||
    mode === "watch" ||
    (mode !== "run" && parsePermissiveBooleanToken(env.CI) !== true) ||
    hasNonRunVitestSubcommand(argv) ||
    hasAlternateVitestRootArg(argv) ||
    collectExplicitProjectRouterTargetArgs(argv, cwd).length > 0 ||
    UNBOUNDED_CONFIG_ONLY_OPTIONS.some((option) => hasVitestOption(argv, option))
  ) {
    return [argv];
  }
  const chunks = options.gatewayServerTargetChunks ?? createGatewayServerTestTargetChunks(cwd);
  return chunks.length > 1 ? chunks.map((targets) => insertVitestTargets(argv, targets)) : [argv];
}

/**
 * Builds spawn options for the primary Vitest child process.
 */
export function resolveVitestSpawnParams(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): PnpmRunnerParams {
  return {
    env: resolveVitestProcessEnv(env),
    detached: shouldUseDetachedVitestProcessGroup(platform),
    stdio: ["inherit", "pipe", "pipe"],
  };
}

/**
 * Filters known noisy Vitest stderr lines after stripping ANSI escapes.
 */
export function shouldSuppressVitestStderrLine(line: string): boolean {
  const normalizedLine = line
    .split(ANSI_CSI_PREFIX)
    .map((segment, index) => (index === 0 ? segment : segment.replace(ANSI_CSI_SUFFIX_RE, "")))
    .join("");
  return SUPPRESSED_VITEST_STDERR_PATTERNS.some((pattern) => normalizedLine.includes(pattern));
}

/**
 * Detects pnpm exec node invocations so the wrapper can spawn Node directly.
 */
export function resolveDirectNodeVitestArgs(pnpmArgs: string[]): string[] | null {
  return pnpmArgs[0] === "exec" && pnpmArgs[1] === "node" ? pnpmArgs.slice(2) : null;
}

function hasExplicitVitestConfigArg(argv: string[]): boolean {
  return argv.some((arg) => arg === "--config" || arg === "-c" || arg.startsWith("--config="));
}

function optionConsumesNextArg(arg: string): boolean {
  if (arg.includes("=")) {
    return false;
  }
  return (
    VITEST_OPTIONS_WITH_VALUE.has(arg) ||
    VITEST_DOTTED_OPTIONS_WITH_VALUE_PREFIXES.some((prefix) => arg.startsWith(prefix))
  );
}

function isPathLikeExplicitFileArg(arg: string): boolean {
  return (
    path.isAbsolute(arg) || arg.startsWith("./") || arg.startsWith("../") || /[/\\]/u.test(arg)
  );
}

function isExplicitFileTargetArg(arg: string): boolean {
  if (!EXPLICIT_FILE_TARGET_RE.test(arg) || GLOB_PATTERN_CHARS_RE.test(arg)) {
    return false;
  }
  return isPathLikeExplicitFileArg(arg);
}

function isExplicitTestFileArg(arg: string): boolean {
  return EXPLICIT_TEST_FILE_RE.test(arg) && isExplicitFileTargetArg(arg);
}

function isDelegableBroadProjectRouterTarget(arg: string, cwd: string): boolean {
  const relative = toRepoRelativeArg(arg, cwd).replace(/\/+$/u, "");
  return (
    relative === "test/scripts" ||
    relative === "test/scripts/*.test.ts" ||
    relative === "test/scripts/**/*.test.ts"
  );
}

function isPathAtOrUnder(value: string, root: string): boolean {
  return value === root || value.startsWith(`${root}/`);
}

function isOwnedAgentDirectoryTarget(arg: string, cwd: string, fsImpl: VitestPathFs): boolean {
  const relative = toRepoRelativeArg(arg, cwd).replace(/\/+$/u, "");
  return (
    isPathAtOrUnder(relative, agentVitestProjectOwners.all.root) &&
    isExplicitDirectoryTargetArg(arg, cwd, fsImpl)
  );
}

function isOwnedExtensionRootTarget(arg: string, cwd: string, fsImpl: VitestPathFs): boolean {
  const relative = toRepoRelativeArg(arg, cwd).replace(/\/+$/u, "");
  const [root, extensionId, ...remainder] = relative.split("/");
  if (
    root !== "extensions" ||
    !extensionId ||
    remainder.length > 0 ||
    !isExplicitDirectoryTargetArg(arg, cwd, fsImpl)
  ) {
    return false;
  }
  // Extension roots delegate so the bounded planner owns process lifetime (#124413).
  // Raw Vitest would run the workspace config as one process.
  return resolveExtensionTestConfig(relative).length > 0;
}

function isExplicitProjectRouterTargetArg(
  arg: string,
  cwd = process.cwd(),
  fsImpl: VitestPathFs = fs,
): boolean {
  if (!isPathLikeExplicitFileArg(arg)) {
    return false;
  }
  if (GLOB_PATTERN_CHARS_RE.test(arg)) {
    return isDelegableBroadProjectRouterTarget(arg, cwd);
  }
  if (isExplicitFileTargetArg(arg)) {
    return true;
  }
  const filePath = path.isAbsolute(arg) ? arg : path.resolve(cwd, arg);
  return fsImpl.existsSync(filePath)
    ? isDelegableBroadProjectRouterTarget(arg, cwd) ||
        isOwnedAgentDirectoryTarget(arg, cwd, fsImpl) ||
        isOwnedExtensionRootTarget(arg, cwd, fsImpl)
    : path.extname(arg) === "" &&
        /^(?:src|test|extensions|ui|packages|apps)\//u.test(toRepoRelativeArg(arg, cwd));
}

function collectExplicitFileTargetArgs(
  argv: string[],
  predicate: (arg: string) => boolean = isExplicitFileTargetArg,
): string[] {
  const files: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === undefined) {
      break;
    }
    if (arg === "--") {
      break;
    }
    if (optionConsumesNextArg(arg)) {
      index += 1;
      continue;
    }
    if (arg.startsWith("-")) {
      continue;
    }
    if (predicate(arg)) {
      files.push(arg);
    }
  }
  return files;
}

function collectExplicitProjectRouterTargetArgs(
  argv: string[],
  cwd = process.cwd(),
  fsImpl: VitestPathFs = fs,
): string[] {
  return collectExplicitFileTargetArgs(argv, (arg) =>
    isExplicitProjectRouterTargetArg(arg, cwd, fsImpl),
  );
}

function isExplicitDirectoryTargetArg(
  arg: string,
  cwd = process.cwd(),
  fsImpl: VitestPathFs = fs,
): boolean {
  if (!isPathLikeExplicitFileArg(arg) || GLOB_PATTERN_CHARS_RE.test(arg)) {
    return false;
  }
  const targetPath = path.isAbsolute(arg) ? arg : path.resolve(cwd, arg);
  try {
    return fsImpl.statSync(targetPath).isDirectory();
  } catch {
    return false;
  }
}

function collectExplicitDirectoryTargetArgs(
  argv: string[],
  cwd = process.cwd(),
  fsImpl: VitestPathFs = fs,
): string[] {
  return collectExplicitFileTargetArgs(argv, (arg) =>
    isExplicitDirectoryTargetArg(arg, cwd, fsImpl),
  );
}

function collectExplicitTestFileArgs(argv: string[]): string[] {
  return collectExplicitFileTargetArgs(argv, isExplicitTestFileArg);
}

/**
 * Forces explicit test-file targets to fail when Vitest finds no matching tests.
 */
export function resolveExplicitTestFileNoPassArgs(argv: string[]): string[] {
  if (collectExplicitTestFileArgs(argv).length === 0) {
    return argv;
  }
  const sentinelIndex = argv.indexOf("--");
  if (sentinelIndex === -1) {
    return [...argv, "--passWithNoTests=false"];
  }
  return [...argv.slice(0, sentinelIndex), "--passWithNoTests=false", ...argv.slice(sentinelIndex)];
}

function hasAlternateVitestRootArg(argv: string[]): boolean {
  return argv.some(
    (arg) =>
      arg === "--root" ||
      arg === "-r" ||
      arg === "--dir" ||
      arg.startsWith("--root=") ||
      arg.startsWith("--dir="),
  );
}

function hasExplicitVitestProjectArg(argv: string[]): boolean {
  return argv.some((arg) => arg === "--project" || arg.startsWith("--project="));
}

function hasExplicitDisabledRunFlag(argv: string[]): boolean {
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === undefined) {
      break;
    }
    if (arg === "--") {
      break;
    }
    const runFlag = resolveBooleanModeFlag(argv, index, "run");
    if (!runFlag) {
      if (optionConsumesNextArg(arg)) {
        index += 1;
      }
      continue;
    }
    if (runFlag.consumedNext) {
      index += 1;
    }
    if (!runFlag.value) {
      return true;
    }
  }
  return false;
}

function resolveDelegatedVitestArgs(argv: string[]): string[] {
  const positionalArgs: string[] = [];
  const optionArgs: string[] = [];
  let canRemoveRunSubcommand = true;
  let passthrough = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === undefined) {
      break;
    }
    if (arg === "--") {
      passthrough = true;
      canRemoveRunSubcommand = false;
      continue;
    }
    if (passthrough) {
      optionArgs.push(arg);
      continue;
    }
    if (optionConsumesNextArg(arg)) {
      optionArgs.push(arg);
      const optionValue = argv[index + 1];
      if (optionValue !== undefined) {
        optionArgs.push(optionValue);
        index += 1;
      }
      continue;
    }
    if (arg.startsWith("-")) {
      optionArgs.push(arg);
      continue;
    }
    if (canRemoveRunSubcommand && arg === "run") {
      canRemoveRunSubcommand = false;
      continue;
    }
    canRemoveRunSubcommand = false;
    positionalArgs.push(arg);
  }
  return optionArgs.length > 0 ? [...positionalArgs, "--", ...optionArgs] : positionalArgs;
}

function hasNonRunVitestSubcommand(argv: string[]): boolean {
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === undefined) {
      break;
    }
    if (arg === "--") {
      return false;
    }
    if (optionConsumesNextArg(arg)) {
      index += 1;
      continue;
    }
    if (arg.startsWith("-")) {
      continue;
    }
    return NON_RUN_VITEST_SUBCOMMANDS.has(arg);
  }
  return false;
}

/**
 * Delegates explicit path runs to the repo test-projects runner.
 */
export function resolveTestProjectsDelegationArgs(
  argv: string[],
  cwd = process.cwd(),
): string[] | null {
  if (
    hasExplicitVitestConfigArg(argv) ||
    hasAlternateVitestRootArg(argv) ||
    hasExplicitVitestProjectArg(argv) ||
    resolveExplicitVitestMode(argv) === "watch" ||
    hasNonRunVitestSubcommand(argv) ||
    hasExplicitDisabledRunFlag(argv) ||
    collectExplicitProjectRouterTargetArgs(argv, cwd).length === 0
  ) {
    return null;
  }
  return resolveDelegatedVitestArgs(argv);
}

/**
 * Lists explicit test file targets missing from the current checkout.
 */
export function resolveMissingExplicitTestFiles(
  argv: string[],
  cwd = process.cwd(),
  fsImpl: Pick<VitestFs, "existsSync"> = fs,
): string[] {
  if (hasExplicitVitestConfigArg(argv) || hasAlternateVitestRootArg(argv)) {
    return [];
  }
  return collectExplicitFileTargetArgs(argv)
    .filter((arg) => {
      const filePath = path.isAbsolute(arg) ? arg : path.resolve(cwd, arg);
      return !fsImpl.existsSync(filePath);
    })
    .map((arg) => toRepoRelativeArg(arg, cwd));
}

function toRepoRelativeArg(arg: string, cwd: string): string {
  const normalized = path.isAbsolute(arg) ? path.relative(cwd, arg) : arg;
  return normalized.replaceAll(path.sep, "/").replace(/^\.\//u, "");
}

function withImplicitVitestConfig(argv: string[], config: string): string[] {
  if (argv[0] === "run") {
    return ["run", "--config", config, ...argv.slice(1)];
  }
  return ["--config", config, ...argv];
}

function isToolingTestTarget(target: string): boolean {
  return (
    target.startsWith("test/") && target.endsWith(".test.ts") && !TOOLING_EXCLUDED_TESTS.has(target)
  );
}

function isToolingDockerTestTarget(target: string): boolean {
  return target === "test/scripts/docker-build-helper.test.ts";
}

/**
 * Resolves config defaults and explicit-file handling for wrapper-inferred runs.
 */
export function resolveImplicitVitestArgs(argv: string[], cwd = process.cwd()): string[] {
  if (hasExplicitVitestConfigArg(argv)) {
    return argv;
  }
  const separatorIndex = argv.indexOf("--");
  const optionArgs = separatorIndex < 0 ? argv : argv.slice(0, separatorIndex);
  const hasExplicitIsolation = optionArgs.some(
    (arg) => arg === "--isolate" || arg === "--no-isolate" || arg.startsWith("--isolate="),
  );
  if (!hasExplicitIsolation && collectExplicitDirectoryTargetArgs(argv, cwd).length > 1) {
    // Mixed directory selectors can activate overlapping Vitest projects.
    // Isolate their module caches so one project's mocks cannot poison another.
    const resolved = [...argv];
    resolved.splice(separatorIndex < 0 ? resolved.length : separatorIndex, 0, "--isolate");
    return resolved;
  }
  const testTargets = argv
    .filter((arg) => !arg.startsWith("-") && arg.endsWith(".test.ts"))
    .map((arg) => toRepoRelativeArg(arg, cwd));
  if (testTargets.length > 0 && testTargets.every(isToolingDockerTestTarget)) {
    return withImplicitVitestConfig(argv, TOOLING_DOCKER_VITEST_CONFIG);
  }
  if (testTargets.length > 0 && testTargets.every(isToolingTestTarget)) {
    return withImplicitVitestConfig(argv, TOOLING_VITEST_CONFIG);
  }
  if (testTargets.length > 0 && testTargets.every(isUiTestTarget)) {
    return withImplicitVitestConfig(argv, UI_VITEST_CONFIG);
  }
  return argv;
}

function spawnVitestProcess({
  pnpmArgs,
  spawnParams,
}: {
  pnpmArgs: string[];
  spawnParams: PnpmRunnerParams;
}): ChildProcess {
  const directNodeArgs = resolveDirectNodeVitestArgs(pnpmArgs);
  if (directNodeArgs) {
    return spawn(process.execPath, directNodeArgs, spawnParams);
  }
  return spawnPnpmRunner({
    pnpmArgs,
    ...spawnParams,
  });
}

/**
 * Installs the no-output watchdog for long-running Vitest children.
 */
export function installVitestNoOutputWatchdog(params: {
  streams?: Array<WatchdogStream | null>;
  timeoutMs: number | null;
  heartbeatMs?: number | null;
  label?: string;
  forceKillAfterMs?: number;
  log?: (message: string) => void;
  onTimeout?: () => void;
  onForceKill?: () => void;
  setTimeoutFn?: typeof setTimeout;
  clearTimeoutFn?: typeof clearTimeout;
}): () => void {
  const timeoutMs = params.timeoutMs;
  if (!timeoutMs || timeoutMs <= 0) {
    return () => {};
  }

  const setTimeoutFn = params.setTimeoutFn ?? setTimeout;
  const clearTimeoutFn = params.clearTimeoutFn ?? clearTimeout;
  const forceKillAfterMs = params.forceKillAfterMs ?? 5_000;
  const heartbeatMs =
    params.heartbeatMs && params.heartbeatMs > 0 && params.heartbeatMs < timeoutMs
      ? params.heartbeatMs
      : null;
  const streams =
    params.streams?.filter((stream): stream is WatchdogStream => stream !== null) ?? [];
  const label = params.label?.trim();
  const suffix = label ? ` (${label})` : "";

  let active = true;
  let silenceTimer: ReturnType<typeof setTimeout> | null = null;
  let forceKillTimer: ReturnType<typeof setTimeout> | null = null;
  let heartbeatTimer: ReturnType<typeof setTimeout> | null = null;
  let silentForMs = 0;
  let timedOut = false;

  const clearHeartbeatTimer = () => {
    if (heartbeatTimer !== null) {
      clearTimeoutFn(heartbeatTimer);
      heartbeatTimer = null;
    }
  };

  const clearForceKillTimer = () => {
    if (forceKillTimer !== null) {
      clearTimeoutFn(forceKillTimer);
      forceKillTimer = null;
    }
  };

  const clearSilenceTimer = () => {
    if (silenceTimer !== null) {
      clearTimeoutFn(silenceTimer);
      silenceTimer = null;
    }
  };

  const scheduleHeartbeatTimer = () => {
    if (!active || heartbeatMs === null) {
      return;
    }
    clearHeartbeatTimer();
    heartbeatTimer = setTimeoutFn(() => {
      if (!active) {
        return;
      }
      silentForMs += heartbeatMs;
      params.log?.(`[vitest] still running with no output for ${silentForMs}ms${suffix}.`);
      if (silentForMs + heartbeatMs < timeoutMs) {
        scheduleHeartbeatTimer();
      }
    }, heartbeatMs);
  };

  const resetSilenceTimer = () => {
    if (!active) {
      return;
    }
    clearSilenceTimer();
    silentForMs = 0;
    scheduleHeartbeatTimer();
    silenceTimer = setTimeoutFn(() => {
      if (!active) {
        return;
      }
      clearHeartbeatTimer();
      timedOut = true;
      params.log?.(
        `[vitest] no output for ${timeoutMs}ms; terminating stalled Vitest process group${suffix}.`,
      );
      params.onTimeout?.();
      if (forceKillAfterMs > 0) {
        clearForceKillTimer();
        forceKillTimer = setTimeoutFn(() => {
          if (!active) {
            return;
          }
          params.log?.(
            `[vitest] process group still alive after ${forceKillAfterMs}ms; sending SIGKILL${suffix}.`,
          );
          params.onForceKill?.();
        }, forceKillAfterMs);
      }
    }, timeoutMs);
  };

  const handleActivity = () => {
    if (timedOut) {
      return;
    }
    clearForceKillTimer();
    resetSilenceTimer();
  };

  const listeners = streams.map((stream) => {
    const handler = () => {
      handleActivity();
    };
    stream.on("data", handler);
    return { stream, handler };
  });

  resetSilenceTimer();

  return () => {
    if (!active) {
      return;
    }
    active = false;
    clearSilenceTimer();
    clearForceKillTimer();
    clearHeartbeatTimer();
    for (const { stream, handler } of listeners) {
      stream.off("data", handler);
    }
  };
}

/**
 * Forwards child output while optionally suppressing complete stderr lines.
 */
function forwardVitestOutput(
  stream: VitestOutputStream | null,
  target: VitestOutputTarget,
  shouldSuppressLine: (line: string) => boolean = () => false,
): void {
  if (!stream) {
    return;
  }

  let buffered = "";
  stream.setEncoding("utf8");
  stream.on("data", (chunk) => {
    buffered += chunk;
    while (true) {
      const newlineIndex = buffered.indexOf("\n");
      if (newlineIndex === -1) {
        break;
      }
      const line = buffered.slice(0, newlineIndex + 1);
      buffered = buffered.slice(newlineIndex + 1);
      if (!shouldSuppressLine(line)) {
        target.write(line);
      }
    }
  });
  stream.on("end", () => {
    if (buffered.length > 0 && !shouldSuppressLine(buffered)) {
      target.write(buffered);
    }
  });
}

/**
 * Spawns Vitest with output forwarding, watchdogs, and process-group cleanup.
 */
export function spawnWatchedVitestProcess({
  pnpmArgs,
  spawnParams,
  env,
  label,
  onNoOutputTimeout,
}: {
  pnpmArgs: string[];
  spawnParams: PnpmRunnerParams;
  env: NodeJS.ProcessEnv;
  label?: string;
  onNoOutputTimeout?: () => void;
}) {
  let forwardedSignal: NodeSignal | null = null;
  const child = spawnVitestProcess({
    pnpmArgs,
    spawnParams,
  });
  const teardownChildCleanup = installVitestProcessGroupCleanup({
    child,
    forceSignal: "SIGKILL",
    forceSignalDelayMs: 100,
    onSignal: (signal) => {
      forwardedSignal ??= signal;
    },
  });
  const teardownNoOutputWatchdog = installVitestNoOutputWatchdog({
    streams: [child.stdout, child.stderr],
    timeoutMs: resolveVitestNoOutputTimeoutMs(env),
    heartbeatMs: resolveVitestNoOutputHeartbeatMs(env),
    label,
    log: (message) => {
      console.error(message);
    },
    onTimeout: () => {
      onNoOutputTimeout?.();
      forwardSignalToVitestProcessGroup({
        child,
        signal: "SIGTERM",
        kill: process.kill.bind(process),
      });
    },
    onForceKill: () => {
      forwardSignalToVitestProcessGroup({
        child,
        signal: "SIGKILL",
        kill: process.kill.bind(process),
      });
    },
  });
  forwardVitestOutput(child.stdout, process.stdout);
  forwardVitestOutput(child.stderr, process.stderr, shouldSuppressVitestStderrLine);

  const teardown = () => {
    teardownChildCleanup();
    teardownNoOutputWatchdog();
  };
  const completion = createVitestProcessCompletion({
    child,
    detached: spawnParams.detached === true,
  })
    .then(({ code, signal }) => ({ code, signal: normalizeNodeSignal(signal) }))
    .finally(teardown);

  return {
    child,
    completion,
    getForwardedSignal: () => forwardedSignal,
    teardown,
  };
}

async function finishVitestProcess({
  completion,
  getForwardedSignal,
}: Pick<VitestProcessHandle, "completion" | "getForwardedSignal">): Promise<number> {
  const { code, signal } = await completion;
  const exitSignal = getForwardedSignal() ?? signal;
  if (exitSignal) {
    writeFailedTrailer("vitest", signalExitCode(exitSignal));
    process.kill(process.pid, exitSignal);
    return signalExitCode(exitSignal);
  }
  const exitCode = code ?? 1;
  process.exitCode = exitCode;
  return exitCode;
}

async function main(
  argv: string[] = process.argv.slice(2),
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  if (argv.length === 0) {
    console.error("usage: node scripts/run-vitest.mjs <vitest args...>");
    process.exitCode = 1;
    return;
  }

  const missingTestFiles = resolveMissingExplicitTestFiles(argv);
  if (missingTestFiles.length > 0) {
    console.error(
      [
        "[vitest] explicit test/source file(s) not found:",
        ...missingTestFiles.map((file) => `  - ${file}`),
      ].join("\n"),
    );
    process.exitCode = 1;
    return;
  }

  const delegatedArgs = resolveTestProjectsDelegationArgs(argv);
  if (delegatedArgs) {
    await finishVitestProcess(spawnTestProjectsRunner(delegatedArgs, env));
    return;
  }

  const vitestArgs = resolveImplicitVitestArgs(argv);
  const invocations = resolveBoundedVitestInvocations(vitestArgs, { env });
  let vitestCliEntry;
  try {
    vitestCliEntry = resolveVitestCliEntry();
  } catch (error) {
    if (isErrorWithCode(error, "OPENCLAW_MISSING_VITEST")) {
      console.error(error.message);
      process.exitCode = 1;
      return;
    }
    throw error;
  }

  for (const [index, invocation] of invocations.entries()) {
    const guardedVitestArgs = resolveExplicitTestFileNoPassArgs(invocation);
    const spawnEnv = resolveRunVitestSpawnEnv(env, guardedVitestArgs);
    if (invocations.length > 1) {
      console.error("[vitest] Gateway server process " + (index + 1) + "/" + invocations.length);
    }
    const exitCode = await finishVitestProcess(
      spawnWatchedVitestProcess({
        pnpmArgs: [
          "exec",
          "node",
          ...resolveVitestNodeArgs(env),
          vitestCliEntry,
          ...guardedVitestArgs,
        ],
        spawnParams: resolveVitestSpawnParams(spawnEnv),
        env: spawnEnv,
        label: guardedVitestArgs.join(" "),
      }),
    );
    if (exitCode !== 0) {
      return;
    }
  }
}

if (import.meta.main) {
  await runWithFailedTrailer("vitest", main);
}
