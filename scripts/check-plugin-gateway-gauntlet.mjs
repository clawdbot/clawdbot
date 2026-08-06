#!/usr/bin/env node

// Runs plugin lifecycle and gateway QA gauntlet probes with timing metrics.
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { stripLeadingPackageManagerSeparator } from "./lib/arg-utils.mjs";
import {
  parseNonNegativeInt,
  parsePositiveInt,
  parsePositiveNumber,
} from "./lib/numeric-options.mjs";
import {
  buildGauntletPrebuildEnv,
  collectGatewayCpuObservations,
  collectMetricObservations,
  collectPluginsWithRequiredEntries,
  collectRequiredPluginEntries,
  collectQaBaselineRegressionObservations,
  detectCommandDiagnosticFailure,
  discoverBundledPluginManifests,
  readQaSuiteSummary,
  selectPluginEntries,
} from "./lib/plugin-gateway-gauntlet.mjs";

const DEFAULT_QA_SCENARIOS = [
  "channel-chat-baseline",
  "memory-failure-fallback",
  "gateway-restart-inflight-run",
];
const DEFAULT_CPU_CORE_WARN = 0.9;
const DEFAULT_HOT_WALL_WARN_MS = 30_000;
const DEFAULT_MAX_RSS_WARN_MB = 1536;
const DEFAULT_QA_PLUGIN_CHUNK_SIZE = 12;
const SINGLE_VALUE_FLAGS = new Set([
  "--build-timeout-ms",
  "--command-timeout-ms",
  "--cpu-core-warn",
  "--hot-wall-warn-ms",
  "--limit",
  "--max-rss-warn-mb",
  "--output-dir",
  "--qa-cpu-regression-multiplier",
  "--qa-plugin-chunk-size",
  "--qa-timeout-ms",
  "--qa-wall-regression-multiplier",
  "--repo-root",
  "--rss-anomaly-multiplier",
  "--shard-index",
  "--shard-total",
  "--wall-anomaly-multiplier",
]);
const COMMAND_OUTPUT_MAX_BUFFER_BYTES = 16 * 1024 * 1024;
const MAX_TIMER_TIMEOUT_MS = 2_147_000_000;
const ANSI_PATTERN = new RegExp(String.raw`\u001B\[[0-9;]*m`, "gu");

/**
 * Parses plugin gateway gauntlet CLI arguments and env defaults.
 */
export function parseArgs(argv) {
  const args = stripLeadingPackageManagerSeparator(argv);
  const options = {
    repoRoot: process.cwd(),
    outputDir: path.join(
      process.cwd(),
      ".artifacts",
      "plugin-gateway-gauntlet",
      new Date().toISOString().replace(/[:.]/g, "-"),
    ),
    pluginIds: [],
    shardTotal: readOptionalPositiveIntEnv("OPENCLAW_PLUGIN_GATEWAY_GAUNTLET_TOTAL") ?? 1,
    shardIndex: readOptionalNonNegativeIntEnv("OPENCLAW_PLUGIN_GATEWAY_GAUNTLET_INDEX") ?? 0,
    limit: undefined,
    skipPrebuild: false,
    skipLifecycle: false,
    skipQa: false,
    qaBaseline: false,
    skipSlashHelp: false,
    qaScenarios: [],
    qaPluginChunkSize: DEFAULT_QA_PLUGIN_CHUNK_SIZE,
    cpuCoreWarn: DEFAULT_CPU_CORE_WARN,
    hotWallWarnMs: DEFAULT_HOT_WALL_WARN_MS,
    maxRssWarnMb: DEFAULT_MAX_RSS_WARN_MB,
    wallAnomalyMultiplier: 3,
    rssAnomalyMultiplier: 2.5,
    qaCpuRegressionMultiplier: 2,
    qaWallRegressionMultiplier: 2,
    commandTimeoutMs: 120_000,
    buildTimeoutMs: 600_000,
    qaTimeoutMs: 900_000,
    allowEmpty: false,
    failOnObservation: process.env.OPENCLAW_PLUGIN_GATEWAY_GAUNTLET_FAIL_ON_OBSERVATION === "1",
    keepRunRoot: process.env.OPENCLAW_PLUGIN_GATEWAY_GAUNTLET_KEEP_RUN_ROOT === "1",
  };
  const envIds = normalizeCsv(process.env.OPENCLAW_PLUGIN_GATEWAY_GAUNTLET_IDS);
  options.pluginIds.push(...envIds);
  const seenSingleValueFlags = new Set();
  parseArgv: for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (SINGLE_VALUE_FLAGS.has(arg)) {
      if (seenSingleValueFlags.has(arg)) {
        throw new Error(`${arg} was provided more than once`);
      }
      seenSingleValueFlags.add(arg);
    }
    const readValue = () => {
      const value = args[index + 1];
      if (!value || value.startsWith("-")) {
        throw new Error(`Missing value for ${arg}`);
      }
      index += 1;
      return value;
    };
    switch (arg) {
      case "--":
        break parseArgv;
      case "--repo-root":
        options.repoRoot = path.resolve(readValue());
        break;
      case "--output-dir":
        options.outputDir = path.resolve(readValue());
        break;
      case "--plugin":
        options.pluginIds.push(readValue());
        break;
      case "--shard-total":
        options.shardTotal = parsePositiveInt(readValue(), "--shard-total");
        break;
      case "--shard-index":
        options.shardIndex = parseNonNegativeInt(readValue(), "--shard-index");
        break;
      case "--limit":
        options.limit = parsePositiveInt(readValue(), "--limit");
        break;
      case "--qa-scenario":
        options.qaScenarios.push(readValue());
        break;
      case "--qa-plugin-chunk-size":
        options.qaPluginChunkSize = parsePositiveInt(readValue(), "--qa-plugin-chunk-size");
        break;
      case "--qa-baseline":
        options.qaBaseline = true;
        break;
      case "--cpu-core-warn":
        options.cpuCoreWarn = parsePositiveNumber(readValue(), "--cpu-core-warn");
        break;
      case "--hot-wall-warn-ms":
        options.hotWallWarnMs = parsePositiveInt(readValue(), "--hot-wall-warn-ms");
        break;
      case "--max-rss-warn-mb":
        options.maxRssWarnMb = parsePositiveNumber(readValue(), "--max-rss-warn-mb");
        break;
      case "--wall-anomaly-multiplier":
        options.wallAnomalyMultiplier = parsePositiveNumber(
          readValue(),
          "--wall-anomaly-multiplier",
        );
        break;
      case "--rss-anomaly-multiplier":
        options.rssAnomalyMultiplier = parsePositiveNumber(readValue(), "--rss-anomaly-multiplier");
        break;
      case "--qa-cpu-regression-multiplier":
        options.qaCpuRegressionMultiplier = parsePositiveNumber(
          readValue(),
          "--qa-cpu-regression-multiplier",
        );
        break;
      case "--qa-wall-regression-multiplier":
        options.qaWallRegressionMultiplier = parsePositiveNumber(
          readValue(),
          "--qa-wall-regression-multiplier",
        );
        break;
      case "--command-timeout-ms":
        options.commandTimeoutMs = parsePositiveInt(readValue(), "--command-timeout-ms");
        break;
      case "--build-timeout-ms":
        options.buildTimeoutMs = parsePositiveInt(readValue(), "--build-timeout-ms");
        break;
      case "--qa-timeout-ms":
        options.qaTimeoutMs = parsePositiveInt(readValue(), "--qa-timeout-ms");
        break;
      case "--skip-prebuild":
        options.skipPrebuild = true;
        break;
      case "--skip-lifecycle":
        options.skipLifecycle = true;
        break;
      case "--skip-qa":
        options.skipQa = true;
        break;
      case "--skip-slash-help":
        options.skipSlashHelp = true;
        break;
      case "--keep-run-root":
        options.keepRunRoot = true;
        break;
      case "--allow-empty":
        options.allowEmpty = true;
        break;
      case "--fail-on-observation":
        options.failOnObservation = true;
        break;
      case "--help":
        printHelp();
        process.exit(0);
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }
  if (options.qaScenarios.length === 0) {
    options.qaScenarios = [...DEFAULT_QA_SCENARIOS];
  }
  assertNoDuplicateValues(options.pluginIds, "--plugin");
  assertNoDuplicateValues(options.qaScenarios, "--qa-scenario");
  return options;
}

