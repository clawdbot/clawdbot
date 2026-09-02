// Parent-side worker boundary for synchronous shadow-index publication.
import { Worker } from "node:worker_threads";
import { resolveRuntimeWorkerUrl } from "openclaw/plugin-sdk/process-runtime";
import { MemoryIndexRevisionConflictError } from "./manager-db.js";
import { memoryPublishWorkerEntrypoint } from "./manager-publish-entrypoint.js";
import type {
  MemoryPublishWorkerInput,
  MemoryPublishWorkerResult,
} from "./manager-publish.worker.js";

const MEMORY_PUBLISH_WORKER_TIMEOUT_MS = 5 * 60_000;

function isResult(value: unknown): value is MemoryPublishWorkerResult {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const result = value as {
    status?: unknown;
    revision?: unknown;
    code?: unknown;
    error?: unknown;
  };
  return result.status === "ok"
    ? typeof result.revision === "number" && Number.isSafeInteger(result.revision)
    : result.status === "failed" &&
        (result.code === "revision-conflict" || result.code === "failed") &&
        typeof result.error === "string";
}

function resolveSourceWorkerExecArgv(workerUrl: URL): string[] | undefined {
  if (!/\.[cm]?ts$/u.test(workerUrl.pathname)) {
    return undefined;
  }
  // `--import tsx` does not install its ESM resolver inside Worker threads.
  // Register the supported API so source-tree .js imports resolve to .ts files.
  const tsxApiUrl = import.meta.resolve("tsx/esm/api");
  const registerTsx = `import { register } from ${JSON.stringify(tsxApiUrl)}; register();`;
  return ["--import", `data:text/javascript,${encodeURIComponent(registerTsx)}`];
}

/** Publish on a lifecycle-bound worker so synchronous SQLite cannot stall the Gateway. */
export async function publishMemoryDatabaseInWorker(
  input: MemoryPublishWorkerInput,
): Promise<number> {
  const workerUrl = resolveRuntimeWorkerUrl(memoryPublishWorkerEntrypoint);
  const worker = new Worker(workerUrl, {
    workerData: input,
    execArgv: resolveSourceWorkerExecArgv(workerUrl),
    stdout: true,
    stderr: true,
  });
  worker.stdout.resume();
  worker.stderr.resume();
  return await new Promise<number>((resolve, reject) => {
    let settled = false;
    const settle = (action: () => void) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      // Wait for the worker to release every runtime/native handle before the
      // caller drops its workspace lease or removes the shadow database.
      // Retain the error listener until then: termination can race startup errors.
      const complete = () => {
        worker.removeAllListeners();
        action();
      };
      void worker.terminate().then(
        () => complete(),
        () => complete(),
      );
    };
    const timeout = setTimeout(() => {
      settle(() => reject(new Error("memory publish worker timed out")));
    }, MEMORY_PUBLISH_WORKER_TIMEOUT_MS);
    worker.once("message", (message: unknown) => {
      settle(() => {
        if (!isResult(message)) {
          reject(new Error("memory publish worker returned an invalid result"));
        } else if (message.status === "ok") {
          resolve(message.revision);
        } else if (message.code === "revision-conflict") {
          reject(new MemoryIndexRevisionConflictError(message.error));
        } else {
          reject(new Error(message.error));
        }
      });
    });
    worker.once("error", (error) =>
      settle(() => reject(error instanceof Error ? error : new Error(String(error)))),
    );
    worker.once("exit", (code) => {
      if (code !== 0) {
        settle(() => reject(new Error(`memory publish worker exited with code ${code}`)));
      } else {
        settle(() => reject(new Error("memory publish worker exited without a result")));
      }
    });
  });
}
