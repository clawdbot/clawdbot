import type { CodeModeWorkerResult } from "./code-mode-runtime.js";
import {
  recordCodeModeSnapshot,
  recordCodeModeWorkerRun,
  type CodeModeStats,
} from "./code-mode-stats.js";
import { normalizeCodeModeWorkerResult, runCodeModeWorker } from "./code-mode-worker.js";

export async function runTrackedCodeModeWorker(params: {
  stats?: CodeModeStats;
  kind: "exec" | "resume";
  workerData: unknown;
  timeoutMs: number;
  signal?: AbortSignal;
}): Promise<CodeModeWorkerResult> {
  let workerSpawnedAt: number | undefined;
  try {
    const result = normalizeCodeModeWorkerResult(
      await runCodeModeWorker({
        workerData: params.workerData,
        timeoutMs: params.timeoutMs,
        signal: params.signal,
        onWorkerSpawned: () => {
          workerSpawnedAt = Date.now();
        },
      }),
    );
    if (result.snapshotAttempt) {
      recordCodeModeSnapshot(params.stats, result.snapshotAttempt);
    }
    const { snapshotAttempt: _snapshotAttempt, ...settlementResult } = result;
    return settlementResult as CodeModeWorkerResult;
  } finally {
    if (workerSpawnedAt !== undefined) {
      recordCodeModeWorkerRun(params.stats, params.kind, Date.now() - workerSpawnedAt);
    }
  }
}
