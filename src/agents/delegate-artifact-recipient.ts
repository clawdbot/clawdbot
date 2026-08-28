import { executeSqliteQuerySync, executeSqliteQueryTakeFirstSync } from "../infra/kysely-sync.js";
import {
  runOpenClawStateWriteTransaction,
  type OpenClawStateDatabaseOptions,
} from "../state/openclaw-state-db.js";
import {
  artifactDb,
  auditOperation,
  ensureDelegateArtifactsSchema,
  resolveClaimForRecipient,
  toClaim,
  toDelegateArtifactSummaryV1,
  type DelegateArtifactOperationOutcome,
  type DelegateArtifactSummaryV1,
} from "./delegate-artifact-store.js";

export function listDelegateArtifactsForRecipient(params: {
  recipientSessionKey: string;
  recipientSessionId: string;
  runtimeEnabled: boolean;
  crossSessionEnabled: boolean;
  now?: number;
  options?: OpenClawStateDatabaseOptions;
}):
  | { outcome: "available"; artifacts: DelegateArtifactSummaryV1[] }
  | { outcome: Exclude<DelegateArtifactOperationOutcome, "available"> } {
  if (!params.runtimeEnabled) {
    return { outcome: "unauthorized" };
  }
  const options = params.options ?? {};
  ensureDelegateArtifactsSchema(options);
  return runOpenClawStateWriteTransaction(
    ({ db }) => {
      const kdb = artifactDb(db);
      const now = params.now ?? Date.now();
      const authorized = executeSqliteQueryTakeFirstSync(
        db,
        kdb
          .selectFrom("delegate_artifact_recipient_outcomes")
          .select("flow_id")
          .where("recipient_session_key", "=", params.recipientSessionKey)
          .where("recipient_session_id", "=", params.recipientSessionId)
          .where("outcome", "=", "available")
          .where("delivery_terminal_reason", "is", null)
          .where("delivery_acknowledged_at", "is not", null)
          .orderBy("flow_id")
          .limit(1),
      );
      if (!authorized) {
        auditOperation({
          db,
          action: "list",
          outcome: "unauthorized",
          recipientSessionKey: params.recipientSessionKey,
          recipientSessionId: params.recipientSessionId,
          now,
        });
        return { outcome: "unauthorized" };
      }
      const bindings = executeSqliteQuerySync(
        db,
        kdb
          .selectFrom("delegate_artifact_bindings")
          .select("claim_id")
          .where(
            "delegate_artifact_bindings.recipient_session_key",
            "=",
            params.recipientSessionKey,
          )
          .where("delegate_artifact_bindings.recipient_session_id", "=", params.recipientSessionId)
          .where("delegate_artifact_bindings.delivery_acknowledged_at", "is not", null)
          .orderBy("delegate_artifact_bindings.arrived_at")
          .orderBy("delegate_artifact_bindings.claim_id"),
      ).rows;
      const artifacts: DelegateArtifactSummaryV1[] = [];
      const unavailableOutcomes = new Set<Exclude<DelegateArtifactOperationOutcome, "available">>();
      for (const binding of bindings) {
        const resolved = resolveClaimForRecipient({
          db,
          claimId: binding.claim_id,
          recipientSessionKey: params.recipientSessionKey,
          recipientSessionId: params.recipientSessionId,
          crossSessionEnabled: params.crossSessionEnabled,
          now,
        });
        if (resolved.outcome !== "available") {
          unavailableOutcomes.add(resolved.outcome);
          continue;
        }
        artifacts.push(toDelegateArtifactSummaryV1(toClaim(resolved.claim)));
      }
      if (artifacts.length === 0) {
        const outcomePriority = [
          "corrupt",
          "unauthorized",
          "revoked",
          "missing",
          "expired",
        ] as const satisfies readonly Exclude<DelegateArtifactOperationOutcome, "available">[];
        const outcome = outcomePriority.find((candidate) => unavailableOutcomes.has(candidate));
        if (outcome) {
          auditOperation({
            db,
            action: "list",
            outcome,
            recipientSessionKey: params.recipientSessionKey,
            recipientSessionId: params.recipientSessionId,
            now,
          });
          return { outcome };
        }
      }
      auditOperation({
        db,
        action: "list",
        outcome: "available",
        recipientSessionKey: params.recipientSessionKey,
        recipientSessionId: params.recipientSessionId,
        now,
      });
      return {
        outcome: "available",
        artifacts,
      };
    },
    options,
    { operationLabel: "delegate-artifacts.list" },
  );
}

export function inspectDelegateArtifactForRecipient(params: {
  claimId: string;
  recipientSessionKey: string;
  recipientSessionId: string;
  runtimeEnabled: boolean;
  crossSessionEnabled: boolean;
  now?: number;
  options?: OpenClawStateDatabaseOptions;
}):
  | { outcome: "available"; artifact: DelegateArtifactSummaryV1 }
  | { outcome: Exclude<DelegateArtifactOperationOutcome, "available"> } {
  if (!params.runtimeEnabled) {
    return { outcome: "unauthorized" };
  }
  const options = params.options ?? {};
  ensureDelegateArtifactsSchema(options);
  return runOpenClawStateWriteTransaction(
    ({ db }) => {
      const resolved = resolveClaimForRecipient({
        db,
        claimId: params.claimId,
        recipientSessionKey: params.recipientSessionKey,
        recipientSessionId: params.recipientSessionId,
        crossSessionEnabled: params.crossSessionEnabled,
        now: params.now ?? Date.now(),
      });
      auditOperation({
        db,
        action: "inspect",
        outcome: resolved.outcome,
        claimId: params.claimId,
        ...("flowId" in resolved && resolved.flowId ? { flowId: resolved.flowId } : {}),
        recipientSessionKey: params.recipientSessionKey,
        recipientSessionId: params.recipientSessionId,
        now: params.now ?? Date.now(),
      });
      return resolved.outcome === "available"
        ? { outcome: "available", artifact: toDelegateArtifactSummaryV1(toClaim(resolved.claim)) }
        : { outcome: resolved.outcome };
    },
    options,
    { operationLabel: "delegate-artifacts.inspect" },
  );
}

