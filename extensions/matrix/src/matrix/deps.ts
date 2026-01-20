import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

import type { RuntimeEnv } from "clawdbot/plugin-sdk";
import { getMatrixRuntime } from "../runtime.js";

const MATRIX_SDK_PACKAGE = "matrix-bot-sdk";
const getDepsLogger = () => getMatrixRuntime().logging.getChildLogger({ module: "matrix-deps" });
const logDepsVerbose = (message: string) => {
  const core = getMatrixRuntime();
  if (!core.logging.shouldLogVerbose()) return;
  getDepsLogger().debug(message);
};

export function isMatrixSdkAvailable(): boolean {
  try {
    const req = createRequire(import.meta.url);
    req.resolve(MATRIX_SDK_PACKAGE);
    return true;
  } catch (err) {
    logDepsVerbose(`matrix: dependency check failed for ${MATRIX_SDK_PACKAGE}: ${String(err)}`);
    return false;
  }
}

function resolvePluginRoot(): string {
  const currentDir = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(currentDir, "..", "..");
}

export async function ensureMatrixSdkInstalled(params: {
  runtime: RuntimeEnv;
  confirm?: (message: string) => Promise<boolean>;
}): Promise<void> {
  if (isMatrixSdkAvailable()) return;
  const confirm = params.confirm;
  if (confirm) {
    const ok = await confirm("Matrix requires matrix-bot-sdk. Install now?");
    if (!ok) {
      throw new Error("Matrix requires matrix-bot-sdk (install dependencies first).");
    }
  }

  const root = resolvePluginRoot();
  const command = fs.existsSync(path.join(root, "pnpm-lock.yaml"))
    ? ["pnpm", "install"]
    : ["npm", "install", "--omit=dev", "--silent"];
  params.runtime.log?.(`matrix: installing dependencies via ${command[0]} (${root})…`);
  const result = await getMatrixRuntime().system.runCommandWithTimeout(command, {
    cwd: root,
    timeoutMs: 300_000,
    env: { COREPACK_ENABLE_DOWNLOAD_PROMPT: "0" },
  });
  if (result.code !== 0) {
    throw new Error(
      result.stderr.trim() || result.stdout.trim() || "Matrix dependency install failed.",
    );
  }
  if (!isMatrixSdkAvailable()) {
    throw new Error("Matrix dependency install completed but matrix-bot-sdk is still missing.");
  }
}
