// Destructive session deletion and lifecycle cleanup.
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  ErrorCodes,
  errorShape,
  validateSessionsDeleteParams,
} from "../../../packages/gateway-protocol/src/index.js";
import { resolveDefaultAgentId } from "../../agents/agent-scope.js";
import { managedWorktrees } from "../../agents/worktrees/service.js";
import {
  deleteSessionEntryLifecycle,
  resolveMainSessionKey,
  SESSION_LIFECYCLE_CHANGED_ERROR_REASON,
  type SessionEntry,
} from "../../config/sessions.js";
import { rollbackPluginOwnedSessionEntryLifecycle } from "../../config/sessions/session-accessor.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { isAgentHarnessSessionKey } from "../../sessions/agent-harness-session-key.js";
import { isModelSelectionLocked } from "../../sessions/model-overrides.js";
import {
  interruptSessionWorkAdmissions,
  runExclusiveSessionLifecycleMutation,
  SESSION_WORK_ADMISSION_DRAIN_TIMEOUT_MS,
} from "../../sessions/session-lifecycle-admission.js";
import { handleSessionStateSessionDeleted } from "../../sessions/session-state-events.js";
import { resolveRequestedSessionAgentId as resolveRequestedGlobalAgentId } from "../session-create-service.js";
import { resolveSessionStoreAgentId } from "../session-store-key.js";
import { loadSessionEntry } from "../session-utils.js";
import { chatHandlers } from "./chat.js";
import { emitSessionsChanged } from "./session-change-event.js";
import {
  loadAccessorSessionEntryForGatewayTarget,
  loadSessionsRuntimeModule,
  rejectPluginRuntimeDeleteMismatch,
  rejectWebchatSessionMutation,
  requireSessionKey,
  resolveGatewaySessionTargetFromKey,
  resolveSessionWorkerPlacementMutationError,
  respondSessionWorkerPlacementMutationError,
  sessionLog,
} from "./sessions-shared.js";
import type { GatewayRequestHandlers } from "./types.js";
import { assertValidParams } from "./validation.js";

