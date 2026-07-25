import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { ArtifactSummary } from "@openclaw/gateway-protocol";
import { z } from "zod";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../infra/kysely-sync.js";
import { generateSecureUuid } from "../infra/secure-random.js";
import { DELEGATE_ARTIFACTS_SCHEMA_SQL } from "../state/delegate-artifacts-schema.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
  type OpenClawStateDatabaseOptions,
} from "../state/openclaw-state-db.js";

export const DELEGATE_ARTIFACT_OUTPUT_ROOT = ".openclaw/delegate-output";
export const DELEGATE_ARTIFACT_MAX_COUNT = 8;
export const DELEGATE_ARTIFACT_MAX_BYTES = 16 * 1024 * 1024;
export const DELEGATE_ARTIFACT_MAX_TOTAL_BYTES = 32 * 1024 * 1024;
export const DELEGATE_ARTIFACT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

const MIME_PATTERN = /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/;
const ALLOWED_MIME_PATTERNS = [
  "image/*",
  "audio/*",
  "video/*",
  "text/*",
  "application/json",
  "application/pdf",
  "application/zip",
] as const;

export type DelegateArtifactModeV1 = "forbidden" | "optional" | "required";

export type DelegateArtifactRecipientV1 = {
  sessionKey: string;
  sessionId: string;
  relation: "parent" | "inter_session";
  purpose?: string;
};

export type DelegateArtifactRouteV1 =
  | { kind: "parent" }
  | { kind: "target"; targetSessionKey: string }
  | { kind: "targets"; targetSessionKeys: string[] }
  | { kind: "fanout"; fanoutMode: "tree" | "all" };

export type DelegateArtifactPolicyV1 = {
  flowId: string;
  producerSessionKey: string;
  producerSessionId?: string;
  producerRunId: string;
  originParentSessionKey: string;
  originParentSessionId: string;
  dispatchRevision: number;
  dispatchAcceptedAt?: number;
  scheduledAt?: number;
  notBefore?: number;
  artifactMode: Exclude<DelegateArtifactModeV1, "forbidden">;
  recipientContext?: string;
  recipients: DelegateArtifactRecipientV1[];
  route: DelegateArtifactRouteV1;
};

export type DelegateArtifactClaim = {
  claimId: string;
  flowId: string;
  type: string;
  title: string;
  mimeType?: string;
  sizeBytes: number;
  createdAt: number;
  finalizedAt?: number;
};

export type DelegateArtifactSummaryV1 = Pick<
  ArtifactSummary,
  "id" | "type" | "title" | "mimeType" | "sizeBytes" | "source" | "download"
> & {
  source: "delegate-return";
  download: { mode: "unsupported" };
};

export type DelegateArtifactArrivalContextV1 = {
  deliveryClass: "delegate result" | "inter-session enrichment";
  deliveryMode: "announced" | "silent";
  dispatchId: string;
  producer: { sessionKey: string; runId: string };
  completionId: string;
  binding: { recipientSessionKey: string; recipientSessionId: string };
  dispatchAcceptedAt: number;
  scheduledAt?: number;
  notBefore?: number;
  completedAt: number;
  deliveredAt: number;
  replayedAt?: number;
  policyVersion: 1;
  availability: "available" | "unavailable";
  recipientContext?: { purpose: string };
};

export type DelegateArtifactRecipientProjectionV1 = {
  artifacts: DelegateArtifactSummaryV1[];
  arrivalContext: DelegateArtifactArrivalContextV1;
};

export type DelegateArtifactOperationOutcome =
  | "available"
  | "expired"
  | "revoked"
  | "missing"
  | "corrupt"
  | "unauthorized";