function printHelp() {
  console.log(`Usage: pnpm test:plugins:gateway-gauntlet [options]

Runs a shardable bundled-plugin lifecycle, slash inventory, and QA gateway perf gauntlet.

Options:
  --plugin <id>                  Plugin id to include, repeatable
  --shard-total <count>          Total plugin shards (default: env or 1)
  --shard-index <index>          Zero-based shard index (default: env or 0)
  --limit <count>                Limit selected plugins after sharding
  --output-dir <path>            Artifact directory
  --qa-scenario <id>             QA Lab scenario id, repeatable
  --qa-plugin-chunk-size <count> Plugins enabled per QA run (default: 12)
  --qa-baseline                  Run a no-extra-plugin QA baseline before plugin chunks
  --cpu-core-warn <ratio>        Hot CPU threshold (default: 0.9)
  --hot-wall-warn-ms <ms>        Minimum wall time for hot CPU observations (default: 30000)
  --max-rss-warn-mb <mb>         Maximum RSS warning threshold (default: 1536)
  --wall-anomaly-multiplier <n>  Wall-time anomaly multiplier (default: 3)
  --rss-anomaly-multiplier <n>   RSS anomaly multiplier (default: 2.5)
  --qa-cpu-regression-multiplier <n>  QA baseline CPU regression multiplier (default: 2)
  --qa-wall-regression-multiplier <n> QA baseline wall regression multiplier (default: 2)
  --command-timeout-ms <ms>      Lifecycle/slash command timeout (default: 120000)
  --build-timeout-ms <ms>        Prebuild command timeout (default: 600000)
  --qa-timeout-ms <ms>           QA chunk timeout (default: 900000)
  --skip-prebuild                Skip the upfront build used to avoid per-command rebuild noise
  --skip-lifecycle              Skip plugin install/inspect/disable/enable/doctor/uninstall
  --skip-qa                     Skip QA Lab RPC conversation runs
  --skip-slash-help             Skip CLI help probes for plugin-declared command aliases
  --allow-empty                 Allow zero-command runs when every active phase is skipped
  --fail-on-observation         Treat RSS/CPU/wall observation rows as guard failures
  --keep-run-root               Preserve isolated HOME/state/log temp root after success

Environment:
  OPENCLAW_PLUGIN_GATEWAY_GAUNTLET_IDS   Comma-separated plugin ids to include
  OPENCLAW_PLUGIN_GATEWAY_GAUNTLET_TOTAL Total plugin shards
  OPENCLAW_PLUGIN_GATEWAY_GAUNTLET_INDEX Zero-based shard index
  OPENCLAW_PLUGIN_GATEWAY_GAUNTLET_FAIL_ON_OBSERVATION=1
  OPENCLAW_PLUGIN_GATEWAY_GAUNTLET_KEEP_RUN_ROOT=1
  OPENCLAW_PLUGIN_GATEWAY_GAUNTLET_QA_SUMMARY_MAX_BYTES  QA summary read ceiling
`);
}

function normalizeCsv(raw) {
  return raw
    ? raw
        .split(",")
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0)
    : [];
}

