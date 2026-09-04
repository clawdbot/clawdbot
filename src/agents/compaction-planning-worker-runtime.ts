import { resolveTimerTimeoutMs } from "@openclaw/normalization-core/number-coercion";
import { resolveRuntimeWorkerUrl } from "../infra/runtime-worker-url.js";
import { WorkerTaskError, WorkerTaskPool } from "../infra/worker-task-pool.js";
import type {
  CompactionPlanningWorkerInput,
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

const planningPool = new WorkerTaskPool<
  CompactionPlanningWorkerInput,
  CompactionPlanningWorkerValue
>({
  workerUrl: resolveRuntimeWorkerUrl({
    currentModuleUrl: import.meta.url,
    sourceWorkerName: "compaction-planning.worker",
    distWorkerPath: "agents/compaction-planning.worker.js",
  }),
});

export async function runCompactionPlanningWorker(params: {
  input: CompactionPlanningWorkerInput;
  signal?: AbortSignal;
  timeoutMs?: number;
  workerUrl?: URL;
}): Promise<CompactionPlanningWorkerValue> {
  const pool = params.workerUrl
    ? new WorkerTaskPool<CompactionPlanningWorkerInput, CompactionPlanningWorkerValue>({
        workerUrl: params.workerUrl,
      })
    : planningPool;
  try {
    return await pool.run(params.input, {
      timeoutMs: resolveTimerTimeoutMs(params.timeoutMs, COMPACTION_PLANNING_WORKER_TIMEOUT_MS),
      signal: params.signal,
    });
  } catch (error) {
    if (error instanceof WorkerTaskError && error !== params.signal?.reason) {
      throw new CompactionPlanningWorkerError(
        error.code === "timeout" ? "compaction planning worker timed out" : error.message,
        error.code,
      );
    }
    throw error;
  } finally {
    if (params.workerUrl) {
      await pool.close();
    }
  }
}