export function readDelegateArtifactForMaterialization(params: {
  claimId: string;
  recipientSessionKey: string;
  recipientSessionId: string;
  runtimeEnabled: boolean;
  crossSessionEnabled: boolean;
  now?: number;
  options?: OpenClawStateDatabaseOptions;
}):
  | { outcome: "available"; bytes: Uint8Array }
  | { outcome: Exclude<DelegateArtifactOperationOutcome, "available"> } {
  if (!params.runtimeEnabled) {
    return { outcome: "unauthorized" };
  }
  const options = params.options ?? {};
  ensureDelegateArtifactsSchema(options);
  return runOpenClawStateWriteTransaction(
    ({ db }) => {
      const now = params.now ?? Date.now();
      const resolved = resolveClaimForRecipient({
        db,
        claimId: params.claimId,
        recipientSessionKey: params.recipientSessionKey,
        recipientSessionId: params.recipientSessionId,
        crossSessionEnabled: params.crossSessionEnabled,
        now,
      });
      auditOperation({
        db,
        action: "materialize-authorize",
        outcome: resolved.outcome,
        claimId: params.claimId,
        ...("flowId" in resolved && resolved.flowId ? { flowId: resolved.flowId } : {}),
        recipientSessionKey: params.recipientSessionKey,
        recipientSessionId: params.recipientSessionId,
        now,
      });
      if (resolved.outcome !== "available") {
        return { outcome: resolved.outcome };
      }
      if (resolved.claim.backing === null) {
        return { outcome: "corrupt" };
      }
      return { outcome: "available", bytes: Uint8Array.from(resolved.claim.backing) };
    },
    options,
    { operationLabel: "delegate-artifacts.materialize" },
  );
}

export function markDelegateArtifactMaterialized(params: {
  claimId: string;
  recipientSessionKey: string;
  recipientSessionId: string;
  runtimeEnabled: boolean;
  crossSessionEnabled: boolean;
  destination: string;
  now?: number;
  options?: OpenClawStateDatabaseOptions;
}): { outcome: DelegateArtifactOperationOutcome } {
  if (!params.runtimeEnabled) {
    return { outcome: "unauthorized" };
  }
  const options = params.options ?? {};
  ensureDelegateArtifactsSchema(options);
  return runOpenClawStateWriteTransaction(
    ({ db }) => {
      const now = params.now ?? Date.now();
      const resolved = resolveClaimForRecipient({
        db,
        claimId: params.claimId,
        recipientSessionKey: params.recipientSessionKey,
        recipientSessionId: params.recipientSessionId,
        crossSessionEnabled: params.crossSessionEnabled,
        now,
      });
      if (resolved.outcome === "available") {
        const kdb = artifactDb(db);
        executeSqliteQuerySync(
          db,
          kdb
            .updateTable("delegate_artifact_bindings")
            .set({ status: "materialized", materialized_at: now })
            .where("claim_id", "=", params.claimId)
            .where("recipient_session_key", "=", params.recipientSessionKey)
            .where("recipient_session_id", "=", params.recipientSessionId),
        );
      }
      auditOperation({
        db,
        action: "materialize",
        outcome: resolved.outcome,
        claimId: params.claimId,
        ...("flowId" in resolved && resolved.flowId ? { flowId: resolved.flowId } : {}),
        recipientSessionKey: params.recipientSessionKey,
        recipientSessionId: params.recipientSessionId,
        destination: params.destination,
        now,
      });
      return { outcome: resolved.outcome };
    },
    options,
    { operationLabel: "delegate-artifacts.materialize.commit" },
  );
}

export function discardDelegateArtifactForRecipient(params: {
  claimId: string;
  recipientSessionKey: string;
  recipientSessionId: string;
  runtimeEnabled: boolean;
  crossSessionEnabled: boolean;
  now?: number;
  options?: OpenClawStateDatabaseOptions;
}): { outcome: DelegateArtifactOperationOutcome } {
  if (!params.runtimeEnabled) {
    return { outcome: "unauthorized" };
  }
  const options = params.options ?? {};
  ensureDelegateArtifactsSchema(options);
  return runOpenClawStateWriteTransaction(
    ({ db }) => {
      const now = params.now ?? Date.now();
      const resolved = resolveClaimForRecipient({
        db,
        claimId: params.claimId,
        recipientSessionKey: params.recipientSessionKey,
        recipientSessionId: params.recipientSessionId,
        crossSessionEnabled: params.crossSessionEnabled,
        now,
      });
      if (resolved.outcome === "available") {
        const kdb = artifactDb(db);
        executeSqliteQuerySync(
          db,
          kdb
            .updateTable("delegate_artifact_bindings")
            .set({ status: "discarded", discarded_at: now })
            .where("claim_id", "=", params.claimId)
            .where("recipient_session_key", "=", params.recipientSessionKey)
            .where("recipient_session_id", "=", params.recipientSessionId),
        );
      }
      auditOperation({
        db,
        action: "discard",
        outcome: resolved.outcome,
        claimId: params.claimId,
        ...("flowId" in resolved && resolved.flowId ? { flowId: resolved.flowId } : {}),
        recipientSessionKey: params.recipientSessionKey,
        recipientSessionId: params.recipientSessionId,
        now,
      });
      return { outcome: resolved.outcome };
    },
    options,
    { operationLabel: "delegate-artifacts.discard" },
  );
}