function assertNoDuplicateValues(values, label) {
  const seen = new Set();
  for (const value of values) {
    const normalized = value.trim();
    if (!normalized) {
      continue;
    }
    if (seen.has(normalized)) {
      throw new Error(`Duplicate ${label} value: ${normalized}`);
    }
    seen.add(normalized);
  }
}

function readOptionalPositiveIntEnv(name) {
  const raw = process.env[name];
  return raw ? parsePositiveInt(raw, name) : undefined;
}

function readOptionalNonNegativeIntEnv(name) {
  const raw = process.env[name];
  return raw ? parseNonNegativeInt(raw, name) : undefined;
}

function shouldPromoteObservationGuardFailure(observation) {
  // Setup and the first cold work command are still reported, but they are not
  // stable enough to fail the gauntlet's steady-state regression guard.
  return observation?.phase !== "prebuild" && observation?.coldStart !== true;
}

export function buildObservationGuardFailures(observations, enabled = false) {
  if (!enabled) {
    return [];
  }
  return observations
    .filter((observation) => shouldPromoteObservationGuardFailure(observation))
    .map((observation) => ({
      kind: `observation:${observation.kind ?? "unknown"}`,
      message: `Gauntlet observation threshold exceeded: ${observation.kind ?? "unknown"}`,
      observation,
    }));
}

/**
 * Builds the command that prepares QA runtime artifacts before gauntlet probes.
 */
export function createGauntletPrebuildCommand(repoRoot) {
  return {
    command: process.execPath,
    args: [path.join(repoRoot, "scripts", "build-all.mjs"), "qaRuntime"],
  };
}

function openclawCommand(repoRoot, args) {
  return {
    command: process.execPath,
    args: [path.join(repoRoot, "dist", "entry.js"), ...args],
  };
}

function builtEntryPath(repoRoot) {
  return path.join(repoRoot, "dist", "entry.js");
}

function selectSlashHelpAliases(plugin, includePluginOwnedCliAliases) {
  return includePluginOwnedCliAliases
    ? plugin.cliCommandAliases
    : plugin.cliCommandAliases.filter((entry) => !isPluginOwnedCliAlias(entry));
}

function requiresBuiltEntry(options, selectedPlugins) {
  if (selectedPlugins.length === 0) {
    return false;
  }
  if (!options.skipLifecycle) {
    return true;
  }
  if (options.skipSlashHelp) {
    return false;
  }
  return selectedPlugins.some((plugin) => selectSlashHelpAliases(plugin, true).length > 0);
}

function sourceOpenclawCommand(repoRoot, args) {
  return {
    command: process.execPath,
    args: [path.join(repoRoot, "scripts", "run-node.mjs"), ...args],
  };
}

function chunkArray(values, chunkSize) {
  const chunks = [];
  for (let index = 0; index < values.length; index += chunkSize) {
    chunks.push(values.slice(index, index + chunkSize));
  }
  return chunks;
}

/**
 * Converts an output path to a repo-relative path, rejecting paths outside the repo.
 */
export function toRepoRelativePath(repoRoot, absolutePath) {
  const relativePath = path.relative(repoRoot, absolutePath);
  if (!relativePath || relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
    throw new Error(`Output path must stay inside repo root: ${absolutePath}`);
  }
  return relativePath;
}

function validateOutputDir(options, repoRoot) {
  if (!options.skipQa) {
    toRepoRelativePath(repoRoot, path.join(options.outputDir, "qa-suite"));
  }
}

function createIsolatedEnv(repoRoot, runRoot) {
  const home = path.join(runRoot, "home");
  const stateDir = path.join(runRoot, "state");
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(stateDir, { recursive: true });
  return {
    ...process.env,
    HOME: home,
    XDG_CONFIG_HOME: path.join(home, ".config"),
    XDG_CACHE_HOME: path.join(home, ".cache"),
    XDG_DATA_HOME: path.join(home, ".local", "share"),
    OPENCLAW_STATE_DIR: stateDir,
    OPENCLAW_CONFIG_PATH: path.join(stateDir, "openclaw.json"),
    OPENCLAW_LOG_DIR: path.join(runRoot, "logs"),
    OPENCLAW_QA_SUITE_PROGRESS: process.env.OPENCLAW_QA_SUITE_PROGRESS ?? "1",
    PATH: process.env.PATH,
    PWD: repoRoot,
  };
}

function hasUsrBinTime() {
  return fs.existsSync("/usr/bin/time");
}

function timeWrapperArgs(command, args) {
  if (!hasUsrBinTime()) {
    return { command, args, mode: "none" };
  }
  if (process.platform === "darwin") {
    return { command: "/usr/bin/time", args: ["-l", command, ...args], mode: "bsd" };
  }
  return { command: "/usr/bin/time", args: ["-v", command, ...args], mode: "gnu" };
}

/**
 * Parses `/usr/bin/time` output into wall, CPU, and RSS metrics.
 */
