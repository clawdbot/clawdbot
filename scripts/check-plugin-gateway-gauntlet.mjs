#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import {
  buildGauntletPrebuildEnv,
  collectGatewayCpuObservations,
  collectMetricObservations,
  collectQaBaselineRegressionObservations,
  discoverBundledPluginManifests,
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
const ANSI_PATTERN = new RegExp(String.raw`\u001B\[[0-9;]*m`, "gu");

function parseArgs(argv) {
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
  };
  const envIds = normalizeCsv(process.env.OPENCLAW_PLUGIN_GATEWAY_GAUNTLET_IDS);
  options.pluginIds.push(...envIds);
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const readValue = () => {
      const value = argv[index + 1];
      if (!value) {
        throw new Error(`Missing value for ${arg}`);
      }
      index += 1;
      return value;
    };
    switch (arg) {
      case "--":
        break;
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
  --skip-prebuild                Skip the upfront build used to avoid per-command rebuild noise
  --skip-lifecycle              Skip plugin install/inspect/disable/enable/doctor/uninstall
  --skip-qa                     Skip QA Lab RPC conversation runs
  --skip-slash-help             Skip CLI help probes for plugin-declared command aliases
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

function readOptionalPositiveIntEnv(name) {
  const raw = process.env[name];
  return raw ? parsePositiveInt(raw, name) : undefined;
}

function readOptionalNonNegativeIntEnv(name) {
  const raw = process.env[name];
  return raw ? parseNonNegativeInt(raw, name) : undefined;
}

function parsePositiveInt(raw, label) {
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${label} must be a positive integer`);
  }
  return value;
}

function parseNonNegativeInt(raw, label) {
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative integer`);
  }
  return value;
}

