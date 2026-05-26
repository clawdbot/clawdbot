import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { formatErrorMessage } from "./lib/error-format.mjs";
import { createPnpmRunnerSpawnSpec } from "./pnpm-runner.mjs";

export function parseArgs(argv) {
  const args = {
    mode: "",
    outputDir: process.env.OPENCLAW_VITEST_PROFILE_DIR?.trim() || "",
    vitestArgs: [],
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--") {
      const rest = argv.slice(i + 1);
      if (rest[0] === "--output-dir") {
        continue;
      }
      args.vitestArgs = rest;
      break;
    }
    if (arg === "--output-dir") {
      args.outputDir = argv[i + 1] ?? "";
      i += 1;
      continue;
    }
    if (!args.mode) {
      args.mode = arg;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  if (args.mode !== "main" && args.mode !== "runner") {
    throw new Error(
      "Usage: node scripts/run-vitest-profile.mjs <main|runner> [--output-dir <dir>]",
    );
  }

  return args;
}

export function resolveVitestProfileDir({ mode, outputDir }) {
  if (outputDir && outputDir.trim()) {
    return path.resolve(outputDir);
  }

  return fs.mkdtempSync(path.join(os.tmpdir(), `openclaw-vitest-${mode}-profile-`));
}

export function buildVitestProfileCommand({ mode, outputDir }) {
  return buildVitestProfileCommandWithArgs({ mode, outputDir, vitestArgs: [] });
}

export function buildVitestProfileCommandWithArgs({ mode, outputDir, vitestArgs }) {
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

export function buildVitestProfileSpawnSpec(plan, runnerOptions = {}) {
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
    },
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
