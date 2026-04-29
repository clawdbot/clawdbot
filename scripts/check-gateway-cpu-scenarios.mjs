#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const DEFAULT_STARTUP_CASES = ["default", "oneInternalHook", "allInternalHooks"];
const DEFAULT_QA_SCENARIOS = [
  "channel-chat-baseline",
  "memory-failure-fallback",
  "gateway-restart-inflight-run",
];
const DEFAULT_CPU_CORE_WARN = 0.9;
const DEFAULT_HOT_WALL_WARN_MS = 30_000;

function parseArgs(argv) {
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
  return options;
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

function runStep(name, command, args) {
  console.error(`[gateway-cpu] start ${name}`);
  const result = spawnSync(command, args, {
    cwd: process.cwd(),
    env: process.env,
    stdio: "inherit",
  });
  const status = result.status ?? (result.signal ? 1 : 0);
  console.error(`[gateway-cpu] ${status === 0 ? "pass" : "fail"} ${name}`);
  return { name, status, signal: result.signal ?? null };
}

function pnpmCommand() {
  return process.platform === "win32" ? "pnpm.cmd" : "pnpm";
}

function toRepoRelativePath(absolutePath) {
  const relativePath = path.relative(process.cwd(), absolutePath);
  if (!relativePath || relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
    throw new Error(`Output path must stay inside the repo root: ${absolutePath}`);
  }
  return relativePath;
}

function collectObservations(params) {
  const observations = [];
  for (const result of params.startup?.results ?? []) {
    const cpuCoreMax = result.summary?.cpuCoreRatio?.max;
    const wallMax = result.summary?.readyzMs?.max ?? result.summary?.healthzMs?.max;
    if (
      typeof cpuCoreMax === "number" &&
      typeof wallMax === "number" &&
      cpuCoreMax >= params.cpuCoreWarn &&
      wallMax >= params.hotWallWarnMs
    ) {
      observations.push({
        kind: "startup-cpu-hot",
        id: result.id,
        cpuCoreRatioMax: cpuCoreMax,
        wallMsMax: wallMax,
      });
    }
  }
  const qaCpuCoreRatio = params.qa?.metrics?.gatewayCpuCoreRatio;
  const qaWallMs = params.qa?.metrics?.wallMs;
  if (
    typeof qaCpuCoreRatio === "number" &&
    typeof qaWallMs === "number" &&
    qaCpuCoreRatio >= params.cpuCoreWarn &&
    qaWallMs >= params.hotWallWarnMs
  ) {
    observations.push({
      kind: "qa-cpu-hot",
      id: "qa-suite",
      cpuCoreRatio: qaCpuCoreRatio,
      wallMs: qaWallMs,
    });
  }
  return observations;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  fs.mkdirSync(options.outputDir, { recursive: true });

  const startupOutput = path.join(options.outputDir, "gateway-startup-bench.json");
  const qaOutputDir = path.join(options.outputDir, "qa-suite");
  const qaOutputArg = toRepoRelativePath(qaOutputDir);
  const steps = [];

  if (!options.skipStartup) {
    steps.push(
      runStep("startup bench", process.execPath, [
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
      ]),
    );
  }

  if (!options.skipQa) {
    steps.push(
      runStep("qa suite", pnpmCommand(), [
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
      ]),
    );
  }

  const startup = readJsonIfExists(startupOutput);
  const qa = readJsonIfExists(path.join(qaOutputDir, "qa-suite-summary.json"));
  const observations = collectObservations({
    startup,
    qa,
    cpuCoreWarn: options.cpuCoreWarn,
    hotWallWarnMs: options.hotWallWarnMs,
  });
  const summary = {
    generatedAt: new Date().toISOString(),
    outputDir: options.outputDir,
    startupOutput: fs.existsSync(startupOutput) ? startupOutput : null,
    qaSummary: fs.existsSync(path.join(qaOutputDir, "qa-suite-summary.json"))
      ? path.join(qaOutputDir, "qa-suite-summary.json")
      : null,
    options: {
      startupCases: options.startupCases,
      qaScenarios: options.qaScenarios,
      runs: options.runs,
      warmup: options.warmup,
      cpuCoreWarn: options.cpuCoreWarn,
      hotWallWarnMs: options.hotWallWarnMs,
    },
    steps,
    observations,
  };
  const summaryPath = path.join(options.outputDir, "summary.json");
  fs.writeFileSync(summaryPath, `${JSON.stringify(summary, null, 2)}\n`);
  console.log(JSON.stringify(summary, null, 2));

  if (steps.some((step) => step.status !== 0)) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : String(error));
  process.exitCode = 1;
});
