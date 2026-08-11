/**
 * Session suspension and lane auto-resume helpers.
 *
 * Records quota/manual/circuit suspensions and temporarily lowers command-lane concurrency.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { resolveAgentMaxConcurrent, resolveSubagentMaxConcurrent } from "../config/agent-limits.js";
import { resolveCronMaxConcurrentRuns } from "../config/cron-limits.js";
import { patchSessionEntry } from "../config/sessions/session-accessor.js";
import type { QuotaSuspension } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { setCommandLaneConcurrency } from "../process/command-queue.js";
import { CommandLane } from "../process/lanes.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import {
  resolveExpiresAtMsFromDurationMs,
  resolveTimerTimeoutMs,
} from "../shared/number-coercion.js";
import { resolveRegisteredAgentIdForDir } from "./agent-dir-registry.js";
import { resolveStoredSessionKeyForSessionId } from "./command/session.js";
import type { FailoverReason } from "./failover/signal.js";

const log = createSubsystemLogger("session-suspension");

const DEFAULT_CUSTOM_LANE_RESUME_CONCURRENCY = 1;
const DEFAULT_QUOTA_SUSPENSION_RESUME_MS = 30 * 60 * 1000; // 30 min

type LaneResumeTimer = {
  timer: ReturnType<typeof setTimeout>;
  resumeConcurrency: number;
  resumeAtMs: number;
};

type ClearedLaneResume = {
  resumeConcurrency: number;
  resumeAtMs: number;
};

type SessionSuspensionRuntimeState = {
  laneResumeTimers: Map<string, LaneResumeTimer>;
  clearedLaneResumes: Map<string, ClearedLaneResume>;
  gatewayLaneResumeConcurrencies: Map<string, number>;
  pendingSuspensionWrites: Map<
    string,
    {
      generation: number;
      previousQuotaSuspension: QuotaSuspension | undefined;
      previousSnapshotCaptured: boolean;
      activeCount: number;
    }
  >;
  suspensionWriteChain: Promise<void>;
  cleanupGeneration: number;
  cleanupActive: boolean;
};

/**
 * Keep timer shutdown state process-global so bundled gateway chunks cannot
 * leave one module copy scheduling lane resumes after another copy cleaned up.
 */
const SESSION_SUSPENSION_STATE_KEY = Symbol.for("openclaw.sessionSuspensionRuntimeState");

function getSessionSuspensionState(): SessionSuspensionRuntimeState {
  const state = resolveGlobalSingleton<SessionSuspensionRuntimeState>(
    SESSION_SUSPENSION_STATE_KEY,
    () => ({
      laneResumeTimers: new Map<string, LaneResumeTimer>(),
      clearedLaneResumes: new Map<string, ClearedLaneResume>(),
      gatewayLaneResumeConcurrencies: new Map<string, number>(),
      pendingSuspensionWrites: new Map<
        string,
        {
          generation: number;
          previousQuotaSuspension: QuotaSuspension | undefined;
          previousSnapshotCaptured: boolean;
          activeCount: number;
        }
      >(),
      suspensionWriteChain: Promise.resolve(),
      cleanupGeneration: 0,
      cleanupActive: false,
    }),
  );
  if (!state.clearedLaneResumes) {
    state.clearedLaneResumes = new Map<string, ClearedLaneResume>();
  }
  if (!state.gatewayLaneResumeConcurrencies) {
    state.gatewayLaneResumeConcurrencies = new Map<string, number>();
  }
  if (!state.pendingSuspensionWrites) {
    state.pendingSuspensionWrites = new Map<
      string,
      {
        generation: number;
        previousQuotaSuspension: QuotaSuspension | undefined;
        previousSnapshotCaptured: boolean;
        activeCount: number;
      }
    >();
  }
  if (state.suspensionWriteChain === undefined) {
    state.suspensionWriteChain = Promise.resolve();
  }
  return state;
}

const deferredSessionSuspension = new AsyncLocalStorage<{
  claimed: boolean;
  onDeferred?: (params: SessionSuspensionParams) => void;
}>();

type SessionSuspensionReason = "quota_exhausted" | "manual" | "circuit_open";
type SessionSuspensionTarget =
  | { mode: "defer"; defer: (params: SessionSuspensionParams) => void }
  | { mode: "suspend" };
