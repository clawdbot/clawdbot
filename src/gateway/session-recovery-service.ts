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
import { createAgentRunDirectAbortError } from "../agents/run-termination.js";
import { recoverSessionEntryFromRestartTombstone } from "../config/sessions/session-accessor.js";
import {
  inheritSessionCreationPolicy,
  type SessionCreatedActor,
} from "../config/sessions/session-entry-provenance.js";
import type { InternalSessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { formatErrorMessage } from "../infra/errors.js";
import {
  closeSessionWorkAdmissions,
  isSessionWorkAdmissionActive,
  runExclusiveSessionLifecycleMutation,
} from "../sessions/session-lifecycle-admission.js";
import { normalizeSessionIdentities } from "../sessions/session-lifecycle-identity.js";
import { recordSessionCreated } from "../sessions/session-state-events.js";
import { resolveGlobalMap } from "../shared/global-singleton.js";
import { runQueuedStoreWrite, type StoreWriterQueue } from "../shared/store-writer-queue.js";
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
  prepareSessionWorkerPlacementMutationCheck,
  prepareSessionWorkerPlacementStop,
  type SessionWorkerPlacementContext,
} from "./worker-environments/session-placement-lifecycle.js";

export type SessionRecoveryContinuationOutcome = SessionsRecoverResult["continuation"];

const recoveryQueues = resolveGlobalMap<string, StoreWriterQueue>(
  Symbol.for("openclaw.sessionRecoveryQueues"),
);

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
  const recovery = initialSource.mainRestartRecovery;
  if (!recovery?.tombstone) {
    return {
      ok: false,
      error: errorShape(ErrorCodes.INVALID_REQUEST, "Session is not recoverable."),
    };
  }
  const generatedSuccessorKey = buildDashboardSessionKey(sourceTarget.agentId);
  const successorTarget = resolveGatewaySessionStoreTarget({
    cfg: params.cfg,
    key: generatedSuccessorKey,
    agentId: sourceTarget.agentId,
  });
  const successorSessionId = randomUUID();

  const resolveCurrentSource = () => {
    params.commitGuard?.();
    const currentSource = readSource();
    const currentOwnershipError = resolvePluginSessionOwnershipError({
      action: "recover",
      entry: currentSource,
      key: sourceTarget.canonicalKey,
      pluginOwnerId: params.authorizedPluginId,
    });
    if (currentOwnershipError) {
      return { ok: false as const, error: currentOwnershipError };
    }
    if (
      !currentSource?.sessionId ||
      currentSource.sessionId !== initialSource.sessionId ||
      currentSource.lifecycleRevision !== initialSource.lifecycleRevision ||
      currentSource.mainRestartRecovery?.cycleId !== recovery.cycleId ||
      (!currentSource.mainRestartRecovery.tombstone?.recoveredSessionKey &&
        currentSource.mainRestartRecovery.revision !== recovery.revision)
    ) {
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
    return { ok: true as const, source: currentSource };
  };
  const assertCurrent = () => {
    const current = resolveCurrentSource();
    if (!current.ok) {
      throw new Error(current.error.message);
    }
  };
  const sourceIdentities = [
    ...sourceTarget.storeKeys,
    sourceTarget.canonicalKey,
    initialSource.sessionId,
  ];
  const stopFailure = (error: unknown) =>
    errorShape(
      ErrorCodes.UNAVAILABLE,
      `Session recovery cannot safely stop/reclaim its cloud worker: ${formatErrorMessage(error)} Stop cloud worker or call sessions.reclaim, then retry recovery.`,
      { retryable: true },
    );
  const commitRecovery = async () => {
    let release = () => {};
    try {
      const prepared = await runExclusiveSessionLifecycleMutation({
        scope: sourceTarget.storePath,
        identities: sourceIdentities,
        run: async () => {
          const current = resolveCurrentSource();
          if (!current.ok) {
            return current;
          }
          let stop: (() => Promise<void>) | undefined;
          try {
            if (!current.source.mainRestartRecovery?.tombstone?.recoveredSessionKey) {
              stop = prepareSessionWorkerPlacementStop({
                action: "recover",
                agentId: sourceTarget.agentId,
                authorize: assertCurrent,
                context: params.workerPlacementContext,
                sessionId: initialSource.sessionId,
                sessionKey: sourceTarget.canonicalKey,
              });
            }
          } catch (error) {
            return { ok: false as const, error: stopFailure(error) };
          }
          // Reclaim may need both queues after this short exact-owner preflight.
          release = closeSessionWorkAdmissions({
            scope: sourceTarget.storePath,
            identities: sourceIdentities,
            reason: createAgentRunDirectAbortError(),
          });
          return { ...current, stop };
        },
      });
      if (!prepared.ok) {
        return prepared;
      }
      let assertPlacementCurrent: (() => void) | undefined;
      if (prepared.stop) {
        try {
          await prepared.stop();
          assertPlacementCurrent = prepareSessionWorkerPlacementMutationCheck({
            context: params.workerPlacementContext,
            sessionId: initialSource.sessionId,
          });
        } catch (error) {
          const current = resolveCurrentSource();
          return current.ok ? { ok: false as const, error: stopFailure(error) } : current;
        }
      }
      return await runExclusiveSessionLifecycleMutation({
        targets: [
          { scope: sourceTarget.storePath, identities: sourceIdentities },
          {
            scope: successorTarget.storePath,
            identities: [successorTarget.canonicalKey, successorSessionId],
          },
        ],
        prepare: async () => release(),
        run: async () => {
          const settled = resolveCurrentSource();
          if (!settled.ok) {
            return settled;
          }
          const currentSource = settled.source;
          const commitGuard = () => {
            assertCurrent();
            assertPlacementCurrent?.();
          };
          commitGuard();
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
            commitGuard,
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
    } finally {
      release();
    }
  };
  // Only recovery takes this queue: Move/reclaim can acquire their lifecycle fences.
  // Publish the successor before another recovery checks it; launch outside the queue.
  const committed = await runQueuedStoreWrite({
    queues: recoveryQueues,
    storePath: normalizeSessionIdentities(sourceTarget.storePath, [sourceTarget.canonicalKey])[0]!,
    label: "recoverGatewaySession",
    fn: commitRecovery,
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
