// Supervisor registry tracks active and historical supervised process runs.
import type { RunRecord, RunState, TerminationReason } from "./types.js";

/** In-memory run index for the supervisor; callers receive detached snapshots. */
function nowMs() {
  return Date.now();
}

const DEFAULT_MAX_EXITED_RECORDS = 2_000;

function resolveMaxExitedRecords(value?: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 1) {
    return DEFAULT_MAX_EXITED_RECORDS;
  }
  return Math.max(1, Math.floor(value));
}

type RunRegistry = {
  add: (record: RunRecord) => void;
  get: (runId: string) => RunRecord | undefined;
  updateState: (
    runId: string,
    state: RunState,
    patch?: Partial<Pick<RunRecord, "pid" | "terminationReason" | "exitCode" | "exitSignal">>,
  ) => RunRecord | undefined;
  touchOutput: (runId: string) => void;
  finalize: (
    runId: string,
    exit: {
      reason: TerminationReason;
      exitCode: number | null;
      exitSignal: NodeJS.Signals | number | null;
    },
  ) => { record: RunRecord; firstFinalize: boolean } | null;
};

/**
 * Create the supervisor's mutable run registry. Exited records are retained
 * only for diagnostics, so the cap bounds memory without touching live runs.
 */
export function createRunRegistry(options?: { maxExitedRecords?: number }): RunRegistry {
  const records = new Map<string, RunRecord>();
  const maxExitedRecords = resolveMaxExitedRecords(options?.maxExitedRecords);

  const pruneExitedRecords = () => {
    if (!records.size) {
      return;
    }
    let exited = 0;
    for (const record of records.values()) {
      if (record.state === "exited") {
        exited += 1;
      }
    }
    if (exited <= maxExitedRecords) {
      return;
    }
    let remove = exited - maxExitedRecords;
    // Map insertion order is the retention policy: oldest exited records leave first.
    for (const [runId, record] of records.entries()) {
      if (remove <= 0) {
        break;
      }
      if (record.state !== "exited") {
        continue;
      }
      records.delete(runId);
      remove -= 1;
    }
  };

  const add: RunRegistry["add"] = (record) => {
    records.set(record.runId, { ...record });
  };

  const get: RunRegistry["get"] = (runId) => {
    const record = records.get(runId);
    return record ? { ...record } : undefined;
  };

  const updateState: RunRegistry["updateState"] = (runId, state, patch) => {
    const current = records.get(runId);
    if (!current) {
      return undefined;
    }
    const updatedAtMs = nowMs();
    const next: RunRecord = {
      ...current,
      ...patch,
      state,
      updatedAtMs,
      lastOutputAtMs: current.lastOutputAtMs,
    };
    records.set(runId, next);
    return { ...next };
  };

  const touchOutput: RunRegistry["touchOutput"] = (runId) => {
    const current = records.get(runId);
    if (!current) {
      return;
    }
    const ts = nowMs();
    records.set(runId, {
      ...current,
      lastOutputAtMs: ts,
      updatedAtMs: ts,
    });
  };

  const finalize: RunRegistry["finalize"] = (runId, exit) => {
    const current = records.get(runId);
    if (!current) {
      return null;
    }
    const firstFinalize = current.state !== "exited";
    const ts = nowMs();
    const next: RunRecord = {
      ...current,
      state: "exited",
      // First terminal observation wins; late fallback timers must not rewrite
      // the exit reason or signal after a real process exit has been recorded.
      terminationReason: current.terminationReason ?? exit.reason,
      exitCode: current.exitCode !== undefined ? current.exitCode : exit.exitCode,
      exitSignal: current.exitSignal !== undefined ? current.exitSignal : exit.exitSignal,
      updatedAtMs: ts,
    };
    records.set(runId, next);
    pruneExitedRecords();
    return { record: { ...next }, firstFinalize };
  };

  return {
    add,
    get,
    updateState,
    touchOutput,
    finalize,
  };
}
