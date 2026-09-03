// Runs grouped batches through the repository's installed Vitest entrypoint.
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { TestHomeSelection } from "../../test/test-home-policy.mts";
import { installVitestProcessGroupCleanup } from "../vitest-process-group.mts";
import { resolveVitestCliEntry } from "./vitest-build-prerequisites.mts";
import { resolveVitestHomeSelection } from "./vitest-home-selection.mts";
import { resolveVitestNodeArgs } from "./vitest-process-env.mts";
import { spawnOwnedVitestProcess } from "./vitest-process.mts";
import type { VitestReportOutcome } from "./vitest-report-owner.mts";

export type VitestBatchRunParams = {
  args: string[];
  config: string;
  env?: NodeJS.ProcessEnv;
  // Owner-generated report configs retain their validated original selection.
  homeMode?: TestHomeSelection;
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
    const nodeArgs = resolveVitestNodeArgs(params.env);
    // Match project runs: installed tooling must not rediscover pnpm in an isolated HOME.
    const { child, completion } = spawnOwnedVitestProcess({
      homeMode:
        params.homeMode ??
        resolveVitestHomeSelection(["--config", params.config, ...params.args, ...params.targets], {
          cwd: repoRoot,
          env: params.env,
        }),
      command: process.execPath,
      nodeEntryIndex: nodeArgs.length,
      args: [
        ...nodeArgs,
        resolveVitestCliEntry({ env: params.env }),
        "run",
        "--config",
        params.config,
        ...params.args,
        ...params.targets,
      ],
      options: { cwd: repoRoot, env: params.env, stdio: "inherit" },
    });
    const cleanup = installVitestProcessGroupCleanup({
      child,
      forceSignal: "SIGKILL",
      forceSignalDelayMs: 100,
    });
    completion.finally(cleanup.teardown).then((result) => {
      const { code, signal } = result;
      const forwardedSignal = cleanup.getForwardedSignal();
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
 * Checks whether a module URL is the current direct script entrypoint.
 */
export function isDirectScriptRun(metaUrl: string): boolean {
  const entryHref = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : "";
  return metaUrl === entryHref;
}
