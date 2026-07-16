// Compaction checkpoint branching and restore operations.
import {
  ErrorCodes,
  errorShape,
  validateSessionsCompactionBranchParams,
  validateSessionsCompactionRestoreParams,
} from "../../../packages/gateway-protocol/src/index.js";
import { clearSessionQueues } from "../../auto-reply/reply/queue/cleanup.js";
import { SESSION_LIFECYCLE_CHANGED_ERROR_REASON } from "../../config/sessions.js";
import {
  interruptSessionWorkAdmissions,
  runExclusiveSessionLifecycleMutation,
  SESSION_WORK_ADMISSION_DRAIN_TIMEOUT_MS,
} from "../../sessions/session-lifecycle-admission.js";
import {
  createFileBackedCompactionCheckpointStore,
  getSessionCompactionCheckpoint,
} from "../session-compaction-checkpoints.js";
import {
  buildDashboardSessionKey,
  resolveRequestedSessionAgentId as resolveRequestedGlobalAgentId,
} from "../session-create-service.js";
import { emitSessionsChanged } from "./session-change-event.js";
import { interruptSessionRunIfActive } from "./sessions-messaging.js";
import {
  loadAccessorSessionEntryForGatewayTarget,
  rejectWebchatSessionMutation,
  requireSessionKey,
  resolveSessionWorkerPlacementMutationError,
  respondSessionWorkerPlacementMutationError,
  type SessionWorkerPlacementMutationError,
} from "./sessions-shared.js";
import type { GatewayRequestHandlers } from "./types.js";
import { assertValidParams } from "./validation.js";

const compactionCheckpointStore = createFileBackedCompactionCheckpointStore();
const MODEL_SELECTION_LOCKED_CHECKPOINT_MESSAGE =
  "Checkpoint branch and restore are unavailable while model selection is locked.";

