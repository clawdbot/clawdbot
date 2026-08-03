import { executeSqliteQuerySync, executeSqliteQueryTakeFirstSync } from "../infra/kysely-sync.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
  type OpenClawStateDatabaseOptions,
} from "../state/openclaw-state-db.js";
import {
  ALLOWED_MIME_PATTERNS,
  artifactDb,
  DELEGATE_ARTIFACT_MAX_BYTES,
  DELEGATE_ARTIFACT_MAX_COUNT,
  DELEGATE_ARTIFACT_MAX_TOTAL_BYTES,
  DELEGATE_ARTIFACT_OUTPUT_ROOT,
  DELEGATE_ARTIFACT_PURGE_BATCH_SIZE,
  DELEGATE_ARTIFACT_RETENTION_MS,
  ensureDelegateArtifactsSchema,
  RecipientsSchema,
  RouteSchema,
  type DelegateArtifactPolicyV1,
} from "./delegate-artifact-store.js";

export function createDelegateArtifactPolicy(
  policy: DelegateArtifactPolicyV1,
  options: OpenClawStateDatabaseOptions = {},
): void {
  const recipients = RecipientsSchema.parse(policy.recipients);
  const route = RouteSchema.parse(policy.route);
  ensureDelegateArtifactsSchema(options);
  runOpenClawStateWriteTransaction(
    ({ db }) => {
      const kdb = artifactDb(db);
      const existing = executeSqliteQueryTakeFirstSync(
        db,
        kdb
          .selectFrom("delegate_artifact_policies")
          .selectAll()
          .where("flow_id", "=", policy.flowId),
      );
      const recipientsJson = JSON.stringify(recipients);
      const routeJson = JSON.stringify(route);
      const dispatchAcceptedAt =
        existing?.dispatch_accepted_at ?? policy.dispatchAcceptedAt ?? Date.now();
      if (existing) {
        const immutableMatch =
          existing.producer_session_key === policy.producerSessionKey &&
          existing.producer_session_id === (policy.producerSessionId ?? null) &&
          existing.producer_run_id === policy.producerRunId &&
          existing.origin_parent_session_key === policy.originParentSessionKey &&
          existing.origin_parent_session_id === policy.originParentSessionId &&
          existing.dispatch_revision === policy.dispatchRevision &&
          existing.dispatch_accepted_at === dispatchAcceptedAt &&
          existing.scheduled_at === (policy.scheduledAt ?? null) &&
          existing.not_before === (policy.notBefore ?? null) &&
          existing.artifact_mode === policy.artifactMode &&
          existing.recipient_context === (policy.recipientContext ?? null) &&
          existing.recipients_json === recipientsJson &&
          existing.route_json === routeJson;
        if (!immutableMatch) {
          throw new Error("delegate artifact policy replay did not match accepted dispatch");
        }
        return;
      }
      executeSqliteQuerySync(
        db,
        kdb.insertInto("delegate_artifact_policies").values({
          flow_id: policy.flowId,
          producer_session_key: policy.producerSessionKey,
          producer_session_id: policy.producerSessionId ?? null,
          producer_run_id: policy.producerRunId,
          origin_parent_session_key: policy.originParentSessionKey,
          origin_parent_session_id: policy.originParentSessionId,
          policy_version: 1,
          dispatch_revision: policy.dispatchRevision,
          dispatch_accepted_at: dispatchAcceptedAt,
          scheduled_at: policy.scheduledAt ?? null,
          not_before: policy.notBefore ?? null,
          artifact_mode: policy.artifactMode,
          recipient_context: policy.recipientContext ?? null,
          recipients_json: recipientsJson,
          route_json: routeJson,
          output_root: DELEGATE_ARTIFACT_OUTPUT_ROOT,
          max_artifact_count: DELEGATE_ARTIFACT_MAX_COUNT,
          max_artifact_bytes: DELEGATE_ARTIFACT_MAX_BYTES,
          max_total_bytes: DELEGATE_ARTIFACT_MAX_TOTAL_BYTES,
          allowed_mimes_json: JSON.stringify(ALLOWED_MIME_PATTERNS),
          retention_deadline:
            Math.max(dispatchAcceptedAt, policy.notBefore ?? dispatchAcceptedAt) +
            DELEGATE_ARTIFACT_RETENTION_MS,
          status: "active",
          completion_id: null,
          completion_finalization_key: null,
          completed_at: null,
          completion_status: null,
          completion_delivery_mode: null,
          completion_disposition: null,
        }),
      );
    },
    options,
    { operationLabel: "delegate-artifacts.policy.create" },
  );
}

export function isDelegateArtifactReturnConfigured(
  producerRunId: string,
  options: OpenClawStateDatabaseOptions = {},
): boolean {
  ensureDelegateArtifactsSchema(options);
  const { db } = openOpenClawStateDatabase(options);
  return Boolean(
    executeSqliteQueryTakeFirstSync(
      db,
      artifactDb(db)
        .selectFrom("delegate_artifact_policies")
        .select("flow_id")
        .where("producer_run_id", "=", producerRunId),
    ),
  );
}

