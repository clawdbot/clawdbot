import { randomUUID } from "node:crypto";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  ErrorCodes,
  errorShape,
  type ErrorShape,
  type SessionsRecoverResult,
} from "../../packages/gateway-protocol/src/index.js";
import { isEmbeddedAgentRunActive } from "../agents/embedded-agent.js";
import { inspectMainRestartRecoveryRolloverEligibility } from "../agents/main-session-recovery/main-session-recovery-state.js";
import { recoverSessionEntryFromRestartTombstone } from "../config/sessions/session-accessor.js";
import {
  inheritSessionCreationPolicy,
  type SessionCreatedActor,
} from "../config/sessions/session-entry-provenance.js";
import type { InternalSessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { formatErrorMessage } from "../infra/errors.js";
import {
  isSessionWorkAdmissionActive,
  runExclusiveSessionLifecycleMutation,
} from "../sessions/session-lifecycle-admission.js";
import { recordSessionCreated } from "../sessions/session-state-events.js";
import { authorizeGatewaySessionCreation, resolveCreatorSandbox } from "./operator-role-policy.js";
import type { GatewayOperatorRoleActor } from "./server-methods/shared-types.js";
import { buildDashboardSessionKey } from "./session-create-service.js";
import { resolvePluginSessionOwnershipError } from "./session-plugin-ownership.js";
import { buildRestartRecoverySuccessorEntry } from "./session-recovery-entry.js";
import {
  loadGatewaySessionEntryReadOnly,
  resolveGatewaySessionStoreTarget,
} from "./session-utils.js";
import {
  prepareSessionWorkerPlacementStop,
  type SessionWorkerPlacementContext,
} from "./worker-environments/session-placement-lifecycle.js";

export type SessionRecoveryContinuationOutcome = SessionsRecoverResult["continuation"];

type RecoverGatewaySessionResult =
  | {
      ok: true;
      agentId: string;
      created: boolean;
      sourceKey: string;
      successorEntry: InternalSessionEntry;
      successorKey: string;
      continuation: SessionRecoveryContinuationOutcome;
    }
  | { ok: false; error: ErrorShape };

function recoveryConflictError(reason: string): ErrorShape {
  const unavailable = reason === "successor-missing" || reason === "transcript-missing";
  return errorShape(
    unavailable ? ErrorCodes.UNAVAILABLE : ErrorCodes.INVALID_REQUEST,
    unavailable
      ? "Session recovery state is incomplete."
      : "Session changed before recovery; refresh and retry.",
    { details: { reason } },
  );
}

/** Owns explicit restart recovery from authorization through continuation launch. */
export async function recoverGatewaySession(params: {
  actor?: SessionCreatedActor;
  agentId?: string;
  authorizedPluginId?: string;
  cfg: OpenClawConfig;
  commitGuard?: () => void;
  key: string;
  requestingOperatorProfileId?: string;
  operatorRoleActor?: GatewayOperatorRoleActor;
  workerPlacementContext: SessionWorkerPlacementContext;
  launchContinuation: (params: {
    agentId: string;
    idempotencyKey: string;
    sessionId: string;
    sessionKey: string;
  }) => Promise<SessionRecoveryContinuationOutcome>;
}): Promise<RecoverGatewaySessionResult> {
  const sourceTarget = resolveGatewaySessionStoreTarget({
    cfg: params.cfg,
    key: params.key,
    ...(params.agentId ? { agentId: params.agentId } : {}),
  });
  const readSource = () =>
    loadGatewaySessionEntryReadOnly(sourceTarget.canonicalKey, {
      agentId: sourceTarget.agentId,
    }).entry as InternalSessionEntry | undefined;
  const initialSource = readSource();
  const checkOwnership = (entry: InternalSessionEntry | undefined) =>
    resolvePluginSessionOwnershipError({
      action: "recover",
      entry,
      key: sourceTarget.canonicalKey,
      pluginOwnerId: params.authorizedPluginId,
    });
  if (!initialSource?.sessionId) {
    return {
      ok: false,
      error: errorShape(ErrorCodes.INVALID_REQUEST, "Session recovery source was not found."),
    };
  }
  const initialEligibility = inspectMainRestartRecoveryRolloverEligibility(initialSource);
  if (!initialEligibility.eligible && initialEligibility.reason !== "already_recovered") {
    return {
      ok: false,
      error: errorShape(
        ErrorCodes.INVALID_REQUEST,
        "Session recovery requires a restart-tombstoned session.",
      ),
    };
  }
  const ownershipError = checkOwnership(initialSource);
  if (ownershipError) {
    return { ok: false, error: ownershipError };
  }

  const recovery = initialSource.mainRestartRecovery;
  if (!recovery?.tombstone) {
    return {
      ok: false,
      error: errorShape(ErrorCodes.INVALID_REQUEST, "Session is not recoverable."),
    };
  }
  if (!recovery.tombstone.recoveredSessionKey) {
    const creationError = authorizeGatewaySessionCreation({
      cfg: params.cfg,
      agentId: sourceTarget.agentId,
      ...(params.operatorRoleActor
        ? { actor: params.operatorRoleActor }
        : { profileId: params.requestingOperatorProfileId }),
    });
    if (creationError) {
      return { ok: false, error: creationError };
    }
  }
  const generatedSuccessorKey = buildDashboardSessionKey(sourceTarget.agentId);
  const successorTarget = resolveGatewaySessionStoreTarget({
    cfg: params.cfg,
    key: generatedSuccessorKey,
    agentId: sourceTarget.agentId,
  });
  const successorSessionId = randomUUID();

  const committed = await runExclusiveSessionLifecycleMutation({
    targets: [
      {
        scope: sourceTarget.storePath,
        identities: [...sourceTarget.storeKeys, sourceTarget.canonicalKey, initialSource.sessionId],
      },
      {
        scope: successorTarget.storePath,
        identities: [successorTarget.canonicalKey, successorSessionId],
      },
    ],
    run: async () => {
      let currentSource = readSource();
      const currentOwnershipError = checkOwnership(currentSource);
      if (currentOwnershipError) {
        return { ok: false as const, error: currentOwnershipError };
      }
      if (!currentSource?.sessionId) {
        return { ok: false as const, error: recoveryConflictError("source-changed") };
      }
      if (!currentSource.mainRestartRecovery?.tombstone?.recoveredSessionKey) {
        const creationError = authorizeGatewaySessionCreation({
          cfg: params.cfg,
          agentId: sourceTarget.agentId,
          ...(params.operatorRoleActor
            ? { actor: params.operatorRoleActor }
            : { profileId: params.requestingOperatorProfileId }),
        });
        if (creationError) {
          return { ok: false as const, error: creationError };
        }
      }
      if (
        isEmbeddedAgentRunActive(currentSource.sessionId) ||
        isSessionWorkAdmissionActive(sourceTarget.storePath, [
          sourceTarget.canonicalKey,
          currentSource.sessionId,
        ])
      ) {
        return {
          ok: false as const,
          error: errorShape(
            ErrorCodes.INVALID_REQUEST,
            "Session recovery is unavailable while the source still has active work.",
          ),
        };
      }
      const alreadyRecovered = currentSource.mainRestartRecovery?.tombstone?.recoveredSessionKey;
      const placement = params.workerPlacementContext.workerSessionPlacementService
        ?.getMany([currentSource.sessionId])
        .get(currentSource.sessionId);
      if (placement && !alreadyRecovered) {
        try {
          await prepareSessionWorkerPlacementStop({
            action: "recover",
            agentId: sourceTarget.agentId,
            ...(params.commitGuard ? { authorize: params.commitGuard } : {}),
            context: params.workerPlacementContext,
            sessionId: currentSource.sessionId,
            sessionKey: sourceTarget.canonicalKey,
          })();
        } catch (error) {
          params.commitGuard?.();
          return {
            ok: false as const,
            error: errorShape(
              ErrorCodes.UNAVAILABLE,
              `Session recovery cannot safely stop/reclaim its cloud worker: ${formatErrorMessage(error)} Stop cloud worker or call sessions.reclaim, then retry recovery.`,
              { retryable: true },
            ),
          };
        }
        params.commitGuard?.();
        const settledSource = readSource();
        if (
          settledSource?.sessionId !== currentSource.sessionId ||
          settledSource.lifecycleRevision !== currentSource.lifecycleRevision
        ) {
          return { ok: false as const, error: recoveryConflictError("source-changed") };
        }
        const settledOwnershipError = checkOwnership(settledSource);
        if (settledOwnershipError) {
          return { ok: false as const, error: settledOwnershipError };
        }
        currentSource = settledSource;
      }
      const successorEntry = buildRestartRecoverySuccessorEntry({
        sessionId: successorSessionId,
        source: currentSource,
        // Authenticated recovery creates a new person's session; actorless recovery
        // continues the source's immutable isolation instead of dropping it.
        creation: params.actor
          ? { actor: params.actor, sandbox: resolveCreatorSandbox(params.cfg, params) }
          : inheritSessionCreationPolicy(currentSource),
      });

      const result = await recoverSessionEntryFromRestartTombstone({
        agentId: sourceTarget.agentId,
        ...(params.actor ? { archivedBy: params.actor } : {}),
        ...(params.commitGuard ? { commitGuard: params.commitGuard } : {}),
        expected: {
          cycleId: recovery.cycleId,
          lifecycleRevision: initialSource.lifecycleRevision,
          revision: recovery.revision,
          sessionId: initialSource.sessionId,
          ...(normalizeOptionalString(initialSource.pluginOwnerId)
            ? { pluginOwnerId: initialSource.pluginOwnerId }
            : {}),
        },
        sourceTarget,
        storePath: sourceTarget.storePath,
        successorEntry,
        successorTarget,
      });
      if (result.status === "conflict") {
        return { ok: false as const, error: recoveryConflictError(result.reason) };
      }
      return {
        ok: true as const,
        created: result.status === "created",
        successorEntry: result.successorEntry as InternalSessionEntry,
        successorKey: result.successorKey,
      };
    },
  });
  if (!committed.ok) {
    return committed;
  }

  if (committed.created) {
    recordSessionCreated({
      sessionKey: committed.successorKey,
      entry: committed.successorEntry,
      agentId: sourceTarget.agentId,
    });
  }
  const continuation = await params.launchContinuation({
    agentId: sourceTarget.agentId,
    idempotencyKey: `restart-recovery-rollover:${committed.successorEntry.sessionId}`,
    sessionId: committed.successorEntry.sessionId,
    sessionKey: committed.successorKey,
  });
  return {
    ok: true,
    agentId: sourceTarget.agentId,
    created: committed.created,
    sourceKey: sourceTarget.canonicalKey,
    successorEntry: committed.successorEntry,
    successorKey: committed.successorKey,
    continuation,
  };
}
