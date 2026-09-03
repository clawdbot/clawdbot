// Runs Vitest through repo project selection, local scheduling policy, output
// watchdogs, and process-group cleanup.
import fs from "node:fs";
import { constants as osConstants } from "node:os";
import path from "node:path";
import { assertTestHomeSelection } from "../test/test-home-policy.mts";
import { agentVitestProjectOwners } from "../test/vitest/vitest.agents-paths.mjs";
import { toolingIsolatedTestFiles } from "../test/vitest/vitest.tooling-isolated-paths.mjs";
import { isUiBrowserTestFile, isUiTestTarget } from "../test/vitest/vitest.ui-paths.mjs";
import { boundaryTestFiles } from "../test/vitest/vitest.unit-paths.mjs";
import { parsePermissiveBooleanToken } from "./lib/arg-utils.mts";
import { resolveExtensionTestConfig } from "./lib/extension-test-plan.mts";
import { createGatewayServerTestTargetChunks } from "./lib/gateway-server-test-plan.mts";
import { resolveRepoRoot } from "./lib/repo-root.mjs";
import { spawnTestProjectsRunner } from "./lib/test-projects-delegation.mts";
import {
  prepareE2eVitestRuntime,
  resolveVitestCliEntry,
  resolveVitestRuntimeCliSelections,
  prepareVitestRuntime,
} from "./lib/vitest-build-prerequisites.mts";
import {
  hasNonRunVitestSubcommand,
  collectVitestFileFilters,
  resolveBooleanModeFlag,
  resolveExplicitVitestMode,
  vitestOptionConsumesNextArg,
} from "./lib/vitest-cli-mode.mts";
import { parseVitestExecutionArgs } from "./lib/vitest-cli.mts";
import { resolveVitestHomeSelection } from "./lib/vitest-home-selection.mts";
import {
  resolveVitestProcessEnv,
  resolveVitestNodeArgs,
  resolveRunVitestSpawnEnv,
  resolveVitestNoOutputTimeoutMs,
  resolveVitestNoOutputHeartbeatMs,
  resolveVitestCompileCacheSafeEnv,
  resolveVitestConfigArg,
  normalizeVitestConfigPath,
  matchesVitestConfigPath,
} from "./lib/vitest-process-env.mts";
import {
  spawnOwnedVitestProcess,
  runVitestCli,
  type exitVitestBySignal,
} from "./lib/vitest-process.mts";
import {
  createVitestUnhandledErrorDetector,
  stripVitestAnsi,
  writeVitestUnhandledErrorSummary,
} from "./lib/vitest-unhandled-errors.mts";
import { createVitestWorkerRun, type VitestWorkerRun } from "./lib/vitest-worker-run.mts";
import { createPnpmRunnerSpawnSpec, type PnpmRunnerParams } from "./pnpm-runner.mts";
import {
  forwardSignalToVitestProcessGroup,
  installVitestProcessGroupCleanup,
  shouldUseDetachedVitestProcessGroup,
  terminateVitestProcessGroupForTimeout,
} from "./vitest-process-group.mts";

type VitestPathFs = Pick<typeof fs, "existsSync" | "statSync">;
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

