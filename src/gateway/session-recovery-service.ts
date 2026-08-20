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
import type { SessionCreatedActor } from "../config/sessions/session-entry-provenance.js";
import type { InternalSessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  isSessionWorkAdmissionActive,
  runExclusiveSessionLifecycleMutation,
} from "../sessions/session-lifecycle-admission.js";
import { recordSessionCreated } from "../sessions/session-state-events.js";
import { buildDashboardSessionKey } from "./session-create-service.js";
import { resolvePluginSessionOwnershipError } from "./session-plugin-ownership.js";
import { buildRestartRecoverySuccessorEntry } from "./session-recovery-entry.js";
import {
  loadGatewaySessionEntryReadOnly,
  resolveGatewaySessionStoreTarget,
} from "./session-utils.js";

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
  const initialSource = loadGatewaySessionEntryReadOnly(sourceTarget.canonicalKey, {
    agentId: sourceTarget.agentId,
  }).entry as InternalSessionEntry | undefined;
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
  const ownershipError = resolvePluginSessionOwnershipError({
    action: "recover",
    entry: initialSource,
    key: sourceTarget.canonicalKey,
    pluginOwnerId: params.authorizedPluginId,
  });
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
        identities: [sourceTarget.canonicalKey, initialSource.sessionId],
      },
      {
        scope: successorTarget.storePath,
        identities: [successorTarget.canonicalKey, successorSessionId],
      },
    ],
    run: async () => {
      const currentSource = loadGatewaySessionEntryReadOnly(sourceTarget.canonicalKey, {
        agentId: sourceTarget.agentId,
      }).entry as InternalSessionEntry | undefined;
      const currentOwnershipError = resolvePluginSessionOwnershipError({
        action: "recover",
        entry: currentSource,
        key: sourceTarget.canonicalKey,
        pluginOwnerId: params.authorizedPluginId,
      });
      if (currentOwnershipError) {
        return { ok: false as const, error: currentOwnershipError };
      }
      if (!currentSource?.sessionId) {
        return {
          ok: false as const,
          error: errorShape(
            ErrorCodes.INVALID_REQUEST,
            "Session changed before recovery; refresh and retry.",
          ),
        };
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
      const successorEntry = buildRestartRecoverySuccessorEntry({
        sessionId: successorSessionId,
        source: currentSource,
        ...(params.actor ? { actor: params.actor } : {}),
      });

      const result = await recoverSessionEntryFromRestartTombstone({
        agentId: sourceTarget.agentId,
        ...(params.actor ? { archivedBy: params.actor } : {}),
        ...(params.commitGuard ? { commitGuard: params.commitGuard } : {}),
        expected: {
          cycleId: recovery.cycleId,
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
