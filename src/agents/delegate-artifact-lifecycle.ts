import { createHash } from "node:crypto";
import { executeSqliteQuerySync, executeSqliteQueryTakeFirstSync } from "../infra/kysely-sync.js";
import { generateSecureUuid } from "../infra/secure-random.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
  type OpenClawStateDatabaseOptions,
} from "../state/openclaw-state-db.js";
import {
  artifactDb,
  claimRowsForFlow,
  classifyArtifact,
  ensureDelegateArtifactsSchema,
  isAllowedMime,
  parseAllowedMimePatterns,
  parseRecipients,
  parseRoute,
  policyRequiresCrossSessionGate,
  projectionsForCompletedPolicy,
  toClaim,
  toDelegateArtifactSummaryV1,
  type DelegateArtifactRecipientProjectionV1,
  type DelegateArtifactRecipientV1,
  type DelegateArtifactRouteV1,
} from "./delegate-artifact-store.js";

export type DelegateArtifactPublicationCandidate = {
  bytes: Uint8Array;
  mimeType: string;
};

export type DelegateArtifactPublicationResult =
  | { status: "published"; count: number }
  | {
      status: "rejected";
      reason:
        | "forbidden"
        | "runtime_disabled"
        | "invalid_candidate"
        | "policy_limit"
        | "policy_expired";
    };

export function publishDelegateArtifactCandidates(params: {
  producerSessionKey: string;
  producerSessionId: string;
  producerRunId: string;
  publicationKey: string;
  candidates: DelegateArtifactPublicationCandidate[];
  runtimeEnabled: boolean;
  crossSessionEnabled: boolean;
  now?: number;
  options?: OpenClawStateDatabaseOptions;
}): DelegateArtifactPublicationResult {
  const now = params.now ?? Date.now();
  if (!params.runtimeEnabled) {
    return { status: "rejected", reason: "runtime_disabled" };
  }
  const options = params.options ?? {};
  ensureDelegateArtifactsSchema(options);
  return runOpenClawStateWriteTransaction(
    ({ db }) => {
      const kdb = artifactDb(db);
      const policy = executeSqliteQueryTakeFirstSync(
        db,
        kdb
          .selectFrom("delegate_artifact_policies")
          .selectAll()
          .where("producer_run_id", "=", params.producerRunId),
      );
      if (
        !policy ||
        policy.producer_session_key !== params.producerSessionKey ||
        (policy.producer_session_id !== null &&
          policy.producer_session_id !== params.producerSessionId) ||
        policy.status !== "active"
      ) {
        return { status: "rejected", reason: "forbidden" } as const;
      }
      try {
        if (!params.crossSessionEnabled && policyRequiresCrossSessionGate(policy)) {
          return { status: "rejected", reason: "runtime_disabled" } as const;
        }
      } catch {
        return { status: "rejected", reason: "forbidden" } as const;
      }
      if (policy.retention_deadline <= now) {
        return { status: "rejected", reason: "policy_expired" } as const;
      }
      const allowedMimePatterns = parseAllowedMimePatterns(policy);
      if (
        !allowedMimePatterns ||
        params.candidates.length === 0 ||
        params.candidates.length > policy.max_artifact_count ||
        params.candidates.some(
          (candidate) =>
            candidate.bytes.byteLength === 0 ||
            candidate.bytes.byteLength > policy.max_artifact_bytes ||
            !isAllowedMime(candidate.mimeType, allowedMimePatterns),
        )
      ) {
        return { status: "rejected", reason: "invalid_candidate" } as const;
      }
      if (policy.producer_session_id === null) {
        executeSqliteQuerySync(
          db,
          kdb
            .updateTable("delegate_artifact_policies")
            .set({ producer_session_id: params.producerSessionId })
            .where("flow_id", "=", policy.flow_id)
            .where("producer_session_id", "is", null),
        );
      }
      const existingRows = executeSqliteQuerySync(
        db,
        kdb
          .selectFrom("delegate_artifact_claims")
          .selectAll()
          .where("flow_id", "=", policy.flow_id)
          .orderBy("ordinal"),
      ).rows;
      const publicationRows = existingRows.filter(
        (row) => row.publication_key === params.publicationKey,
      );
      if (publicationRows.length > 0) {
        const replayMatches =
          publicationRows.length === params.candidates.length &&
          publicationRows.every((row, index) => {
            const candidate = params.candidates[index];
            return (
              candidate !== undefined &&
              row.publication_index === index &&
              row.mime_type === candidate.mimeType &&
              row.size_bytes === candidate.bytes.byteLength &&
              row.sha256 === createHash("sha256").update(candidate.bytes).digest("hex")
            );
          });
        if (!replayMatches) {
          return { status: "rejected", reason: "invalid_candidate" } as const;
        }
        return { status: "published", count: publicationRows.length } as const;
      }
      const existingBytes = existingRows.reduce((sum, row) => sum + row.size_bytes, 0);
      const incomingBytes = params.candidates.reduce(
        (sum, candidate) => sum + candidate.bytes.byteLength,
        0,
      );
      if (
        existingRows.length + params.candidates.length > policy.max_artifact_count ||
        existingBytes + incomingBytes > policy.max_total_bytes
      ) {
        return { status: "rejected", reason: "policy_limit" } as const;
      }
      for (const [index, candidate] of params.candidates.entries()) {
        const classification = classifyArtifact(candidate.mimeType);
        executeSqliteQuerySync(
          db,
          kdb.insertInto("delegate_artifact_claims").values({
            claim_id: generateSecureUuid(),
            flow_id: policy.flow_id,
            publication_key: params.publicationKey,
            publication_index: index,
            ordinal: existingRows.length + index,
            artifact_type: classification.type,
            title: classification.title,
            mime_type: candidate.mimeType,
            size_bytes: candidate.bytes.byteLength,
            sha256: createHash("sha256").update(candidate.bytes).digest("hex"),
            backing: candidate.bytes,
            status: "pending",
            created_at: now,
            finalized_at: null,
          }),
        );
      }
      return { status: "published", count: params.candidates.length } as const;
    },
    options,
    { operationLabel: "delegate-artifacts.publish" },
  );
}

