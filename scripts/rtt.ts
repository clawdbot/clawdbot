#!/usr/bin/env -S node --import tsx
import fs from "node:fs/promises";
import path from "node:path";
import {
  appendJsonl,
  assertDockerAvailable,
  assertHarnessRoot,
  assertRequiredEnv,
  buildRttResult,
  buildRunId,
  createHarnessEnv,
  readTelegramSummary,
  resolvePublishedVersion,
  runHarness,
  validateOpenClawPackageSpec,
  writeJson,
  type RttProviderMode,
} from "./lib/rtt-harness.ts";

const DEFAULT_SCENARIOS = ["telegram-mentioned-message-reply"];
const DEFAULT_PROVIDER_MODE = "mock-openai" satisfies RttProviderMode;
const DEFAULT_TIMEOUT_MS = 180_000;

function usage() {
  return [
    "Usage: pnpm rtt <openclaw@spec> [--provider mock-openai|live-frontier] [--runs N] [--timeout-ms N] [--harness-root PATH] [--output PATH]",
    "",
    "Examples:",
    "  pnpm rtt openclaw@beta",
    "  pnpm rtt openclaw@2026.4.30",
    "  pnpm rtt openclaw@latest --provider live-frontier",
  ].join("\n");
}

function parseProviderMode(value: string): RttProviderMode {
  if (value === "mock-openai" || value === "live-frontier") {
    return value;
  }
  throw new Error(`--provider must be mock-openai or live-frontier; got: ${value}`);
}

function parsePositiveInt(label: string, value: string) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`${label} must be a positive integer; got: ${value}`);
  }
  return parsed;
}

function resolveHome(input: string) {
  if (input === "~") {
    return process.env.HOME ?? input;
  }
  if (input.startsWith("~/")) {
    return path.join(process.env.HOME ?? "~", input.slice(2));
  }
  return input;
}

function parseArgs(argv: string[]) {
  let spec: string | undefined;
  let providerMode = DEFAULT_PROVIDER_MODE;
  let runs = 1;
  let harnessRoot = "~/Developer/clawdbot";
  let output = "runs";
  let timeoutMs = DEFAULT_TIMEOUT_MS;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") {
      process.stdout.write(`${usage()}\n`);
      process.exit(0);
    }
    if (arg === "--provider") {
      providerMode = parseProviderMode(argv[++index] ?? "");
      continue;
    }
    if (arg === "--runs") {
      runs = parsePositiveInt("--runs", argv[++index] ?? "");
      continue;
    }
    if (arg === "--harness-root") {
      harnessRoot = argv[++index] ?? "";
      if (!harnessRoot.trim()) {
        throw new Error("--harness-root requires a path.");
      }
      continue;
    }
    if (arg === "--timeout-ms") {
      timeoutMs = parsePositiveInt("--timeout-ms", argv[++index] ?? "");
      continue;
    }
    if (arg === "--output") {
      output = argv[++index] ?? "";
      if (!output.trim()) {
        throw new Error("--output requires a path.");
      }
      continue;
    }
    if (arg.startsWith("--")) {
      throw new Error(`Unknown option: ${arg}`);
    }
    if (spec) {
      throw new Error(`Unexpected extra argument: ${arg}`);
    }
    spec = arg;
  }

  if (!spec) {
    throw new Error(`Missing package spec.\n${usage()}`);
  }

  return {
    spec: validateOpenClawPackageSpec(spec),
    options: {
      providerMode,
      runs,
      harnessRoot: path.resolve(resolveHome(harnessRoot)),
      output: path.resolve(resolveHome(output)),
      scenarios: DEFAULT_SCENARIOS,
      timeoutMs,
    },
  };
}

async function runOne(params: {
  index: number;
  options: ReturnType<typeof parseArgs>["options"];
  spec: string;
  version: string;
}) {
  const runId = buildRunId({ now: new Date(), spec: params.spec, index: params.index });
  const runDir = path.join(params.options.output, runId);
  const rawDir = path.join(runDir, "raw");
  const resultPath = path.join(runDir, "result.json");
  const harnessRawDir = path.join(params.options.harnessRoot, ".artifacts/rtt", runId, "raw");
  const rawOutputDir = path.relative(params.options.harnessRoot, harnessRawDir);
  const startedAt = new Date();
  const env = createHarnessEnv({
    baseEnv: process.env,
    providerMode: params.options.providerMode,
    rawOutputDir,
    scenarios: params.options.scenarios,
    spec: params.spec,
    timeoutMs: params.options.timeoutMs,
    version: params.version,
  });

  process.stderr.write(`[rtt] run ${params.index + 1}/${params.options.runs}: ${params.spec}\n`);
  const harnessExitCode = await runHarness({ env, harnessRoot: params.options.harnessRoot });
  await readTelegramSummary(path.join(harnessRawDir, "telegram-qa-summary.json"));
  await fs.rm(rawDir, { recursive: true, force: true });
  await fs.mkdir(path.dirname(rawDir), { recursive: true });
  await fs.cp(harnessRawDir, rawDir, { recursive: true });

  const rawSummaryPath = path.join(rawDir, "telegram-qa-summary.json");
  const rawReportPath = path.join(rawDir, "telegram-qa-report.md");
  const rawObservedMessagesPath = path.join(rawDir, "telegram-qa-observed-messages.json");
  const rawSummary = await readTelegramSummary(rawSummaryPath);
  const finishedAt = new Date();
  const result = buildRttResult({
    artifacts: {
      rawSummaryPath,
      rawReportPath,
      rawObservedMessagesPath,
      resultPath,
    },
    finishedAt,
    providerMode: params.options.providerMode,
    rawSummary,
    runId,
    scenarios: params.options.scenarios,
    spec: params.spec,
    startedAt,
    version: params.version,
  });

  await writeJson(resultPath, result);
  await appendJsonl(path.resolve("data/rtt.jsonl"), result);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  return {
    harnessExitCode,
    result,
  };
}

async function main() {
  const { spec, options } = parseArgs(process.argv.slice(2));
  assertRequiredEnv(process.env);
  await assertHarnessRoot(options.harnessRoot);
  await assertDockerAvailable();
  const version = await resolvePublishedVersion(spec);
  let failed = false;
  for (let index = 0; index < options.runs; index += 1) {
    const run = await runOne({ index, options, spec, version });
    failed = failed || run.harnessExitCode !== 0 || run.result.run.status === "fail";
  }
  if (failed) {
    process.exitCode = 1;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`[rtt] ${message}\n`);
    process.exitCode = 1;
  });
}

export const __testing = {
  parseArgs,
  parseProviderMode,
  parsePositiveInt,
  resolveHome,
};