const SUPPRESSED_VITEST_STDERR_PATTERNS = ["[PLUGIN_TIMINGS]"];
const UI_VITEST_CONFIG = "test/vitest/vitest.ui.config.ts";
const UI_BROWSER_VITEST_CONFIG = "test/vitest/vitest.ui-browser.config.ts";
const TOOLING_DOCKER_VITEST_CONFIG = "test/vitest/vitest.tooling-docker.config.ts";
const TOOLING_VITEST_CONFIG = "test/vitest/vitest.tooling.config.ts";
const GATEWAY_SERVER_VITEST_CONFIG = "test/vitest/vitest.gateway-server.config.ts";
const E2E_VITEST_CONFIG = "test/vitest/vitest.e2e.config.ts";
const E2E_TEST_PROCESS_COUNT = 4;
export const TOOLING_EXCLUDED_TESTS = new Set([
  ...boundaryTestFiles,
  "test/scripts/docker-build-helper.test.ts",
  ...toolingIsolatedTestFiles,
]);
const EXPLICIT_FILE_TARGET_RE = /\.(?:[cm]?[jt]sx?)$/u;
const EXPLICIT_TEST_FILE_RE = /\.(?:test|e2e|live)\.(?:[cm]?[jt]sx?)$/u;
const GLOB_PATTERN_CHARS_RE = /[*?[\]{}]/u;
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
 * Bounds shared-worker lifetime with fresh processes so broad non-isolated
 * runs do not exhaust the worker heap.
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
  const isE2E = matchesVitestConfigPath(normalizedConfig, E2E_VITEST_CONFIG);
  if (
    (!isE2E && !matchesVitestConfigPath(normalizedConfig, GATEWAY_SERVER_VITEST_CONFIG)) ||
    mode === "watch" ||
    hasExplicitDisabledRunFlag(argv) ||
    (mode !== "run" && parsePermissiveBooleanToken(env.CI) !== true) ||
    hasNonRunVitestSubcommand(argv) ||
    hasAlternateVitestRootArg(argv) ||
    collectExplicitProjectRouterTargetArgs(argv, cwd).length > 0 ||
    [...UNBOUNDED_CONFIG_ONLY_OPTIONS, "--bail"].some((option) => hasVitestOption(argv, option))
  ) {
    return [argv];
  }
  if (isE2E) {
    // Let Vitest own include/exclude and shard membership. Filtered and report-producing
    // calls retain one process so small selections and aggregate outputs keep their semantics.
    if (
      collectExplicitFileTargetArgs(argv, (arg) => arg !== "run").length > 0 ||
      argv.includes("--") ||
      [
        "--exclude",
        "--testNamePattern",
        "-t",
        "--tagsFilter",
        "--sequence.sequencer",
        "--reporter",
        "--reporters",
        "--listTags",
        "--clearCache",
        "--standalone",
        "--help",
        "-h",
        "--version",
        "-v",
      ].some((option) => hasVitestOption(argv, option))
    ) {
      return [argv];
    }
    return Array.from({ length: E2E_TEST_PROCESS_COUNT }, (_, index) => [
      ...argv,
      `--shard=${index + 1}/${E2E_TEST_PROCESS_COUNT}`,
    ]);
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
    env: resolveVitestProcessEnv(resolveVitestCompileCacheSafeEnv(env)),
    detached: shouldUseDetachedVitestProcessGroup(platform),
    stdio: ["inherit", "pipe", "pipe"],
  };
}

/**
 * Filters known noisy Vitest stderr lines after stripping ANSI escapes.
 */
export function shouldSuppressVitestStderrLine(line: string): boolean {
  const normalizedLine = stripVitestAnsi(line);
  return SUPPRESSED_VITEST_STDERR_PATTERNS.some((pattern) => normalizedLine.includes(pattern));
}

/**
 * Detects pnpm exec node invocations so the wrapper can spawn Node directly.
 */
export function resolveDirectNodeVitestArgs(pnpmArgs: string[]): string[] | null {
  return pnpmArgs[0] === "exec" && pnpmArgs[1] === "node" ? pnpmArgs.slice(2) : null;
}