type DelegateArtifactDatabase = {
  delegate_artifact_policies: {
    flow_id: string;
    producer_session_key: string;
    producer_session_id: string | null;
    producer_run_id: string;
    origin_parent_session_key: string;
    origin_parent_session_id: string;
    policy_version: number;
    dispatch_revision: number;
    dispatch_accepted_at: number;
    scheduled_at: number | null;
    not_before: number | null;
    artifact_mode: string;
    recipient_context: string | null;
    recipients_json: string;
    route_json: string;
    output_root: string;
    max_artifact_count: number;
    max_artifact_bytes: number;
    max_total_bytes: number;
    allowed_mimes_json: string;
    retention_deadline: number;
    status: string;
    completion_id: string | null;
    completion_finalization_key: string | null;
    completed_at: number | null;
    completion_status: string | null;
    completion_delivery_mode: string | null;
    completion_disposition: string | null;
  };
  delegate_artifact_claims: {
    claim_id: string;
    flow_id: string;
    publication_key: string;
    publication_index: number;
    ordinal: number;
    artifact_type: string;
    title: string;
    mime_type: string | null;
    size_bytes: number;
    sha256: string;
    backing: Uint8Array | null;
    status: string;
    created_at: number;
    finalized_at: number | null;
  };
  delegate_artifact_recipient_outcomes: {
    flow_id: string;
    recipient_session_key: string;
    recipient_session_id: string;
    recipient_relation: string;
    purpose: string | null;
    outcome: string;
    unavailable_reason: string | null;
    decided_at: number;
    first_delivery_at: number | null;
    replayed_at: number | null;
    delivery_acknowledged_at: number | null;
    delivery_terminal_reason: string | null;
  };
  delegate_artifact_bindings: {
    claim_id: string;
    recipient_session_key: string;
    recipient_session_id: string;
    recipient_relation: string;
    purpose: string | null;
    status: string;
    unavailable_reason: string | null;
    arrived_at: number | null;
    replayed_at: number | null;
    materialized_at: number | null;
    discarded_at: number | null;
    last_delivery_attempt_at: number | null;
    delivery_acknowledged_at: number | null;
  };
  delegate_artifact_audit: {
    sequence?: number;
    action: string;
    outcome: string;
    claim_id: string | null;
    flow_id: string | null;
    recipient_session_key: string;
    recipient_session_id: string;
    destination: string | null;
    occurred_at: number;
  };
};

type PolicyRow = DelegateArtifactDatabase["delegate_artifact_policies"];
type ClaimRow = DelegateArtifactDatabase["delegate_artifact_claims"];

const PurposeSchema = z
  .string()
  .trim()
  .min(1)
  .refine((value) => Buffer.byteLength(value, "utf8") <= 1024)
  .refine((value) => !/[\u0000-\u001f\u007f]/.test(value));
const RecipientSchema = z.discriminatedUnion("relation", [
  z
    .object({
      sessionKey: z.string().trim().min(1),
      sessionId: z.string().trim().min(1),
      relation: z.literal("parent"),
    })
    .strict(),
  z
    .object({
      sessionKey: z.string().trim().min(1),
      sessionId: z.string().trim().min(1),
      relation: z.literal("inter_session"),
      purpose: PurposeSchema,
    })
    .strict(),
]);

const RecipientsSchema = z.array(RecipientSchema).min(1);
const RouteSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("parent") }).strict(),
  z.object({ kind: z.literal("target"), targetSessionKey: z.string().min(1) }).strict(),
  z.object({ kind: z.literal("targets"), targetSessionKeys: z.array(z.string().min(1)) }).strict(),
  z.object({ kind: z.literal("fanout"), fanoutMode: z.enum(["tree", "all"]) }).strict(),
]);
const SummarySchema = z
  .object({
    id: z.string().uuid(),
    type: z.string().min(1),
    title: z.string().min(1),
    mimeType: z.string().regex(MIME_PATTERN).optional(),
    sizeBytes: z.number().int().nonnegative().optional(),
    source: z.literal("delegate-return"),
    download: z.object({ mode: z.literal("unsupported") }).strict(),
  })
  .strict();
