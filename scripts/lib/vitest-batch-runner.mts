// Runs grouped Vitest batches through the repo pnpm wrapper.
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnPnpmRunner } from "../pnpm-runner.mts";
import {
  createVitestProcessCompletion,
  installVitestProcessGroupCleanup,
  shouldUseDetachedVitestProcessGroup,
} from "../vitest-process-group.mts";

export type VitestBatchRunParams = {
  args: string[];
  config: string;
  env?: NodeJS.ProcessEnv;
  targets: string[];
};

const scriptFile = fileURLToPath(import.meta.url);
const scriptDir = path.dirname(scriptFile);
const repoRoot = path.resolve(scriptDir, "../..");

/**
 * Runs one Vitest batch and forwards process-group cleanup signals.
 */
export async function runVitestBatch(params: VitestBatchRunParams): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    let forwardedSignal: NodeJS.Signals | undefined;
    const detached = shouldUseDetachedVitestProcessGroup();
    const child = spawnPnpmRunner({
      cwd: repoRoot,
      detached,
      env: params.env,
      pnpmArgs: buildVitestBatchPnpmArgs(params),
      stdio: "inherit",
    });
    const teardownChildCleanup = installVitestProcessGroupCleanup({
      child,
      forceSignal: "SIGKILL",
      forceSignalDelayMs: 100,
      onSignal(signal: NodeJS.Signals) {
        forwardedSignal ??= signal;
      },
    });
    const completion = createVitestProcessCompletion({ child, detached }).finally(
      teardownChildCleanup,
    );

    completion.then((result) => {
      const { code, signal } = result;
      if (forwardedSignal) {
        process.kill(process.pid, forwardedSignal);
        return;
      }
      if (signal) {
        process.kill(process.pid, signal);
        return;
      }
      resolve(code ?? 1);
    }, reject);
  });
}

/**
 * Builds pnpm arguments for a Vitest batch run.
 */
export function buildVitestBatchPnpmArgs(params: VitestBatchRunParams): string[] {
  return ["exec", "vitest", "run", "--config", params.config, ...params.args, ...params.targets];
}

/**
 * Checks whether a module URL is the current direct script entrypoint.
 */
export function isDirectScriptRun(metaUrl: string): boolean {
  const entryHref = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : "";
  return metaUrl === entryHref;
}
