import path from "node:path";
import type { InternalSessionEntry } from "../config/sessions.js";
import {
  createSessionWorkStartChangedError,
  SessionWorkStartChangedError,
} from "../config/sessions/lifecycle.js";
import { racePromiseWithAbortSignal } from "../infra/abort-signal.js";
import { assertAgentRunLifecycleGenerationCurrent } from "../infra/agent-events.js";
import { formatErrorMessage } from "../infra/errors.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { getSessionWorkAdmissionOwnerRelease } from "../sessions/session-lifecycle-admission.js";
import type { AgentCommandOpts } from "./command/types.js";
import { MAIN_SESSION_RECOVERY_WORK_ADMISSION_OWNER } from "./main-session-recovery/main-session-recovery-admission.js";
import { repairMainSessionRecoveryMutation } from "./main-session-recovery/main-session-recovery-lifecycle.js";
import { scheduleMainSessionRecoveryPendingTarget } from "./main-session-recovery/main-session-recovery-owner-release.js";
import {
  claimMainSessionRecoveryOwner,
  inspectMainSessionRecoveryRequired,
  refreshMainSessionRecoveryOwner,
  releaseMainSessionRecoveryOwner,
  type MainSessionRecoveryOwnerLease,
  type MainSessionRecoveryPendingTarget,
} from "./main-session-recovery/main-session-recovery-store.js";

const log = createSubsystemLogger("agents/agent-command");

type PreparedRecoveryOwnerTarget = object & {
  sessionAgentId: string;
  isNewSession: boolean;
  previousSessionId?: string;
  sessionId: string;
  sessionKey?: string;
  sessionEntry?: InternalSessionEntry;
  sessionStore?: Record<string, InternalSessionEntry>;
  storePath: string;
  runLease?: { release: () => Promise<void> };
};

type AcquiredRecoveryOwner = {
  lease: MainSessionRecoveryOwnerLease;
  entry: InternalSessionEntry;
  sessionKey: string;
};

function cloneRecoveryOwnerEntry(entry: InternalSessionEntry): InternalSessionEntry {
  return {
    ...entry,
    ...(entry.restartRecoveryRuns
      ? { restartRecoveryRuns: entry.restartRecoveryRuns.map((run) => ({ ...run })) }
      : {}),
    ...(entry.mainRestartRecovery
      ? { mainRestartRecovery: structuredClone(entry.mainRestartRecovery) }
      : {}),
  };
}

function refreshPreparedRecoveryOwnerTarget(
  prepared: PreparedRecoveryOwnerTarget,
  acquired: AcquiredRecoveryOwner | undefined,
): void {
  if (!acquired || acquired.entry.sessionId !== prepared.sessionId) {
    return;
  }
  const entry = cloneRecoveryOwnerEntry(acquired.entry);
  prepared.sessionEntry = entry;
  if (prepared.sessionStore && prepared.sessionKey) {
    prepared.sessionStore[prepared.sessionKey] = entry;
  }
}