export const DelegateArtifactRecipientProjectionSchema = z
  .object({
    artifacts: z.array(SummarySchema),
    arrivalContext: z
      .object({
        deliveryClass: z.enum(["delegate result", "inter-session enrichment"]),
        deliveryMode: z.enum(["announced", "silent"]),
        dispatchId: z.string().min(1),
        producer: z
          .object({
            sessionKey: z.string().min(1),
            runId: z.string().min(1),
          })
          .strict(),
        completionId: z.string().min(1),
        binding: z
          .object({
            recipientSessionKey: z.string().min(1),
            recipientSessionId: z.string().min(1),
          })
          .strict(),
        dispatchAcceptedAt: z.number().int().nonnegative(),
        scheduledAt: z.number().int().nonnegative().optional(),
        notBefore: z.number().int().nonnegative().optional(),
        completedAt: z.number().int().nonnegative(),
        deliveredAt: z.number().int().nonnegative(),
        replayedAt: z.number().int().nonnegative().optional(),
        policyVersion: z.literal(1),
        availability: z.enum(["available", "unavailable"]),
        recipientContext: z.object({ purpose: PurposeSchema }).strict().optional(),
      })
      .strict(),
  })
  .strict();

const ensuredDatabases = new WeakSet<DatabaseSync>();

function artifactDb(db: DatabaseSync) {
  return getNodeSqliteKysely<DelegateArtifactDatabase>(db);
}

function ensureDelegateArtifactsSchema(options: OpenClawStateDatabaseOptions): void {
  const database = openOpenClawStateDatabase(options);
  if (ensuredDatabases.has(database.db)) {
    return;
  }
  runOpenClawStateWriteTransaction(
    ({ db }) => {
      db.exec(DELEGATE_ARTIFACTS_SCHEMA_SQL);
    },
    options,
    { operationLabel: "delegate-artifacts.schema.ensure" },
  );
  ensuredDatabases.add(database.db);
}

function parseRecipients(row: Pick<PolicyRow, "recipients_json">): DelegateArtifactRecipientV1[] {
  return RecipientsSchema.parse(JSON.parse(row.recipients_json));
}

function parseRoute(row: Pick<PolicyRow, "route_json">): DelegateArtifactRouteV1 {
  return RouteSchema.parse(JSON.parse(row.route_json));
}

function policyRequiresCrossSessionGate(
  policy: Pick<PolicyRow, "route_json" | "recipients_json">,
): boolean {
  const route = parseRoute(policy);
  return (
    route.kind !== "parent" &&
    !(route.kind === "fanout" && route.fanoutMode === "tree") &&
    parseRecipients(policy).some((recipient) => recipient.relation === "inter_session")
  );
}

