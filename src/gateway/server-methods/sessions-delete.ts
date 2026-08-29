// Destructive session deletion and lifecycle cleanup.
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  ErrorCodes,
  errorShape,
  type ErrorShape,
  type PreservedSessionWorktree,
  type SessionsDeleteResult,
  validateSessionsDeleteParams,
} from "../../../packages/gateway-protocol/src/index.js";
import { classifyWorktreeRemovalError, managedWorktrees } from "../../agents/worktrees/service.js";
import { tryResolveLegacyCompatibilityAgentId } from "../../config/legacy.default-agent-owner.js";
import {
  deleteSessionEntryLifecycle,
  SESSION_LIFECYCLE_CHANGED_ERROR_REASON,
  type SessionEntry,
} from "../../config/sessions.js";
import { rollbackPluginOwnedSessionEntryLifecycle } from "../../config/sessions/session-accessor.js";
import { resolvePersistedSessionStoreOwnerForKey } from "../../config/sessions/session-store-owner.js";
import { formatErrorMessage } from "../../infra/errors.js";
import {
  isIncognitoSessionKey,
  normalizeAgentId,
  parseAgentSessionKey,
} from "../../routing/session-key.js";
import { isAgentHarnessSessionKey } from "../../sessions/agent-harness-session-key.js";
import { isModelSelectionLocked } from "../../sessions/model-overrides.js";
import { runExclusiveSessionLifecycleMutation } from "../../sessions/session-lifecycle-admission.js";
import { handleSessionStateSessionDeleted } from "../../sessions/session-state-events.js";
import { resolvePluginSessionOwnershipError } from "../session-plugin-ownership.js";
import { resolveRequestedSessionAgentId as resolveRequestedGlobalAgentId } from "../session-request-agent.js";
import { resolveSessionStoreAgentId } from "../session-store-key.js";
import { loadSessionEntry } from "../session-utils.js";
import { prepareSessionWorkerPlacementRetirement } from "../worker-environments/session-placement-lifecycle.js";
import { emitSessionsChanged } from "./session-change-event.js";
import {
  prepareSessionLifecycleDrain,
  type SessionLifecycleDrain,
} from "./sessions-lifecycle-drain.js";
import {
  loadAccessorSessionEntryForGatewayTarget,
  loadSessionsRuntimeModule,
  isAgentMainSessionKey,
  requireSessionKey,
  resolveGatewaySessionTargetFromKey,
  sessionLog,
} from "./sessions-shared.js";
import type { GatewayRequestHandlers } from "./types.js";
import { assertValidParams } from "./validation.js";

class SessionDeletionError extends Error {
  constructor(readonly error: ErrorShape) {
    super(error.message);
  }
}

