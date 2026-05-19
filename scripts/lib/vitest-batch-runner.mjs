import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  installVitestProcessGroupCleanup,
  shouldUseDetachedVitestProcessGroup,
} from "../vitest-process-group.mjs";

const scriptFile = fileURLToPath(import.meta.url);
const scriptDir = path.dirname(scriptFile);
const repoRoot = path.resolve(scriptDir, "../..");
const pnpm = "pnpm";

export async function runVitestBatch(params) {
  return await new Promise((resolve, reject) => {
    const child = spawn(
      pnpm,
      ["exec", "vitest", "run", "--config", params.config, ...params.targets, ...params.args],
      {
        cwd: repoRoot,
        detached: shouldUseDetachedVitestProcessGroup(),
        stdio: "inherit",
        shell: process.platform === "win32",
        env: params.env,
      },
    );
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

export function isDirectScriptRun(metaUrl) {
  const entryHref = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : "";
  return metaUrl === entryHref;
}
