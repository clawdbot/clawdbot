/**
 * Session suspension persistence and lifecycle helpers.
 *
 * Records quota/manual/circuit suspensions for diagnostics and recovery flows.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import {
  resolveExpiresAtMsFromDurationMs,
  resolveTimerTimeoutMs,
} from "@openclaw/normalization-core/number-coercion";
import { patchSessionEntryCore } from "../config/sessions/session-accessor.js";
import type { QuotaSuspension } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import { resolveRegisteredAgentIdForDir } from "./agent-dir-registry.js";
import { resolveStoredSessionKeyForSessionId } from "./command/session.js";
import type { FailoverReason } from "./failover/signal.js";

const log = createSubsystemLogger("session-suspension");

const DEFAULT_QUOTA_SUSPENSION_RESUME_MS = 30 * 60 * 1000; // 30 min

type SessionSuspensionRuntimeState = {
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
  reason: SessionSuspensionReason;
  failedProvider: string;
  failedModel: string;
  summary?: string;
  ttlMs?: number;
};

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

export function fenceSessionSuspensionWritesForGatewayShutdown(): void {
  const state = getSessionSuspensionState();
  state.cleanupGeneration += 1;
  state.cleanupActive = true;
}

export function enableSessionSuspensionWritesForGatewayStart(): void {
  const state = getSessionSuspensionState();
  state.cleanupGeneration += 1;
  state.cleanupActive = false;
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
  // Assigned at the end of the try; the catch path returns, so every read
  // below sees the real patch outcome.
  let persistedSuspension: boolean;

  try {
    const patchedEntry = await patchSessionEntryCore(
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
            expectedResumeBy,
            state: "suspended",
          },
        };
      },
      { skipMaintenance: true, takeCacheOwnership: true },
    );
    persistedSuspension = patchedEntry !== null;
  } catch (err) {
    log.warn("failed to persist quota suspension", {
      sessionId: params.sessionId,
      error: err instanceof Error ? err.message : String(err),
    });
    releasePendingWrite();
    return;
  }

  const postPatchState = getSessionSuspensionState();
  if (
    persistedSuspension &&
    (postPatchState.cleanupActive || suspensionGeneration !== postPatchState.cleanupGeneration)
  ) {
    try {
      await patchSessionEntryCore(
        { storePath, sessionKey },
        (entry) =>
          entry.quotaSuspension?.suspendedAt === now &&
          entry.quotaSuspension.reason === params.reason &&
          entry.quotaSuspension.failedProvider === params.failedProvider &&
          entry.quotaSuspension.failedModel === params.failedModel
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
        error: err instanceof Error ? err.message : String(err),
      });
    }
    releasePendingWrite();
    return;
  }

  releasePendingWrite();
}

function resetSessionSuspensionStateForTest(): void {
  const state = getSessionSuspensionState();
  // Invalidate in-flight writes before clearing test state. Rewinding to a
  // reused generation lets a fire-and-forget suspension regain ownership.
  state.cleanupGeneration += 1;
  state.pendingSuspensionWrites.clear();
  state.suspensionWriteChain = Promise.resolve();
  state.cleanupActive = false;
}

function isSessionSuspensionWriteCleanupActiveForTest(): boolean {
  return getSessionSuspensionState().cleanupActive;
}

if (process.env.VITEST || process.env.NODE_ENV === "test") {
  (globalThis as Record<PropertyKey, unknown>)[Symbol.for("openclaw.sessionSuspensionTestApi")] = {
    isSessionSuspensionWriteCleanupActiveForTest,
    resetSessionSuspensionStateForTest,
  };
}
