import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnPnpmRunner } from "../pnpm-runner.mjs";
import {
  installVitestProcessGroupCleanup,
  shouldUseDetachedVitestProcessGroup,
} from "../vitest-process-group.mjs";

const scriptFile = fileURLToPath(import.meta.url);
const scriptDir = path.dirname(scriptFile);
const repoRoot = path.resolve(scriptDir, "../..");

export async function runVitestBatch(params) {
  return await new Promise((resolve, reject) => {
    const child = spawnPnpmRunner({
      cwd: repoRoot,
      detached: shouldUseDetachedVitestProcessGroup(),
      env: params.env,
      pnpmArgs: buildVitestBatchPnpmArgs(params),
      stdio: "inherit",
    });
    const teardownChildCleanup = installVitestProcessGroupCleanup({ child });

    child.on("error", (error) => {
      teardownChildCleanup();
      reject(error);
    });
    child.on("exit", (code, signal) => {
      teardownChildCleanup();
      if (signal) {
        process.kill(process.pid, signal);
        return;
      }
      resolve(code ?? 1);
    });
  });
}

export function buildVitestBatchPnpmArgs(params) {
  return ["exec", "vitest", "run", "--config", params.config, ...params.args, ...params.targets];
}

export function isDirectScriptRun(metaUrl) {
  const entryHref = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : "";
  return metaUrl === entryHref;
}
