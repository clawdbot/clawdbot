import type {
  CompactionPlanningWorkerInput,
  CompactionPlanningWorkerValue,
} from "./compaction-planning.worker.js";
import "./compaction-planning-worker.js";

type CompactionPlanningWorkerTestApi = {
  resolveCompactionPlanningWorkerUrl(currentModuleUrl?: string): URL;
  runCompactionPlanningWorker(params: {
    input: CompactionPlanningWorkerInput;
    signal?: AbortSignal;
    timeoutMs?: number;
    workerUrl?: URL;
  }): Promise<CompactionPlanningWorkerValue>;
};

export const compactionPlanningWorkerTesting = (globalThis as Record<PropertyKey, unknown>)[
  Symbol.for("openclaw.compactionPlanningWorkerTestApi")
] as CompactionPlanningWorkerTestApi;
