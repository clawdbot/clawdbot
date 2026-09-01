// Profiles Vitest main or runner processes and writes CPU/heap artifacts.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { formatErrorMessage } from "./lib/error-format.mts";
import { signalExitCode } from "./lib/managed-child-process.mts";
import { spawnOwnedVitestProcess } from "./lib/vitest-process.mts";
import { installVitestProcessGroupCleanup } from "./vitest-process-group.mts";

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
 * Builds the profiler command for either Vitest main or worker-runner profiling.
 */
export function buildVitestProfileCommandWithArgs({
  mode,
  outputDir,
  vitestArgs,
}: ReturnType<typeof parseArgs>) {
  return {
    command: process.execPath,
    args: [
      fileURLToPath(new URL("./run-vitest-profile-child.mts", import.meta.url)),
      mode,
      outputDir,
      "run",
      ...vitestArgs,
    ],
  };
}

async function main() {
  const parsed = parseArgs(process.argv.slice(2));
  const outputDir = resolveVitestProfileDir(parsed);
  fs.mkdirSync(outputDir, { recursive: true });

  const plan = buildVitestProfileCommandWithArgs({
    mode: parsed.mode,
    outputDir,
    vitestArgs: parsed.vitestArgs,
  });

  console.log(`[run-vitest-profile] writing ${parsed.mode} profiles to ${outputDir}`);

  const { child, completion } = spawnOwnedVitestProcess({
    ...plan,
    options: { env: process.env, stdio: "inherit" },
  });
  let forwardedSignal: NodeJS.Signals | undefined;
  const teardown = installVitestProcessGroupCleanup({
    child,
    forceSignal: "SIGKILL",
    forceSignalDelayMs: 100,
    onSignal: (signal) => {
      forwardedSignal ??= signal;
    },
  });
  const result = await completion.finally(teardown);
  if (forwardedSignal) {
    console.error(`[run-vitest-profile] FAILED (exit ${signalExitCode(forwardedSignal)})`);
    process.kill(process.pid, forwardedSignal);
    return;
  }
  process.exitCode = result.code ?? 1;
}

const isMain =
  typeof process.argv[1] === "string" &&
  process.argv[1].length > 0 &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (isMain) {
  try {
    await main();
  } catch (error) {
    console.error(formatErrorMessage(error));
    process.exitCode = 1;
  }
  if (process.exitCode) {
    console.error(`[run-vitest-profile] FAILED (exit ${process.exitCode})`);
  }
}