export function parseTimedMetrics(stderr, wallMs, mode) {
  let userSeconds = null;
  let systemSeconds = null;
  let maxRssMb = null;
  if (mode === "gnu") {
    userSeconds = parseLastFloat(stderr, /^\s*User time \(seconds\):\s*([0-9.]+)\s*$/gmu);
    systemSeconds = parseLastFloat(stderr, /^\s*System time \(seconds\):\s*([0-9.]+)\s*$/gmu);
    const maxRssKb = parseLastFloat(
      stderr,
      /^\s*Maximum resident set size \(kbytes\):\s*([0-9.]+)\s*$/gmu,
    );
    maxRssMb = maxRssKb == null ? null : maxRssKb / 1024;
  } else if (mode === "bsd") {
    const cpuLine = parseLastMatch(
      stderr,
      /^\s*[0-9.]+\s+real\s+([0-9.]+)\s+user\s+([0-9.]+)\s+sys\s*$/gmu,
    );
    userSeconds = parseMatchFloat(cpuLine, 1);
    systemSeconds = parseMatchFloat(cpuLine, 2);
    const maxRssBytes = parseLastFloat(stderr, /^\s*([0-9]+)\s+maximum resident set size\s*$/gmu);
    maxRssMb = maxRssBytes == null ? null : maxRssBytes / 1024 / 1024;
  }
  const cpuMs =
    userSeconds == null && systemSeconds == null
      ? null
      : ((userSeconds ?? 0) + (systemSeconds ?? 0)) * 1000;
  return {
    wallMs,
    cpuMs,
    cpuCoreRatio: cpuMs == null || wallMs <= 0 ? null : cpuMs / wallMs,
    maxRssMb,
  };
}

function parseLastMatch(value, pattern) {
  let lastMatch = null;
  for (const match of value.matchAll(pattern)) {
    lastMatch = match;
  }
  return lastMatch;
}

