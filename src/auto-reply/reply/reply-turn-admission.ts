import { scheduleMainSessionRecoveryPendingTarget } from "../../agents/main-session-recovery-owner-release.js";
import { isMainRestartRecoveryCandidate } from "../../agents/main-session-recovery-state.js";
import {
  claimMainSessionRecoveryOwner,
  releaseMainSessionRecoveryOwner,
  type MainSessionRecoveryPendingTarget,
  type MainSessionRecoveryOwnerLease,
} from "../../agents/main-session-recovery-store.js";
// Decides whether an inbound turn may start, queue, or abort a reply run.
import { resolveSessionWorkStartError } from "../../config/sessions/lifecycle.js";
import { loadSessionEntry } from "../../config/sessions/session-accessor.js";
import type { InternalSessionEntry, SessionEntry } from "../../config/sessions/types.js";
import { getAgentEventLifecycleGeneration } from "../../infra/agent-events.js";
import { formatErrorMessage } from "../../infra/errors.js";
import {
  getDiagnosticSessionActivitySnapshot,
  resolveRunStaleThresholdMs,
} from "../../logging/diagnostic-run-activity.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import {
  beginSessionWorkAdmission,
  type SessionWorkAdmissionLease,
} from "../../sessions/session-lifecycle-admission.js";
import {
  createReplyOperation,
  expireStaleReplyOperation,
  isReplyRunEvidenceStale,
  REPLY_RUN_IDLE_SETTLE_TIMEOUT_MS,
  REPLY_RUN_TERMINAL_SETTLE_TIMEOUT_MS,
  replyRunRegistry,
  ReplyRunAlreadyActiveError,
  ReplyRunFollowupAdmissionBlockedError,
  retainReplyOperationUntilComplete,
  runAfterReplyOperationClear,
  type ReplyOperation,
  waitForReplyRunFollowupAdmission,
} from "./reply-run-registry.js";

/** Kinds of turns that compete for one reply run slot per session. */
type ReplyTurnKind = "visible" | "heartbeat" | "queued_followup";

/** Admission result for a reply turn attempting to own the session run slot. */
type ReplyTurnAdmission =
  | { status: "owned"; operation: ReplyOperation; sessionEntry?: SessionEntry }
  | {
      status: "skipped";
      reason: "active-run" | "aborted" | "lifecycle-invalidated";
      activeOperation?: ReplyOperation;
      lifecycleAdmission?: SessionWorkAdmissionLease;
    };

class QueuedFollowupLifecycleInvalidatedError extends Error {}

const log = createSubsystemLogger("auto-reply/reply-turn-admission");
const lifecycleAdmissionByOperation = new WeakMap<ReplyOperation, SessionWorkAdmissionLease>();

async function releaseReplyRecoveryOwner(
  lease: MainSessionRecoveryOwnerLease | undefined,
): Promise<MainSessionRecoveryPendingTarget | undefined> {
  try {
    return await releaseMainSessionRecoveryOwner(lease);
  } catch (error) {
    log.warn(`failed to release main-session recovery reply owner: ${formatErrorMessage(error)}`);
    return undefined;
  }
}

/** Runs owner work with its admission marked as the initiating lifecycle context. */
export async function runWithReplyOperationLifecycleAdmission<T>(
  operation: ReplyOperation,
  run: () => Promise<T>,
): Promise<T> {
  const admission = lifecycleAdmissionByOperation.get(operation);
  return admission ? await admission.run(run) : await run();
}

function rejectLifecycleInvalidatedWork(params: { kind: ReplyTurnKind; message: string }): never {
  if (params.kind === "queued_followup") {
    throw new QueuedFollowupLifecycleInvalidatedError(params.message);
  }
  throw new Error(params.message);
}

function isAbortSignalAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

function expireVisibleStaleOperation(operation: ReplyOperation | undefined): boolean {
  if (!operation) {
    return false;
  }
  const idleMs = Date.now() - operation.lastActivityAtMs;
  if (operation.result) {
    return (
      idleMs >= REPLY_RUN_TERMINAL_SETTLE_TIMEOUT_MS &&
      expireStaleReplyOperation(operation, "terminal_unreleased")
    );
  }
  return isReplyRunEvidenceStale(operation) && expireStaleReplyOperation(operation, "no_activity");
}

