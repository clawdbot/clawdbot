#!/usr/bin/env node

// Runs gateway startup and QA scenarios while checking hot CPU observations.
import { spawnSync as defaultSpawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { stripLeadingPackageManagerSeparator } from "./lib/arg-utils.mjs";
import {
  parseNonNegativeInt,
  parsePositiveInt,
  parsePositiveNumber,
} from "./lib/numeric-options.mjs";
import {
  collectGatewayCpuObservations,
  readQaSuiteSummary,
} from "./lib/plugin-gateway-gauntlet.mjs";
import { createPnpmRunnerSpawnSpec } from "./pnpm-runner.mjs";

const DEFAULT_STARTUP_CASES = ["default", "oneInternalHook", "allInternalHooks"];
const DEFAULT_QA_SCENARIOS = [
  "channel-chat-baseline",
  "memory-failure-fallback",
  "gateway-restart-inflight-run",
];
const DEFAULT_CPU_CORE_WARN = 0.9;
const DEFAULT_HOT_WALL_WARN_MS = 30_000;
const PRIVATE_QA_REQUIRED_DIST_ENTRIES = [
  "dist/plugin-sdk/qa-lab.js",
  "dist/plugin-sdk/qa-runtime.js",
];

function parseArgs(argv) {
  const args = stripLeadingPackageManagerSeparator(argv);
  const options = {
    outputDir: path.join(
      process.cwd(),
      ".artifacts",
      "gateway-cpu-scenarios",
      new Date().toISOString().replace(/[:.]/g, "-"),
    ),
    startupCases: [],
    qaScenarios: [],
    runs: 1,
    warmup: 0,
    skipStartup: false,
    skipQa: false,
    cpuCoreWarn: DEFAULT_CPU_CORE_WARN,
    hotWallWarnMs: DEFAULT_HOT_WALL_WARN_MS,
  };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const readValue = () => {
      const value = args[index + 1];
      if (!value || value.startsWith("--")) {
        throw new Error(`Missing value for ${arg}`);
      }
      index += 1;
      return value;
    };
    switch (arg) {
      case "--output-dir":
        options.outputDir = path.resolve(readValue());
        break;
      case "--startup-case":
        options.startupCases.push(readValue());
        break;
      case "--qa-scenario":
        options.qaScenarios.push(readValue());
        break;
      case "--runs":
        options.runs = parsePositiveInt(readValue(), "--runs");
        break;
      case "--warmup":
        options.warmup = parseNonNegativeInt(readValue(), "--warmup");
        break;
      case "--cpu-core-warn":
        options.cpuCoreWarn = parsePositiveNumber(readValue(), "--cpu-core-warn");
        break;
      case "--hot-wall-warn-ms":
        options.hotWallWarnMs = parsePositiveInt(readValue(), "--hot-wall-warn-ms");
        break;
      case "--skip-startup":
        options.skipStartup = true;
        break;
      case "--skip-qa":
        options.skipQa = true;
        break;
      case "--help":
        printHelp();
        process.exit(0);
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }
  if (options.startupCases.length === 0) {
    options.startupCases = [...DEFAULT_STARTUP_CASES];
  }
  if (options.qaScenarios.length === 0) {
    options.qaScenarios = [...DEFAULT_QA_SCENARIOS];
  }
  if (options.skipStartup && options.skipQa) {
    throw new Error("--skip-startup and --skip-qa cannot be used together");
  }
  return options;
}

function printHelp() {
  console.log(`Usage: pnpm test:gateway:cpu-scenarios [options]

Runs a small gateway CPU scenario suite against built dist artifacts.

Options:
  --output-dir <path>        Artifact directory
  --startup-case <id>        Startup bench case, repeatable
  --qa-scenario <id>         QA Lab scenario, repeatable
  --runs <count>             Startup bench runs per case (default: 1)
  --warmup <count>           Startup bench warmup runs per case (default: 0)
  --cpu-core-warn <ratio>    Hot CPU observation threshold (default: 0.9)
  --hot-wall-warn-ms <ms>    Minimum wall time for hot CPU observations (default: 30000)
  --skip-startup             Skip startup bench
  --skip-qa                  Skip QA Lab scenario smoke
`);
}

function readJsonIfExists(filePath) {
  if (!fs.existsSync(filePath)) {
    return null;
  }
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function validateStartupReport(report) {
  if (!report || typeof report !== "object" || Array.isArray(report)) {
    return "startup report must be a JSON object";
  }
  if (!Array.isArray(report.results)) {
    return "startup report missing results array";
  }
  if (report.results.length === 0) {
    return "startup report has no measured results";
  }
  return null;
}

function readStartupReport(startupOutput) {
  if (!fs.existsSync(startupOutput)) {
    return {
      diagnosticFailure: "startup-report-missing",
      diagnosticDetail: `expected startup bench report at ${startupOutput}`,
      report: null,
    };
  }
  try {
    const report = readJsonIfExists(startupOutput);
    const invalidReason = validateStartupReport(report);
    if (invalidReason) {
      return {
        diagnosticFailure: "startup-report-invalid",
        diagnosticDetail: invalidReason,
        report: null,
      };
    }
    return {
      diagnosticFailure: null,
      diagnosticDetail: null,
      report,
    };
  } catch (error) {
    return {
      diagnosticFailure: "startup-report-invalid",
      diagnosticDetail: error instanceof Error ? error.message : String(error),
      report: null,
    };
  }
}

function runStep(name, command, args, options = {}, params = {}) {
  console.error(`[gateway-cpu] start ${name}`);
  const spawn = params.spawnSync ?? defaultSpawnSync;
  const result = spawn(command, args, {
    cwd: params.cwd ?? process.cwd(),
    env: params.env ?? process.env,
    stdio: "inherit",
    ...options,
  });
  const error =
    result.error instanceof Error
      ? result.error.message
      : result.error
        ? String(result.error)
        : null;
  const status = result.error ? 1 : (result.status ?? (result.signal ? 1 : 0));
  console.error(
    `[gateway-cpu] ${status === 0 ? "pass" : "fail"} ${name}${error ? `: ${error}` : ""}`,
  );
  return {
    name,
    status,
    signal: result.signal ?? null,
    ...(error ? { error } : {}),
  };
}

function pnpmCommand(args, params = {}) {
  return createPnpmRunnerSpawnSpec({
    cwd: params.cwd ?? process.cwd(),
    env: params.env ?? process.env,
    pnpmArgs: args,
    stdio: "inherit",
  });
}

function toRepoRelativePath(repoRoot, absolutePath) {
  const relativePath = path.relative(repoRoot, absolutePath);
  if (!relativePath || relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
    throw new Error(`Output path must stay inside the repo root: ${absolutePath}`);
  }
  return relativePath;
}

function hasPrivateQaDist(repoRoot, fsImpl = fs) {
  return PRIVATE_QA_REQUIRED_DIST_ENTRIES.every((relativePath) => {
    try {
      return fsImpl.statSync(path.join(repoRoot, relativePath)).isFile();
    } catch {
      return false;
    }
  });
}

function buildPrivateQaEnv(env, qaState) {
  return {
    ...env,
    ...(qaState
      ? {
          HOME: qaState.home,
          USERPROFILE: qaState.home,
          OPENCLAW_HOME: qaState.home,
          OPENCLAW_STATE_DIR: qaState.stateDir,
          OPENCLAW_CONFIG_PATH: qaState.configPath,
        }
      : {}),
    OPENCLAW_BUILD_PRIVATE_QA: "1",
    OPENCLAW_ENABLE_PRIVATE_QA_CLI: "1",
    OPENCLAW_RUN_NODE_SKIP_DTS_BUILD: env.OPENCLAW_RUN_NODE_SKIP_DTS_BUILD ?? "1",
    OPENCLAW_TEST_DISABLE_UPDATE_CHECK: env.OPENCLAW_TEST_DISABLE_UPDATE_CHECK ?? "1",
  };
}

function createQaState(outputDir) {
  const root = path.join(outputDir, "qa-state-root");
  const home = path.join(root, "home");
  const stateDir = path.join(root, "state");
  return {
    configPath: path.join(stateDir, "openclaw.json"),
    home,
    root,
    stateDir,
  };
}

async function runGatewayCpuScenarios(options, params = {}) {
  const repoRoot = params.cwd ?? process.cwd();
  const baseEnv = params.env ?? process.env;
  fs.mkdirSync(options.outputDir, { recursive: true });

  const startupOutput = path.join(options.outputDir, "gateway-startup-bench.json");
  const qaOutputDir = path.join(options.outputDir, "qa-suite");
  const qaSummaryPath = path.join(qaOutputDir, "qa-suite-summary.json");
  const qaState = options.skipQa ? null : createQaState(options.outputDir);
  if (qaState) {
    fs.mkdirSync(qaState.home, { recursive: true });
    fs.mkdirSync(qaState.stateDir, { recursive: true });
  }
  const qaBuildEnv = buildPrivateQaEnv(baseEnv, qaState);
  const qaOutputArg = toRepoRelativePath(repoRoot, qaOutputDir);
  const steps = [];

  if (!options.skipStartup) {
    const startupBuild = runStep(
      "startup build",
      process.execPath,
      ["scripts/ensure-cli-startup-build.mjs"],
      {},
      params,
    );
    steps.push(startupBuild);
    steps.push(
      startupBuild.status === 0
        ? runStep(
            "startup bench",
            process.execPath,
            [
              "--import",
              "tsx",
              "scripts/bench-gateway-startup.ts",
              "--runs",
              String(options.runs),
              "--warmup",
              String(options.warmup),
              "--output",
              startupOutput,
              ...options.startupCases.flatMap((id) => ["--case", id]),
            ],
            {},
            params,
          )
        : { name: "startup bench", signal: null, status: 1 },
    );
  }

  let privateQaBuildFailed = false;
  if (!options.skipQa && !hasPrivateQaDist(repoRoot, params.fs ?? fs)) {
    const privateQaBuild = runStep(
      "private QA build",
      process.execPath,
      ["scripts/build-all.mjs", "qaRuntime"],
      { env: qaBuildEnv },
      params,
    );
    steps.push(privateQaBuild);
    privateQaBuildFailed = privateQaBuild.status !== 0;
  }

  let qaStep = null;
  if (!options.skipQa) {
    const qaCommand = pnpmCommand(
      [
        "openclaw",
        "qa",
        "suite",
        "--provider-mode",
        "mock-openai",
        "--concurrency",
        "1",
        "--output-dir",
        qaOutputArg,
        ...options.qaScenarios.flatMap((id) => ["--scenario", id]),
      ],
      { cwd: repoRoot, env: qaBuildEnv },
    );
    qaStep = privateQaBuildFailed
      ? { name: "qa suite", signal: null, status: 1 }
      : runStep("qa suite", qaCommand.command, qaCommand.args, qaCommand.options, params);
    steps.push(qaStep);
  }

  const startupReportResult = options.skipStartup ? null : readStartupReport(startupOutput);
  const startupReportFailure =
    steps.find((step) => step.name === "startup bench")?.status === 0
      ? (startupReportResult?.diagnosticFailure ?? null)
      : null;
  const startup = startupReportResult?.report ?? null;
  const qaSummaryResult = options.skipQa ? null : readQaSuiteSummary(qaSummaryPath);
  const qaSummaryFailure =
    qaStep?.status === 0 ? (qaSummaryResult?.diagnosticFailure ?? null) : null;
  const qa = qaSummaryResult?.summary ?? null;
  const observations = collectGatewayCpuObservations({
    startup,
    qa,
    cpuCoreWarn: options.cpuCoreWarn,
    hotWallWarnMs: options.hotWallWarnMs,
  });
  const summary = {
    generatedAt: new Date().toISOString(),
    outputDir: options.outputDir,
    startupOutput: fs.existsSync(startupOutput) ? startupOutput : null,
    qaSummary: fs.existsSync(qaSummaryPath) ? qaSummaryPath : null,
    ...(startupReportFailure
      ? {
          startupReportFailure,
          startupReportFailureDetail: startupReportResult?.diagnosticDetail ?? null,
        }
      : {}),
    ...(qaSummaryFailure
      ? {
          qaSummaryFailure,
          qaSummaryFailureDetail: qaSummaryResult?.diagnosticDetail ?? null,
        }
      : {}),
    options: {
      startupCases: options.startupCases,
      qaScenarios: options.qaScenarios,
      runs: options.runs,
      warmup: options.warmup,
      cpuCoreWarn: options.cpuCoreWarn,
      hotWallWarnMs: options.hotWallWarnMs,
      qaStateDir: qaState?.stateDir ?? null,
    },
    steps,
    observations,
  };
  const summaryPath = path.join(options.outputDir, "summary.json");
  fs.writeFileSync(summaryPath, `${JSON.stringify(summary, null, 2)}\n`);
  if (!params.silent) {
    console.log(JSON.stringify(summary, null, 2));
  }
  if (observations.length > 0) {
    console.error(
      `[gateway-cpu] fail hot CPU observations: ${observations
        .map((observation) => `${observation.kind}:${observation.id}`)
        .join(", ")}`,
    );
  }
  if (qaSummaryFailure) {
    console.error(`[gateway-cpu] fail QA summary: ${qaSummaryResult?.diagnosticDetail}`);
  }
  if (startupReportFailure) {
    console.error(`[gateway-cpu] fail startup report: ${startupReportResult?.diagnosticDetail}`);
  }

  const exitCode =
    steps.some((step) => step.status !== 0) ||
    observations.length > 0 ||
    qaSummaryFailure ||
    startupReportFailure
      ? 1
      : 0;
  return { exitCode, summary };
}

async function main(params = {}) {
  const options = parseArgs(params.argv ?? process.argv.slice(2));
  const result = await runGatewayCpuScenarios(options, params);
  if (result.exitCode !== 0) {
    process.exitCode = 1;
  }
}

/**
 * Test-only access to the gateway CPU scenario parser and runner helpers.
 */
export const testing = {
  hasPrivateQaDist,
  parseArgs,
  readStartupReport,
  runGatewayCpuScenarios,
  validateStartupReport,
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(
    /** @param {unknown} error */ (error) => {
      console.error(error instanceof Error ? error.stack : String(error));
      process.exitCode = 1;
    },
  );
}
