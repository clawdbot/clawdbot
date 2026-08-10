import type { CodeModeSnapshotAttempt } from "./code-mode-runtime.js";
import { CODE_MODE_BRIDGE_METHODS, type CodeModeBridgeMethod } from "./code-mode-worker-types.js";

type CodeModeWorkerKind = "exec" | "resume";
type CodeModeOutcome = "completed" | "waiting" | "failed" | "aborted";
const CODE_MODE_CONTROLS = ["exec", "wait"] as const;
const CODE_MODE_WORKER_KINDS = ["exec", "resume"] as const;
const CODE_MODE_OUTCOMES = ["completed", "waiting", "failed", "aborted"] as const;

type CodeModeWorkerRunStats = {
  count: number;
  elapsedMs: number;
};

type CodeModeSnapshotStats = {
  attempted: number;
  produced: number;
  accepted: number;
  rejected: number;
  incomplete: number;
  rejectedByReason?: Partial<Record<"size" | "schema", number>>;
  totalBytes: number;
  maxBytes: number;
  serializationMs: number;
  coverage: "exact" | "lower_bound";
};

export type CodeModeStats = {
  /** Once this object exists, omitted sparse counters mean observed zero. */
  controlCalls: Partial<Record<"exec" | "wait", number>>;
  bridgeCalls: Partial<Record<CodeModeBridgeMethod, number>>;
  workerRuns: Partial<Record<CodeModeWorkerKind, CodeModeWorkerRunStats>>;
  bridgeLifecycle: {
    registered?: number;
    started?: number;
    settled?: number;
    failed?: number;
    cancelRequested?: number;
    settledAfterCancel?: number;
    /** Outstanding bridge count sampled when stats leave one Code Mode attempt. */
    unresolvedAtExtraction?: number;
  };
  snapshots?: CodeModeSnapshotStats;
  outcomes: Partial<Record<CodeModeOutcome, number>>;
};

type CodeModeStatsOwner = {
  current?: {
    codeModeStats?: CodeModeStats;
  };
};

type CodeModeStatsRuntime = {
  unresolved: number;
  // A cumulative maximum cannot reconstruct a later attempt's lower maximum.
  // Consume this interval-owned high-water at the drain boundary instead.
  snapshotMaxBytesSinceDrain: number;
};

const runtimeByStats = new WeakMap<CodeModeStats, CodeModeStatsRuntime>();
// Parked sources outlive their first attempt owner. Global source baselines let
// a validated later owner drain only new mutations without double-counting.
const sourcesByOwner = new WeakMap<CodeModeStatsOwner, Set<CodeModeStats>>();
const drainedBySource = new WeakMap<CodeModeStats, CodeModeStats>();

function incrementCounter<K extends string>(counters: Partial<Record<K, number>>, key: K): void {
  counters[key] = (counters[key] ?? 0) + 1;
}

function incrementLifecycle(
  stats: CodeModeStats | undefined,
  key: Exclude<keyof CodeModeStats["bridgeLifecycle"], "unresolvedAtExtraction">,
): void {
  if (stats) {
    stats.bridgeLifecycle[key] = (stats.bridgeLifecycle[key] ?? 0) + 1;
  }
}

function runtimeFor(stats: CodeModeStats): CodeModeStatsRuntime {
  const existing = runtimeByStats.get(stats);
  if (existing) {
    return existing;
  }
  const created = { unresolved: 0, snapshotMaxBytesSinceDrain: 0 };
  runtimeByStats.set(stats, created);
  return created;
}

export function createCodeModeStats(): CodeModeStats {
  return {
    controlCalls: {},
    bridgeCalls: {},
    workerRuns: {},
    bridgeLifecycle: {},
    outcomes: {},
  };
}

export function ensureCodeModeStats(owner?: CodeModeStatsOwner): CodeModeStats | undefined {
  const catalog = owner?.current;
  if (!catalog) {
    return undefined;
  }
  catalog.codeModeStats ??= createCodeModeStats();
  registerCodeModeStatsSource(owner, catalog.codeModeStats);
  return catalog.codeModeStats;
}

