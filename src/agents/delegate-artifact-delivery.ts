import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { executeSqliteQuerySync, executeSqliteQueryTakeFirstSync } from "../infra/kysely-sync.js";
import {
  runOpenClawStateWriteTransaction,
  type OpenClawStateDatabaseOptions,
} from "../state/openclaw-state-db.js";
import {
  artifactDb,
  auditOperation,
  claimRowsForFlow,
  ensureDelegateArtifactsSchema,
  policyRequiresCrossSessionGate,
  projectionMatchesDurableFacts,
  projectionsForCompletedPolicy,
  type DelegateArtifactRecipientProjectionV1,
} from "./delegate-artifact-store.js";

export function recordDelegateArtifactDelivery(params: {
  projection: DelegateArtifactRecipientProjectionV1;
  phase: "attempt" | "replay" | "acknowledged";
  now?: number;
  options?: OpenClawStateDatabaseOptions;
}): void {
  recordDelegateArtifactDeliveryBinding({
    dispatchId: params.projection.arrivalContext.dispatchId,
    recipientSessionKey: params.projection.arrivalContext.binding.recipientSessionKey,
    recipientSessionId: params.projection.arrivalContext.binding.recipientSessionId,
    phase: params.phase,
    now: params.now,
    options: params.options,
    availability: params.projection.arrivalContext.availability,
  });
}

export type DelegateArtifactDeliveryPreparation =
  | { status: "ready"; projection: DelegateArtifactRecipientProjectionV1 }
  | { status: "acknowledged" }
  | { status: "deferred" }
  | { status: "unavailable" };

export function prepareDelegateArtifactDelivery(params: {
  projection: DelegateArtifactRecipientProjectionV1;
  runtimeEnabled: boolean;
  crossSessionEnabled: boolean;
  currentRecipientSessionId?: string;
  now?: number;
  options?: OpenClawStateDatabaseOptions;
}): DelegateArtifactDeliveryPreparation {
  if (!params.runtimeEnabled) {
    return { status: "deferred" };
  }
  const options = params.options ?? {};
  ensureDelegateArtifactsSchema(options);
  return runOpenClawStateWriteTransaction(
    ({ db }) => {
      const now = params.now ?? Date.now();
      const context = params.projection.arrivalContext;
      const markUnavailable = () => {
        markDelegateArtifactDeliveryUnavailableInTransaction({
          db,
          dispatchId: context.dispatchId,
          recipientSessionKey: context.binding.recipientSessionKey,
          recipientSessionId: context.binding.recipientSessionId,
          reason: "delivery-state-unavailable",
          now,
        });
        return { status: "unavailable" } as const;
      };
      const kdb = artifactDb(db);
      const policy = executeSqliteQueryTakeFirstSync(
        db,
        kdb
          .selectFrom("delegate_artifact_policies")
          .selectAll()
          .where("flow_id", "=", context.dispatchId),
      );
      if (
        !policy ||
        (policy.status !== "completed" && policy.status !== "failed") ||
        policy.completion_id !== context.completionId
      ) {
        return { status: "unavailable" } as const;
      }
      try {
        if (!params.crossSessionEnabled && policyRequiresCrossSessionGate(policy)) {
          return { status: "deferred" } as const;
        }
      } catch {
        return { status: "unavailable" } as const;
      }
      const recipientOutcome = executeSqliteQueryTakeFirstSync(
        db,
        kdb
          .selectFrom("delegate_artifact_recipient_outcomes")
          .selectAll()
          .where("flow_id", "=", context.dispatchId)
          .where("recipient_session_key", "=", context.binding.recipientSessionKey)
          .where("recipient_session_id", "=", context.binding.recipientSessionId),
      );
      if (
        recipientOutcome?.outcome !== "available" ||
        recipientOutcome.delivery_terminal_reason !== null
      ) {
        return recipientOutcome?.delivery_terminal_reason
          ? { status: "unavailable" }
          : markUnavailable();
      }
      if (recipientOutcome.delivery_acknowledged_at !== null) {
        return { status: "acknowledged" } as const;
      }
      if (params.currentRecipientSessionId !== context.binding.recipientSessionId) {
        markDelegateArtifactDeliveryUnavailableInTransaction({
          db,
          dispatchId: context.dispatchId,
          recipientSessionKey: context.binding.recipientSessionKey,
          recipientSessionId: context.binding.recipientSessionId,
          reason: "recipient-incarnation-changed",
          now,
        });
        return { status: "unavailable" } as const;
      }
      const claims = claimRowsForFlow(db, context.dispatchId).filter(
        (claim) => claim.status === "available",
      );
      const corruptBacking = claims.some(
        (claim) =>
          claim.backing === null ||
          claim.backing.byteLength !== claim.size_bytes ||
          createHash("sha256").update(claim.backing).digest("hex") !== claim.sha256,
      );
      if (policy.retention_deadline <= now || corruptBacking) {
        return markUnavailable();
      }
      const bindings = executeSqliteQuerySync(
        db,
        kdb
          .selectFrom("delegate_artifact_bindings")
          .innerJoin(
            "delegate_artifact_claims",
            "delegate_artifact_claims.claim_id",
            "delegate_artifact_bindings.claim_id",
          )
          .select([
            "delegate_artifact_bindings.claim_id",
            "delegate_artifact_bindings.status",
            "delegate_artifact_bindings.arrived_at",
          ])
          .where("delegate_artifact_claims.flow_id", "=", context.dispatchId)
          .where("recipient_session_key", "=", context.binding.recipientSessionKey)
          .where("recipient_session_id", "=", context.binding.recipientSessionId),
      ).rows;
      if (
        bindings.length !== claims.length ||
        bindings.some(
          (binding) => binding.status === "discarded" || binding.status === "unavailable",
        )
      ) {
        return markUnavailable();
      }
      const deliveredAt = recipientOutcome.first_delivery_at ?? now;
      const durableProjection = projectionsForCompletedPolicy({
        db,
        policy,
        deliveredAt,
        availability: policy.completion_disposition === "available" ? "available" : "unavailable",
      }).get(context.binding.recipientSessionKey);
      if (
        !durableProjection ||
        !projectionMatchesDurableFacts(params.projection, durableProjection)
      ) {
        return { status: "unavailable" } as const;
      }
      return {
        status: "ready",
        projection: durableProjection,
      } as const;
    },
    options,
    { operationLabel: "delegate-artifacts.delivery.prepare" },
  );
}