export const sessionDeleteHandlers: GatewayRequestHandlers = {
  "sessions.delete": async ({ req, params, respond, client, isWebchatConnect, context }) => {
    if (!assertValidParams(params, validateSessionsDeleteParams, "sessions.delete", respond)) {
      return;
    }
    const p = params;
    const key = requireSessionKey(p.key, respond);
    if (!key) {
      return;
    }
    if (rejectWebchatSessionMutation({ action: "delete", client, isWebchatConnect, respond })) {
      return;
    }

    const cfg = context.getRuntimeConfig();
    const requestedAgent = resolveRequestedGlobalAgentId(cfg, key, p.agentId);
    if (!requestedAgent.ok) {
      respond(false, undefined, requestedAgent.error);
      return;
    }
    const requestedAgentId = requestedAgent.agentId;
    const { target, storePath } = resolveGatewaySessionTargetFromKey(key, cfg, {
      agentId: requestedAgentId,
    });
    const mainKey = resolveMainSessionKey(cfg);
    const isSelectedNonDefaultGlobal =
      target.canonicalKey === "global" &&
      requestedAgentId !== undefined &&
      requestedAgentId !== resolveDefaultAgentId(cfg);
    if (target.canonicalKey === mainKey && !isSelectedNonDefaultGlobal) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, `Cannot delete the main session (${mainKey}).`),
      );
      return;
    }

    const deleteTranscript = typeof p.deleteTranscript === "boolean" ? p.deleteTranscript : true;
    const {
      cleanupSessionBeforeMutation,
      emitGatewaySessionEndPluginHook,
      emitSessionUnboundLifecycleEvent,
    } = await loadSessionsRuntimeModule();

    const initialDeleteEntry = loadSessionEntry(key, {
      agentId: requestedAgentId,
    }).entry;
    const rejectModelSelectionLockedDelete = (
      entry: SessionEntry | undefined,
      sessionKey: string,
    ): boolean => {
      if (!isModelSelectionLocked(entry)) {
        return false;
      }
      const deletablePluginOwnedSession =
        normalizeOptionalString(entry?.pluginOwnerId) !== undefined &&
        entry?.agentHarnessId === undefined &&
        !isAgentHarnessSessionKey(sessionKey);
      if (deletablePluginOwnedSession) {
        return false;
      }
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          "This session cannot be deleted while model selection is locked.",
        ),
      );
      return true;
    };
    if (rejectModelSelectionLockedDelete(initialDeleteEntry, target.canonicalKey)) {
      return;
    }
    // archivedOnly is the archive-then-delete contract: the dispatcher grants
    // it to write-scope operators, so the target must actually be archived.
    if (p.archivedOnly === true && initialDeleteEntry?.archivedAt === undefined) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `Session ${key} is not archived. Archive it first, then delete it.`,
        ),
      );
      return;
    }
    const expectedSessionId = p.expectedSessionId?.trim();
    const expectedLifecycleRevision = p.expectedLifecycleRevision?.trim();
    const expectedSessionUpdatedAt = p.expectedSessionUpdatedAt;
    const expectedLifecycleRevisionMatches = (entry: SessionEntry | undefined): boolean =>
      !expectedLifecycleRevision || entry?.lifecycleRevision === expectedLifecycleRevision;
    const expectedSessionIdMatches = (entry: SessionEntry | undefined): boolean => {
      if (!expectedSessionId || entry?.sessionId === expectedSessionId) {
        return true;
      }
      return false;
    };
    const respondSessionChanged = () => {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, `Session ${key} changed before deletion. Retry.`, {
          details: { reason: SESSION_LIFECYCLE_CHANGED_ERROR_REASON },
        }),
      );
    };
    const rejectExpectedSessionMismatch = (entry: SessionEntry | undefined): boolean => {
      const updatedAtMatches =
        expectedSessionUpdatedAt === undefined || entry?.updatedAt === expectedSessionUpdatedAt;
      if (
        expectedLifecycleRevisionMatches(entry) &&
        expectedSessionIdMatches(entry) &&
        updatedAtMatches
      ) {
        return false;
      }
      respondSessionChanged();
      return true;
    };
    if (rejectExpectedSessionMismatch(initialDeleteEntry)) {
      return;
    }
    const initialPlacementError = resolveSessionWorkerPlacementMutationError({
      action: "delete",
      context,
      key,
      sessionId: normalizeOptionalString(initialDeleteEntry?.sessionId),
    });
    if (initialPlacementError) {
      respondSessionWorkerPlacementMutationError(initialPlacementError, respond);
      return;
    }
    if (
      rejectPluginRuntimeDeleteMismatch({
        client,
        key: target.canonicalKey ?? key,
        entry: initialDeleteEntry,
        respond,
      })
    ) {
      return;
    }
    let abortResult:
      | {
          ok: boolean;
          error?: ReturnType<typeof errorShape>;
        }
      | undefined;
    const abortSessionKey = target.canonicalKey ?? key;
    const chatAbort = chatHandlers["chat.abort"];
    if (!chatAbort) {
      throw new Error("chat.abort handler is not registered");
    }
    await chatAbort({
      req,
      params: {
        sessionKey: abortSessionKey,
        ...(requestedAgentId ? { agentId: requestedAgentId } : {}),
      },
      respond: (ok, _payload, error) => {
        abortResult = { ok, ...(error ? { error } : {}) };
      },
      context,
      client,
      isWebchatConnect,
    });
    if (abortResult?.ok === false) {
      respond(false, undefined, abortResult.error);
      return;
    }
    const deleteLifecycleIdentities = [
      target.canonicalKey,
      key,
      initialDeleteEntry?.sessionId,
      expectedSessionId,
    ];
    let admittedWorkReleased = true;
    let expectedSessionStillCurrent = true;
    let deleteBlockedByModelLock = false;
    let deleteBlockedByWorkerPlacement = false;
    const deletion = await runExclusiveSessionLifecycleMutation({
      scope: storePath,
      identities: deleteLifecycleIdentities,
      prepare: async () => {
        const preparedEntry = loadSessionEntry(key, { agentId: requestedAgentId }).entry;
        deleteBlockedByModelLock = rejectModelSelectionLockedDelete(
          preparedEntry,
          target.canonicalKey,
        );
        if (deleteBlockedByModelLock) {
          return;
        }
        expectedSessionStillCurrent = !rejectExpectedSessionMismatch(preparedEntry);
        if (!expectedSessionStillCurrent) {
          return;
        }
        const placementError = resolveSessionWorkerPlacementMutationError({
          action: "delete",
          context,
          key,
          sessionId: normalizeOptionalString(preparedEntry?.sessionId),
        });
        if (placementError) {
          deleteBlockedByWorkerPlacement = true;
          respondSessionWorkerPlacementMutationError(placementError, respond);
          return;
        }
        admittedWorkReleased = await interruptSessionWorkAdmissions({
          scope: storePath,
          identities: deleteLifecycleIdentities,
          timeoutMs: SESSION_WORK_ADMISSION_DRAIN_TIMEOUT_MS,
        });
      },
      run: async () => {
        if (
          deleteBlockedByModelLock ||
          deleteBlockedByWorkerPlacement ||
          !expectedSessionStillCurrent
        ) {
          return undefined;
        }
        if (!admittedWorkReleased) {
          respond(
            false,
            undefined,
            errorShape(ErrorCodes.UNAVAILABLE, `Session ${key} is still active; try again.`),
          );
          return undefined;
        }
        const { entry, legacyKey, canonicalKey } = loadSessionEntry(key, {
          agentId: requestedAgentId,
        });
        if (rejectModelSelectionLockedDelete(entry, canonicalKey ?? target.canonicalKey)) {
          return undefined;
        }
        if (rejectExpectedSessionMismatch(entry)) {
          return undefined;
        }
        // Recheck under the lifecycle lock: an unarchive racing the pre-lock
        // check must not let an archive-gated delete remove an active session.
        if (p.archivedOnly === true && entry?.archivedAt === undefined) {
          respond(
            false,
            undefined,
            errorShape(
              ErrorCodes.INVALID_REQUEST,
              `Session ${key} is not archived. Archive it first, then delete it.`,
            ),
          );
          return undefined;
        }
        if (
          rejectPluginRuntimeDeleteMismatch({
            client,
            key: canonicalKey ?? key,
            entry,
            respond,
          })
        ) {
          return undefined;
        }
        const mutationCleanupError = await cleanupSessionBeforeMutation({
          cfg,
          key,
          target,
          entry,
          legacyKey,
          canonicalKey,
          reason: "session-delete",
        });
        if (mutationCleanupError) {
          respond(false, undefined, mutationCleanupError);
          return undefined;
        }
        const postCleanupTarget = loadAccessorSessionEntryForGatewayTarget({
          key,
          cfg,
          ...(requestedAgentId ? { agentId: requestedAgentId } : {}),
        });
        const postCleanupEntry = postCleanupTarget.entry;
        if (
          !expectedLifecycleRevisionMatches(postCleanupEntry) ||
          !expectedSessionIdMatches(postCleanupEntry)
        ) {
          respondSessionChanged();
          return undefined;
        }
        const pluginOwnerId = normalizeOptionalString(postCleanupEntry?.pluginOwnerId);
        const deletionParams = {
          agentId: target.agentId,
          archiveTranscript: deleteTranscript,
          expectedEntry: postCleanupEntry,
          expectedLifecycleRevision,
          expectedSessionId,
          expectedUpdatedAt: postCleanupEntry?.updatedAt,
          storePath,
          target: {
            canonicalKey: target.canonicalKey,
            storeKeys: target.storeKeys,
          },
        };
        // Catalog and other plugin-owned sessions keep model selection locked,
        // so deletion must use the exact-row owner-validated lifecycle seam.
        const result =
          postCleanupEntry && pluginOwnerId && isModelSelectionLocked(postCleanupEntry)
            ? await rollbackPluginOwnedSessionEntryLifecycle({
                ...deletionParams,
                expectedEntry: postCleanupEntry,
                expectedPluginOwnerId: pluginOwnerId,
                target: {
                  canonicalKey: postCleanupTarget.target.canonicalKey,
                  storeKeys: postCleanupTarget.target.storeKeys,
                },
              })
            : await deleteSessionEntryLifecycle(deletionParams);
        if (result.expectedEntryMismatch) {
          respondSessionChanged();
          return undefined;
        }
        if (result.deleted) {
          emitGatewaySessionEndPluginHook({
            cfg,
            sessionKey: target.canonicalKey ?? key,
            sessionId: result.deletedSessionId,
            storePath,
            sessionFile: result.deletedSessionFile,
            agentId: target.agentId,
            reason: "deleted",
            archivedTranscripts: result.archivedTranscripts,
          });
          await emitSessionUnboundLifecycleEvent({
            targetSessionKey: target.canonicalKey ?? key,
            reason: "session-delete",
            emitHooks: p.emitLifecycleHooks !== false,
          });
        }
        return result;
      },
    });
    if (!deletion) {
      return;
    }
    const deleted = deletion.deleted;
    const archivedTranscripts = deletion.archivedTranscripts;
    const archived = archivedTranscripts.map((entryLocal) => entryLocal.archivedPath);

    // Session deletion ends worktree ownership. Snapshot before removal so
    // inherited unpushed history or local edits do not leave an ownerless checkout.
    let worktreePreserved: { id: string; branch: string; path: string } | undefined;
    if (deleted) {
      // requestedAgentId wins: "global" canonical keys resolve to the default store
      // agent, which would purge the wrong agent's rows for explicit-agent deletes.
      handleSessionStateSessionDeleted(
        target.canonicalKey ?? key,
        requestedAgentId ?? resolveSessionStoreAgentId(cfg, target.canonicalKey ?? key),
      );
      let worktree: ReturnType<typeof managedWorktrees.findLiveByOwner> = undefined;
      try {
        worktree = managedWorktrees.findLiveByOwner("session", target.canonicalKey);
        if (worktree) {
          await managedWorktrees.remove({ id: worktree.id, reason: "session-delete" });
        }
      } catch (error) {
        if (worktree) {
          worktreePreserved = { id: worktree.id, branch: worktree.branch, path: worktree.path };
        }
        sessionLog.warn(
          `failed to clean up worktree for deleted session ${target.canonicalKey}: ${formatErrorMessage(error)}`,
        );
      }
    }

    respond(
      true,
      {
        ok: true,
        key: target.canonicalKey,
        deleted,
        archived,
        ...(worktreePreserved ? { worktreePreserved } : {}),
      },
      undefined,
    );
    if (deleted) {
      emitSessionsChanged(context, {
        sessionKey: target.canonicalKey,
        agentId: target.agentId,
        reason: "delete",
      });
    }
  },
};