export const sessionDeleteHandlers: GatewayRequestHandlers = {
  "sessions.delete": async ({ params, respond, client, context, sessionMutationAuthorization }) => {
    if (!assertValidParams(params, validateSessionsDeleteParams, "sessions.delete", respond)) {
      return;
    }
    const p = params;
    const key = requireSessionKey(p.key, respond);
    if (!key) {
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
    const compatibilityDefaultAgentId = tryResolveLegacyCompatibilityAgentId(cfg);
    const persistedStoreOwner = resolvePersistedSessionStoreOwnerForKey(cfg, key);
    const protectedGlobalAgentId =
      persistedStoreOwner.kind === "configured"
        ? persistedStoreOwner.agentId
        : compatibilityDefaultAgentId;
    const explicitlySelectedGlobalAgentId =
      normalizeOptionalString(p.agentId) ?? parseAgentSessionKey(key)?.agentId;
    const isSelectedNonDefaultGlobal =
      target.canonicalKey === "global" &&
      explicitlySelectedGlobalAgentId !== undefined &&
      normalizeAgentId(explicitlySelectedGlobalAgentId) !== protectedGlobalAgentId;
    const isMainSession =
      target.canonicalKey !== "global" && isAgentMainSessionKey(cfg, target.canonicalKey);
    if ((target.canonicalKey === "global" || isMainSession) && !isSelectedNonDefaultGlobal) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `Cannot delete the main session (${target.canonicalKey}).`,
        ),
      );
      return;
    }

    const deleteTranscript = typeof p.deleteTranscript === "boolean" ? p.deleteTranscript : true;
    const initialDeleteEntry = loadSessionEntry(key, {
      agentId: requestedAgentId,
    }).entry;
    const expectedSessionId = p.expectedSessionId?.trim();
    const expectedLifecycleRevision = p.expectedLifecycleRevision?.trim();
    const sessionChangedError = () =>
      errorShape(ErrorCodes.INVALID_REQUEST, `Session ${key} changed before deletion. Retry.`, {
        details: { reason: SESSION_LIFECYCLE_CHANGED_ERROR_REASON },
      });
    const resolveEntryError = (entry: SessionEntry | undefined) => {
      const deletablePluginOwnedSession =
        normalizeOptionalString(entry?.pluginOwnerId) !== undefined &&
        entry?.agentHarnessId === undefined &&
        !isAgentHarnessSessionKey(target.canonicalKey);
      if (isModelSelectionLocked(entry) && !deletablePluginOwnedSession) {
        return errorShape(
          ErrorCodes.INVALID_REQUEST,
          "This session cannot be deleted while model selection is locked.",
        );
      }
      // archivedOnly is the write-scope archive-then-delete contract, rechecked
      // under the fence so a racing unarchive cannot authorize active deletion.
      if (p.archivedOnly === true && entry?.archivedAt === undefined) {
        return errorShape(
          ErrorCodes.INVALID_REQUEST,
          `Session ${key} is not archived. Archive it first, then delete it.`,
        );
      }
      if (
        (expectedSessionId && entry?.sessionId !== expectedSessionId) ||
        (expectedLifecycleRevision && entry?.lifecycleRevision !== expectedLifecycleRevision)
      ) {
        return sessionChangedError();
      }
      return resolvePluginSessionOwnershipError({
        action: "delete",
        entry,
        key: target.canonicalKey,
        pluginOwnerId: client?.internal?.pluginRuntimeOwnerId,
      });
    };
    const initialError = resolveEntryError(initialDeleteEntry);
    if (initialError) {
      respond(false, undefined, initialError);
      return;
    }
    // Capture the target before lazy loading can yield to a same-key successor.
    const {
      cleanupSessionBeforeMutation,
      emitGatewaySessionEndPluginHook,
      emitSessionUnboundLifecycleEvent,
    } = await loadSessionsRuntimeModule();

    const assertCurrent = () => {
      sessionMutationAuthorization?.assertCurrent();
      const current = loadSessionEntry(key, { agentId: requestedAgentId });
      if (
        current.storePath !== storePath ||
        current.canonicalKey !== target.canonicalKey ||
        current.entry?.sessionId !== initialDeleteEntry?.sessionId ||
        current.entry?.lifecycleRevision !== initialDeleteEntry?.lifecycleRevision
      ) {
        throw new SessionDeletionError(sessionChangedError());
      }
      const error = resolveEntryError(current.entry);
      if (error) {
        throw new SessionDeletionError(error);
      }
      return current;
    };
    const deleteLifecycleIdentities = [
      target.canonicalKey,
      key,
      ...target.storeKeys,
      initialDeleteEntry?.sessionId,
      expectedSessionId,
    ];
    let drain: SessionLifecycleDrain | undefined;
    let deletedWorktreeId: string | undefined;
    let worktreePreserved: PreservedSessionWorktree | undefined;
    const deletion = await runExclusiveSessionLifecycleMutation({
      scope: storePath,
      identities: deleteLifecycleIdentities,
      prepare: async () => {
        const current = assertCurrent();
        if (
          p.expectedSessionUpdatedAt !== undefined &&
          current.entry?.updatedAt !== p.expectedSessionUpdatedAt
        ) {
          throw new SessionDeletionError(sessionChangedError());
        }
        try {
          drain = await prepareSessionLifecycleDrain({
            action: "delete",
            authorize: assertCurrent,
            context,
            storePath,
            sessionKeys: Array.from(new Set([key, target.canonicalKey, ...target.storeKeys])),
            sessionId: current.entry?.sessionId,
            sessionKey: target.canonicalKey,
            agentId: target.agentId,
            defaultAgentId: compatibilityDefaultAgentId,
            lifecycleIdentities: deleteLifecycleIdentities.filter((identity): identity is string =>
              Boolean(identity),
            ),
          });
        } catch (error) {
          assertCurrent();
          throw new SessionDeletionError(
            errorShape(
              ErrorCodes.UNAVAILABLE,
              `Session ${key} could not safely stop before deletion: ${formatErrorMessage(error)} Retry after active work or worker recovery finishes.`,
              { retryable: true },
            ),
          );
        }
      },
      run: async () => {
        const { entry, legacyKey, canonicalKey } = assertCurrent();
        const retirement = prepareSessionWorkerPlacementRetirement({
          context,
          sessionId: entry?.sessionId,
        });
        const commitGuard = () => {
          assertCurrent();
          retirement.assertCurrent();
          if (drain?.hasAuthoritativeWork()) {
            throw new SessionDeletionError(
              errorShape(ErrorCodes.UNAVAILABLE, `Session ${key} is still active; try again.`, {
                retryable: true,
              }),
            );
          }
        };
        commitGuard();
        const mutationCleanupError = await cleanupSessionBeforeMutation({
          cfg,
          key,
          target,
          entry,
          legacyKey,
          canonicalKey,
          reason: "session-delete",
          assertCurrent: commitGuard,
        });
        if (mutationCleanupError) {
          throw new SessionDeletionError(mutationCleanupError);
        }
        const postCleanupTarget = loadAccessorSessionEntryForGatewayTarget({
          key,
          cfg,
          ...(requestedAgentId ? { agentId: requestedAgentId } : {}),
        });
        const postCleanupEntry = postCleanupTarget.entry;
        deletedWorktreeId = normalizeOptionalString(postCleanupEntry?.worktree?.id);
        commitGuard();
        const pluginOwnerId = normalizeOptionalString(postCleanupEntry?.pluginOwnerId);
        const incognito =
          postCleanupEntry?.incognito === true || isIncognitoSessionKey(target.canonicalKey);
        const deletionParams = {
          agentId: target.agentId,
          archiveTranscript: incognito ? false : deleteTranscript,
          commitGuard,
          deleteDeliveryArtifacts: true,
          deleteTranscriptWithoutArchive: incognito,
          expectedEntry: postCleanupEntry,
          expectedLifecycleRevision,
          expectedSessionId: initialDeleteEntry?.sessionId ?? null,
          expectedUpdatedAt: postCleanupEntry?.updatedAt,
          storePath,
          target: { canonicalKey: target.canonicalKey, storeKeys: target.storeKeys },
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
          throw new SessionDeletionError(sessionChangedError());
        }
        if (result.deleted) {
          // Retain cloud affinity on every precommit failure. The absent-session
          // reconciler covers a crash or artifact-publication failure after commit.
          retirement.retire();
          emitGatewaySessionEndPluginHook({
            cfg,
            sessionKey: target.canonicalKey ?? key,
            sessionId: result.deletedSessionId,
            storePath,
            agentId: target.agentId,
            reason: "deleted",
            archivedTranscripts: result.archivedTranscripts,
          });
          await emitSessionUnboundLifecycleEvent({
            targetSessionKey: target.canonicalKey ?? key,
            reason: "session-delete",
            emitHooks: p.emitLifecycleHooks !== false,
          });
          // Hooks and unbinding retain their historical post-delete order. The
          // generation-scoped purge and checkout cleanup still finish before
          // this fence opens, so a same-key successor cannot be mistaken for it.
          const deletedSessionKey = target.canonicalKey ?? key;
          handleSessionStateSessionDeleted(
            deletedSessionKey,
            requestedAgentId ?? resolveSessionStoreAgentId(cfg, deletedSessionKey),
          );
          const deletedWorktree = deletedWorktreeId
            ? managedWorktrees.findLiveById(deletedWorktreeId)
            : undefined;
          if (deletedWorktree) {
            if (
              deletedWorktree.ownerKind !== "session" ||
              deletedWorktree.ownerId !== deletedSessionKey
            ) {
              worktreePreserved = {
                id: deletedWorktree.id,
                branch: deletedWorktree.branch,
                path: deletedWorktree.path,
                reason: "owner-mismatch",
              };
              sessionLog.warn(
                `refusing to clean up worktree ${deletedWorktree.id} for deleted session ${deletedSessionKey}: registry owner is ${deletedWorktree.ownerKind}${deletedWorktree.ownerId ? ` ${deletedWorktree.ownerId}` : ""}`,
              );
            } else {
              try {
                await managedWorktrees.remove({
                  id: deletedWorktree.id,
                  reason: "session-delete",
                });
              } catch (error) {
                sessionLog.warn(
                  `failed to clean up worktree for deleted session ${deletedSessionKey}: ${formatErrorMessage(error)}`,
                );
                const liveWorktree = managedWorktrees.findLiveById(deletedWorktree.id);
                if (liveWorktree) {
                  worktreePreserved = {
                    id: liveWorktree.id,
                    branch: liveWorktree.branch,
                    path: liveWorktree.path,
                    reason: classifyWorktreeRemovalError(error),
                  };
                }
              }
            }
          }
        }
        return result;
      },
      finalize: async () => {
        drain?.release();
      },
    }).catch((error: unknown) => {
      if (!(error instanceof SessionDeletionError)) {
        throw error;
      }
      respond(false, undefined, error.error);
      return undefined;
    });
    if (!deletion) {
      return;
    }
    const deleted = deletion.deleted;
    const archivedTranscripts = deletion.archivedTranscripts;
    const archived = archivedTranscripts.map((entryLocal) => entryLocal.archivedPath);

    const response: SessionsDeleteResult = {
      ok: true,
      key: target.canonicalKey,
      deleted,
      archived,
      ...(worktreePreserved ? { worktreePreserved } : {}),
    };
    respond(true, response, undefined);
    if (deleted) {
      emitSessionsChanged(context, {
        sessionKey: target.canonicalKey,
        sessionId: deletion.deletedSessionId,
        agentId: target.agentId,
        reason: "delete",
      });
      emitSessionsChanged(context, { reason: "delete" });
    }
  },
};
