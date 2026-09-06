import { err, ok, type Result } from "@openclaw/normalization-core/result";
import {
  ErrorCodes,
  errorShape,
  type ErrorShape,
  type SessionCreatedActor,
  type SessionsPatchParams,
} from "../../../packages/gateway-protocol/src/index.js";
import type { ModelCatalogEntry } from "../../agents/model-catalog.js";
import type { SessionEntry } from "../../config/sessions.js";
import type { SessionAccessScope } from "../../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { resolveMissingAgentHarnessSessionError } from "../../sessions/agent-harness-session-key.js";
import {
  SessionWorktreeLifecycleError,
  synchronizeSessionWorktreeArchive,
} from "../../sessions/session-worktree-lifecycle.js";
import type { UserModelAccountSelection } from "../model-account-authority.js";
import { ModelAccountConnectAuthorityError } from "../model-account-connect.js";
import { resolvePluginSessionOwnershipError } from "../session-plugin-ownership.js";
import { tryResolveSessionCompatibilityOwnerAgentId } from "../session-request-agent.js";
import { SessionMutationAuthorizationChangedError } from "../session-sharing.js";
import {
  resolveCanonicalGatewaySessionStoreKey,
  resolveGatewaySessionStoreTargetWithStore,
} from "../session-utils.js";
import { projectSessionsPatchEntry } from "../sessions-patch.js";
import { prepareSessionWorkerPlacementMutationCheck } from "../worker-environments/session-placement-lifecycle.js";
import {
  prepareSessionLifecycleDrain,
  type SessionLifecycleDrain,
} from "./sessions-lifecycle-drain.js";
import {
  sessionChangedError as archiveChangedError,
  unexpectedPatchError,
} from "./sessions-patch-errors.js";
import {
  isAgentMainSessionKey,
  resolveSessionWorkerPlacementPatchError,
  sessionLog,
} from "./sessions-shared.js";
import type { GatewayRequestContext } from "./types.js";

export type SessionPatchArchivePreparation = {
  canonicalKey: string;
  drain: SessionLifecycleDrain;
  entry?: SessionEntry;
};

export function releaseSessionPatchArchive(preparation?: SessionPatchArchivePreparation): void {
  try {
    preparation?.drain.release();
  } catch (error) {
    sessionLog.warn(
      `sessions.patch: archive drain release failed for ${preparation?.canonicalKey}: ${formatErrorMessage(error)}`,
    );
  }
}

export type SessionPatchArchiveTarget = {
  archiveActor: SessionCreatedActor | undefined;
  canonicalKey: string;
  fullPatch: SessionsPatchParams;
  initialEntry?: SessionEntry;
  initialStoreKeys: string[];
  key: string;
  lifecycleIdentities: Array<string | undefined>;
  requestedAgentId?: string;
  storePath: string;
};

function archiveUnavailableError(key: string, message: "active" | "stopping"): ErrorShape {
  return errorShape(
    ErrorCodes.UNAVAILABLE,
    message === "active"
      ? `Session ${key} is still active; retry the archive.`
      : `Session ${key} did not finish stopping; retry the archive.`,
    { retryable: true },
  );
}

function protectedArchiveError(cfg: OpenClawConfig, canonicalKey: string): ErrorShape | undefined {
  if (canonicalKey === "unknown") {
    return errorShape(ErrorCodes.INVALID_REQUEST, "Cannot archive the unknown session sentinel.");
  }
  if (canonicalKey === "global" || isAgentMainSessionKey(cfg, canonicalKey)) {
    return errorShape(ErrorCodes.INVALID_REQUEST, "Cannot archive an agent's main session.");
  }
  return undefined;
}

function archiveTargetChanged(params: {
  baselineEntry: SessionEntry | undefined;
  currentEntry: SessionEntry | undefined;
  patch: SessionsPatchParams;
}): boolean {
  const { baselineEntry, currentEntry, patch } = params;
  const expectedSessionChanged =
    (patch.expectedSessionId !== undefined &&
      currentEntry?.sessionId !== patch.expectedSessionId) ||
    (patch.expectedLifecycleRevision !== undefined &&
      currentEntry?.lifecycleRevision !== patch.expectedLifecycleRevision);
  const generationChanged =
    baselineEntry !== undefined &&
    currentEntry !== undefined &&
    (currentEntry.sessionId !== baselineEntry.sessionId ||
      currentEntry.lifecycleRevision !== baselineEntry.lifecycleRevision);
  return (
    expectedSessionChanged ||
    (baselineEntry !== undefined && currentEntry === undefined) ||
    (baselineEntry === undefined && currentEntry !== undefined) ||
    generationChanged
  );
}