export type SessionSuspensionParams = {
  cfg: OpenClawConfig | undefined;
  agentId?: string;
  agentDir?: string;
  sessionId: string;
  laneId?: string;
  reason: SessionSuspensionReason;
  failedProvider: string;
  failedModel: string;
  summary?: string;
  ttlMs?: number;
};

function resolveLaneResumeConcurrency(cfg: OpenClawConfig | undefined, laneId: string): number {
  switch (laneId) {
    case "main":
      return resolveAgentMaxConcurrent(cfg);
    case "subagent":
      return resolveSubagentMaxConcurrent(cfg);
    case "cron":
    case "cron-nested":
    case "hook-dispatch":
      return resolveCronMaxConcurrentRuns();
    default:
      return DEFAULT_CUSTOM_LANE_RESUME_CONCURRENCY;
  }
}

function isGatewayManagedLane(laneId: string): boolean {
  // Lane ids are open strings (plugins mint their own); narrow once so the
  // membership check compares within the enum.
  const lane = laneId as CommandLane;
  return (
    lane === CommandLane.Main ||
    lane === CommandLane.Subagent ||
    lane === CommandLane.Cron ||
    lane === CommandLane.CronNested ||
    lane === CommandLane.HookDispatch ||
    lane === CommandLane.Nested
  );
}

export function resolveSessionSuspensionReason(reason: FailoverReason): SessionSuspensionReason {
  if (reason === "billing") {
    return "manual";
  }
  if (reason === "rate_limit") {
    return "quota_exhausted";
  }
  return "circuit_open";
}

export function runWithDeferredSessionSuspension<T>(
  run: () => Promise<T>,
  onDeferred?: (params: SessionSuspensionParams) => void,
): Promise<T> {
  return deferredSessionSuspension.run({ claimed: false, onDeferred }, run);
}

export function resolveSessionSuspensionTarget(): SessionSuspensionTarget {
  const scope = deferredSessionSuspension.getStore();
  if (!scope || scope.claimed) {
    return { mode: "suspend" };
  }
  // One candidate callback may launch nested direct embedded runs. Only its
  // first embedded run inherits the outer fallback's remaining-candidate fact.
  scope.claimed = true;
  return { mode: "defer", defer: (params) => scope.onDeferred?.(params) };
}

function scheduleLaneAutoResume(
  laneId: string,
  delayMs: number,
  resumeConcurrency: number,
  opts: { nowMs?: number } = {},
) {
  const nowMs = opts.nowMs ?? Date.now();
  const state = getSessionSuspensionState();
  const existing = state.laneResumeTimers.get(laneId);
  if (existing) {
    clearTimeout(existing.timer);
  }
  const canonicalResumeConcurrency = isGatewayManagedLane(laneId)
    ? (state.gatewayLaneResumeConcurrencies.get(laneId) ?? resumeConcurrency)
    : resumeConcurrency;
  const entry = {
    timer: undefined as unknown as ReturnType<typeof setTimeout>,
    resumeConcurrency: canonicalResumeConcurrency,
    resumeAtMs: nowMs + delayMs,
  };
  const timer = setTimeout(() => {
    if (state.laneResumeTimers.get(laneId) !== entry) {
      return;
    }
    state.laneResumeTimers.delete(laneId);
    setCommandLaneConcurrency(laneId, entry.resumeConcurrency);
    log.info("auto-resumed lane after suspension TTL", {
      laneId,
      delayMs,
      resumeConcurrency: entry.resumeConcurrency,
    });
  }, delayMs);
  entry.timer = timer;
  if (typeof timer.unref === "function") {
    timer.unref();
  }
  state.laneResumeTimers.set(laneId, entry);
}

export function clearSessionSuspensionTimers(): number {
  const state = getSessionSuspensionState();
  state.cleanupGeneration += 1;
  state.cleanupActive = true;
  let cleared = 0;
  for (const [laneId, entry] of state.laneResumeTimers) {
    clearTimeout(entry.timer);
    state.clearedLaneResumes.set(laneId, {
      resumeConcurrency: entry.resumeConcurrency,
      resumeAtMs: entry.resumeAtMs,
    });
    cleared += 1;
  }
  state.laneResumeTimers.clear();
  return cleared;
}