async function claimAgentCommandRecoveryOwner(params: {
  lifecycleGeneration: string;
  mode: "claim" | "reject_uncoordinated";
  opts: AgentCommandOpts;
  prepared: PreparedRecoveryOwnerTarget;
}): Promise<AcquiredRecoveryOwner | undefined> {
  const transferredLease = params.opts.mainRestartRecoveryOwnerLease;
  if (transferredLease) {
    const expectedLeaseSessionId = params.prepared.isNewSession
      ? params.prepared.previousSessionId
      : params.prepared.sessionId;
    const matchesPreparedTarget =
      expectedLeaseSessionId !== undefined &&
      transferredLease.lifecycleGeneration === params.lifecycleGeneration &&
      transferredLease.sessionId === expectedLeaseSessionId &&
      transferredLease.sessionKey === params.prepared.sessionKey &&
      (transferredLease.agentId === undefined ||
        transferredLease.agentId === params.prepared.sessionAgentId) &&
      path.resolve(transferredLease.storePath) === path.resolve(params.prepared.storePath);
    if (!matchesPreparedTarget) {
      // Gateway transfers a persisted fence before preparation; bind it again after
      // session resolution so rollover or rerouting cannot execute under another row's lease.
      throw new Error("main-session recovery owner changed during ingress preparation; retry");
    }
    const snapshot = await refreshMainSessionRecoveryOwner(transferredLease, params.opts.runId);
    if (!snapshot) {
      throw new Error("main-session recovery owner changed during ingress preparation; retry");
    }
    return snapshot;
  }
  if (params.opts.sessionEffects === "internal") {
    return undefined;
  }
  if (params.opts.mainRestartRecoveryAdmitted === true) {
    return undefined;
  }
  const sessionKey = params.prepared.sessionKey;
  if (!sessionKey) {
    return undefined;
  }
  const target = {
    agentId: params.prepared.sessionAgentId,
    sessionKey,
    storePath: params.prepared.storePath,
  };
  if (params.mode === "reject_uncoordinated") {
    const recoveryInspection = await inspectMainSessionRecoveryRequired({
      allowMissingSession:
        (params.prepared.isNewSession && !params.prepared.previousSessionId) ||
        params.opts.sessionId?.trim() === params.prepared.sessionId,
      expectedSessionId: params.prepared.previousSessionId ?? params.prepared.sessionId,
      lifecycleGeneration: params.lifecycleGeneration,
      target,
    });
    if (recoveryInspection.kind === "invalidated") {
      throw createSessionWorkStartChangedError(sessionKey);
    }
    if (recoveryInspection.kind === "required") {
      throw new Error(
        `Session "${sessionKey}" has interrupted work pending restart recovery; retry through a healthy Gateway or reset it there with /new or /reset.`,
      );
    }
    return undefined;
  }
  // Claim against the latest durable row instead of the preparation snapshot.
  // A restart marker may appear or clear while preparation reads the session.
  const claim = await claimMainSessionRecoveryOwner({
    allowMissingSession:
      (params.prepared.isNewSession && !params.prepared.previousSessionId) ||
      params.opts.sessionId?.trim() === params.prepared.sessionId,
    lifecycleGeneration: params.lifecycleGeneration,
    sessionId: params.prepared.previousSessionId ?? params.prepared.sessionId,
    replacementSessionId: params.prepared.isNewSession ? params.prepared.sessionId : undefined,
    runId: params.opts.runId,
    target,
  });
  if (claim.kind === "invalidated") {
    throw createSessionWorkStartChangedError(sessionKey);
  }
  if (claim.kind === "not_required") {
    return undefined;
  }
  // Explicit replacements keep this token through successor persistence so
  // recovery cannot race the replacement; Gateway claims follow the same lease path.
  return { lease: claim.lease, entry: claim.entry, sessionKey: claim.sessionKey };
}

export async function runWithAgentCommandRecoveryOwner<
  TPrepared extends PreparedRecoveryOwnerTarget,
  TResult,