export async function prepareSessionPatchArchive(params: {
  commitGuard: () => ErrorShape | undefined;
  cfg: OpenClawConfig;
  context: GatewayRequestContext;
  loadGatewayModelCatalog: () => Promise<ModelCatalogEntry[]>;
  personalModelSelection?: UserModelAccountSelection;
  pluginOwnerId?: string;
  target: SessionPatchArchiveTarget;
}): Promise<Result<SessionPatchArchivePreparation, ErrorShape>> {
  const { cfg, target } = params;
  const resolveCurrent = (): Result<
    {
      freshResolved: ReturnType<typeof resolveGatewaySessionStoreTargetWithStore>;
      fresh: ReturnType<typeof resolveCanonicalGatewaySessionStoreKey>;
      freshCanonicalKey: string;
    },
    ErrorShape
  > => {
    const freshResolved = resolveGatewaySessionStoreTargetWithStore({
      cfg,
      key: target.key,
      ...(target.requestedAgentId ? { agentId: target.requestedAgentId } : {}),
      exactRead: true,
    });
    if (freshResolved.storePath !== target.storePath) {
      return err(archiveChangedError(target.key));
    }
    const fresh = resolveCanonicalGatewaySessionStoreKey({
      cfg,
      key: target.key,
      store: freshResolved.store,
      agentId: target.requestedAgentId,
    });
    const freshCanonicalKey = fresh.target.canonicalKey ?? target.key;
    const ownershipError = resolvePluginSessionOwnershipError({
      action: "patch",
      entry: fresh.entry,
      key: freshCanonicalKey,
      pluginOwnerId: params.pluginOwnerId,
    });
    if (ownershipError) {
      return err(ownershipError);
    }
    if (
      freshCanonicalKey !== target.canonicalKey ||
      archiveTargetChanged({
        currentEntry: fresh.entry,
        baselineEntry: target.initialEntry,
        patch: target.fullPatch,
      })
    ) {
      return err(archiveChangedError(target.key));
    }
    const missingHarnessSessionError = resolveMissingAgentHarnessSessionError(
      freshCanonicalKey,
      fresh.entry,
    );
    if (missingHarnessSessionError) {
      return err(errorShape(ErrorCodes.INVALID_REQUEST, missingHarnessSessionError));
    }
    const protectedError = protectedArchiveError(cfg, freshCanonicalKey);
    if (protectedError) {
      return err(protectedError);
    }
    const placementError = resolveSessionWorkerPlacementPatchError({
      agentId: freshResolved.agentId,
      cfg,
      context: params.context,
      entry: fresh.entry,
      key: target.key,
      patch: target.fullPatch,
      sessionKey: freshCanonicalKey,
      validateModelRuntime: false,
    });
    if (placementError) {
      return err(errorShape(ErrorCodes.INVALID_REQUEST, placementError));
    }
    return ok({ freshResolved, fresh, freshCanonicalKey });
  };
  const resolved = resolveCurrent();
  if (!resolved.ok) {
    return resolved;
  }
  const { freshResolved, fresh, freshCanonicalKey } = resolved.value;
  const assertCurrent = () => {
    params.personalModelSelection?.assertCurrent();
    const authorizationError = params.commitGuard();
    if (authorizationError) {
      throw new SessionMutationAuthorizationChangedError(authorizationError);
    }
    const current = resolveCurrent();
    if (!current.ok) {
      throw new SessionMutationAuthorizationChangedError(current.error);
    }
  };
  const freshCandidateKeys = new Set(fresh.target.storeKeys);
  const preview = await projectSessionsPatchEntry({
    cfg,
    existingEntry: fresh.entry,
    isLabelInUse: (label) =>
      Object.entries(freshResolved.store).some(
        ([sessionKey, entry]) => !freshCandidateKeys.has(sessionKey) && entry.label === label,
      ),
    storeKey: fresh.primaryKey,
    agentId: target.requestedAgentId,
    patch: target.fullPatch,
    archivedBy: target.archiveActor,
    loadGatewayModelCatalog: params.loadGatewayModelCatalog,
    personalModelSelection: params.personalModelSelection,
  });
  if (!preview.ok) {
    return err(preview.error);
  }
  const previewPlacementError = resolveSessionWorkerPlacementPatchError({
    agentId: freshResolved.agentId,
    cfg,
    context: params.context,
    entry: preview.entry,
    key: target.key,
    patch: target.fullPatch,
    sessionKey: freshCanonicalKey,
    validateModelRuntime: true,
  });
  if (previewPlacementError) {
    return err(errorShape(ErrorCodes.INVALID_REQUEST, previewPlacementError));
  }
  try {
    const drain = await prepareSessionLifecycleDrain({
      action: "archive",
      authorize: assertCurrent,
      context: params.context,
      storePath: target.storePath,
      sessionKeys: Array.from(
        new Set([
          target.key,
          target.canonicalKey,
          ...target.initialStoreKeys,
          freshCanonicalKey,
          ...fresh.target.storeKeys,
        ]),
      ),
      sessionId: fresh.entry?.sessionId,
      sessionKey: freshCanonicalKey,
      agentId: freshResolved.agentId,
      defaultAgentId: tryResolveSessionCompatibilityOwnerAgentId(cfg, freshCanonicalKey),
      lifecycleIdentities: target.lifecycleIdentities.filter((identity): identity is string =>
        Boolean(identity),
      ),
    });
    return ok({
      canonicalKey: freshCanonicalKey,
      drain,
      ...(fresh.entry ? { entry: fresh.entry } : {}),
    });
  } catch (error) {
    if (
      error instanceof SessionMutationAuthorizationChangedError ||
      error instanceof ModelAccountConnectAuthorityError
    ) {
      return err(unexpectedPatchError(target.key, error));
    }
    sessionLog.warn(
      `sessions.patch: archive drain failed for ${target.canonicalKey}: ${formatErrorMessage(error)}`,
    );
    return err(archiveUnavailableError(target.key, "stopping"));
  }
}

