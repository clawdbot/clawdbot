// Runs grouped Vitest batches through the repo pnpm wrapper.
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnPnpmRunner } from "../pnpm-runner.mjs";
import {
  forceKillVitestProcessGroup,
  installVitestProcessGroupCleanup,
  shouldUseDetachedVitestProcessGroup,
} from "../vitest-process-group.mjs";

const scriptFile = fileURLToPath(import.meta.url);
const scriptDir = path.dirname(scriptFile);
const repoRoot = path.resolve(scriptDir, "../..");

/**
 * Runs one Vitest batch and forwards process-group cleanup signals.
 */
export async function runVitestBatch(params) {
  return await new Promise((resolve, reject) => {
    let forwardedSignal;
    const child = spawnPnpmRunner({
      cwd: repoRoot,
      detached: shouldUseDetachedVitestProcessGroup(),
      env: params.env,
      pnpmArgs: buildVitestBatchPnpmArgs(params),
      stdio: "inherit",
    });
    const teardownChildCleanup = installVitestProcessGroupCleanup({
      child,
      forceSignal: "SIGKILL",
      forceSignalDelayMs: 100,
      onSignal(signal) {
        forwardedSignal ??= signal;
      },
    });

    child.on("error", (error) => {
      teardownChildCleanup();
      reject(error);
    });
    child.on("exit", (code, signal) => {
      teardownChildCleanup();
      if (forwardedSignal) {
        forceKillVitestProcessGroup(child);
        process.kill(process.pid, forwardedSignal);
        return;
      }
      if (signal) {
        process.kill(process.pid, signal);
        return;
      }
      resolve(code ?? 1);
    });
  });
}

/**
 * Builds pnpm arguments for a Vitest batch run.
 */
export function buildVitestBatchPnpmArgs(params) {
  return ["exec", "vitest", "run", "--config", params.config, ...params.args, ...params.targets];
}

/**
 * Checks whether a module URL is the current direct script entrypoint.
 */
export function isDirectScriptRun(metaUrl) {
  const entryHref = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : "";
  return metaUrl === entryHref;
}
