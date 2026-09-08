// Compaction checkpoint branching and restore operations.
import {
  ErrorCodes,
  errorShape,
  validateSessionsCompactionBranchParams,
  validateSessionsCompactionRestoreParams,
  type ErrorShape,
} from "../../../packages/gateway-protocol/src/index.js";
import { GATEWAY_OWNER_PROFILE_ID } from "../../../packages/gateway-protocol/src/schema/users.js";
import { clearSessionQueues } from "../../auto-reply/reply/queue/cleanup.js";
import { SESSION_LIFECYCLE_CHANGED_ERROR_REASON } from "../../config/sessions.js";
import {
  interruptSessionWorkAdmissions,
  runExclusiveSessionLifecycleMutation,
  SESSION_WORK_ADMISSION_DRAIN_TIMEOUT_MS,
} from "../../sessions/session-lifecycle-admission.js";
import { authorizeGatewaySessionCreation, resolveCreatorSandbox } from "../operator-role-policy.js";
import {
  createFileBackedCompactionCheckpointStore,
  getSessionCompactionCheckpoint,
} from "../session-compaction-checkpoints.js";
import { buildDashboardSessionKey } from "../session-create-service.js";
import { resolveRequestedSessionAgentId } from "../session-request-agent.js";
import { emitSessionsChanged } from "./session-change-event.js";
import { resolveOperatorSessionCreation } from "./session-creation-provenance.js";
import { interruptSessionRunIfActive } from "./session-run-interruption.js";
import {
  loadAccessorSessionEntryForGatewayTarget,
  requireSessionKey,
  resolveSessionWorkerPlacementMutationError,
} from "./sessions-shared.js";
import type { GatewayRequestHandler, GatewayRequestHandlers } from "./types.js";
import { assertValidParams } from "./validation.js";

const compactionCheckpointStore = createFileBackedCompactionCheckpointStore();
const MODEL_SELECTION_LOCKED_CHECKPOINT_MESSAGE =
  "Checkpoint branch and restore are unavailable while model selection is locked.";
type CheckpointAction = "branch" | "restore";
type CheckpointMutationResult = Awaited<
  ReturnType<typeof compactionCheckpointStore.branchCheckpointSession>
>;

function checkpointConflict(key: string, action: CheckpointAction): ErrorShape {
  return errorShape(
    ErrorCodes.INVALID_REQUEST,
    `Session ${key} changed before checkpoint ${action}. Retry.`,
    { details: { reason: SESSION_LIFECYCLE_CHANGED_ERROR_REASON } },
  );
}