function markDelegateArtifactDeliveryUnavailableInTransaction(params: {
  db: DatabaseSync;
  dispatchId: string;
  recipientSessionKey: string;
  recipientSessionId: string;
  reason: string;
  now: number;
}): void {
  const kdb = artifactDb(params.db);
  executeSqliteQuerySync(
    params.db,
    kdb
      .updateTable("delegate_artifact_bindings")
      .set({ status: "unavailable", unavailable_reason: params.reason })
      .where(
        "claim_id",
        "in",
        kdb
          .selectFrom("delegate_artifact_claims")
          .select("claim_id")
          .where("flow_id", "=", params.dispatchId),
      )
      .where("recipient_session_key", "=", params.recipientSessionKey)
      .where("recipient_session_id", "=", params.recipientSessionId)
      .where("status", "in", ["available", "materialized"])
      .where("delivery_acknowledged_at", "is", null),
  );
  executeSqliteQuerySync(
    params.db,
    kdb
      .updateTable("delegate_artifact_recipient_outcomes")
      .set({ delivery_terminal_reason: params.reason })
      .where("flow_id", "=", params.dispatchId)
      .where("recipient_session_key", "=", params.recipientSessionKey)
      .where("recipient_session_id", "=", params.recipientSessionId)
      .where("delivery_acknowledged_at", "is", null),
  );
  auditOperation({
    db: params.db,
    action: "delivery-terminal",
    outcome: "unavailable",
    flowId: params.dispatchId,
    recipientSessionKey: params.recipientSessionKey,
    recipientSessionId: params.recipientSessionId,
    now: params.now,
  });
}

export function markDelegateArtifactDeliveryUnavailable(params: {
  dispatchId: string;
  recipientSessionKey: string;
  recipientSessionId: string;
  reason:
    | "recipient-incarnation-changed"
    | "recipient-no-longer-active"
    | "delivery-state-unavailable";
  now?: number;
  options?: OpenClawStateDatabaseOptions;
}): void {
  const options = params.options ?? {};
  ensureDelegateArtifactsSchema(options);
  runOpenClawStateWriteTransaction(
    ({ db }) =>
      markDelegateArtifactDeliveryUnavailableInTransaction({
        db,
        dispatchId: params.dispatchId,
        recipientSessionKey: params.recipientSessionKey,
        recipientSessionId: params.recipientSessionId,
        reason: params.reason,
        now: params.now ?? Date.now(),
      }),
    options,
    { operationLabel: "delegate-artifacts.delivery.unavailable" },
  );
}