export function registerCodeModeStatsSource(
  owner: CodeModeStatsOwner | undefined,
  stats: CodeModeStats | undefined,
): void {
  if (!owner?.current || !stats) {
    return;
  }
  const sources = sourcesByOwner.get(owner) ?? new Set<CodeModeStats>();
  sources.add(stats);
  sourcesByOwner.set(owner, sources);
  runtimeFor(stats);
}

export function cloneCodeModeStats(stats: CodeModeStats): CodeModeStats {
  const workerRuns: CodeModeStats["workerRuns"] = {};
  for (const kind of CODE_MODE_WORKER_KINDS) {
    const value = stats.workerRuns[kind];
    if (value) {
      workerRuns[kind] = { ...value };
    }
  }
  const clone: CodeModeStats = {
    controlCalls: { ...stats.controlCalls },
    bridgeCalls: { ...stats.bridgeCalls },
    workerRuns,
    bridgeLifecycle: { ...stats.bridgeLifecycle },
    ...(stats.snapshots
      ? {
          snapshots: {
            ...stats.snapshots,
            ...(stats.snapshots.rejectedByReason
              ? { rejectedByReason: { ...stats.snapshots.rejectedByReason } }
              : {}),
          },
        }
      : {}),
    outcomes: { ...stats.outcomes },
  };
  const runtime = runtimeByStats.get(stats);
  if (runtime) {
    clone.bridgeLifecycle.unresolvedAtExtraction = runtime.unresolved;
  }
  return clone;
}

function positiveDelta(
  current: number | undefined,
  previous: number | undefined,
): number | undefined {
  if (current === undefined) {
    return undefined;
  }
  const delta = Math.max(0, current - (previous ?? 0));
  return delta > 0 ? delta : undefined;
}

function codeModeStatsDelta(
  current: CodeModeStats,
  previous: CodeModeStats | undefined,
  snapshotMaxBytes: number,
): CodeModeStats {
  const delta = createCodeModeStats();
  for (const control of CODE_MODE_CONTROLS) {
    const value = positiveDelta(current.controlCalls[control], previous?.controlCalls[control]);
    if (value !== undefined) {
      delta.controlCalls[control] = value;
    }
  }
  for (const method of CODE_MODE_BRIDGE_METHODS) {
    const value = positiveDelta(current.bridgeCalls[method], previous?.bridgeCalls[method]);
    if (value !== undefined) {
      delta.bridgeCalls[method] = value;
    }
  }
  for (const kind of CODE_MODE_WORKER_KINDS) {
    const value = current.workerRuns[kind];
    if (!value) {
      continue;
    }
    const count = Math.max(0, value.count - (previous?.workerRuns[kind]?.count ?? 0));
    const elapsedMs = Math.max(0, value.elapsedMs - (previous?.workerRuns[kind]?.elapsedMs ?? 0));
    if (count > 0 || elapsedMs > 0) {
      delta.workerRuns[kind] = { count, elapsedMs };
    }
  }
  for (const key of [
    "registered",
    "started",
    "settled",
    "failed",
    "cancelRequested",
    "settledAfterCancel",
  ] as const) {
    const value = positiveDelta(current.bridgeLifecycle[key], previous?.bridgeLifecycle[key]);
    if (value !== undefined) {
      delta.bridgeLifecycle[key] = value;
    }
  }
  if (current.snapshots) {
    const attempted = Math.max(
      0,
      current.snapshots.attempted - (previous?.snapshots?.attempted ?? 0),
    );
    const produced = Math.max(0, current.snapshots.produced - (previous?.snapshots?.produced ?? 0));
    const accepted = Math.max(0, current.snapshots.accepted - (previous?.snapshots?.accepted ?? 0));
    const rejected = Math.max(0, current.snapshots.rejected - (previous?.snapshots?.rejected ?? 0));
    const incomplete = Math.max(
      0,
      current.snapshots.incomplete - (previous?.snapshots?.incomplete ?? 0),
    );
    const totalBytes = Math.max(
      0,
      current.snapshots.totalBytes - (previous?.snapshots?.totalBytes ?? 0),
    );
    const serializationMs = Math.max(
      0,
      current.snapshots.serializationMs - (previous?.snapshots?.serializationMs ?? 0),
    );
    const rejectedByReason = Object.fromEntries(
      (["size", "schema"] as const).flatMap((reason) => {
        const value = positiveDelta(
          current.snapshots?.rejectedByReason?.[reason],
          previous?.snapshots?.rejectedByReason?.[reason],
        );
        return value === undefined ? [] : [[reason, value]];
      }),
    ) as NonNullable<CodeModeSnapshotStats["rejectedByReason"]>;
    if (attempted > 0 || totalBytes > 0 || serializationMs > 0) {
      delta.snapshots = {
        attempted,
        produced,
        accepted,
        rejected,
        incomplete,
        ...(Object.keys(rejectedByReason).length > 0 ? { rejectedByReason } : {}),
        totalBytes,
        maxBytes: snapshotMaxBytes,
        serializationMs,
        coverage: produced === attempted ? "exact" : "lower_bound",
      };
    }
  }
  for (const outcome of CODE_MODE_OUTCOMES) {
    const value = positiveDelta(current.outcomes[outcome], previous?.outcomes[outcome]);
    if (value !== undefined) {
      delta.outcomes[outcome] = value;
    }
  }
  return delta;
}