function hasExplicitVitestConfigArg(argv: string[]): boolean {
  // Delegation consumes separators; keep config-bearing argv direct so its tail
  // cannot become an active override in the project runner.
  return argv.some(
    (arg) =>
      arg === "--config" || arg === "-c" || arg.startsWith("--config=") || arg.startsWith("-c="),
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
  return collectVitestFileFilters(argv).filter(predicate);
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
export async function resolveExplicitTestFileNoPassArgs(argv: string[]): Promise<string[]> {
  if (collectExplicitTestFileArgs(argv).length === 0) {
    return argv;
  }
  const policyArgs: string[] = [];
  const spellings = new Set(["passWithNoTests"]);
  for (const [index, arg] of argv.entries()) {
    if (arg === "--") {
      break;
    }
    const spelling = /^(?:--(?!-)(?:no-)?|-+no-)([^=.]+)/u.exec(arg)?.[1];
    if (
      !spelling ||
      spelling.replace(/([a-z])-([a-z])/gu, (_, a: string, b: string) => a + b.toUpperCase()) !==
        "passWithNoTests"
    ) {
      continue;
    }
    policyArgs.push(arg);
    spellings.add(spelling);
    const value = argv[index + 1];
    if (arg.replace(/[=]$/u, "") === `--${spelling}` && (value === "true" || value === "false")) {
      policyArgs.push(value);
    }
  }
  if (policyArgs.length) {
    const { parseCLI } = await import("vitest/node");
    // Validate only the scalar policy can overwrite; the child owns help/version
    // and unrelated errors. parseCLI mutates its input, so always give it a copy.
    parseCLI(["vitest", ...policyArgs], { allowUnknownOptions: true });
  }
  // CAC camelcases after parsing. Negate every raw spelling so a later alias
  // cannot overwrite strict policy, without erasing caller scalar errors.
  return insertVitestTargets(
    argv,
    Array.from(spellings, (name) => `--no-${name}`),
  );
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
      if (vitestOptionConsumesNextArg(arg, argv[index + 1])) {
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
    if (vitestOptionConsumesNextArg(arg, argv[index + 1])) {
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
  fsImpl: { existsSync(filePath: string): boolean } = fs,
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
  if (collectExplicitDirectoryTargetArgs(argv, cwd).length > 0) {
    return argv;
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
  // Glob selectors can span both browser owners; the root project matrix partitions them.
  if (testTargets.some((target) => /[*?[\]{}]|[@+!]\(/u.test(target))) {
    return argv;
  }
  if (testTargets.length > 0 && testTargets.every(isUiBrowserTestFile)) {
    return withImplicitVitestConfig(argv, UI_BROWSER_VITEST_CONFIG);
  }
  if (
    testTargets.length > 0 &&
    testTargets.every((target) => isUiTestTarget(target) && !isUiBrowserTestFile(target))
  ) {
    return withImplicitVitestConfig(argv, UI_VITEST_CONFIG);
  }
  return argv;
}

/**
 * Installs the no-output watchdog for long-running Vitest children.
 */
export function installVitestNoOutputWatchdog(params: {
  streams?: Array<WatchdogStream | null>;
  timeoutMs: number | null;
  heartbeatMs?: number | null;
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
      params.log?.(`[vitest] still running with no output for ${silentForMs}ms.`);
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
        `[vitest] no output for ${timeoutMs}ms; terminating stalled Vitest process group.`,
      );
      if (forceKillAfterMs > 0) {
        clearForceKillTimer();
        forceKillTimer = setTimeoutFn(() => {
          if (!active) {
            return;
          }
          params.log?.(
            `[vitest] process group still alive after ${forceKillAfterMs}ms; sending SIGKILL.`,
          );
          params.onForceKill?.();
        }, forceKillAfterMs);
      }
      params.onTimeout?.();
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
  observeLine: (line: string) => void = () => {},
): Promise<void> {
  if (!stream) {
    return Promise.resolve();
  }

  let buffered = "";
  const forwardLine = (line: string) => {
    if (shouldSuppressLine(line)) {
      return;
    }
    observeLine(line);
    target.write(line);
  };
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
      forwardLine(line);
    }
  });
  return new Promise((resolve) => {
    stream.on("end", () => {
      if (buffered.length > 0) {
        forwardLine(buffered);
      }
      resolve();
    });
  });
}

/**
 * Spawns Vitest with output forwarding, watchdogs, and process-group cleanup.
 */
export function spawnWatchedVitestProcess({
  pnpmArgs,
  spawnParams,
  env,
  onNoOutputTimeout,
  workerRun,
  homeMode = resolveVitestHomeSelection(pnpmArgs, { cwd: spawnParams.cwd, env }),
}: {
  pnpmArgs: string[];
  spawnParams: PnpmRunnerParams;
  env: NodeJS.ProcessEnv;
  onNoOutputTimeout?: () => void;
  workerRun?: VitestWorkerRun;
  homeMode?: Parameters<typeof spawnOwnedVitestProcess>[0]["homeMode"];
}) {
  if (homeMode !== "tooling") {
    assertTestHomeSelection(env, homeMode);
  }
  let diagnosticsCompletion: Promise<void> | null = null;
  const directNodeArgs = resolveDirectNodeVitestArgs(pnpmArgs);
  if (workerRun && directNodeArgs) {
    // Preserve Node flags while giving the same owned child its private generation.
    const cliIndex = directNodeArgs.findIndex((arg) => path.basename(arg) === "vitest.mjs");
    if (cliIndex < 0) {
      throw new Error("Compiled subprocess owner requires a native Vitest CLI spec");
    }
    directNodeArgs.splice(
      cliIndex,
      0,
      path.join(resolveRepoRoot(import.meta.url), "scripts/lib/vitest-worker-bootstrap.mts"),
      workerRun.descriptor.directory,
    );
  }
  const childSpawnParams: PnpmRunnerParams = workerRun
    ? {
        ...spawnParams,
        stdio: [
          ...(Array.isArray(spawnParams.stdio)
            ? spawnParams.stdio
            : [
                spawnParams.stdio ?? "pipe",
                spawnParams.stdio ?? "pipe",
                spawnParams.stdio ?? "pipe",
              ]),
          "ipc",
        ],
      }
    : spawnParams;
  const { child, completion: childCompletion } = spawnOwnedVitestProcess({
    ...(directNodeArgs
      ? { command: process.execPath, args: directNodeArgs, options: childSpawnParams }
      : createPnpmRunnerSpawnSpec({ pnpmArgs, ...childSpawnParams })),
    homeMode,
  });
  const childCleanup = installVitestProcessGroupCleanup({
    child,
    forceSignal: "SIGKILL",
    forceSignalDelayMs: 100,
  });
  const teardownNoOutputWatchdog = installVitestNoOutputWatchdog({
    streams: [child.stdout, child.stderr],
    timeoutMs: resolveVitestNoOutputTimeoutMs(env),
    heartbeatMs: resolveVitestNoOutputHeartbeatMs(env),
    log: (message) => {
      console.error(message);
    },
    onTimeout: () => {
      const termination = terminateVitestProcessGroupForTimeout({
        child,
        kill: process.kill.bind(process),
        log: (message) => {
          console.error(message);
        },
        onTimeout: onNoOutputTimeout,
      });
      diagnosticsCompletion = termination.diagnostics;
    },
    onForceKill: () => {
      forwardSignalToVitestProcessGroup({
        child,
        signal: "SIGKILL",
        kill: process.kill.bind(process),
      });
    },
  });
  const unhandledErrors = createVitestUnhandledErrorDetector();
  const forwardedOutput = Promise.all([
    forwardVitestOutput(child.stdout, process.stdout, undefined, unhandledErrors.observe),
    forwardVitestOutput(
      child.stderr,
      process.stderr,
      shouldSuppressVitestStderrLine,
      unhandledErrors.observe,
    ),
  ]);

  const teardown = () => {
    childCleanup.teardown();
    teardownNoOutputWatchdog();
  };
  const completion = Promise.all([childCompletion, forwardedOutput])
    .then(async ([{ code, signal }]) => {
      await diagnosticsCompletion;
      const result = unhandledErrors.finish();
      if (result) {
        writeVitestUnhandledErrorSummary(result, env);
      }
      return { code, signal: normalizeNodeSignal(signal) };
    })
    .finally(teardown);

  return {
    child,
    completion: workerRun ? workerRun.borrow(child, completion) : completion,
    getForwardedSignal: childCleanup.getForwardedSignal,
    teardown,
  };
}

export async function runVitest(
  exitBySignal: typeof exitVitestBySignal,
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
    const handle = spawnTestProjectsRunner(delegatedArgs, env);
    const { code, signal } = await handle.completion;
    const exitSignal = handle.getForwardedSignal() ?? signal;
    if (exitSignal) {
      await exitBySignal(exitSignal);
    }
    process.exitCode = code ?? 1;
    return;
  }

  const vitestArgs = resolveImplicitVitestArgs(argv);
  assertTestHomeSelection(env, resolveVitestHomeSelection(vitestArgs, { env }));
  const repoRoot = resolveRepoRoot(import.meta.url);
  let vitestCliEntry;
  try {
    // Resolution owns hydrated-module linking and missing-dependency guidance;
    // it must finish before the execution parser imports Vitest.
    vitestCliEntry = resolveVitestCliEntry({ baseDir: repoRoot });
  } catch (error) {
    if (isErrorWithCode(error, "OPENCLAW_MISSING_VITEST")) {
      console.error(error.message);
      process.exitCode = 1;
      return;
    }
    throw error;
  }
  const { parseCLI } = await import("vitest/node");
  const execution = parseVitestExecutionArgs(vitestArgs, parseCLI);
  const invocations = execution
    ? resolveBoundedVitestInvocations(vitestArgs, { env })
    : [vitestArgs];
  const config = resolveVitestConfigArg(vitestArgs);
  const relativeConfig = config ? toRepoRelativeArg(path.resolve(config), repoRoot) : "";
  const invocationEnv =
    invocations.length > 1 && relativeConfig === E2E_VITEST_CONFIG
      ? { ...env, ...(await prepareE2eVitestRuntime(env)) }
      : env;
  // Canonical configs have known project scopes. Custom roots/projects keep
  // their own setup; never infer their runtime selection from a config name.
  if (
    execution &&
    config &&
    !hasAlternateVitestRootArg(vitestArgs) &&
    !hasExplicitVitestProjectArg(vitestArgs) &&
    !hasNonRunVitestSubcommand(vitestArgs) &&
    !hasExplicitDisabledRunFlag(vitestArgs)
  ) {
    const code = await prepareVitestRuntime(
      invocations.flatMap((cliArgs) =>
        resolveVitestRuntimeCliSelections(relativeConfig, cliArgs, invocationEnv),
      ),
      invocationEnv,
    );
    if (code !== 0) {
      process.exitCode = code;
      return;
    }
  }
  const sourceMode =
    !execution || execution.options.watch || resolveExplicitVitestMode(vitestArgs) === "watch";
  const workers = sourceMode ? undefined : createVitestWorkerRun();
  let interrupted: NodeJS.Signals | undefined;
  const onSignal = (signal: NodeJS.Signals) => {
    interrupted ??= signal;
  };
  // The invocation outlives child-scoped handlers when admission or final
  // verification is still reading. Retain signal ownership through disposal.
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
  try {
    let failedExitCode = 0;
    for (const [index, invocation] of invocations.entries()) {
      const guardedVitestArgs = await resolveExplicitTestFileNoPassArgs(invocation);
      const spawnEnv = resolveRunVitestSpawnEnv(invocationEnv, guardedVitestArgs);
      if (invocations.length > 1) {
        console.error("[vitest] bounded process " + (index + 1) + "/" + invocations.length);
      }
      const handle = spawnWatchedVitestProcess({
        workerRun: workers,
        pnpmArgs: [
          "exec",
          "node",
          ...resolveVitestNodeArgs(invocationEnv),
          vitestCliEntry,
          ...guardedVitestArgs,
        ],
        spawnParams: resolveVitestSpawnParams(spawnEnv),
        env: spawnEnv,
      });
      const { code, signal } = await handle.completion;
      interrupted ??= handle.getForwardedSignal() ?? signal ?? undefined;
      const exitCode = code ?? 1;
      // Ordinary test failures must not hide later files; interruptions stop
      // admission and are re-raised only after the invocation has been disposed.
      if (interrupted || (exitCode !== 0 && exitCode !== 1)) {
        process.exitCode = exitCode;
        return;
      }
      failedExitCode ||= exitCode;
    }
    process.exitCode = failedExitCode;
  } finally {
    try {
      await workers?.dispose().catch((error: unknown) => {
        process.exitCode ||= 1;
        console.error(error);
      });
    } finally {
      process.off("SIGINT", onSignal);
      process.off("SIGTERM", onSignal);
      if (interrupted) {
        await exitBySignal(interrupted);
      }
    }
  }
}

if (import.meta.main) {
  await runVitestCli("vitest", runVitest);
}
