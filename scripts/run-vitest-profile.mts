// Profiles Vitest main or runner processes and writes CPU/heap artifacts.
import { spawnSync, type SpawnSyncOptions } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { formatErrorMessage } from "./lib/error-format.mts";
import { createPnpmRunnerSpawnSpec } from "./pnpm-runner.mts";

function readOutputDirValue(argv: string[], index: number): string {
  const value = argv[index + 1];
  if (value === undefined || value === "" || value.startsWith("-")) {
    throw new Error("Expected --output-dir <dir>.");
  }
  return value;
}

/**
 * Parses Vitest profiler mode, output directory, and forwarded Vitest args.
 */
export function parseArgs(argv: string[]) {
  let mode = "";
  let outputDir = process.env.OPENCLAW_VITEST_PROFILE_DIR?.trim() || "";
  let vitestArgs: string[] = [];

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (arg === "--") {
      const rest = argv.slice(i + 1);
      if (rest[0] === "--output-dir") {
        continue;
      }
      vitestArgs = rest;
      break;
    }
    if (arg === "--output-dir") {
      outputDir = readOutputDirValue(argv, i);
      i += 1;
      continue;
    }
    if (!mode) {
      mode = arg;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  if (mode !== "main" && mode !== "runner") {
    throw new Error(
      "Usage: node --import tsx scripts/run-vitest-profile.mts <main|runner> [--output-dir <dir>]",
    );
  }

  return { mode, outputDir, vitestArgs };
}

type VitestProfileOptions = Pick<ReturnType<typeof parseArgs>, "mode" | "outputDir">;
type VitestProfileSpawnSpec = {
  args: string[];
  command: string;
  options: SpawnSyncOptions;
};

/**
 * Resolves or creates the directory used for profiler artifacts.
 */
export function resolveVitestProfileDir({ mode, outputDir }: VitestProfileOptions) {
  if (outputDir && outputDir.trim()) {
    return path.resolve(outputDir);
  }

  return fs.mkdtempSync(path.join(os.tmpdir(), `openclaw-vitest-${mode}-profile-`));
}

/**
 * Builds a profiler command without additional Vitest args.
 */
export function buildVitestProfileCommand({ mode, outputDir }: VitestProfileOptions) {
  return buildVitestProfileCommandWithArgs({ mode, outputDir, vitestArgs: [] });
}

/**
 * Builds the profiler command for either Vitest main or worker-runner profiling.
 */
export function buildVitestProfileCommandWithArgs({
  mode,
  outputDir,
  vitestArgs,
}: ReturnType<typeof parseArgs>) {
  if (mode === "main") {
    return {
      command: process.execPath,
      args: [
        "--cpu-prof",
        `--cpu-prof-dir=${outputDir}`,
        "./node_modules/vitest/vitest.mjs",
        "run",
        "--config",
        "test/vitest/vitest.unit.config.ts",
        "--no-file-parallelism",
        ...vitestArgs,
      ],
    };
  }

  return {
    command: "pnpm",
    args: [
      "vitest",
      "run",
      "--config",
      "test/vitest/vitest.unit.config.ts",
      "--no-file-parallelism",
      "--execArgv=--cpu-prof",
      `--execArgv=--cpu-prof-dir=${outputDir}`,
      "--execArgv=--heap-prof",
      `--execArgv=--heap-prof-dir=${outputDir}`,
      ...vitestArgs,
    ],
  };
}

/**
 * Converts a profiler plan into a spawn spec, routing pnpm through the wrapper.
 */
export function buildVitestProfileSpawnSpec(
  plan: ReturnType<typeof buildVitestProfileCommandWithArgs>,
  runnerOptions: NonNullable<Parameters<typeof createPnpmRunnerSpawnSpec>[0]> = {},
): VitestProfileSpawnSpec {
  if (plan.command === "pnpm") {
    return createPnpmRunnerSpawnSpec({
      ...runnerOptions,
      env: runnerOptions.env ?? process.env,
      pnpmArgs: plan.args,
      stdio: "inherit",
    });
  }
  return {
    args: plan.args,
    command: plan.command,
    options: {
      env: process.env,
      stdio: "inherit",
    } satisfies SpawnSyncOptions,
  };
}

function main() {
  const parsed = parseArgs(process.argv.slice(2));
  const outputDir = resolveVitestProfileDir(parsed);
  fs.mkdirSync(outputDir, { recursive: true });

  const plan = buildVitestProfileCommandWithArgs({
    mode: parsed.mode,
    outputDir,
    vitestArgs: parsed.vitestArgs,
  });

  console.log(`[run-vitest-profile] writing ${parsed.mode} profiles to ${outputDir}`);

  const spawnSpec = buildVitestProfileSpawnSpec(plan);
  const result = spawnSync(spawnSpec.command, spawnSpec.args, spawnSpec.options);

  if (result.error) {
    throw result.error;
  }
  process.exit(result.status ?? 1);
}

const isMain =
  typeof process.argv[1] === "string" &&
  process.argv[1].length > 0 &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (isMain) {
  try {
    main();
  } catch (error) {
    console.error(formatErrorMessage(error));
    process.exit(1);
  }
}