export function enableSessionSuspensionTimersForGatewayStart(): Set<string> {
  const state = getSessionSuspensionState();
  state.cleanupGeneration += 1;
  state.cleanupActive = false;
  const suspendedLaneIds = new Set<string>();
  const nowMs = Date.now();
  for (const [laneId, cleared] of state.clearedLaneResumes) {
    const remainingMs = resolveTimerTimeoutMs(cleared.resumeAtMs - nowMs, 0, 0);
    if (remainingMs > 0) {
      setCommandLaneConcurrency(laneId, 0);
      scheduleLaneAutoResume(laneId, remainingMs, cleared.resumeConcurrency, { nowMs });
      suspendedLaneIds.add(laneId);
      continue;
    }
    if (isGatewayManagedLane(laneId)) {
      continue;
    }
    setCommandLaneConcurrency(laneId, cleared.resumeConcurrency);
  }
  state.clearedLaneResumes.clear();
  return suspendedLaneIds;
}

export function setGatewayLaneResumeConcurrencies(
  concurrencies: Readonly<Record<string, number>>,
): void {
  // Gateway publication owns the desired post-suspension widths. Record them
  // even when no timer exists yet so an asynchronous suspension write that
  // finishes after a config reload cannot schedule a stale resume target.
  const state = getSessionSuspensionState();
  for (const [laneId, rawConcurrency] of Object.entries(concurrencies)) {
    if (!isGatewayManagedLane(laneId)) {
      continue;
    }
    const resumeConcurrency = Math.max(0, Math.floor(rawConcurrency));
    state.gatewayLaneResumeConcurrencies.set(laneId, resumeConcurrency);
    const activeTimer = state.laneResumeTimers.get(laneId);
    if (activeTimer) {
      activeTimer.resumeConcurrency = resumeConcurrency;
    }
    const clearedResume = state.clearedLaneResumes.get(laneId);
    if (clearedResume) {
      clearedResume.resumeConcurrency = resumeConcurrency;
    }
  }
}

export function getSuspendedLaneIdsForGatewayPublication(): Set<string> {
  const state = getSessionSuspensionState();
  const suspended = state.cleanupActive ? state.clearedLaneResumes : state.laneResumeTimers;
  return new Set(suspended.keys());
}

export async function suspendSession(params: SessionSuspensionParams) {
  const state = getSessionSuspensionState();
  const queuedGeneration = state.cleanupGeneration;
  const run = state.suspensionWriteChain
    .catch(() => undefined)
    .then(() => suspendSessionQueued(params, queuedGeneration));
  // Suspension persistence is per-process and rare; serialize it so cleanup
  // rollback has one winner and cannot erase another in-flight suspension.
  state.suspensionWriteChain = run.then(
    () => undefined,
    () => undefined,
  );
  await run;
}