export function recordDelegateArtifactDeliveryBinding(params: {
  dispatchId: string;
  recipientSessionKey: string;
  recipientSessionId: string;
  phase: "attempt" | "replay" | "acknowledged";
  now?: number;
  options?: OpenClawStateDatabaseOptions;
  availability?: "available" | "unavailable";
}): void {
  const options = params.options ?? {};
  ensureDelegateArtifactsSchema(options);
  runOpenClawStateWriteTransaction(
    ({ db }) => {
      const now = params.now ?? Date.now();
      const kdb = artifactDb(db);
      const recipientOutcome = executeSqliteQueryTakeFirstSync(
        db,
        kdb
          .selectFrom("delegate_artifact_recipient_outcomes")
          .selectAll()
          .where("flow_id", "=", params.dispatchId)
          .where("recipient_session_key", "=", params.recipientSessionKey)
          .where("recipient_session_id", "=", params.recipientSessionId),
      );
      if (
        !recipientOutcome ||
        recipientOutcome.outcome !== "available" ||
        recipientOutcome.delivery_terminal_reason !== null
      ) {
        throw new Error("delegate artifact delivery binding is unavailable");
      }
      if (params.phase === "acknowledged" && recipientOutcome.first_delivery_at === null) {
        throw new Error("delegate artifact delivery cannot be acknowledged before its attempt");
      }
      if (params.phase === "acknowledged" && recipientOutcome.delivery_acknowledged_at !== null) {
        return;
      }
      if (params.phase !== "acknowledged" && recipientOutcome.delivery_acknowledged_at !== null) {
        return;
      }
      if (params.phase === "attempt" && recipientOutcome.first_delivery_at !== null) {
        return;
      }
      executeSqliteQuerySync(
        db,
        kdb
          .updateTable("delegate_artifact_recipient_outcomes")
          .set(
            params.phase === "acknowledged"
              ? { delivery_acknowledged_at: now }
              : params.phase === "attempt"
                ? { first_delivery_at: now }
                : recipientOutcome.first_delivery_at === null
                  ? { first_delivery_at: now, replayed_at: now }
                  : { replayed_at: now },
          )
          .where("flow_id", "=", params.dispatchId)
          .where("recipient_session_key", "=", params.recipientSessionKey)
          .where("recipient_session_id", "=", params.recipientSessionId),
      );
      const bindings = executeSqliteQuerySync(
        db,
        kdb
          .selectFrom("delegate_artifact_bindings")
          .innerJoin(
            "delegate_artifact_claims",
            "delegate_artifact_claims.claim_id",
            "delegate_artifact_bindings.claim_id",
          )
          .select(["delegate_artifact_bindings.claim_id", "delegate_artifact_bindings.arrived_at"])
          .where("delegate_artifact_claims.flow_id", "=", params.dispatchId)
          .where(
            "delegate_artifact_bindings.recipient_session_key",
            "=",
            params.recipientSessionKey,
          )
          .where("delegate_artifact_bindings.recipient_session_id", "=", params.recipientSessionId),
      ).rows;
      for (const binding of bindings) {
        const update =
          params.phase === "acknowledged"
            ? { delivery_acknowledged_at: now }
            : params.phase === "attempt"
              ? { arrived_at: now, last_delivery_attempt_at: now }
              : binding.arrived_at === null
                ? { arrived_at: now, replayed_at: now, last_delivery_attempt_at: now }
                : { replayed_at: now, last_delivery_attempt_at: now };
        executeSqliteQuerySync(
          db,
          kdb
            .updateTable("delegate_artifact_bindings")
            .set(update)
            .where("claim_id", "=", binding.claim_id)
            .where("recipient_session_key", "=", params.recipientSessionKey)
            .where("recipient_session_id", "=", params.recipientSessionId),
        );
      }
      auditOperation({
        db,
        action:
          params.phase === "acknowledged"
            ? "delivery-acknowledged"
            : params.phase === "replay"
              ? "delivery-replay"
              : "delivery-attempt",
        outcome: params.availability ?? "available",
        flowId: params.dispatchId,
        recipientSessionKey: params.recipientSessionKey,
        recipientSessionId: params.recipientSessionId,
        now,
      });
    },
    options,
    { operationLabel: `delegate-artifacts.delivery.${params.phase}` },
  );
}