export function drainCodeModeAttemptStats(owner?: CodeModeStatsOwner): CodeModeStats | undefined {
  if (!owner?.current) {
    return undefined;
  }
  if (owner.current.codeModeStats) {
    registerCodeModeStatsSource(owner, owner.current.codeModeStats);
  }
  const sources = sourcesByOwner.get(owner);
  if (!sources || sources.size === 0) {
    return undefined;
  }

  const drained = createCodeModeStats();
  let unresolved = 0;
  for (const source of sources) {
    const runtime = runtimeFor(source);
    mergeCodeModeStats(
      drained,
      codeModeStatsDelta(source, drainedBySource.get(source), runtime.snapshotMaxBytesSinceDrain),
    );
    drainedBySource.set(source, cloneCodeModeStats(source));
    runtime.snapshotMaxBytesSinceDrain = 0;
    unresolved += runtime.unresolved;
  }
  drained.bridgeLifecycle.unresolvedAtExtraction = unresolved;
  return drained;
}

export function mergeCodeModeStats(target: CodeModeStats, source: CodeModeStats): void {
  for (const control of CODE_MODE_CONTROLS) {
    const value = source.controlCalls[control];
    if (value !== undefined) {
      target.controlCalls[control] = (target.controlCalls[control] ?? 0) + value;
    }
  }
  for (const method of CODE_MODE_BRIDGE_METHODS) {
    const value = source.bridgeCalls[method];
    if (value !== undefined) {
      target.bridgeCalls[method] = (target.bridgeCalls[method] ?? 0) + value;
    }
  }
  for (const kind of CODE_MODE_WORKER_KINDS) {
    const value = source.workerRuns[kind];
    if (!value) {
      continue;
    }
    const current = target.workerRuns[kind] ?? { count: 0, elapsedMs: 0 };
    current.count += value.count;
    current.elapsedMs += value.elapsedMs;
    target.workerRuns[kind] = current;
  }
  for (const key of [
    "registered",
    "started",
    "settled",
    "failed",
    "cancelRequested",
    "settledAfterCancel",
  ] as const) {
    const value = source.bridgeLifecycle[key];
    if (value !== undefined) {
      target.bridgeLifecycle[key] = (target.bridgeLifecycle[key] ?? 0) + value;
    }
  }
  if (source.bridgeLifecycle.unresolvedAtExtraction !== undefined) {
    target.bridgeLifecycle.unresolvedAtExtraction = source.bridgeLifecycle.unresolvedAtExtraction;
  } else {
    delete target.bridgeLifecycle.unresolvedAtExtraction;
  }
  if (source.snapshots) {
    const current: CodeModeSnapshotStats = target.snapshots ?? {
      attempted: 0,
      produced: 0,
      accepted: 0,
      rejected: 0,
      incomplete: 0,
      totalBytes: 0,
      maxBytes: 0,
      serializationMs: 0,
      coverage: "exact" as const,
    };
    current.attempted += source.snapshots.attempted;
    current.produced += source.snapshots.produced;
    current.accepted += source.snapshots.accepted;
    current.rejected += source.snapshots.rejected;
    current.incomplete += source.snapshots.incomplete;
    current.totalBytes += source.snapshots.totalBytes;
    current.maxBytes = Math.max(current.maxBytes, source.snapshots.maxBytes);
    current.serializationMs += source.snapshots.serializationMs;
    for (const reason of ["size", "schema"] as const) {
      const value = source.snapshots.rejectedByReason?.[reason];
      if (value !== undefined) {
        current.rejectedByReason ??= {};
        current.rejectedByReason[reason] = (current.rejectedByReason[reason] ?? 0) + value;
      }
    }
    current.coverage = current.produced === current.attempted ? "exact" : "lower_bound";
    target.snapshots = current;
  }
  for (const outcome of CODE_MODE_OUTCOMES) {
    const value = source.outcomes[outcome];
    if (value !== undefined) {
      target.outcomes[outcome] = (target.outcomes[outcome] ?? 0) + value;
    }
  }
}