function parseMatchFloat(match, index) {
  if (!match) {
    return null;
  }
  const parsed = Number(match[index]);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseLastFloat(value, pattern) {
  return parseMatchFloat(parseLastMatch(value, pattern), 1);
}

function stripAnsi(value) {
  return value.replace(ANSI_PATTERN, "");
}

function resolveTimerTimeoutMs(valueMs) {
  const value = Number.isFinite(valueMs) ? Math.floor(valueMs) : MAX_TIMER_TIMEOUT_MS;
  return Math.min(Math.max(value, 1), MAX_TIMER_TIMEOUT_MS);
}

function resolveOptionalTimerTimeoutMs(valueMs) {
  return valueMs === undefined || valueMs <= 0 ? null : resolveTimerTimeoutMs(valueMs);
}

function writeCommandLog(params) {
  const { logDir, label, stdout, stderr } = params;
  fs.mkdirSync(logDir, { recursive: true });
  const safeLabel = label.replace(/[^a-zA-Z0-9_.-]+/gu, "_");
  const logPath = path.join(logDir, `${safeLabel}.log`);
  fs.writeFileSync(
    logPath,
    [`$ ${params.command.join(" ")}`, "", stripAnsi(stdout), stripAnsi(stderr)].join("\n"),
    "utf8",
  );
  return logPath;
}

/**
 * Runs a measured command through the live process implementation.
 */
export async function runMeasuredCommand(params) {
  return await runMeasuredCommandLive(params);
}

/**
 * Runs one command with optional timing wrapper, bounded output, and log capture.
 */
export function runMeasuredCommandLive(params) {
  const { command, args, mode } =
    params.timeMode === "none"
      ? { command: params.command, args: params.args, mode: "none" }
      : timeWrapperArgs(params.command, params.args);
  const started = performance.now();
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let stdoutRelayBytes = 0;
    let stderrRelayBytes = 0;
    let stdoutTruncated = false;
    let stderrTruncated = false;
    let stdoutRelayTruncated = false;
    let stderrRelayTruncated = false;
    let spawnError = null;
    let timedOut = false;
    let settled = false;
    let forceKillTimeout = null;
    let forceKillAt = 0;
    let parentTerminationSignal = null;
    const maxBufferBytes = params.maxBufferBytes ?? COMMAND_OUTPUT_MAX_BUFFER_BYTES;
    const maxRelayBytes = params.consoleOutputMaxBytes ?? maxBufferBytes;
    const timeoutMs = resolveOptionalTimerTimeoutMs(params.timeoutMs);
    const timeoutKillGraceMs = resolveTimerTimeoutMs(params.timeoutKillGraceMs ?? 5_000);
    const spawnOptions = mode === "none" ? (params.spawnOptions ?? {}) : {};
    const useProcessGroup =
      process.platform !== "win32" &&
      params.killProcessGroup !== false &&
      spawnOptions.detached !== false;
    const child = spawn(command, args, {
      cwd: params.cwd,
      env: params.env,
      ...spawnOptions,
      ...(useProcessGroup ? { detached: true } : {}),
    });
    const killMeasuredProcess = (signal = "SIGTERM") => {
      if (useProcessGroup && child.pid) {
        try {
          process.kill(-child.pid, signal);
          return;
        } catch {}
      }
      child.kill(signal);
    };
    const processGroupAlive = () => {
      if (!useProcessGroup || !child.pid) {
        return false;
      }
      try {
        process.kill(-child.pid, 0);
        return true;
      } catch (error) {
        return Boolean(error && error.code === "EPERM");
      }
    };
    const waitForProcessGroupExit = async (timeoutBudgetMs) => {
      const deadlineAt = Date.now() + timeoutBudgetMs;
      while (Date.now() < deadlineAt) {
        if (!processGroupAlive()) {
          return true;
        }
        await new Promise((resolvePoll) => {
          setTimeout(resolvePoll, 25);
        });
      }
      return !processGroupAlive();
    };
    const scheduleForceKill = () => {
      forceKillAt = Date.now() + timeoutKillGraceMs;
      forceKillTimeout ??= setTimeout(() => {
        forceKillTimeout = null;
        killMeasuredProcess("SIGKILL");
      }, timeoutKillGraceMs);
      forceKillTimeout.unref?.();
    };
    const parentSignalHandlers = new Map();
    const removeParentSignalHandlers = () => {
      for (const [signal, handler] of parentSignalHandlers) {
        process.off(signal, handler);
      }
      parentSignalHandlers.clear();
    };
    const parentSignals =
      process.platform === "win32" ? ["SIGINT", "SIGTERM"] : ["SIGINT", "SIGTERM", "SIGHUP"];
    for (const signal of parentSignals) {
      const handler = () => {
        if (parentTerminationSignal) {
          return;
        }
        parentTerminationSignal = signal;
        killMeasuredProcess(signal);
        scheduleForceKill();
      };
      parentSignalHandlers.set(signal, handler);
      process.once(signal, handler);
    }
    const appendCapturedOutput = (streamName, chunk) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      const currentBytes = streamName === "stdout" ? stdoutBytes : stderrBytes;
      const alreadyTruncated = streamName === "stdout" ? stdoutTruncated : stderrTruncated;
      if (alreadyTruncated) {
        return;
      }
      const remainingBytes = maxBufferBytes - currentBytes;
      const appendTruncation = () => {
        const message = `\n[${streamName} truncated after ${maxBufferBytes} bytes]\n`;
        if (streamName === "stdout") {
          stdout += message;
          stdoutTruncated = true;
        } else {
          stderr += message;
          stderrTruncated = true;
        }
      };
      if (remainingBytes <= 0) {
        appendTruncation();
        return;
      }
      const capturedBuffer =
        buffer.length > remainingBytes ? buffer.subarray(0, remainingBytes) : buffer;
      if (streamName === "stdout") {
        stdout += capturedBuffer.toString("utf8");
        stdoutBytes += capturedBuffer.length;
      } else {
        stderr += capturedBuffer.toString("utf8");
        stderrBytes += capturedBuffer.length;
      }
      if (buffer.length > remainingBytes) {
        appendTruncation();
      }
    };
    const relayOutput = (streamName, chunk) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      const currentBytes = streamName === "stdout" ? stdoutRelayBytes : stderrRelayBytes;
      const alreadyTruncated =
        streamName === "stdout" ? stdoutRelayTruncated : stderrRelayTruncated;
      if (alreadyTruncated) {
        return;
      }
      const write =
        streamName === "stdout"
          ? process.stdout.write.bind(process.stdout)
          : process.stderr.write.bind(process.stderr);
      const markTruncated = () => {
        write(`\n[${streamName} relay truncated after ${maxRelayBytes} bytes]\n`);
        if (streamName === "stdout") {
          stdoutRelayTruncated = true;
        } else {
          stderrRelayTruncated = true;
        }
      };
      const remainingBytes = maxRelayBytes - currentBytes;
      if (remainingBytes <= 0) {
        markTruncated();
        return;
      }
      const relayedBuffer =
        buffer.length > remainingBytes ? buffer.subarray(0, remainingBytes) : buffer;
      if (relayedBuffer.length > 0) {
        write(relayedBuffer.toString("utf8"));
      }
      if (streamName === "stdout") {
        stdoutRelayBytes += relayedBuffer.length;
      } else {
        stderrRelayBytes += relayedBuffer.length;
      }
      if (buffer.length > remainingBytes) {
        markTruncated();
      }
    };
    const appendOutput = (streamName, chunk) => {
      relayOutput(streamName, chunk);
      appendCapturedOutput(streamName, chunk);
    };
    child.stdout?.on("data", (chunk) => appendOutput("stdout", chunk));
    child.stderr?.on("data", (chunk) => appendOutput("stderr", chunk));
    const timeout =
      timeoutMs !== null
        ? setTimeout(() => {
            timedOut = true;
            spawnError = {
              code: "ETIMEDOUT",
              message: `Command timed out after ${timeoutMs}ms`,
            };
            killMeasuredProcess();
            scheduleForceKill();
          }, timeoutMs)
        : null;
    timeout?.unref?.();
    const finish = (status, signal) => {
      if (settled) {
        return;
      }
      settled = true;
      if (timeout) {
        clearTimeout(timeout);
      }
      if (forceKillTimeout) {
        clearTimeout(forceKillTimeout);
      }
      removeParentSignalHandlers();
      const wallMs = performance.now() - started;
      const finalStatus = status ?? (signal || spawnError ? 1 : 0);
      const finalStderr = [
        stderr,
        spawnError ? `[spawn error] ${spawnError.code ?? "unknown"} ${spawnError.message}` : "",
      ]
        .filter(Boolean)
        .join("\n");
      let logPath = null;
      let logWriteError = null;
      try {
        logPath = writeCommandLog({
          logDir: params.logDir,
          label: params.label,
          command: [params.command, ...params.args],
          stdout,
          stderr: finalStderr,
        });
      } catch (error) {
        logWriteError = error instanceof Error ? error.message : String(error);
      }
      const outputDiagnosticFailure = detectCommandDiagnosticFailure(stdout, finalStderr);
      const diagnosticFailure =
        outputDiagnosticFailure ?? (logWriteError ? "command-log-write-failure" : null);
      resolve({
        label: params.label,
        phase: params.phase,
        pluginId: params.pluginId ?? null,
        status: logWriteError ? 1 : finalStatus,
        diagnosticFailure,
        signal: signal ?? null,
        timedOut,
        spawnError,
        logPath,
        ...(logWriteError ? { logWriteError } : {}),
        ...parseTimedMetrics(finalStderr, wallMs, mode),
      });
    };
    const waitForTerminationCleanup = async () => {
      const remainingGraceMs = Math.max(0, forceKillAt - Date.now());
      if (remainingGraceMs > 0) {
        await waitForProcessGroupExit(remainingGraceMs);
      }
      if (processGroupAlive()) {
        killMeasuredProcess("SIGKILL");
        await waitForProcessGroupExit(100);
      }
    };
    const rethrowParentTermination = () => {
      settled = true;
      if (timeout) {
        clearTimeout(timeout);
      }
      if (forceKillTimeout) {
        clearTimeout(forceKillTimeout);
      }
      removeParentSignalHandlers();
      process.kill(process.pid, parentTerminationSignal);
    };
    const finishAfterTimeoutTeardown = async (status, signal) => {
      await waitForTerminationCleanup();
      if (parentTerminationSignal) {
        rethrowParentTermination();
        return;
      }
      finish(status, signal);
    };
    const finishAfterParentTermination = async () => {
      await waitForTerminationCleanup();
      rethrowParentTermination();
    };
    child.on("error", (error) => {
      spawnError = {
        code: typeof error.code === "string" ? error.code : null,
        message: error.message,
      };
      finish(null, null);
    });
    child.on("close", (status, signal) => {
      if (parentTerminationSignal) {
        void finishAfterParentTermination();
        return;
      }
      if (timedOut) {
        void finishAfterTimeoutTeardown(status, signal);
        return;
      }
      finish(status, signal);
    });
  });
}