const AllowedMimePatternsSchema = z
  .array(
    z
      .string()
      .min(3)
      .max(127)
      .regex(/^[a-z0-9!#$&^_.+-]+\/(?:[a-z0-9!#$&^_.+-]+|\*)$/),
  )
  .min(1)
  .max(64);

function isAllowedMime(mimeType: string, allowedPatterns: readonly string[]): boolean {
  if (!MIME_PATTERN.test(mimeType)) {
    return false;
  }
  return allowedPatterns.some((pattern) =>
    pattern.endsWith("/*") ? mimeType.startsWith(pattern.slice(0, -1)) : mimeType === pattern,
  );
}

function parseAllowedMimePatterns(policy: PolicyRow): string[] | undefined {
  try {
    const parsed = AllowedMimePatternsSchema.safeParse(JSON.parse(policy.allowed_mimes_json));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

function classifyArtifact(mimeType: string): { type: string; title: string } {
  if (mimeType.startsWith("image/")) {
    return { type: "image", title: "Delegate image" };
  }
  if (mimeType.startsWith("audio/")) {
    return { type: "audio", title: "Delegate audio" };
  }
  if (mimeType.startsWith("video/")) {
    return { type: "video", title: "Delegate video" };
  }
  if (mimeType === "application/pdf") {
    return { type: "report", title: "Delegate report" };
  }
  if (mimeType === "application/json" || mimeType === "text/csv") {
    return { type: "dataset", title: "Delegate dataset" };
  }
  if (mimeType === "text/x-diff" || mimeType === "text/x-patch") {
    return { type: "patch", title: "Delegate patch" };
  }
  return { type: "file", title: "Delegate file" };
}

function toClaim(row: ClaimRow): DelegateArtifactClaim {
  return {
    claimId: row.claim_id,
    flowId: row.flow_id,
    type: row.artifact_type,
    title: row.title,
    ...(row.mime_type ? { mimeType: row.mime_type } : {}),
    sizeBytes: row.size_bytes,
    createdAt: row.created_at,
    ...(row.finalized_at !== null ? { finalizedAt: row.finalized_at } : {}),
  };
}

function assertSafeArtifactScalar(value: string, field: "type" | "title" | "mimeType"): void {
  const unsafe =
    /[\u0000-\u001f\u007f]/.test(value) ||
    value.includes("/") ||
    value.includes("\\") ||
    value.includes("://") ||
    /^[a-z][a-z0-9+.-]*:/i.test(value) ||
    /^bearer(?:\s|$)/i.test(value);
  if (unsafe || (field === "mimeType" && !MIME_PATTERN.test(value))) {
    throw new Error(`invalid delegate artifact ${field}`);
  }
}

/** Construct the only recipient-visible #666 projection from host-validated claim metadata. */
export function toDelegateArtifactSummaryV1(
  claim: DelegateArtifactClaim,
): DelegateArtifactSummaryV1 {
  assertSafeArtifactScalar(claim.type, "type");
  assertSafeArtifactScalar(claim.title, "title");
  if (claim.mimeType) {
    if (!MIME_PATTERN.test(claim.mimeType)) {
      throw new Error("invalid delegate artifact mimeType");
    }
  }
  return SummarySchema.parse({
    id: claim.claimId,
    type: claim.type,
    title: claim.title,
    ...(claim.mimeType ? { mimeType: claim.mimeType } : {}),
    sizeBytes: claim.sizeBytes,
    source: "delegate-return",
    download: { mode: "unsupported" },
  }) as DelegateArtifactSummaryV1;
}

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
          retention_deadline: dispatchAcceptedAt + DELEGATE_ARTIFACT_RETENTION_MS,
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
      .select("flow_id")
      .where("flow_id", "=", flowId),
  );
  if (!policy) {
    throw new Error("artifact-capable continuation dispatch has no accepted policy");
  }
}

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
        throw new Error("cannot remove an accepted delegate artifact policy");
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

function claimRowsForFlow(db: DatabaseSync, flowId: string): ClaimRow[] {
  const kdb = artifactDb(db);
  return executeSqliteQuerySync(
    db,
    kdb
      .selectFrom("delegate_artifact_claims")
      .selectAll()
      .where("flow_id", "=", flowId)
      .orderBy("ordinal"),
  ).rows;
}

function projectionsForCompletedPolicy(params: {
  db: DatabaseSync;
  policy: PolicyRow;
  deliveredAt: number;
  replayedAt?: number;
  availability?: "available" | "unavailable";
}): Map<string, DelegateArtifactRecipientProjectionV1> {
  if (!params.policy.completion_id || params.policy.completed_at === null) {
    return new Map();
  }
  const deliveryMode = z
    .enum(["announced", "silent"])
    .safeParse(params.policy.completion_delivery_mode);
  if (!deliveryMode.success) {
    return new Map();
  }
  const kdb = artifactDb(params.db);
  const claims = claimRowsForFlow(params.db, params.policy.flow_id)
    .filter((row) => row.status === "available")
    .map(toClaim);
  const outcomes = executeSqliteQuerySync(
    params.db,
    kdb
      .selectFrom("delegate_artifact_recipient_outcomes")
      .selectAll()
      .where("flow_id", "=", params.policy.flow_id)
      .where("outcome", "=", "available"),
  ).rows;
  const projections = new Map<string, DelegateArtifactRecipientProjectionV1>();
  for (const outcome of outcomes) {
    const binding = executeSqliteQueryTakeFirstSync(
      params.db,
      kdb
        .selectFrom("delegate_artifact_bindings")
        .innerJoin(
          "delegate_artifact_claims",
          "delegate_artifact_claims.claim_id",
          "delegate_artifact_bindings.claim_id",
        )
        .select(["arrived_at", "replayed_at"])
        .where("delegate_artifact_claims.flow_id", "=", params.policy.flow_id)
        .where("recipient_session_key", "=", outcome.recipient_session_key)
        .where("recipient_session_id", "=", outcome.recipient_session_id)
        .limit(1),
    );
    const recipientContext =
      outcome.recipient_relation === "inter_session" && outcome.purpose
        ? { purpose: outcome.purpose }
        : undefined;
    projections.set(outcome.recipient_session_key, {
      artifacts: claims.map(toDelegateArtifactSummaryV1),
      arrivalContext: {
        deliveryClass:
          outcome.recipient_relation === "parent" ? "delegate result" : "inter-session enrichment",
        deliveryMode: deliveryMode.data,
        dispatchId: params.policy.flow_id,
        producer: {
          sessionKey: params.policy.producer_session_key,
          runId: params.policy.producer_run_id,
        },
        completionId: params.policy.completion_id,
        binding: {
          recipientSessionKey: outcome.recipient_session_key,
          recipientSessionId: outcome.recipient_session_id,
        },
        dispatchAcceptedAt: params.policy.dispatch_accepted_at,
        ...(params.policy.scheduled_at !== null ? { scheduledAt: params.policy.scheduled_at } : {}),
        ...(params.policy.not_before !== null ? { notBefore: params.policy.not_before } : {}),
        completedAt: params.policy.completed_at,
        deliveredAt: binding?.arrived_at ?? outcome.first_delivery_at ?? params.deliveredAt,
        ...(params.replayedAt !== undefined
          ? { replayedAt: params.replayedAt }
          : binding?.replayed_at !== null && binding?.replayed_at !== undefined
            ? { replayedAt: binding.replayed_at }
            : outcome.replayed_at !== null
              ? { replayedAt: outcome.replayed_at }
              : {}),
        policyVersion: 1,
        availability: params.availability ?? "available",
        ...(recipientContext ? { recipientContext } : {}),
      },
    });
  }
  return projections;
}

function projectionMatchesDurableFacts(
  supplied: DelegateArtifactRecipientProjectionV1,
  durable: DelegateArtifactRecipientProjectionV1,
): boolean {
  const {
    deliveredAt: _suppliedDeliveredAt,
    replayedAt: _suppliedReplayedAt,
    ...suppliedContext
  } = supplied.arrivalContext;
  const {
    deliveredAt: _durableDeliveredAt,
    replayedAt: _durableReplayedAt,
    ...durableContext
  } = durable.arrivalContext;
  return (
    JSON.stringify(supplied.artifacts) === JSON.stringify(durable.artifacts) &&
    JSON.stringify(suppliedContext) === JSON.stringify(durableContext)
  );
}

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

function auditOperation(params: {
  db: DatabaseSync;
  action: string;
  outcome: string;
  claimId?: string;
  flowId?: string;
  recipientSessionKey: string;
  recipientSessionId: string;
  destination?: string;
  now: number;
}): void {
  const kdb = artifactDb(params.db);
  executeSqliteQuerySync(
    params.db,
    kdb.insertInto("delegate_artifact_audit").values({
      action: params.action,
      outcome: params.outcome,
      claim_id: params.claimId ?? null,
      flow_id: params.flowId ?? null,
      recipient_session_key: params.recipientSessionKey,
      recipient_session_id: params.recipientSessionId,
      destination: params.destination ?? null,
      occurred_at: params.now,
    }),
  );
}

function resolveClaimForRecipient(params: {
  db: DatabaseSync;
  claimId: string;
  recipientSessionKey: string;
  recipientSessionId: string;
  crossSessionEnabled: boolean;
  now: number;
}):
  | { outcome: "available"; claim: ClaimRow; policy: PolicyRow }
  | { outcome: Exclude<DelegateArtifactOperationOutcome, "available">; flowId?: string } {
  const kdb = artifactDb(params.db);
  const claim = executeSqliteQueryTakeFirstSync(
    params.db,
    kdb.selectFrom("delegate_artifact_claims").selectAll().where("claim_id", "=", params.claimId),
  );
  if (!claim) {
    return { outcome: "missing" };
  }
  const policy = executeSqliteQueryTakeFirstSync(
    params.db,
    kdb.selectFrom("delegate_artifact_policies").selectAll().where("flow_id", "=", claim.flow_id),
  );
  const binding = executeSqliteQueryTakeFirstSync(
    params.db,
    kdb
      .selectFrom("delegate_artifact_bindings")
      .selectAll()
      .where("claim_id", "=", params.claimId)
      .where("recipient_session_key", "=", params.recipientSessionKey)
      .where("recipient_session_id", "=", params.recipientSessionId),
  );
  if (!policy || !binding) {
    return { outcome: "unauthorized", flowId: claim.flow_id };
  }
  if (policy.retention_deadline <= params.now || claim.status === "expired") {
    return { outcome: "expired", flowId: claim.flow_id };
  }
  if (claim.status === "revoked" || binding.status === "discarded") {
    return { outcome: "revoked", flowId: claim.flow_id };
  }
  if (binding.status === "unavailable") {
    return { outcome: "unauthorized", flowId: claim.flow_id };
  }
  try {
    if (!params.crossSessionEnabled && policyRequiresCrossSessionGate(policy)) {
      return { outcome: "unauthorized", flowId: claim.flow_id };
    }
  } catch {
    return { outcome: "corrupt", flowId: claim.flow_id };
  }
  if (binding.arrived_at === null || binding.delivery_acknowledged_at === null) {
    return { outcome: "unauthorized", flowId: claim.flow_id };
  }
  if (
    claim.status !== "available" ||
    policy.status !== "completed" ||
    claim.backing === null ||
    claim.backing.byteLength !== claim.size_bytes ||
    createHash("sha256").update(claim.backing).digest("hex") !== claim.sha256
  ) {
    return { outcome: "corrupt", flowId: claim.flow_id };
  }
  return { outcome: "available", claim, policy };
}

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
          .where("delegate_artifact_bindings.status", "in", ["available", "materialized"])
          .where("delegate_artifact_bindings.delivery_acknowledged_at", "is not", null)
          .orderBy("delegate_artifact_bindings.arrived_at")
          .orderBy("delegate_artifact_bindings.claim_id"),
      ).rows;
      const artifacts: DelegateArtifactSummaryV1[] = [];
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
          auditOperation({
            db,
            action: "list",
            outcome: resolved.outcome,
            claimId: binding.claim_id,
            ...("flowId" in resolved && resolved.flowId ? { flowId: resolved.flowId } : {}),
            recipientSessionKey: params.recipientSessionKey,
            recipientSessionId: params.recipientSessionId,
            now,
          });
          return { outcome: resolved.outcome };
        }
        artifacts.push(toDelegateArtifactSummaryV1(toClaim(resolved.claim)));
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
        return { status: "unavailable" } as const;
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
        return { status: "unavailable" } as const;
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
        return { status: "unavailable" } as const;
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
          .where("delegate_artifact_claims.status", "!=", "purged"),
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