export function validateSessionPatchArchiveProjection(params: {
  cfg: OpenClawConfig;
  existingEntry: SessionEntry | undefined;
  fullPatch: SessionsPatchParams;
  key: string;
  pluginOwnerId?: string;
  preparation: SessionPatchArchivePreparation;
  primaryKey: string;
}): ErrorShape | undefined {
  if (params.preparation.drain.hasAuthoritativeWork()) {
    return archiveUnavailableError(params.key, "active");
  }
  if (
    params.primaryKey !== params.preparation.canonicalKey ||
    archiveTargetChanged({
      currentEntry: params.existingEntry,
      baselineEntry: params.preparation.entry,
      patch: params.fullPatch,
    })
  ) {
    return archiveChangedError(params.key);
  }
  return (
    protectedArchiveError(params.cfg, params.primaryKey) ??
    resolvePluginSessionOwnershipError({
      action: "patch",
      entry: params.existingEntry,
      key: params.primaryKey,
      pluginOwnerId: params.pluginOwnerId,
    })
  );
}

/** Restore before opening admission; remove only after archive metadata is durable. */
export async function prepareSessionPatchWorktreeTransition(params: {
  archived: boolean;
  entry: SessionEntry;
  context: GatewayRequestContext;
  scope: SessionAccessScope;
  authorize: () => ErrorShape | undefined;
  preparation?: SessionPatchArchivePreparation;
}): Promise<{
  assertCommitAllowed: () => void;
  afterCommit?: (entry: SessionEntry) => Promise<ErrorShape | undefined>;
}> {
  const assertPlacementCurrent = prepareSessionWorkerPlacementMutationCheck({
    context: params.context,
    sessionId: params.entry.sessionId,
  });
  const commitGuard = () => {
    const authorizationError = params.authorize();
    if (authorizationError) {
      throw new SessionMutationAuthorizationChangedError(authorizationError);
    }
    assertPlacementCurrent();
    if (params.preparation?.drain.hasAuthoritativeWork()) {
      throw new SessionWorktreeLifecycleError(
        "Session worktree is still active; retry the archive after work settles.",
        "busy",
      );
    }
  };
  const synchronize = (entry: SessionEntry) =>
    synchronizeSessionWorktreeArchive({
      archived: params.archived,
      entry,
      scope: params.scope,
      commitGuard,
    });
  // Carry the exact restored binding through the later metadata commit.
  const assertCommitAllowed = params.archived ? commitGuard : await synchronize(params.entry);
  return {
    assertCommitAllowed,
    afterCommit: params.archived
      ? async (entry) => {
          try {
            // The durable archive row hands failed cleanup to GC. Keep the lifecycle
            // fence and compare the exact committed projection, never a fresh successor.
            await synchronize(entry);
            return undefined;
          } catch (error) {
            const cleanupError = unexpectedPatchError(params.scope.sessionKey, error);
            return errorShape(
              ErrorCodes.UNAVAILABLE,
              `Session archived, but worktree cleanup did not finish. ${cleanupError.message} Retry archive after resolving the cleanup condition; garbage collection will also retry.`,
              // Deferred self-archive must stop retrying an already committed archive.
              { retryable: false },
            );
          }
        }
      : undefined,
  };
}