/**
 * Reports whether gauntlet result rows contain work beyond the prebuild step.
 */
export function hasGauntletWorkRows(rows) {
  return rows.some((row) => row.phase !== "prebuild");
}

function isPluginOwnedCliAlias(alias) {
  return alias.kind === "runtime-slash" && alias.cliCommand === alias.name;
}

function buildSlashHelpProbe(params) {
  const command = params.alias.cliCommand ?? params.alias.name;
  return {
    cwd: params.repoRoot,
    env: params.env,
    logDir: path.join(params.outputDir, "logs", "slash-help"),
    ...openclawCommand(params.repoRoot, [command, "--help"]),
    label: `${params.plugin.id}-slash-${params.alias.name}`,
    phase: "slash:help",
    pluginId: params.plugin.id,
    timeoutMs: params.commandTimeoutMs,
  };
}

async function runPluginLifecycleCommand(params) {
  process.stderr.write(`[plugin-gauntlet] ${params.logPluginId} ${params.phase}\n`);
  params.rows.push(
    await runMeasuredCommand({
      cwd: params.repoRoot,
      env: params.env,
      logDir: path.join(params.outputDir, "logs", "lifecycle"),
      ...openclawCommand(params.repoRoot, ["plugins", ...params.args]),
      label: params.label,
      phase: `lifecycle:${params.phase}`,
      pluginId: params.pluginId,
      timeoutMs: params.commandTimeoutMs,
    }),
  );
}

async function runPluginLifecycle(params) {
  for (const plugin of params.plugins) {
    const requiredPlugins = collectRequiredPluginEntries(params.matrix, [plugin]);
    for (const requiredPlugin of requiredPlugins) {
      await runPluginLifecycleCommand({
        ...params,
        logPluginId: plugin.id,
        label: `${plugin.id}-requires-${requiredPlugin.id}-install`,
        phase: `requires:${requiredPlugin.id}:install`,
        args: ["install", requiredPlugin.id],
        pluginId: requiredPlugin.id,
      });
    }
    const commands = [
      {
        phase: "install",
        args: ["install", plugin.id],
      },
      { phase: "inspect", args: ["inspect", plugin.id, "--json"] },
      ...(params.skipSlashHelp
        ? []
        : plugin.cliCommandAliases
            .filter(isPluginOwnedCliAlias)
            .map((alias) => ({ phase: `slash-help:${alias.name}`, alias }))),
      { phase: "disable", args: ["disable", plugin.id] },
      ...(plugin.hasRequiredConfigFields ? [] : [{ phase: "enable", args: ["enable", plugin.id] }]),
      { phase: "doctor", args: ["doctor"] },
      { phase: "uninstall", args: ["uninstall", plugin.id, "--force"] },
    ];
    for (const { phase, args, alias } of commands) {
      if (alias) {
        process.stderr.write(`[plugin-gauntlet] ${plugin.id} ${phase}\n`);
        params.rows.push(
          await runMeasuredCommand({
            ...buildSlashHelpProbe({
              repoRoot: params.repoRoot,
              outputDir: params.outputDir,
              env: params.env,
              plugin,
              alias,
              commandTimeoutMs: params.commandTimeoutMs,
            }),
            label: `${plugin.id}-${phase}`,
          }),
        );
        continue;
      }
      await runPluginLifecycleCommand({
        ...params,
        logPluginId: plugin.id,
        label: `${plugin.id}-${phase}`,
        phase,
        args,
        pluginId: plugin.id,
      });
    }
    for (const requiredPlugin of requiredPlugins.toReversed()) {
      await runPluginLifecycleCommand({
        ...params,
        logPluginId: plugin.id,
        label: `${plugin.id}-requires-${requiredPlugin.id}-uninstall`,
        phase: `requires:${requiredPlugin.id}:uninstall`,
        args: ["uninstall", requiredPlugin.id, "--force"],
        pluginId: requiredPlugin.id,
      });
    }
  }
}

async function runSlashHelpProbes(params) {
  for (const plugin of params.plugins) {
    const aliases = selectSlashHelpAliases(plugin, params.includePluginOwnedCliAliases);
    for (const alias of aliases) {
      process.stderr.write(`[plugin-gauntlet] ${plugin.id} slash-help /${alias.name}\n`);
      params.rows.push(
        await runMeasuredCommand({
          ...buildSlashHelpProbe({
            repoRoot: params.repoRoot,
            outputDir: params.outputDir,
            env: params.env,
            plugin,
            alias,
            commandTimeoutMs: params.commandTimeoutMs,
          }),
        }),
      );
    }
  }
}