>(params: {
  lifecycleGeneration: string;
  mode: "claim" | "reject_uncoordinated";
  opts: AgentCommandOpts;
  prepare: (opts: AgentCommandOpts) => Promise<TPrepared>;
  restoreAdmittedRecovery?: () => Promise<MainSessionRecoveryPendingTarget | undefined>;
  run: (prepared: TPrepared) => Promise<TResult>;
}): Promise<TResult> {
  // Gateway may preclaim before dispatch, so every preparation outcome must release ownership.
  let lease = params.opts.mainRestartRecoveryOwnerLease;
  let pendingRecovery: Awaited<ReturnType<typeof releaseMainSessionRecoveryOwner>> = undefined;
  let prepared: TPrepared | undefined;
  try {
    try {
      prepared = await params.prepare(params.opts);
    } catch (error) {
      // Gateway admission consumes the durable reservation before command
      // preparation. Restore it when preparation fails before a run exists.
      const restoreAdmittedRecovery = params.restoreAdmittedRecovery;
      if (restoreAdmittedRecovery) {
        pendingRecovery = await repairMainSessionRecoveryMutation({
          mutation: restoreAdmittedRecovery,
          onDeferredSuccess: scheduleMainSessionRecoveryPendingTarget,
          onError: (restoreError) =>
            log.warn(
              `failed to restore admitted recovery after command preparation: ${formatErrorMessage(restoreError)}`,
            ),
        });
      }
      throw error;
    }
    const target = prepared;
    const mayWaitForRecovery =
      params.mode === "claim" &&
      params.opts.inputProvenance?.sourceTool === "subagent_settle" &&
      params.opts.sessionEffects !== "internal" &&
      !params.opts.mainRestartRecoveryAdmitted &&
      !params.opts.mainRestartRecoveryOwnerLease;
    const recoveryOwnerRelease = () =>
      mayWaitForRecovery
        ? getSessionWorkAdmissionOwnerRelease({
            scope: target.storePath,
            identities: [target.sessionKey, target.previousSessionId ?? target.sessionId],
            owner: MAIN_SESSION_RECOVERY_WORK_ADMISSION_OWNER,
          })
        : undefined;
    let pendingOwner = recoveryOwnerRelease();
    let acquired: AcquiredRecoveryOwner | undefined;
    for (;;) {
      if (pendingOwner) {
        // Keep the accepted settle turn (and its idempotency key) alive rather
        // than returning a cached no-turn rejection to the durable delivery owner.
        await racePromiseWithAbortSignal(pendingOwner, params.opts.abortSignal);
        params.opts.abortSignal?.throwIfAborted();
        assertAgentRunLifecycleGenerationCurrent(params.lifecycleGeneration);
        await prepared.runLease?.release();
        prepared = undefined;
        prepared = await params.prepare(params.opts);
        if (
          prepared.sessionId !== target.sessionId ||
          prepared.previousSessionId !== target.previousSessionId ||
          prepared.sessionKey !== target.sessionKey ||
          path.resolve(prepared.storePath) !== path.resolve(target.storePath)
        ) {
          throw createSessionWorkStartChangedError(target.sessionKey ?? target.sessionId);
        }
      }
      if (mayWaitForRecovery) {
        params.opts.abortSignal?.throwIfAborted();
        assertAgentRunLifecycleGenerationCurrent(params.lifecycleGeneration);
      }
      try {
        acquired = await claimAgentCommandRecoveryOwner({ ...params, prepared });
      } catch (error) {
        // A recovery owner can start during the writer-ordered claim. Only a
        // proven live owner makes this rejection waitable; stale/deleted rows
        // and tombstones still fail through the unchanged durable guard.
        pendingOwner =
          error instanceof SessionWorkStartChangedError ? recoveryOwnerRelease() : undefined;
        if (!pendingOwner) {
          throw error;
        }
        continue;
      }
      pendingOwner = acquired ? undefined : recoveryOwnerRelease();
      if (!pendingOwner) {
        break;
      }
    }
    lease = acquired?.lease;
    if (mayWaitForRecovery) {
      params.opts.abortSignal?.throwIfAborted();
      assertAgentRunLifecycleGenerationCurrent(params.lifecycleGeneration);
    }
    // Preparation uses a detached working copy. Carry the owner transaction's
    // exact row forward so successful settlement can consume the same recovery cycle.
    refreshPreparedRecoveryOwnerTarget(prepared, acquired);
    return await params.run(prepared);
  } finally {
    try {
      const releasedRecovery = await releaseMainSessionRecoveryOwner(lease);
      pendingRecovery ??= releasedRecovery;
    } catch (error) {
      log.warn(`failed to release main-session recovery owner: ${formatErrorMessage(error)}`);
    }
    try {
      await prepared?.runLease?.release();
    } finally {
      scheduleMainSessionRecoveryPendingTarget(pendingRecovery);
    }
  }
}
