import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runtimeProcessEntrypoints } from "../../infra/runtime-process-entrypoints.js";
import { runUtf8CommandWithTimeout } from "../../process/exec.js";
import { resolveNodeRunner } from "./shared.js";
import {
  resolveUpdatedInstallCommandEnv,
  stripGatewayServiceMarkerEnv,
} from "./update-command-service-env.js";

/** A fresh candidate owns inference imports; the updater's old hashed chunks may be gone. */
export async function runUpdateInferenceProbe(params: {
  root: string | undefined;
  env: NodeJS.ProcessEnv;
  nodeRunner?: string;
  signal?: AbortSignal;
}): Promise<boolean> {
  params.signal?.throwIfAborted();
  if (!params.root) {
    return false;
  }
  const worker = path.join(
    params.root,
    "dist",
    runtimeProcessEntrypoints.updateInferenceProbe.distWorkerPath,
  );
  try {
    const scratchDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-update-inference-"));
    try {
      const result = await runUtf8CommandWithTimeout(
        [params.nodeRunner ?? resolveNodeRunner(), worker],
        {
          cwd: params.root,
          baseEnv: {},
          env: {
            ...stripGatewayServiceMarkerEnv(
              resolveUpdatedInstallCommandEnv({ processEnv: params.env }),
            ),
            OPENCLAW_UPDATE_IN_PROGRESS: "0",
            TMPDIR: scratchDir,
            TMP: scratchDir,
            TEMP: scratchDir,
          },
          timeoutMs: 15_000,
          signal: params.signal,
          killProcessTree: true,
          killGraceMs: 0,
          input: "",
          maxOutputBytes: 16 * 1024,
          terminateOnOutputLimit: true,
        },
      );
      params.signal?.throwIfAborted();
      return result.code === 0 && result.termination === "exit";
    } finally {
      // A deadline kills the worker before its own finally can remove copied
      // auth. The parent owns all scratch until process-tree teardown completes.
      await fs.rm(scratchDir, { recursive: true, force: true });
    }
  } catch {
    params.signal?.throwIfAborted();
    // Older targets may not ship this advisory worker; provider outages and
    // missing probe support never authorize package rollback.
    return false;
  }
}
