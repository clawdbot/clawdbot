import path from "node:path";
import type { InternalSessionEntry } from "../config/sessions.js";
import { formatErrorMessage } from "../infra/errors.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import type { AgentCommandOpts } from "./command/types.js";
import { scheduleMainSessionRecoveryPendingTarget } from "./main-session-recovery-owner-release.js";
import {
  restoreAdmittedRecoveryWithRetries,
  scheduleAdmittedRecoveryRestore,
} from "./main-session-recovery-restore.js";
import {
  bindMainSessionRecoveryOwnerRun,
  claimMainSessionRecoveryOwner,
  inspectMainSessionRecoveryRequired,
  readMainSessionRecoveryOwner,
  releaseMainSessionRecoveryOwner,
  type MainSessionRecoveryOwnerLease,
  type MainSessionRecoveryPendingTarget,
} from "./main-session-recovery-store.js";

const log = createSubsystemLogger("agents/agent-command");

type PreparedRecoveryOwnerTarget = object & {
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
      path.resolve(transferredLease.storePath) === path.resolve(params.prepared.storePath);
    if (!matchesPreparedTarget) {
      // Gateway transfers a persisted fence before preparation; bind it again after
      // session resolution so rollover or rerouting cannot execute under another row's lease.
      throw new Error("main-session recovery owner changed during ingress preparation; retry");
    }
    if (params.opts.runId) {
      return await bindMainSessionRecoveryOwnerRun(transferredLease, params.opts.runId);
    }
    const snapshot = await readMainSessionRecoveryOwner(transferredLease);
    if (!snapshot) {
      throw new Error("main-session recovery owner changed during ingress preparation; retry");
    }
    return { ...snapshot, lease: transferredLease };
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
  if (params.mode === "reject_uncoordinated") {
    const recoveryInspection = await inspectMainSessionRecoveryRequired({
      allowMissingSession:
        (params.prepared.isNewSession && !params.prepared.previousSessionId) ||
        params.opts.sessionId?.trim() === params.prepared.sessionId,
      expectedSessionId: params.prepared.previousSessionId ?? params.prepared.sessionId,
      lifecycleGeneration: params.lifecycleGeneration,
      target: { sessionKey, storePath: params.prepared.storePath },
    });
    if (recoveryInspection.kind === "invalidated") {
      throw new Error(`Session "${sessionKey}" changed while starting work. Retry.`);
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
    target: { sessionKey, storePath: params.prepared.storePath },
  });
  if (claim.kind === "invalidated") {
    throw new Error(`Session "${sessionKey}" changed while starting work. Retry.`);
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
      if (params.restoreAdmittedRecovery) {
        try {
          pendingRecovery = await restoreAdmittedRecoveryWithRetries(
            params.restoreAdmittedRecovery,
          );
        } catch (restoreError) {
          log.warn(
            `failed to restore admitted recovery after command preparation: ${formatErrorMessage(restoreError)}`,
          );
          scheduleAdmittedRecoveryRestore(params.restoreAdmittedRecovery);
        }
      }
      throw error;
    }
    const acquired = await claimAgentCommandRecoveryOwner({ ...params, prepared });
    lease = acquired?.lease;
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