function resolveVisibleActiveWaitMs(operation: ReplyOperation | undefined): number {
  if (!operation) {
    return REPLY_RUN_IDLE_SETTLE_TIMEOUT_MS;
  }
  const ageMs = Date.now() - operation.lastActivityAtMs;
  const activity = getDiagnosticSessionActivitySnapshot({
    sessionId: operation.sessionId,
    sessionKey: operation.key,
  });
  const remainingMs = operation.result
    ? REPLY_RUN_TERMINAL_SETTLE_TIMEOUT_MS - ageMs
    : resolveRunStaleThresholdMs(activity) - ageMs;
  return Math.min(REPLY_RUN_IDLE_SETTLE_TIMEOUT_MS, Math.max(1, remainingMs));
}

type ReplyTurnAdmissionParams = {
  sessionKey: string;
  sessionId: string;
  agentId?: string;
  expectedSessionId?: string;
  expectedActiveOperation?: ReplyOperation;
  storePath?: string;
  kind: ReplyTurnKind;
  resetTriggered: boolean;
  routeThreadId?: string | number;
  /**
   * Move this already-held operation into sessionKey's run slot instead of
   * creating a new one. Used when a native command turn (admitted under its
   * slash source key) continues into a full agent turn on the target session.
   */
  adoptOperation?: ReplyOperation;
  upstreamAbortSignal?: AbortSignal;
  waitTimeoutMs?: number;
  waitForActive?: boolean;
  retainLifecycleAdmissionOnActive?: boolean;
  onLifecycleInterrupt?: () => void;
  /** Reports one interval while blocked behind an older lane owner or its delivery barrier. */
  onReplyAdmissionWaitChange?: (waiting: boolean) => void;
};

type WaitForReplyAdmission = <T>(wait: () => Promise<T>) => Promise<T>;

/** Waits for or claims the per-session reply run slot. */
export async function admitReplyTurn(
  params: ReplyTurnAdmissionParams,
): Promise<ReplyTurnAdmission> {
  let admissionWaitReported = false;
  const waitForAdmission = async <T>(wait: () => Promise<T>): Promise<T> => {
    if (!admissionWaitReported) {
      admissionWaitReported = true;
      params.onReplyAdmissionWaitChange?.(true);
    }
    return await wait();
  };
  try {
    return await admitReplyTurnWithWaitSignal(params, waitForAdmission);
  } finally {
    if (admissionWaitReported) {
      params.onReplyAdmissionWaitChange?.(false);
    }
  }
}

