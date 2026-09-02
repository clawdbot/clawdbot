import { inject, TestRunner, type SerializedConfig } from "vitest";
import { finishVitestWorkerProfile } from "./vitest-profiler.mts";

const originalRunner = inject("openclawVitestProfileRunner");
const BaseRunner: typeof TestRunner = originalRunner
  ? (await import(originalRunner)).default
  : TestRunner;

export default class ProfiledRunner extends BaseRunner {
  constructor(config: SerializedConfig) {
    super({ ...config, runner: originalRunner });
    if (typeof this.onCleanupWorkerContext !== "function") {
      throw new Error("Runner profiling requires a custom runner extending Vitest TestRunner.");
    }
    // Vitest awaits this hook before acknowledging teardown, then may kill a fork
    // after 500 ms. Native exit-time profiling is too late for that boundary.
    this.onCleanupWorkerContext(finishVitestWorkerProfile);
  }
}