function createCheckpointHandler(action: CheckpointAction): GatewayRequestHandler {
  const validate =
    action === "branch"
      ? validateSessionsCompactionBranchParams
      : validateSessionsCompactionRestoreParams;
  return async ({ req, params, respond, context, client, isWebchatConnect }) => {
    if (!assertValidParams(params, validate, `sessions.compaction.${action}`, respond)) {
      return;
    }
    const fail = (error: ErrorShape | string) =>
      respond(
        false,
        undefined,
        typeof error === "string" ? errorShape(ErrorCodes.INVALID_REQUEST, error) : error,
      );
    const key = requireSessionKey(params.key, respond);
    if (!key) {
      return;
    }
    const checkpointId = params.checkpointId.trim();
    if (!checkpointId) {
      return fail("checkpointId required");
    }
    const cfg = context.getRuntimeConfig();
    const requestedAgent = resolveRequestedSessionAgentId(cfg, key, params.agentId);
    if (!requestedAgent.ok) {
      return fail(requestedAgent.error);
    }
    const { entry, canonicalKey, sessionStoreKey, target, storePath } =
      loadAccessorSessionEntryForGatewayTarget({ key, cfg, agentId: requestedAgent.agentId });
    if (!entry?.sessionId) {
      return fail(`session not found: ${key}`);
    }
    if (!getSessionCompactionCheckpoint({ entry, checkpointId })) {
      return fail(`checkpoint not found: ${checkpointId}`);
    }

    const complete = (result: CheckpointMutationResult, sourceKey: string) => {
      switch (result.status) {
        case "missing-checkpoint":
        case "missing-boundary":
          return fail(`checkpoint not found: ${checkpointId}`);
        case "missing-session":
          return fail(`session not found: ${key}`);
        case "model-selection-locked":
          return fail(MODEL_SELECTION_LOCKED_CHECKPOINT_MESSAGE);
        case "conflict":
          return fail(checkpointConflict(key, action));
        case "failed":
          return fail(
            errorShape(
              ErrorCodes.UNAVAILABLE,
              action === "branch"
                ? "failed to create checkpoint branch transcript"
                : "failed to restore checkpoint transcript",
            ),
          );
        case "created":
          break;
        default:
          return result satisfies never;
      }
      respond(
        true,
        {
          ok: true,
          ...(action === "branch" ? { sourceKey } : {}),
          key: result.key,
          sessionId: result.entry.sessionId,
          checkpoint: result.checkpoint,
          entry: result.entry,
        },
        undefined,
      );
      emitSessionsChanged(context, {
        sessionKey: sourceKey,
        agentId: requestedAgent.agentId,
        reason: `checkpoint-${action}`,
      });
      if (action === "branch") {
        emitSessionsChanged(context, { sessionKey: result.key, reason: "checkpoint-branch" });
      }
    };

    if (action === "branch") {
      const creationError = authorizeGatewaySessionCreation({
        cfg,
        client,
        agentId: target.agentId,
      });
      if (creationError) {
        return fail(creationError);
      }
      const nextKey = buildDashboardSessionKey(target.agentId);
      const creation = resolveOperatorSessionCreation(client);
      // Owner attribution keeps the source isolation inherited by identityless branches.
      const sandbox =
        creation.actor?.id === GATEWAY_OWNER_PROFILE_ID
          ? entry.sandbox
          : resolveCreatorSandbox(cfg, creation);
      const result = await compactionCheckpointStore.branchCheckpointSession({
        agentId: target.agentId,
        expectedState: { sessionId: entry.sessionId, lifecycleRevision: entry.lifecycleRevision },
        storePath,
        sourceKey: canonicalKey,
        sourceStoreKey: sessionStoreKey,
        nextKey,
        checkpointId,
        ...(creation.actor ? { creation: { ...creation, sandbox } } : {}),
      });
      return complete(result, canonicalKey);
    }

    const initialPlacementError = resolveSessionWorkerPlacementMutationError({
      action: "restore",
      context,
      key,
      sessionId: entry.sessionId,
    });
    if (initialPlacementError) {
      return fail(initialPlacementError.message);
    }
    const lifecycleIdentities = [
      key,
      canonicalKey,
      sessionStoreKey,
      entry.sessionId,
      entry.lifecycleRevision,
    ];
    let preparationError: ErrorShape | undefined;
    // Restore replaces the active transcript identity. Hold the same lifecycle fence as
    // compaction so neither operation can publish state from the other's obsolete session.
    await runExclusiveSessionLifecycleMutation({
      scope: storePath,
      identities: [entry.sessionId, entry.lifecycleRevision],
      prepare: async () => {
        const current = loadAccessorSessionEntryForGatewayTarget({
          key,
          cfg,
          agentId: requestedAgent.agentId,
        });
        const currentCheckpoint = current.entry
          ? getSessionCompactionCheckpoint({ entry: current.entry, checkpointId })
          : undefined;
        if (
          current.entry?.sessionId !== entry.sessionId ||
          current.entry.lifecycleRevision !== entry.lifecycleRevision ||
          !currentCheckpoint
        ) {
          preparationError = checkpointConflict(key, "restore");
          return;
        }
        if (current.entry.modelSelectionLocked === true) {
          preparationError = errorShape(
            ErrorCodes.INVALID_REQUEST,
            MODEL_SELECTION_LOCKED_CHECKPOINT_MESSAGE,
          );
          return;
        }
        const placementError = resolveSessionWorkerPlacementMutationError({
          action: "restore",
          context,
          key,
          sessionId: current.entry.sessionId,
        });
        if (placementError) {
          preparationError = errorShape(ErrorCodes.INVALID_REQUEST, placementError.message);
          return;
        }
        clearSessionQueues([
          key,
          current.canonicalKey,
          current.sessionStoreKey,
          current.entry.sessionId,
        ]);
        const released = await interruptSessionWorkAdmissions({
          scope: storePath,
          identities: lifecycleIdentities,
          timeoutMs: SESSION_WORK_ADMISSION_DRAIN_TIMEOUT_MS,
        });
        if (!released) {
          preparationError = errorShape(
            ErrorCodes.UNAVAILABLE,
            `Session ${key} is still active; try again.`,
          );
        }
      },
      run: async () => {
        if (preparationError) {
          return fail(preparationError);
        }
        const current = loadAccessorSessionEntryForGatewayTarget({
          key,
          cfg,
          agentId: requestedAgent.agentId,
        });
        if (!current.entry?.sessionId) {
          return fail(`session not found: ${key}`);
        }
        if (current.entry.modelSelectionLocked === true) {
          return fail(MODEL_SELECTION_LOCKED_CHECKPOINT_MESSAGE);
        }
        if (!getSessionCompactionCheckpoint({ entry: current.entry, checkpointId })) {
          return fail(`checkpoint not found: ${checkpointId}`);
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
          return fail(interruptResult.error);
        }
        const result = await compactionCheckpointStore.restoreCheckpointSession({
          agentId: requestedAgent.agentId,
          expectedState: {
            sessionId: current.entry.sessionId,
            lifecycleRevision: current.entry.lifecycleRevision,
          },
          storePath,
          sessionKey: current.canonicalKey,
          sessionStoreKey: current.sessionStoreKey,
          checkpointId,
        });
        complete(result, current.canonicalKey);
      },
    });
  };
}

export const sessionCheckpointHandlers: GatewayRequestHandlers = {
  "sessions.compaction.branch": createCheckpointHandler("branch"),
  "sessions.compaction.restore": createCheckpointHandler("restore"),
};