async function admitReplyTurnWithWaitSignal(
  params: ReplyTurnAdmissionParams,
  waitForAdmission: WaitForReplyAdmission,
): Promise<ReplyTurnAdmission> {
  let sessionId = params.sessionId;
  let expectedSessionId = params.expectedSessionId;
  const waitTimeoutMs =
    params.waitTimeoutMs ??
    (params.kind === "queued_followup" ? REPLY_RUN_IDLE_SETTLE_TIMEOUT_MS : undefined);
  while (true) {
    if (isAbortSignalAborted(params.upstreamAbortSignal)) {
      return { status: "skipped", reason: "aborted" };
    }
    try {
      const storePath = params.storePath;
      let operation: ReplyOperation | undefined;
      let admittedSessionEntry: InternalSessionEntry | undefined;
      let recoveryOwnerLease: MainSessionRecoveryOwnerLease | undefined;
      let interruptedBeforeOperation = false;
      const admission = storePath
        ? await beginSessionWorkAdmission({
            scope: storePath,
            identities: [params.sessionKey],
            signal: params.upstreamAbortSignal,
            onInterrupt: () => {
              interruptedBeforeOperation = true;
              operation?.abortForRestart();
              params.onLifecycleInterrupt?.();
            },
            assertAllowed: () => {
              const currentEntry = loadSessionEntry({
                storePath,
                sessionKey: params.sessionKey,
                readConsistency: "latest",
              });
              admittedSessionEntry = currentEntry as InternalSessionEntry | undefined;
              if (expectedSessionId && !currentEntry) {
                rejectLifecycleInvalidatedWork({
                  kind: params.kind,
                  message: `Session "${params.sessionKey}" was deleted while starting work. Retry.`,
                });
              }
              const registeredOperation = replyRunRegistry.get(params.sessionKey);
              const rotationOperation = [registeredOperation, params.expectedActiveOperation].find(
                (candidate) => {
                  if (
                    !candidate ||
                    !expectedSessionId ||
                    currentEntry?.sessionId !== candidate.sessionId ||
                    !candidate.hasOwnedSessionId(expectedSessionId)
                  ) {
                    return false;
                  }
                  if (
                    candidate.result?.kind === "aborted" &&
                    candidate.result.code === "aborted_for_restart"
                  ) {
                    return false;
                  }
                  return candidate === registeredOperation || candidate.result !== null;
                },
              );
              const activeOperationRotatedExpectedSession = Boolean(
                rotationOperation && currentEntry?.sessionId === rotationOperation.sessionId,
              );
              if (
                expectedSessionId &&
                currentEntry?.sessionId !== expectedSessionId &&
                !activeOperationRotatedExpectedSession
              ) {
                rejectLifecycleInvalidatedWork({
                  kind: params.kind,
                  message: `Session "${params.sessionKey}" changed while starting work. Retry.`,
                });
              }
              if (activeOperationRotatedExpectedSession) {
                expectedSessionId = currentEntry?.sessionId;
              }
              const archivedSessionError = resolveSessionWorkStartError(
                params.sessionKey || sessionId,
                currentEntry,
              );
              if (archivedSessionError) {
                rejectLifecycleInvalidatedWork({
                  kind: params.kind,
                  message: archivedSessionError,
                });
              }
              sessionId = currentEntry?.sessionId ?? sessionId;
            },
          })
        : undefined;
      try {
        if (
          storePath &&
          !params.resetTriggered &&
          admittedSessionEntry &&
          ((admittedSessionEntry.status === "running" &&
            (admittedSessionEntry.abortedLastRun === true ||
              admittedSessionEntry.restartRecoveryRuns !== undefined ||
              admittedSessionEntry.mainRestartRecovery !== undefined)) ||
            admittedSessionEntry.mainRestartRecovery?.tombstone !== undefined) &&
          isMainRestartRecoveryCandidate(admittedSessionEntry, params.sessionKey)
        ) {
          const ownerClaim = await claimMainSessionRecoveryOwner({
            lifecycleGeneration: getAgentEventLifecycleGeneration(),
            sessionId,
            target: { sessionKey: params.sessionKey, storePath },
          });
          if (ownerClaim.kind === "invalidated") {
            rejectLifecycleInvalidatedWork({
              kind: params.kind,
              message: `Session "${params.sessionKey}" changed while starting work. Retry.`,
            });
          }
          recoveryOwnerLease = ownerClaim.kind === "claimed" ? ownerClaim.lease : undefined;
        }
        if (interruptedBeforeOperation || isAbortSignalAborted(params.upstreamAbortSignal)) {
          rejectLifecycleInvalidatedWork({
            kind: params.kind,
            message: `Session "${params.sessionKey}" changed while starting work. Retry.`,
          });
        }
        if (params.adoptOperation) {
          // The dispatch closures own this object's abort/delivery lifecycle,
          // so the reservation must move rather than be recreated. Throws
          // ReplyRunAlreadyActiveError into the shared busy handling below.
          params.adoptOperation.updateSessionKey(params.sessionKey);
          operation = params.adoptOperation;
        } else {
          operation = createReplyOperation({
            sessionKey: params.sessionKey,
            sessionId,
            agentId: params.agentId,
            resetTriggered: params.resetTriggered,
            routeThreadId: params.routeThreadId,
            upstreamAbortSignal: params.upstreamAbortSignal,
            respectFollowupAdmissionBarrier:
              params.kind === "queued_followup" || params.kind === "heartbeat",
          });
        }
      } catch (error) {
        const pendingRecovery = recoveryOwnerLease
          ? await releaseReplyRecoveryOwner(recoveryOwnerLease)
          : undefined;
        if (
          error instanceof ReplyRunAlreadyActiveError &&
          admission &&
          params.retainLifecycleAdmissionOnActive
        ) {
          void admission.released.then(() => {
            scheduleMainSessionRecoveryPendingTarget(pendingRecovery);
          });
          return {
            status: "skipped",
            reason: "active-run",
            activeOperation: replyRunRegistry.get(params.sessionKey),
            lifecycleAdmission: admission,
          };
        }
        admission?.release();
        scheduleMainSessionRecoveryPendingTarget(pendingRecovery);
        throw error;
      }
      if (admission) {
        // The lifecycle fence follows hooks, media work, agent execution, and
        // final delivery. Reset/delete interrupts the operation and waits until
        // its actual owner clears it before mutating the persisted session.
        // Adoption rebinds the map to this target lease; the source-key lease
        // stays registered via its own after-clear callback (release is
        // idempotent), so both identities free on operation clear.
        retainReplyOperationUntilComplete(operation);
        lifecycleAdmissionByOperation.set(operation, admission);
        runAfterReplyOperationClear(operation, () => {
          lifecycleAdmissionByOperation.delete(operation);
          // Keep reset/delete behind durable owner release and its writer lock.
          void releaseReplyRecoveryOwner(recoveryOwnerLease).then((pendingTarget) => {
            admission.release();
            scheduleMainSessionRecoveryPendingTarget(pendingTarget);
          });
        });
      }
      return {
        status: "owned",
        operation,
        ...(admittedSessionEntry ? { sessionEntry: admittedSessionEntry } : {}),
      };
    } catch (error) {
      if (isAbortSignalAborted(params.upstreamAbortSignal)) {
        return { status: "skipped", reason: "aborted" };
      }
      if (error instanceof QueuedFollowupLifecycleInvalidatedError) {
        return { status: "skipped", reason: "lifecycle-invalidated" };
      }
      if (error instanceof ReplyRunFollowupAdmissionBlockedError) {
        if (params.kind === "heartbeat") {
          return { status: "skipped", reason: "active-run" };
        }
        const followupAdmission = await waitForAdmission(() =>
          waitForReplyRunFollowupAdmission(
            params.sessionKey,
            waitTimeoutMs ?? REPLY_RUN_IDLE_SETTLE_TIMEOUT_MS,
            { signal: params.upstreamAbortSignal },
          ),
        );
        if (!followupAdmission.settled) {
          return {
            status: "skipped",
            reason: isAbortSignalAborted(params.upstreamAbortSignal) ? "aborted" : "active-run",
          };
        }
        sessionId = followupAdmission.sessionId ?? sessionId;
        if (expectedSessionId && followupAdmission.sessionId) {
          expectedSessionId = followupAdmission.sessionId;
        }
        continue;
      }
      if (!(error instanceof ReplyRunAlreadyActiveError)) {
        throw error;
      }
      const activeOperation = replyRunRegistry.get(params.sessionKey);
      if (params.kind === "visible" && expireVisibleStaleOperation(activeOperation)) {
        continue;
      }
      if (params.kind === "heartbeat") {
        return { status: "skipped", reason: "active-run", activeOperation };
      }
      // Visible and queued turns may wait for active runs when waitForActive is set.
      if (params.waitForActive === false) {
        return { status: "skipped", reason: "active-run", activeOperation };
      }
      const activeWaitTimeoutMs =
        params.kind === "visible" ? resolveVisibleActiveWaitMs(activeOperation) : waitTimeoutMs;
      const ended = await waitForAdmission(() =>
        replyRunRegistry.waitForIdle(params.sessionKey, activeWaitTimeoutMs, {
          signal: params.upstreamAbortSignal,
        }),
      );
      if (!ended) {
        if (params.kind === "visible" && !isAbortSignalAborted(params.upstreamAbortSignal)) {
          // Visible turns block on active work like before, but in bounded wait
          // slices: each wake reclaims the owner once it is provably stale,
          // otherwise loops back to keep waiting.
          const latestActiveOperation = replyRunRegistry.get(params.sessionKey);
          expireVisibleStaleOperation(latestActiveOperation ?? activeOperation);
          continue;
        }
        return {
          status: "skipped",
          reason: isAbortSignalAborted(params.upstreamAbortSignal) ? "aborted" : "active-run",
          activeOperation,
        };
      }
      if (activeOperation) {
        sessionId = activeOperation.sessionId;
        // In-lane compaction may rotate the active operation's persisted ID.
        // Lifecycle reset aborts use a distinct result and must stay invalidated.
        if (
          expectedSessionId &&
          !(
            activeOperation.result?.kind === "aborted" &&
            activeOperation.result.code === "aborted_for_restart"
          )
        ) {
          expectedSessionId = activeOperation.sessionId;
        }
      }
    }
  }
}

/** Resolves the default turn kind from reply options. */
export function resolveReplyTurnKind(opts?: { isHeartbeat?: boolean }): ReplyTurnKind {
  return opts?.isHeartbeat === true ? "heartbeat" : "visible";
}