async function runQaChunks(params) {
  const chunks = [
    ...(params.qaBaseline ? [{ label: "baseline", plugins: [] }] : []),
    ...chunkArray(params.plugins, params.qaPluginChunkSize).map((plugins, index) => ({
      label: `chunk-${String(index).padStart(2, "0")}`,
      plugins,
    })),
  ];
  const summaries = [];
  for (let index = 0; index < chunks.length; index += 1) {
    const chunk = chunks[index];
    const outputDir = path.join(params.outputDir, "qa-suite", chunk.label);
    const outputArg = toRepoRelativePath(params.repoRoot, outputDir);
    const pluginIds = chunk.plugins.map((plugin) => plugin.id);
    const enabledPluginIds = collectPluginsWithRequiredEntries(params.matrix, chunk.plugins).map(
      (plugin) => plugin.id,
    );
    const pluginIdLabel = pluginIds.length > 0 ? pluginIds.join(",") : "<baseline>";
    process.stderr.write(
      `[plugin-gauntlet] qa chunk ${index + 1}/${chunks.length}: ${pluginIdLabel}\n`,
    );
    const row = await runMeasuredCommand({
      cwd: params.repoRoot,
      env: params.env,
      logDir: path.join(params.outputDir, "logs", "qa-suite"),
      ...sourceOpenclawCommand(params.repoRoot, [
        "qa",
        "suite",
        "--provider-mode",
        "mock-openai",
        "--concurrency",
        "1",
        "--output-dir",
        outputArg,
        ...params.qaScenarios.flatMap((scenario) => ["--scenario", scenario]),
        ...enabledPluginIds.flatMap((pluginId) => ["--enable-plugin", pluginId]),
      ]),
      label: `qa-${chunk.label}`,
      phase: "qa:rpc",
      timeoutMs: params.qaTimeoutMs,
    });
    const summaryPath = path.join(outputDir, "qa-suite-summary.json");
    const qaSummaryResult = readQaSuiteSummary(summaryPath);
    const qaDiagnosticFailure =
      row.status === 0 && !row.timedOut ? qaSummaryResult.diagnosticFailure : null;
    params.rows.push({
      ...row,
      pluginId: pluginIdLabel,
      qaSummaryPath: summaryPath,
      ...(qaDiagnosticFailure ? { diagnosticFailure: qaDiagnosticFailure } : {}),
      ...(qaSummaryResult.diagnosticDetail
        ? { diagnosticDetail: qaSummaryResult.diagnosticDetail }
        : {}),
      ...(qaSummaryResult.summary?.metrics ? { qaMetrics: qaSummaryResult.summary.metrics } : {}),
    });
    if (qaSummaryResult.summary) {
      summaries.push(qaSummaryResult.summary);
    }
  }
  return summaries;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const repoRoot = path.resolve(options.repoRoot);
  validateOutputDir(options, repoRoot);
  fs.mkdirSync(options.outputDir, { recursive: true });
  const runRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-plugin-gauntlet-"));
  let preserveRunRoot = options.keepRunRoot;
  const env = createIsolatedEnv(repoRoot, runRoot);
  try {
    const matrix = discoverBundledPluginManifests(repoRoot);
    const selectedPlugins = selectPluginEntries(matrix, {
      ids: options.pluginIds,
      shardTotal: options.shardTotal,
      shardIndex: options.shardIndex,
      limit: options.limit,
    });
    const selectedPluginsWithRequired = collectPluginsWithRequiredEntries(matrix, selectedPlugins);
    const rows = [];
    const commandEnv = buildGauntletPrebuildEnv(env, {
      includePrivateQa: !options.skipQa,
      buildIds: selectedPluginsWithRequired.map((plugin) => plugin.buildId),
      skipDeclarationBuild: true,
    });
    if (!options.skipPrebuild && (selectedPlugins.length > 0 || !options.skipQa)) {
      process.stderr.write("[plugin-gauntlet] prebuild\n");
      const prebuildCommand = createGauntletPrebuildCommand(repoRoot);
      rows.push(
        await runMeasuredCommandLive({
          cwd: repoRoot,
          env: commandEnv,
          logDir: path.join(options.outputDir, "logs", "prebuild"),
          command: prebuildCommand.command,
          args: prebuildCommand.args,
          label: "prebuild",
          phase: "prebuild",
          timeoutMs: options.buildTimeoutMs,
        }),
      );
    }
    const prebuildFailed = rows.some(
      (row) => row.phase === "prebuild" && (row.status !== 0 || row.timedOut),
    );
    const entryPath = builtEntryPath(repoRoot);
    const missingSkippedPrebuildEntry =
      selectedPlugins.length > 0 &&
      options.skipPrebuild &&
      requiresBuiltEntry(options, selectedPlugins) &&
      !fs.existsSync(entryPath);
    if (!prebuildFailed && !missingSkippedPrebuildEntry && !options.skipLifecycle) {
      await runPluginLifecycle({
        repoRoot,
        outputDir: options.outputDir,
        env: commandEnv,
        matrix,
        plugins: selectedPlugins,
        rows,
        commandTimeoutMs: options.commandTimeoutMs,
        skipSlashHelp: options.skipSlashHelp,
      });
    }
    if (!prebuildFailed && !missingSkippedPrebuildEntry && !options.skipSlashHelp) {
      await runSlashHelpProbes({
        repoRoot,
        outputDir: options.outputDir,
        env: commandEnv,
        plugins: selectedPlugins,
        rows,
        commandTimeoutMs: options.commandTimeoutMs,
        includePluginOwnedCliAliases: options.skipLifecycle,
      });
    }
    const qaSummaries =
      options.skipQa || prebuildFailed
        ? []
        : await runQaChunks({
            repoRoot,
            outputDir: options.outputDir,
            env: commandEnv,
            matrix,
            plugins: selectedPlugins,
            qaBaseline: options.qaBaseline,
            rows,
            qaScenarios: options.qaScenarios,
            qaPluginChunkSize: options.qaPluginChunkSize,
            qaTimeoutMs: options.qaTimeoutMs,
          });
    const metricObservations = collectMetricObservations(rows, {
      cpuCoreWarn: options.cpuCoreWarn,
      hotWallWarnMs: options.hotWallWarnMs,
      maxRssWarnMb: options.maxRssWarnMb,
      wallAnomalyMultiplier: options.wallAnomalyMultiplier,
      rssAnomalyMultiplier: options.rssAnomalyMultiplier,
    });
    const qaBaselineObservations = collectQaBaselineRegressionObservations(rows, {
      cpuRegressionMultiplier: options.qaCpuRegressionMultiplier,
      wallRegressionMultiplier: options.qaWallRegressionMultiplier,
    });
    const gatewayObservations = qaSummaries.flatMap((qa) =>
      collectGatewayCpuObservations({
        startup: null,
        qa,
        cpuCoreWarn: options.cpuCoreWarn,
        hotWallWarnMs: options.hotWallWarnMs,
      }),
    );
    const failures = rows.filter(
      (row) => row.status !== 0 || row.timedOut || row.diagnosticFailure,
    );
    const observations = [...metricObservations, ...qaBaselineObservations, ...gatewayObservations];
    const guardFailures = [];
    if (missingSkippedPrebuildEntry) {
      guardFailures.push({
        kind: "missing-built-entry",
        message:
          `${path.relative(repoRoot, entryPath)} is missing; ` +
          "run without --skip-prebuild or build the gauntlet runtime first.",
      });
    }
    if (!hasGauntletWorkRows(rows) && !options.allowEmpty && guardFailures.length === 0) {
      guardFailures.push({
        kind: "empty-run",
        message:
          "No lifecycle, slash-help, or QA gauntlet commands ran; remove a skip flag or pass --allow-empty for intentional dry runs.",
      });
    }
    guardFailures.push(...buildObservationGuardFailures(observations, options.failOnObservation));
    const hasFailures = failures.length > 0 || guardFailures.length > 0;
    preserveRunRoot = preserveRunRoot || hasFailures;
    let cleanupError = null;
    if (!preserveRunRoot) {
      try {
        fs.rmSync(runRoot, { recursive: true, force: true });
      } catch (error) {
        cleanupError = error instanceof Error ? error.message : String(error);
        preserveRunRoot = true;
      }
    }
    const summary = {
      generatedAt: new Date().toISOString(),
      repoRoot,
      outputDir: options.outputDir,
      isolatedRunRoot: runRoot,
      isolatedRunRootPreserved: preserveRunRoot,
      isolatedRunRootCleanupError: cleanupError,
      selectedPluginCount: selectedPlugins.length,
      totalPluginCount: matrix.length,
      options: {
        pluginIds: options.pluginIds,
        shardTotal: options.shardTotal,
        shardIndex: options.shardIndex,
        limit: options.limit ?? null,
        qaScenarios: options.qaScenarios,
        qaPluginChunkSize: options.qaPluginChunkSize,
        qaBaseline: options.qaBaseline,
        allowEmpty: options.allowEmpty,
        failOnObservation: options.failOnObservation,
        keepRunRoot: options.keepRunRoot,
        skipLifecycle: options.skipLifecycle,
        skipQa: options.skipQa,
        skipSlashHelp: options.skipSlashHelp,
        skipPrebuild: options.skipPrebuild,
        thresholds: {
          cpuCoreWarn: options.cpuCoreWarn,
          hotWallWarnMs: options.hotWallWarnMs,
          maxRssWarnMb: options.maxRssWarnMb,
          wallAnomalyMultiplier: options.wallAnomalyMultiplier,
          rssAnomalyMultiplier: options.rssAnomalyMultiplier,
          qaCpuRegressionMultiplier: options.qaCpuRegressionMultiplier,
          qaWallRegressionMultiplier: options.qaWallRegressionMultiplier,
        },
      },
      matrix,
      selectedPlugins,
      rows,
      observations,
      failures,
      guardFailures,
    };
    const summaryPath = path.join(options.outputDir, "plugin-gateway-gauntlet-summary.json");
    fs.writeFileSync(summaryPath, `${JSON.stringify(summary, null, 2)}\n`, "utf8");
    process.stdout.write(`[plugin-gauntlet] summary: ${summaryPath}\n`);
    process.stdout.write(
      `[plugin-gauntlet] plugins=${selectedPlugins.length}/${matrix.length} rows=${rows.length} failures=${failures.length} observations=${summary.observations.length}\n`,
    );
    if (preserveRunRoot) {
      process.stdout.write(`[plugin-gauntlet] isolated run root preserved: ${runRoot}\n`);
    }
    for (const failure of failures) {
      process.stdout.write(
        `[plugin-gauntlet] failure phase=${failure.phase} plugin=${failure.pluginId ?? "<none>"} status=${failure.status} timedOut=${failure.timedOut} diagnostic=${failure.diagnosticFailure ?? ""} wallMs=${Math.round(failure.wallMs)} log=${failure.logPath}\n`,
      );
    }
    for (const failure of guardFailures) {
      process.stdout.write(`[plugin-gauntlet] failure ${failure.kind}: ${failure.message}\n`);
    }
    for (const observation of summary.observations.slice(0, 20)) {
      process.stdout.write(`[plugin-gauntlet] observation ${JSON.stringify(observation)}\n`);
    }
    if (hasFailures) {
      process.exitCode = 1;
    }
  } catch (error) {
    if (!options.keepRunRoot) {
      try {
        fs.rmSync(runRoot, { recursive: true, force: true });
      } catch (cleanupError) {
        process.stderr.write(
          `[plugin-gauntlet] failed to clean isolated run root ${runRoot}: ${
            cleanupError instanceof Error ? cleanupError.message : String(cleanupError)
          }\n`,
        );
      }
    }
    throw error;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch(
    /** @param {unknown} error */ (error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    },
  );
}
