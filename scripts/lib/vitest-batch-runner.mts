// Runs grouped Vitest batches through the repo pnpm wrapper.
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createPnpmRunnerSpawnSpec } from "../pnpm-runner.mts";
import { installVitestProcessGroupCleanup } from "../vitest-process-group.mts";
import { spawnOwnedVitestProcess } from "./vitest-process.mts";
import type { VitestReportOutcome } from "./vitest-report-owner.mts";

export type VitestBatchRunParams = {
  args: string[];
  config: string;
  env?: NodeJS.ProcessEnv;
  targets: string[];
  onComplete?: (outcome: VitestReportOutcome) => void;
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
    const { child, completion } = spawnOwnedVitestProcess(
      createPnpmRunnerSpawnSpec({
        cwd: repoRoot,
        env: params.env,
        pnpmArgs: buildVitestBatchPnpmArgs(params),
        stdio: "inherit",
      }),
    );
    const teardownChildCleanup = installVitestProcessGroupCleanup({
      child,
      forceSignal: "SIGKILL",
      forceSignalDelayMs: 100,
      onSignal(signal: NodeJS.Signals) {
        forwardedSignal ??= signal;
      },
    });
    completion.finally(teardownChildCleanup).then((result) => {
      const { code, signal } = result;
      if (params.onComplete) {
        const outcome = { code: code ?? 1, signal: forwardedSignal ?? signal };
        params.onComplete(outcome);
        resolve(outcome.code);
        return;
      }
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