async function suspendSessionQueued(params: SessionSuspensionParams, queuedGeneration: number) {
  if (!params.cfg) {
    return;
  }

  // agentDir is <state>/agents/<id>/agent, so basename(agentDir) is always the
  // literal "agent" — only the registry lookup recovers the real owner id.
  const agentIdFromDir = params.agentDir
    ? resolveRegisteredAgentIdForDir(params.agentDir)
    : undefined;
  const { sessionKey, storePath } = resolveStoredSessionKeyForSessionId({
    cfg: params.cfg,
    sessionId: params.sessionId,
    agentId: params.agentId ?? agentIdFromDir,
  });

  if (!sessionKey) {
    return;
  }

  const ttlMs = resolveTimerTimeoutMs(params.ttlMs, DEFAULT_QUOTA_SUSPENSION_RESUME_MS, 0);
  const now = Date.now();
  const expectedResumeBy = resolveExpiresAtMsFromDurationMs(ttlMs, { nowMs: now }) ?? now;
  const state = getSessionSuspensionState();
  if (state.cleanupActive || state.cleanupGeneration !== queuedGeneration) {
    return;
  }
  const suspensionGeneration = state.cleanupGeneration;
  const pendingWriteKey = `${storePath}\0${sessionKey}`;
  const existingPendingWrite = state.pendingSuspensionWrites.get(pendingWriteKey);
  const pendingWrite =
    existingPendingWrite?.generation === suspensionGeneration
      ? existingPendingWrite
      : {
          generation: suspensionGeneration,
          previousQuotaSuspension: undefined as QuotaSuspension | undefined,
          previousSnapshotCaptured: false,
          activeCount: 0,
        };
  pendingWrite.activeCount += 1;
  state.pendingSuspensionWrites.set(pendingWriteKey, pendingWrite);
  const releasePendingWrite = () => {
    pendingWrite.activeCount -= 1;
    if (
      pendingWrite.activeCount <= 0 &&
      getSessionSuspensionState().pendingSuspensionWrites.get(pendingWriteKey) === pendingWrite
    ) {
      getSessionSuspensionState().pendingSuspensionWrites.delete(pendingWriteKey);
    }
  };
  const throttleLane = () => {
    if (!params.laneId) {
      return;
    }
    setCommandLaneConcurrency(params.laneId, 0);
    scheduleLaneAutoResume(
      params.laneId,
      ttlMs,
      resolveLaneResumeConcurrency(params.cfg, params.laneId),
    );
  };
  // Assigned at the end of the try; the catch path returns, so every read
  // below sees the real patch outcome.
  let persistedSuspension: boolean;

  try {
    const patchedEntry = await patchSessionEntry(
      { storePath, sessionKey },
      (entry) => {
        if (getSessionSuspensionState().cleanupGeneration !== suspensionGeneration) {
          return null;
        }
        if (!pendingWrite.previousSnapshotCaptured) {
          pendingWrite.previousQuotaSuspension = entry.quotaSuspension;
          pendingWrite.previousSnapshotCaptured = true;
        }
        return {
          quotaSuspension: {
            schemaVersion: 1,
            suspendedAt: now,
            reason: params.reason,
            failedProvider: params.failedProvider,
            failedModel: params.failedModel,
            summary: params.summary,
            laneId: params.laneId,
            expectedResumeBy,
            state: "suspended",
          },
        };
      },
      { skipMaintenance: true, takeCacheOwnership: true },
    );
    persistedSuspension = patchedEntry !== null;
  } catch (err) {
    log.warn("failed to persist quota suspension; applying transient lane throttle", {
      sessionId: params.sessionId,
      laneId: params.laneId,
      error: err instanceof Error ? err.message : String(err),
    });
    releasePendingWrite();
    if (
      !getSessionSuspensionState().cleanupActive &&
      suspensionGeneration === getSessionSuspensionState().cleanupGeneration
    ) {
      throttleLane();
    }
    return;
  }

  const postPatchState = getSessionSuspensionState();
  if (
    persistedSuspension &&
    (postPatchState.cleanupActive || suspensionGeneration !== postPatchState.cleanupGeneration)
  ) {
    try {
      await patchSessionEntry(
        { storePath, sessionKey },
        (entry) =>
          entry.quotaSuspension?.suspendedAt === now &&
          entry.quotaSuspension.reason === params.reason &&
          entry.quotaSuspension.failedProvider === params.failedProvider &&
          entry.quotaSuspension.failedModel === params.failedModel &&
          entry.quotaSuspension.laneId === params.laneId
            ? { quotaSuspension: pendingWrite.previousQuotaSuspension }
            : null,
        {
          skipMaintenance: true,
          takeCacheOwnership: true,
        },
      );
    } catch (err) {
      log.warn("failed to clear quota suspension after shutdown cleanup", {
        sessionId: params.sessionId,
        laneId: params.laneId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    releasePendingWrite();
    return;
  }

  if (persistedSuspension) {
    throttleLane();
  }
  releasePendingWrite();
}

function resetSessionSuspensionStateForTest(): void {
  const state = getSessionSuspensionState();
  // Invalidate in-flight writes before clearing test state. Rewinding to a
  // reused generation lets a fire-and-forget suspension regain ownership.
  state.cleanupGeneration += 1;
  for (const entry of state.laneResumeTimers.values()) {
    clearTimeout(entry.timer);
  }
  state.laneResumeTimers.clear();
  state.clearedLaneResumes.clear();
  state.gatewayLaneResumeConcurrencies.clear();
  state.pendingSuspensionWrites.clear();
  state.suspensionWriteChain = Promise.resolve();
  state.cleanupActive = false;
}

function seedClearedLaneResumeForTest(
  laneId: string,
  cleared: { resumeConcurrency: number; resumeAtMs: number },
): void {
  const state = getSessionSuspensionState();
  state.cleanupActive = true;
  state.clearedLaneResumes.set(laneId, cleared);
}

if (process.env.VITEST || process.env.NODE_ENV === "test") {
  (globalThis as Record<PropertyKey, unknown>)[Symbol.for("openclaw.sessionSuspensionTestApi")] = {
    resetSessionSuspensionStateForTest,
    seedClearedLaneResumeForTest,
  };
}