export type DelegateArtifactFinalizeResult =
  | { status: "not-configured" }
  | { status: "deferred" }
  | {
      status: "failed";
      disposition: string;
      projections?: Map<string, DelegateArtifactRecipientProjectionV1>;
    }
  | {
      status: "finalized";
      disposition: "available" | "optional-no-artifacts" | "optional-zero-eligible";
      projections: Map<string, DelegateArtifactRecipientProjectionV1>;
    };

export function finalizeDelegateArtifacts(params: {
  producerSessionKey: string;
  producerSessionId: string;
  producerRunId: string;
  completionId: string;
  finalizationKey: string;
  completionStatus: "ok" | "timeout" | "error" | "unknown";
  completedAt: number;
  silent: boolean;
  runtimeEnabled: boolean;
  crossSessionEnabled: boolean;
  resolveSessionId: (sessionKey: string) => string | undefined;
  now?: number;
  options?: OpenClawStateDatabaseOptions;
}): DelegateArtifactFinalizeResult {
  const options = params.options ?? {};
  ensureDelegateArtifactsSchema(options);
  const database = openOpenClawStateDatabase(options);
  const lookup = artifactDb(database.db);
  const policyBefore = executeSqliteQueryTakeFirstSync(
    database.db,
    lookup
      .selectFrom("delegate_artifact_policies")
      .selectAll()
      .where("producer_run_id", "=", params.producerRunId),
  );
  if (!policyBefore) {
    return { status: "not-configured" };
  }
  let snapshottedRecipients: DelegateArtifactRecipientV1[];
  let snapshottedRoute: DelegateArtifactRouteV1;
  try {
    snapshottedRecipients = parseRecipients(policyBefore);
    snapshottedRoute = parseRoute(policyBefore);
  } catch {
    runOpenClawStateWriteTransaction(
      ({ db }) => {
        const kdb = artifactDb(db);
        executeSqliteQuerySync(
          db,
          kdb
            .updateTable("delegate_artifact_claims")
            .set({ status: "purged", backing: null })
            .where("flow_id", "=", policyBefore.flow_id),
        );
        executeSqliteQuerySync(
          db,
          kdb
            .updateTable("delegate_artifact_policies")
            .set({
              status: "failed",
              completion_id: policyBefore.completion_id ?? params.completionId,
              completion_finalization_key:
                policyBefore.completion_finalization_key ?? params.finalizationKey,
              completed_at: policyBefore.completed_at ?? params.completedAt,
              completion_status: policyBefore.completion_status ?? params.completionStatus,
              completion_delivery_mode:
                policyBefore.completion_delivery_mode ?? (params.silent ? "silent" : "announced"),
              completion_disposition: "global-failed(malformed-policy)",
            })
            .where("flow_id", "=", policyBefore.flow_id),
        );
      },
      options,
      { operationLabel: "delegate-artifacts.finalize.malformed-policy" },
    );
    return { status: "failed", disposition: "global-failed(malformed-policy)" };
  }
  if (
    !params.runtimeEnabled ||
    (!params.crossSessionEnabled &&
      snapshottedRoute.kind !== "parent" &&
      !(snapshottedRoute.kind === "fanout" && snapshottedRoute.fanoutMode === "tree") &&
      snapshottedRecipients.some((recipient) => recipient.relation === "inter_session"))
  ) {
    runOpenClawStateWriteTransaction(
      ({ db }) => {
        const kdb = artifactDb(db);
        executeSqliteQuerySync(
          db,
          kdb
            .updateTable("delegate_artifact_policies")
            .set({
              status: "staged",
              completion_id: params.completionId,
              completion_finalization_key: params.finalizationKey,
              completed_at: params.completedAt,
              completion_status: params.completionStatus,
              completion_delivery_mode: params.silent ? "silent" : "announced",
            })
            .where("flow_id", "=", policyBefore.flow_id)
            .where("status", "=", "active"),
        );
        executeSqliteQuerySync(
          db,
          kdb
            .updateTable("delegate_artifact_claims")
            .set({ status: "staged" })
            .where("flow_id", "=", policyBefore.flow_id)
            .where("status", "=", "pending"),
        );
      },
      options,
      { operationLabel: "delegate-artifacts.finalize.stage" },
    );
    return { status: "deferred" };
  }
  const now = params.now ?? Date.now();
  return runOpenClawStateWriteTransaction(
    ({ db }) => {
      const kdb = artifactDb(db);
      const policy = executeSqliteQueryTakeFirstSync(
        db,
        kdb
          .selectFrom("delegate_artifact_policies")
          .selectAll()
          .where("producer_run_id", "=", params.producerRunId),
      );
      if (!policy) {
        return { status: "not-configured" } as const;
      }
      if (policy.status === "completed" || policy.status === "failed") {
        if (
          policy.completion_id !== params.completionId ||
          policy.completion_finalization_key !== params.finalizationKey ||
          policy.completion_delivery_mode !== (params.silent ? "silent" : "announced")
        ) {
          return { status: "failed", disposition: "completion-integrity-mismatch" } as const;
        }
        if (policy.status === "failed") {
          const projections = projectionsForCompletedPolicy({
            db,
            policy,
            deliveredAt: now,
            replayedAt: now,
            availability: "unavailable",
          });
          return {
            status: "failed",
            disposition: policy.completion_disposition ?? "global-failed",
            ...(projections.size > 0 ? { projections } : {}),
          } as const;
        }
        return {
          status: "finalized",
          disposition:
            policy.completion_disposition === "optional-no-artifacts" ||
            policy.completion_disposition === "optional-zero-eligible"
              ? policy.completion_disposition
              : "available",
          projections: projectionsForCompletedPolicy({
            db,
            policy,
            deliveredAt: now,
            ...(policy.completion_disposition === "optional-no-artifacts"
              ? { availability: "unavailable" as const }
              : {}),
          }),
        } as const;
      }
      const claims = claimRowsForFlow(db, policy.flow_id);
      const recipientIncarnations = new Map(
        snapshottedRecipients.map((recipient) => [
          recipient.sessionKey,
          params.resolveSessionId(recipient.sessionKey),
        ]),
      );
      const parentContinuityValid =
        params.resolveSessionId(policy.origin_parent_session_key) ===
        policy.origin_parent_session_id;
      const stagedCompletionIntegrityValid =
        policy.status !== "staged" ||
        (policy.completion_id === params.completionId &&
          policy.completion_finalization_key === params.finalizationKey &&
          policy.completed_at === params.completedAt &&
          policy.completion_status === params.completionStatus &&
          policy.completion_delivery_mode === (params.silent ? "silent" : "announced"));
      const hasCorruptBacking = claims.some((claim) => {
        if (
          claim.backing === null ||
          claim.size_bytes !== claim.backing.byteLength ||
          claim.sha256 !== createHash("sha256").update(claim.backing).digest("hex")
        ) {
          return true;
        }
        try {
          toDelegateArtifactSummaryV1(toClaim(claim));
          return false;
        } catch {
          return true;
        }
      });
      let globalFailure: { disposition: string; backingStatus: string } | undefined;
      if (hasCorruptBacking) {
        globalFailure = { disposition: "global-failed(corrupt)", backingStatus: "purged" };
      } else if (!stagedCompletionIntegrityValid) {
        globalFailure = {
          disposition: "global-failed(completion-integrity)",
          backingStatus: "orphaned",
        };
      } else if (
        policy.producer_session_key !== params.producerSessionKey ||
        (policy.producer_session_id !== null &&
          policy.producer_session_id !== params.producerSessionId) ||
        !parentContinuityValid
      ) {
        globalFailure = { disposition: "global-failed(orphaned)", backingStatus: "orphaned" };
      } else if (policy.retention_deadline <= now) {
        globalFailure = { disposition: "global-failed(expired)", backingStatus: "expired" };
      }
      if (policy.producer_session_id === null) {
        executeSqliteQuerySync(
          db,
          kdb
            .updateTable("delegate_artifact_policies")
            .set({ producer_session_id: params.producerSessionId })
            .where("flow_id", "=", policy.flow_id)
            .where("producer_session_id", "is", null),
        );
      }
      if (globalFailure) {
        const completionId =
          policy.status === "staged" && policy.completion_id
            ? policy.completion_id
            : params.completionId;
        const completionFinalizationKey =
          policy.status === "staged" && policy.completion_finalization_key
            ? policy.completion_finalization_key
            : params.finalizationKey;
        const completedAt =
          policy.status === "staged" && policy.completed_at !== null
            ? policy.completed_at
            : params.completedAt;
        const completionStatus =
          policy.status === "staged" && policy.completion_status
            ? policy.completion_status
            : params.completionStatus;
        executeSqliteQuerySync(
          db,
          kdb
            .updateTable("delegate_artifact_claims")
            .set({
              status: globalFailure.backingStatus,
              ...(globalFailure.backingStatus === "purged" ? { backing: null } : {}),
            })
            .where("flow_id", "=", policy.flow_id),
        );
        executeSqliteQuerySync(
          db,
          kdb
            .updateTable("delegate_artifact_policies")
            .set({
              status: "failed",
              completion_id: completionId,
              completion_finalization_key: completionFinalizationKey,
              completed_at: completedAt,
              completion_status: completionStatus,
              completion_delivery_mode:
                policy.status === "staged" && policy.completion_delivery_mode
                  ? policy.completion_delivery_mode
                  : params.silent
                    ? "silent"
                    : "announced",
              completion_disposition: globalFailure.disposition,
            })
            .where("flow_id", "=", policy.flow_id),
        );
        return { status: "failed", disposition: globalFailure.disposition } as const;
      }
      const recipients = snapshottedRecipients;
      let availableRecipients = 0;
      for (const recipient of recipients) {
        const currentSessionId = recipientIncarnations.get(recipient.sessionKey);
        const available = currentSessionId === recipient.sessionId;
        if (available) {
          availableRecipients += 1;
        }
        executeSqliteQuerySync(
          db,
          kdb.insertInto("delegate_artifact_recipient_outcomes").values({
            flow_id: policy.flow_id,
            recipient_session_key: recipient.sessionKey,
            recipient_session_id: recipient.sessionId,
            recipient_relation: recipient.relation,
            purpose: recipient.purpose ?? null,
            outcome: available ? "available" : "unavailable",
            unavailable_reason: available ? null : "recipient-incarnation-changed",
            decided_at: now,
            first_delivery_at: null,
            replayed_at: null,
            delivery_acknowledged_at: null,
            delivery_terminal_reason: null,
          }),
        );
      }
      const successfulCompletion = params.completionStatus === "ok";
      const canExposeClaims = successfulCompletion && claims.length > 0 && availableRecipients > 0;
      if (canExposeClaims) {
        executeSqliteQuerySync(
          db,
          kdb
            .updateTable("delegate_artifact_claims")
            .set({ status: "available", finalized_at: now })
            .where("flow_id", "=", policy.flow_id)
            .where("status", "in", ["pending", "staged"]),
        );
        for (const claim of claims) {
          for (const recipient of recipients) {
            const available =
              recipientIncarnations.get(recipient.sessionKey) === recipient.sessionId;
            if (!available) {
              continue;
            }
            executeSqliteQuerySync(
              db,
              kdb.insertInto("delegate_artifact_bindings").values({
                claim_id: claim.claim_id,
                recipient_session_key: recipient.sessionKey,
                recipient_session_id: recipient.sessionId,
                recipient_relation: recipient.relation,
                purpose: recipient.purpose ?? null,
                status: "available",
                unavailable_reason: null,
                arrived_at: null,
                replayed_at: null,
                materialized_at: null,
                discarded_at: null,
                last_delivery_attempt_at: null,
                delivery_acknowledged_at: null,
              }),
            );
          }
        }
      } else if (claims.length > 0) {
        executeSqliteQuerySync(
          db,
          kdb
            .updateTable("delegate_artifact_claims")
            .set({ status: "orphaned" })
            .where("flow_id", "=", policy.flow_id),
        );
      }
      const requiredFailure =
        policy.artifact_mode === "required" &&
        (!successfulCompletion || claims.length === 0 || availableRecipients === 0);
      const optionalZeroEligible =
        policy.artifact_mode === "optional" && claims.length > 0 && availableRecipients === 0;
      const optionalUnsuccessful = policy.artifact_mode === "optional" && !successfulCompletion;
      const disposition = requiredFailure
        ? "required-failed"
        : optionalZeroEligible
          ? "optional-zero-eligible"
          : claims.length === 0 || optionalUnsuccessful
            ? "optional-no-artifacts"
            : "available";
      const status = requiredFailure ? "failed" : "completed";
      executeSqliteQuerySync(
        db,
        kdb
          .updateTable("delegate_artifact_policies")
          .set({
            status,
            completion_id: params.completionId,
            completion_finalization_key: params.finalizationKey,
            completed_at: params.completedAt,
            completion_status: params.completionStatus,
            completion_delivery_mode: params.silent ? "silent" : "announced",
            completion_disposition: disposition,
          })
          .where("flow_id", "=", policy.flow_id),
      );
      if (status === "failed") {
        const failedPolicy = {
          ...policy,
          status,
          completion_id: params.completionId,
          completed_at: params.completedAt,
          completion_delivery_mode: params.silent ? "silent" : "announced",
          completion_disposition: disposition,
        };
        return {
          status: "failed",
          disposition,
          projections: projectionsForCompletedPolicy({
            db,
            policy: failedPolicy,
            deliveredAt: now,
            availability: "unavailable",
          }),
        } as const;
      }
      const completedPolicy = {
        ...policy,
        status,
        completion_id: params.completionId,
        completed_at: params.completedAt,
        completion_delivery_mode: params.silent ? "silent" : "announced",
        completion_disposition: disposition,
      };
      return {
        status: "finalized",
        disposition:
          disposition === "optional-no-artifacts" || disposition === "optional-zero-eligible"
            ? disposition
            : "available",
        projections: projectionsForCompletedPolicy({
          db,
          policy: completedPolicy,
          deliveredAt: now,
          ...(disposition === "optional-no-artifacts"
            ? { availability: "unavailable" as const }
            : {}),
        }),
      } as const;
    },
    options,
    { operationLabel: "delegate-artifacts.finalize" },
  );
}