export function recordCodeModeControlCall(
  stats: CodeModeStats | undefined,
  control: keyof CodeModeStats["controlCalls"],
): void {
  if (stats) {
    incrementCounter(stats.controlCalls, control);
  }
}

export function recordCodeModeBridgeRegistered(
  stats: CodeModeStats | undefined,
  method: CodeModeBridgeMethod,
): void {
  if (!stats) {
    return;
  }
  incrementCounter(stats.bridgeCalls, method);
  incrementLifecycle(stats, "registered");
  runtimeFor(stats).unresolved += 1;
}

export function recordCodeModeBridgeStarted(stats: CodeModeStats | undefined): void {
  incrementLifecycle(stats, "started");
}

export function recordCodeModeBridgeCancelRequested(stats: CodeModeStats | undefined): void {
  incrementLifecycle(stats, "cancelRequested");
}

export function recordCodeModeBridgeSettled(
  stats: CodeModeStats | undefined,
  options: { failed: boolean; settledAfterCancel: boolean },
): void {
  if (!stats) {
    return;
  }
  incrementLifecycle(stats, "settled");
  if (options.failed) {
    incrementLifecycle(stats, "failed");
  }
  if (options.settledAfterCancel) {
    incrementLifecycle(stats, "settledAfterCancel");
  }
  const runtime = runtimeFor(stats);
  runtime.unresolved = Math.max(0, runtime.unresolved - 1);
}

export function recordCodeModeWorkerRun(
  stats: CodeModeStats | undefined,
  kind: CodeModeWorkerKind,
  elapsedMs: number,
): void {
  if (!stats) {
    return;
  }
  const current = stats.workerRuns[kind] ?? { count: 0, elapsedMs: 0 };
  current.count += 1;
  current.elapsedMs += Math.max(0, elapsedMs);
  stats.workerRuns[kind] = current;
}

export function recordCodeModeSnapshot(
  stats: CodeModeStats | undefined,
  attempt: CodeModeSnapshotAttempt,
): void {
  if (!stats) {
    return;
  }
  const current: CodeModeSnapshotStats = stats.snapshots ?? {
    attempted: 0,
    produced: 0,
    accepted: 0,
    rejected: 0,
    incomplete: 0,
    totalBytes: 0,
    maxBytes: 0,
    serializationMs: 0,
    coverage: "exact" as const,
  };
  current.attempted += 1;
  current[attempt.disposition] += 1;
  if (attempt.rejectionReason) {
    current.rejectedByReason ??= {};
    current.rejectedByReason[attempt.rejectionReason] =
      (current.rejectedByReason[attempt.rejectionReason] ?? 0) + 1;
  }
  if (attempt.measurement) {
    const bytes = Math.max(0, attempt.measurement.bytes);
    current.produced += 1;
    current.totalBytes += bytes;
    current.maxBytes = Math.max(current.maxBytes, bytes);
    current.serializationMs += Math.max(0, attempt.measurement.serializationMs);
    const runtime = runtimeFor(stats);
    runtime.snapshotMaxBytesSinceDrain = Math.max(runtime.snapshotMaxBytesSinceDrain, bytes);
  }
  current.coverage = current.produced === current.attempted ? "exact" : "lower_bound";
  stats.snapshots = current;
}

export function recordCodeModeOutcome(
  stats: CodeModeStats | undefined,
  outcome: keyof CodeModeStats["outcomes"],
): void {
  if (stats) {
    incrementCounter(stats.outcomes, outcome);
  }
}
