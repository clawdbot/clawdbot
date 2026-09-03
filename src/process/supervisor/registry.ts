// Supervisor registry tracks active and historical supervised process runs.
import type { RunExit, RunRecord, RunState } from "./types.js";

const DEFAULT_MAX_EXITED_RECORDS = 2_000;

function resolveMaxExitedRecords(value?: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 1) {
    return DEFAULT_MAX_EXITED_RECORDS;
  }
  return Math.max(1, Math.floor(value));
}

type RunUpdate = Partial<
  Pick<
    RunRecord,
    "state" | "pid" | "terminationReason" | "exitCode" | "exitSignal" | "lastOutputAtMs"
  >
>;

type RunRegistration = {
  updateState: (state: RunState, patch?: Omit<RunUpdate, "state" | "lastOutputAtMs">) => void;
  touchOutput: () => void;
  finalize: (exit: Pick<RunExit, "reason" | "exitCode" | "exitSignal">) => void;
};

/**
 * Create the supervisor's mutable run registry. Exited records are retained
 * only for diagnostics, so the cap bounds memory without touching live runs.
 */
export function createRunRegistry(options?: { maxExitedRecords?: number }) {
  const records = new Map<string, RunRecord>();
  const maxExitedRecords = resolveMaxExitedRecords(options?.maxExitedRecords);
  // Keep this exact across every write path so ordinary finalization never scans all records.
  let exitedRecords = 0;

  const pruneExitedRecords = () => {
    if (exitedRecords <= maxExitedRecords) {
      return;
    }
    // Map insertion order is the retention policy: oldest exited records leave first.
    for (const [runId, record] of records.entries()) {
      if (exitedRecords <= maxExitedRecords) {
        break;
      }
      if (record.state !== "exited") {
        continue;
      }
      records.delete(runId);
      exitedRecords -= 1;
    }
  };

  const add = (record: RunRecord): RunRegistration => {
    if (records.get(record.runId)?.state === "exited") {
      exitedRecords -= 1;
    }
    const current = { ...record };
    records.set(current.runId, current);
    if (current.state === "exited") {
      exitedRecords += 1;
    }
    const update = (patch: RunUpdate) => {
      // A run ID is shared by retries. Late output, startup, or completion
      // belongs to this registration, never the replacement's diagnostics.
      if (records.get(current.runId) !== current) {
        return false;
      }
      const state = patch.state ?? current.state;
      if (current.state !== "exited" && state === "exited") {
        exitedRecords += 1;
      } else if (current.state === "exited" && state !== "exited") {
        exitedRecords -= 1;
      }
      Object.assign(current, patch, { updatedAtMs: patch.lastOutputAtMs ?? Date.now() });
      return true;
    };
    return {
      updateState: (state, patch) => {
        update({ ...patch, state });
      },
      touchOutput: () => {
        update({ lastOutputAtMs: Date.now() });
      },
      finalize: (exit) => {
        // First terminal observation wins; a fallback timer cannot rewrite it.
        if (current.state === "exited") {
          return;
        }
        if (
          update({
            state: "exited",
            terminationReason: current.terminationReason ?? exit.reason,
            exitCode: exit.exitCode,
            exitSignal: exit.exitSignal,
          })
        ) {
          pruneExitedRecords();
        }
      },
    };
  };

  const get = (runId: string): RunRecord | undefined => {
    const record = records.get(runId);
    return record ? { ...record } : undefined;
  };

  return {
    add,
    get,
  };
}