export class MissingDelegateArtifactPolicyError extends Error {
  constructor() {
    super("artifact-capable continuation dispatch has no accepted policy");
    this.name = "MissingDelegateArtifactPolicyError";
  }
}

export class UnavailableDelegateArtifactPolicyError extends Error {
  constructor() {
    super("artifact-capable continuation dispatch policy is inactive or expired");
    this.name = "UnavailableDelegateArtifactPolicyError";
  }
}

export function assertDelegateArtifactPolicyPrepared(
  flowId: string,
  options: OpenClawStateDatabaseOptions = {},
): void {
  ensureDelegateArtifactsSchema(options);
  const { db } = openOpenClawStateDatabase(options);
  const policy = executeSqliteQueryTakeFirstSync(
    db,
    artifactDb(db)
      .selectFrom("delegate_artifact_policies")
      .select(["flow_id", "status", "retention_deadline"])
      .where("flow_id", "=", flowId),
  );
  if (!policy) {
    throw new MissingDelegateArtifactPolicyError();
  }
  if (policy.status !== "active" || policy.retention_deadline <= Date.now()) {
    throw new UnavailableDelegateArtifactPolicyError();
  }
}

/**
 * Whether a completion has been recorded for the managed child bound to this
 * flow under the expected producer session. The live subagent registry cannot
 * answer once the child has ended or the process restarted, so this durable
 * binding is what keeps a re-drive from reporting a genuinely completed child
 * as a spawn failure. `completed_at` is written by the same statement that
 * leaves a policy `completed`, `failed`, or (finalization deferred by a runtime
 * disable) `staged`, and an `active` policy has none.
 */
export function hasRecordedDelegateArtifactCompletionForProducer(
  params: { flowId: string; producerSessionKey: string },
  options: OpenClawStateDatabaseOptions = {},
): boolean {
  ensureDelegateArtifactsSchema(options);
  const { db } = openOpenClawStateDatabase(options);
  const policy = executeSqliteQueryTakeFirstSync(
    db,
    artifactDb(db)
      .selectFrom("delegate_artifact_policies")
      .select(["completed_at", "producer_session_key"])
      .where("flow_id", "=", params.flowId),
  );
  return policy?.completed_at != null && policy.producer_session_key === params.producerSessionKey;
}

export function removeUnacceptedDelegateArtifactPolicy(
  flowId: string,
  options: OpenClawStateDatabaseOptions = {},
): void {
  ensureDelegateArtifactsSchema(options);
  runOpenClawStateWriteTransaction(
    ({ db }) => {
      const kdb = artifactDb(db);
      const policy = executeSqliteQueryTakeFirstSync(
        db,
        kdb
          .selectFrom("delegate_artifact_policies")
          .select(["status", "producer_session_id"])
          .where("flow_id", "=", flowId),
      );
      if (!policy) {
        return;
      }
      const claim = executeSqliteQueryTakeFirstSync(
        db,
        kdb
          .selectFrom("delegate_artifact_claims")
          .select("claim_id")
          .where("flow_id", "=", flowId)
          .limit(1),
      );
      if (policy.status !== "active" || policy.producer_session_id !== null || claim) {
        return;
      }
      executeSqliteQuerySync(
        db,
        kdb.deleteFrom("delegate_artifact_policies").where("flow_id", "=", flowId),
      );
    },
    options,
    { operationLabel: "delegate-artifacts.policy.remove-unaccepted" },
  );
}

export function purgeExpiredDelegateArtifacts(
  now: number = Date.now(),
  options: OpenClawStateDatabaseOptions = {},
): number {
  ensureDelegateArtifactsSchema(options);
  return runOpenClawStateWriteTransaction(
    ({ db }) => {
      const kdb = artifactDb(db);
      const expiredPolicies = executeSqliteQuerySync(
        db,
        kdb
          .selectFrom("delegate_artifact_policies")
          .innerJoin(
            "delegate_artifact_claims",
            "delegate_artifact_claims.flow_id",
            "delegate_artifact_policies.flow_id",
          )
          .select("delegate_artifact_policies.flow_id")
          .distinct()
          .where("delegate_artifact_policies.retention_deadline", "<=", now)
          .where("delegate_artifact_claims.status", "!=", "purged")
          .limit(DELEGATE_ARTIFACT_PURGE_BATCH_SIZE),
      ).rows;
      for (const policy of expiredPolicies) {
        executeSqliteQuerySync(
          db,
          kdb
            .updateTable("delegate_artifact_claims")
            .set({ status: "purged", backing: null })
            .where("flow_id", "=", policy.flow_id)
            .where("status", "in", [
              "pending",
              "staged",
              "available",
              "expired",
              "revoked",
              "orphaned",
            ]),
        );
      }
      return expiredPolicies.length;
    },
    options,
    { operationLabel: "delegate-artifacts.purge" },
  );
}
