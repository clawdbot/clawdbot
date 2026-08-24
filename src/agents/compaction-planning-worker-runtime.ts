import { Worker } from "node:worker_threads";
import { resolveTimerTimeoutMs } from "@openclaw/normalization-core/number-coercion";
import { toErrorObject } from "../infra/errors.js";
import { resolveRuntimeWorkerUrl } from "../infra/runtime-worker-url.js";
import type {
  CompactionPlanningWorkerInput,
  CompactionPlanningWorkerResult,
  CompactionPlanningWorkerValue,
} from "./compaction-planning.worker.js";

const COMPACTION_PLANNING_WORKER_TIMEOUT_MS = 60_000;

export class CompactionPlanningWorkerError extends Error {
  constructor(
    message: string,
    readonly code: "unavailable" | "timeout" | "failed",
  ) {
    super(message);
    this.name = "CompactionPlanningWorkerError";
  }
}

function compactionPlanningWorkerUrl(): URL {
  return resolveRuntimeWorkerUrl({
    currentModuleUrl: import.meta.url,
    sourceWorkerName: "compaction-planning.worker",
    distWorkerPath: "agents/compaction-planning.worker.js",
  });
}

export function runCompactionPlanningWorker(params: {
  input: CompactionPlanningWorkerInput;
  signal?: AbortSignal;
  timeoutMs?: number;
  workerUrl?: URL;
}): Promise<CompactionPlanningWorkerValue> {
  const abortError = () =>
    toErrorObject(
      params.signal?.reason ?? new Error("compaction planning aborted"),
      "Non-Error rejection",
    );
  if (params.signal?.aborted) {
    return Promise.reject(abortError());
  }

  const workerUrl = params.workerUrl ?? compactionPlanningWorkerUrl();
  const sourceWorkerExecArgv = workerUrl.pathname.endsWith(".ts") ? ["--import", "tsx"] : undefined;
  let worker: Worker;
  try {
    worker = new Worker(workerUrl, {
      workerData: params.input,
      execArgv: sourceWorkerExecArgv,
    });
  } catch (error) {
    return Promise.reject(
      new CompactionPlanningWorkerError(
        error instanceof Error ? error.message : String(error),
        "unavailable",
      ),
    );
  }

  worker.unref?.();

  return new Promise<CompactionPlanningWorkerValue>((resolve, reject) => {
    let settled = false;
    const timeout = setTimeout(
      () =>
        fail(new CompactionPlanningWorkerError("compaction planning worker timed out", "timeout")),
      resolveTimerTimeoutMs(params.timeoutMs, COMPACTION_PLANNING_WORKER_TIMEOUT_MS),
    );
    const abort = () => fail(abortError());

    const settle = (finish: () => void, terminate: boolean) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      params.signal?.removeEventListener("abort", abort);
      worker.removeAllListeners();
      if (terminate) {
        void worker.terminate();
      }
      finish();
    };
    const fail = (error: Error, terminate = true) => settle(() => reject(error), terminate);

    params.signal?.addEventListener("abort", abort, { once: true });

    worker.once("message", (message: CompactionPlanningWorkerResult) => {
      settle(() => {
        if (message.status === "ok") {
          resolve(message.value);
          return;
        }
        reject(new CompactionPlanningWorkerError(message.error, "failed"));
      }, false);
    });
    worker.once("error", (error) => {
      const message = error instanceof Error ? error.message : String(error);
      fail(new CompactionPlanningWorkerError(message, "unavailable"));
    });
    worker.once("exit", (code) => {
      if (code === 0) {
        return;
      }
      fail(
        new CompactionPlanningWorkerError(
          `compaction planning worker exited with code ${code}`,
          "unavailable",
        ),
        false,
      );
    });
  });
}