function parsePositiveNumber(raw, label) {
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${label} must be a positive number`);
  }
  return value;
}

function pnpmCommand() {
  return process.platform === "win32" ? "pnpm.cmd" : "pnpm";
}

function openclawCommand(repoRoot, args) {
  return {
    command: process.execPath,
    args: [path.join(repoRoot, "dist", "entry.js"), ...args],
  };
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

function toRepoRelativePath(repoRoot, absolutePath) {
  const relativePath = path.relative(repoRoot, absolutePath);
  if (!relativePath || relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
    throw new Error(`Output path must stay inside repo root: ${absolutePath}`);
  }
  return relativePath;
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

function parseTimedMetrics(stderr, wallMs, mode) {
  let userSeconds = null;
  let systemSeconds = null;
  let maxRssMb = null;
  if (mode === "gnu") {
    userSeconds = parseFirstFloat(stderr, /User time \(seconds\):\s*([0-9.]+)/u);
    systemSeconds = parseFirstFloat(stderr, /System time \(seconds\):\s*([0-9.]+)/u);
    const maxRssKb = parseFirstFloat(stderr, /Maximum resident set size \(kbytes\):\s*([0-9.]+)/u);
    maxRssMb = maxRssKb == null ? null : maxRssKb / 1024;
  } else if (mode === "bsd") {
    userSeconds = parseFirstFloat(stderr, /[0-9.]+\s+real\s+([0-9.]+)\s+user/u);
    systemSeconds = parseFirstFloat(stderr, /([0-9.]+)\s+sys/u);
    const maxRssBytes = parseFirstFloat(stderr, /([0-9]+)\s+maximum resident set size/u);
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

function parseFirstFloat(value, pattern) {
  const match = value.match(pattern);
  if (!match) {
    return null;
  }
  const parsed = Number(match[1]);
  return Number.isFinite(parsed) ? parsed : null;
}

function stripAnsi(value) {
  return value.replace(ANSI_PATTERN, "");
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

function runMeasuredCommand(params) {
  const { command, args, mode } = timeWrapperArgs(params.command, params.args);
  const started = performance.now();
  const result = spawnSync(command, args, {
    cwd: params.cwd,
    env: params.env,
    encoding: "utf8",
    timeout: params.timeoutMs,
    maxBuffer: 16 * 1024 * 1024,
  });
  const wallMs = performance.now() - started;
  const status = result.status ?? (result.signal ? 1 : 0);
  const stdout = result.stdout ?? "";
  const stderr = result.stderr ?? "";
  const logPath = writeCommandLog({
    logDir: params.logDir,
    label: params.label,
    command: [params.command, ...params.args],
    stdout,
    stderr,
  });
  return {
    label: params.label,
    phase: params.phase,
    pluginId: params.pluginId ?? null,
    status,
    signal: result.signal ?? null,
    timedOut: result.error?.code === "ETIMEDOUT",
    logPath,
    ...parseTimedMetrics(stderr, wallMs, mode),
  };
}

function runPluginLifecycle(params) {
  for (const plugin of params.plugins) {
    const commands = [
      {
        phase: "install",
        args: ["install", plugin.dir, "--link", "--dangerously-force-unsafe-install"],
      },
      { phase: "inspect", args: ["inspect", plugin.id, "--json"] },
      { phase: "disable", args: ["disable", plugin.id] },
      { phase: "enable", args: ["enable", plugin.id] },
      { phase: "doctor", args: ["doctor"] },
      { phase: "uninstall", args: ["uninstall", plugin.id, "--force"] },
    ];
    for (const { phase, args } of commands) {
      process.stderr.write(`[plugin-gauntlet] ${plugin.id} ${phase}\n`);
      params.rows.push(
        runMeasuredCommand({
          cwd: params.repoRoot,
          env: params.env,
          logDir: path.join(params.outputDir, "logs", "lifecycle"),
          ...openclawCommand(params.repoRoot, ["plugins", ...args]),
          label: `${plugin.id}-${phase}`,
          phase: `lifecycle:${phase}`,
          pluginId: plugin.id,
          timeoutMs: params.commandTimeoutMs,
        }),
      );
    }
  }
}

function runSlashHelpProbes(params) {
  for (const plugin of params.plugins) {
    for (const alias of plugin.cliCommandAliases) {
      const command = alias.cliCommand ?? alias.name;
      process.stderr.write(`[plugin-gauntlet] ${plugin.id} slash-help /${alias.name}\n`);
      params.rows.push(
        runMeasuredCommand({
          cwd: params.repoRoot,
          env: params.env,
          logDir: path.join(params.outputDir, "logs", "slash-help"),
          ...openclawCommand(params.repoRoot, [command, "--help"]),
          label: `${plugin.id}-slash-${alias.name}`,
          phase: "slash:help",
          pluginId: plugin.id,
          timeoutMs: params.commandTimeoutMs,
        }),
      );
    }
  }
}

function runQaChunks(params) {
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
    const pluginIdLabel = pluginIds.length > 0 ? pluginIds.join(",") : "<baseline>";
    process.stderr.write(
      `[plugin-gauntlet] qa chunk ${index + 1}/${chunks.length}: ${pluginIdLabel}\n`,
    );
    const row = runMeasuredCommand({
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
        ...pluginIds.flatMap((pluginId) => ["--enable-plugin", pluginId]),
      ]),
      label: `qa-${chunk.label}`,
      phase: "qa:rpc",
      timeoutMs: params.qaTimeoutMs,
    });
    const summaryPath = path.join(outputDir, "qa-suite-summary.json");
    const qaSummary = fs.existsSync(summaryPath)
      ? JSON.parse(fs.readFileSync(summaryPath, "utf8"))
      : null;
    params.rows.push({
      ...row,
      pluginId: pluginIdLabel,
      ...(qaSummary?.metrics ? { qaMetrics: qaSummary.metrics } : {}),
    });
    if (fs.existsSync(summaryPath)) {
      summaries.push(qaSummary);
    }
  }
  return summaries;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const repoRoot = path.resolve(options.repoRoot);
  fs.mkdirSync(options.outputDir, { recursive: true });
  const runRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-plugin-gauntlet-"));
  const env = createIsolatedEnv(repoRoot, runRoot);
  const matrix = discoverBundledPluginManifests(repoRoot);
  const selectedPlugins = selectPluginEntries(matrix, {
    ids: options.pluginIds,
    shardTotal: options.shardTotal,
    shardIndex: options.shardIndex,
    limit: options.limit,
  });
  const rows = [];
  if (!options.skipPrebuild && (selectedPlugins.length > 0 || !options.skipQa)) {
    process.stderr.write("[plugin-gauntlet] prebuild\n");
    rows.push(
      runMeasuredCommand({
        cwd: repoRoot,
        env: buildGauntletPrebuildEnv(env, { includePrivateQa: !options.skipQa }),
        logDir: path.join(options.outputDir, "logs", "prebuild"),
        command: pnpmCommand(),
        args: ["build"],
        label: "prebuild",
        phase: "prebuild",
        timeoutMs: options.buildTimeoutMs,
      }),
    );
  }
  const prebuildFailed = rows.some(
    (row) => row.phase === "prebuild" && (row.status !== 0 || row.timedOut),
  );
  if (!prebuildFailed && !options.skipLifecycle) {
    runPluginLifecycle({
      repoRoot,
      outputDir: options.outputDir,
      env,
      plugins: selectedPlugins,
      rows,
      commandTimeoutMs: options.commandTimeoutMs,
    });
  }
  if (!prebuildFailed && !options.skipSlashHelp) {
    runSlashHelpProbes({
      repoRoot,
      outputDir: options.outputDir,
      env,
      plugins: selectedPlugins,
      rows,
      commandTimeoutMs: options.commandTimeoutMs,
    });
  }
  const qaSummaries =
    options.skipQa || prebuildFailed
      ? []
      : runQaChunks({
          repoRoot,
          outputDir: options.outputDir,
          env,
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
  const failures = rows.filter((row) => row.status !== 0 || row.timedOut);
  const summary = {
    generatedAt: new Date().toISOString(),
    repoRoot,
    outputDir: options.outputDir,
    isolatedRunRoot: runRoot,
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
    observations: [...metricObservations, ...qaBaselineObservations, ...gatewayObservations],
    failures,
  };
  const summaryPath = path.join(options.outputDir, "plugin-gateway-gauntlet-summary.json");
  fs.writeFileSync(summaryPath, `${JSON.stringify(summary, null, 2)}\n`, "utf8");
  process.stdout.write(`[plugin-gauntlet] summary: ${summaryPath}\n`);
  process.stdout.write(
    `[plugin-gauntlet] plugins=${selectedPlugins.length}/${matrix.length} rows=${rows.length} failures=${failures.length} observations=${summary.observations.length}\n`,
  );
  for (const failure of failures) {
    process.stdout.write(
      `[plugin-gauntlet] failure phase=${failure.phase} plugin=${failure.pluginId ?? "<none>"} status=${failure.status} timedOut=${failure.timedOut} wallMs=${Math.round(failure.wallMs)} log=${failure.logPath}\n`,
    );
  }
  for (const observation of summary.observations.slice(0, 20)) {
    process.stdout.write(`[plugin-gauntlet] observation ${JSON.stringify(observation)}\n`);
  }
  if (failures.length > 0) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