export const sessionCheckpointHandlers: GatewayRequestHandlers = {
  "sessions.compaction.branch": async ({ params, respond, context, client, isWebchatConnect }) => {
    if (
      !assertValidParams(
        params,
        validateSessionsCompactionBranchParams,
        "sessions.compaction.branch",
        respond,
      )
    ) {
      return;
    }
    const p = params;
    const key = requireSessionKey(p.key, respond);
    if (!key) {
      return;
    }
    if (rejectWebchatSessionMutation({ action: "branch", client, isWebchatConnect, respond })) {
      return;
    }
    const checkpointId =
      typeof p.checkpointId === "string" && p.checkpointId.trim() ? p.checkpointId.trim() : "";
    if (!checkpointId) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "checkpointId required"));
      return;
    }
    const cfg = context.getRuntimeConfig();
    const requestedAgent = resolveRequestedGlobalAgentId(cfg, key, p.agentId);
    if (!requestedAgent.ok) {
      respond(false, undefined, requestedAgent.error);
      return;
    }
    const { entry, canonicalKey, sessionStoreKey, target, storePath } =
      loadAccessorSessionEntryForGatewayTarget({
        key,
        cfg,
        agentId: requestedAgent.agentId,
      });
    if (!entry?.sessionId) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, `session not found: ${key}`),
      );
      return;
    }
    const checkpoint = getSessionCompactionCheckpoint({ entry, checkpointId });
    if (!checkpoint) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, `checkpoint not found: ${checkpointId}`),
      );
      return;
    }
    const nextKey = buildDashboardSessionKey(target.agentId);
    const branchedSession = await compactionCheckpointStore.branchCheckpointSession({
      agentId: target.agentId,
      storePath,
      sourceKey: canonicalKey,
      sourceStoreKey: sessionStoreKey,
      nextKey,
      checkpointId,
    });
    if (
      branchedSession.status === "missing-checkpoint" ||
      branchedSession.status === "missing-boundary"
    ) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, `checkpoint not found: ${checkpointId}`),
      );
      return;
    }
    if (branchedSession.status === "missing-session") {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, `session not found: ${key}`),
      );
      return;
    }
    if (branchedSession.status === "model-selection-locked") {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, MODEL_SELECTION_LOCKED_CHECKPOINT_MESSAGE),
      );
      return;
    }
    if (branchedSession.status === "failed") {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.UNAVAILABLE, "failed to create checkpoint branch transcript"),
      );
      return;
    }

    respond(
      true,
      {
        ok: true,
        sourceKey: canonicalKey,
        key: branchedSession.key,
        sessionId: branchedSession.entry.sessionId,
        checkpoint: branchedSession.checkpoint,
        entry: branchedSession.entry,
      },
      undefined,
    );
    emitSessionsChanged(context, {
      sessionKey: canonicalKey,
      ...(canonicalKey === "global" && requestedAgent.agentId
        ? { agentId: requestedAgent.agentId }
        : {}),
      reason: "checkpoint-branch",
    });
    emitSessionsChanged(context, {
      sessionKey: branchedSession.key,
      reason: "checkpoint-branch",
    });
  },
  "sessions.compaction.restore": async ({
    req,
    params,
    respond,
    context,
    client,
    isWebchatConnect,
  }) => {
    if (
      !assertValidParams(
        params,
        validateSessionsCompactionRestoreParams,
        "sessions.compaction.restore",
        respond,
      )
    ) {
      return;
    }
    const p = params;
    const key = requireSessionKey(p.key, respond);
    if (!key) {
      return;
    }
    if (rejectWebchatSessionMutation({ action: "restore", client, isWebchatConnect, respond })) {
      return;
    }
    const checkpointId =
      typeof p.checkpointId === "string" && p.checkpointId.trim() ? p.checkpointId.trim() : "";
    if (!checkpointId) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "checkpointId required"));
      return;
    }
    const cfg = context.getRuntimeConfig();
    const requestedAgent = resolveRequestedGlobalAgentId(cfg, key, p.agentId);
    if (!requestedAgent.ok) {
      respond(false, undefined, requestedAgent.error);
      return;
    }
    const { entry, canonicalKey, sessionStoreKey, storePath } =
      loadAccessorSessionEntryForGatewayTarget({
        key,
        cfg,
        agentId: requestedAgent.agentId,
      });
    if (!entry?.sessionId) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, `session not found: ${key}`),
      );
      return;
    }
    const checkpoint = getSessionCompactionCheckpoint({ entry, checkpointId });
    if (!checkpoint) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, `checkpoint not found: ${checkpointId}`),
      );
      return;
    }
    const initialPlacementError = resolveSessionWorkerPlacementMutationError({
      action: "restore",
      context,
      key,
      sessionId: entry.sessionId,
    });
    if (initialPlacementError) {
      respondSessionWorkerPlacementMutationError(initialPlacementError, respond);
      return;
    }
    const lifecycleIdentities = [
      key,
      canonicalKey,
      sessionStoreKey,
      entry.sessionId,
      entry.lifecycleRevision,
    ];
    const restoreLockIdentities = [entry.sessionId, entry.lifecycleRevision];
    let admittedWorkReleased = true;
    let restoreTargetStillCurrent = true;
    let restoreBlockedByModelLock = false;
    let restorePlacementError: SessionWorkerPlacementMutationError | undefined;
    // Restore replaces the active transcript identity. Hold the same lifecycle fence as
    // compaction so neither operation can publish state from the other's obsolete session.
    await runExclusiveSessionLifecycleMutation({
      scope: storePath,
      identities: restoreLockIdentities,
      prepare: async () => {
        const current = loadAccessorSessionEntryForGatewayTarget({
          key,
          cfg,
          agentId: requestedAgent.agentId,
        });
        const currentCheckpoint = current.entry
          ? getSessionCompactionCheckpoint({ entry: current.entry, checkpointId })
          : undefined;
        restoreTargetStillCurrent =
          current.entry?.sessionId === entry.sessionId &&
          current.entry.lifecycleRevision === entry.lifecycleRevision &&
          currentCheckpoint !== undefined;
        if (!restoreTargetStillCurrent) {
          return;
        }
        restoreBlockedByModelLock = current.entry?.modelSelectionLocked === true;
        if (restoreBlockedByModelLock) {
          return;
        }
        restorePlacementError = resolveSessionWorkerPlacementMutationError({
          action: "restore",
          context,
          key,
          sessionId: current.entry?.sessionId,
        });
        if (restorePlacementError) {
          return;
        }
        clearSessionQueues([
          key,
          current.canonicalKey,
          current.sessionStoreKey,
          current.entry?.sessionId,
        ]);
        admittedWorkReleased = await interruptSessionWorkAdmissions({
          scope: storePath,
          identities: lifecycleIdentities,
          timeoutMs: SESSION_WORK_ADMISSION_DRAIN_TIMEOUT_MS,
        });
      },
      run: async () => {
        if (!restoreTargetStillCurrent) {
          respond(
            false,
            undefined,
            errorShape(
              ErrorCodes.INVALID_REQUEST,
              `Session ${key} changed before checkpoint restore. Retry.`,
              { details: { reason: SESSION_LIFECYCLE_CHANGED_ERROR_REASON } },
            ),
          );
          return;
        }
        if (restoreBlockedByModelLock) {
          respond(
            false,
            undefined,
            errorShape(ErrorCodes.INVALID_REQUEST, MODEL_SELECTION_LOCKED_CHECKPOINT_MESSAGE),
          );
          return;
        }
        if (restorePlacementError) {
          respondSessionWorkerPlacementMutationError(restorePlacementError, respond);
          return;
        }
        if (!admittedWorkReleased) {
          respond(
            false,
            undefined,
            errorShape(ErrorCodes.UNAVAILABLE, `Session ${key} is still active; try again.`),
          );
          return;
        }
        const current = loadAccessorSessionEntryForGatewayTarget({
          key,
          cfg,
          agentId: requestedAgent.agentId,
        });
        if (!current.entry?.sessionId) {
          respond(
            false,
            undefined,
            errorShape(ErrorCodes.INVALID_REQUEST, `session not found: ${key}`),
          );
          return;
        }
        if (current.entry.modelSelectionLocked === true) {
          respond(
            false,
            undefined,
            errorShape(ErrorCodes.INVALID_REQUEST, MODEL_SELECTION_LOCKED_CHECKPOINT_MESSAGE),
          );
          return;
        }
        const currentCheckpoint = getSessionCompactionCheckpoint({
          entry: current.entry,
          checkpointId,
        });
        if (!currentCheckpoint) {
          respond(
            false,
            undefined,
            errorShape(ErrorCodes.INVALID_REQUEST, `checkpoint not found: ${checkpointId}`),
          );
          return;
        }
        const interruptResult = await interruptSessionRunIfActive({
          req,
          context,
          client,
          isWebchatConnect,
          requestedKey: key,
          canonicalKey: current.canonicalKey,
          agentId: requestedAgent.agentId,
          sessionId: current.entry.sessionId,
        });
        if (interruptResult.error) {
          respond(false, undefined, interruptResult.error);
          return;
        }

        const restoredSession = await compactionCheckpointStore.restoreCheckpointSession({
          agentId: requestedAgent.agentId,
          storePath,
          sessionKey: current.canonicalKey,
          sessionStoreKey: current.sessionStoreKey,
          checkpointId,
        });
        if (
          restoredSession.status === "missing-checkpoint" ||
          restoredSession.status === "missing-boundary"
        ) {
          respond(
            false,
            undefined,
            errorShape(ErrorCodes.INVALID_REQUEST, `checkpoint not found: ${checkpointId}`),
          );
          return;
        }
        if (restoredSession.status === "missing-session") {
          respond(
            false,
            undefined,
            errorShape(ErrorCodes.INVALID_REQUEST, `session not found: ${key}`),
          );
          return;
        }
        if (restoredSession.status === "model-selection-locked") {
          respond(
            false,
            undefined,
            errorShape(ErrorCodes.INVALID_REQUEST, MODEL_SELECTION_LOCKED_CHECKPOINT_MESSAGE),
          );
          return;
        }
        if (restoredSession.status === "failed") {
          respond(
            false,
            undefined,
            errorShape(ErrorCodes.UNAVAILABLE, "failed to restore checkpoint transcript"),
          );
          return;
        }

        respond(
          true,
          {
            ok: true,
            key: restoredSession.key,
            sessionId: restoredSession.entry.sessionId,
            checkpoint: restoredSession.checkpoint,
            entry: restoredSession.entry,
          },
          undefined,
        );
        emitSessionsChanged(context, {
          sessionKey: current.canonicalKey,
          ...(current.canonicalKey === "global" && requestedAgent.agentId
            ? { agentId: requestedAgent.agentId }
            : {}),
          reason: "checkpoint-restore",
        });
      },
    });
  },
};
