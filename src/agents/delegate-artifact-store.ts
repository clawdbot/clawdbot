import { createHash } from "node:crypto";
import type { ArtifactSummary } from "@openclaw/gateway-protocol";
import { z } from "zod";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../infra/kysely-sync.js";
import { DELEGATE_ARTIFACTS_SCHEMA_SQL } from "../state/delegate-artifacts-schema.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
  type OpenClawStateDatabase,
  type OpenClawStateDatabaseOptions,
} from "../state/openclaw-state-db.js";

export const DELEGATE_ARTIFACT_OUTPUT_ROOT = ".openclaw/delegate-output";
export const DELEGATE_ARTIFACT_MAX_COUNT = 8;
export const DELEGATE_ARTIFACT_MAX_BYTES = 16 * 1024 * 1024;
export const DELEGATE_ARTIFACT_MAX_TOTAL_BYTES = 32 * 1024 * 1024;
export const DELEGATE_ARTIFACT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
export const DELEGATE_ARTIFACT_PURGE_BATCH_SIZE = 100;

const MIME_PATTERN = /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/;
export const ALLOWED_MIME_PATTERNS = [
  "image/*",
  "audio/*",
  "video/*",
  "text/*",
  "application/json",
  "application/pdf",
  "application/zip",
] as const;

type DelegateArtifactModeV1 = "forbidden" | "optional" | "required";

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

type DelegateArtifactClaim = {
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

type DelegateArtifactArrivalContextV1 = {
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
type DelegateArtifactDatabaseHandle = OpenClawStateDatabase["db"];

function hasControlCharacter(value: string): boolean {
  for (const char of value) {
    const code = char.charCodeAt(0);
    if (code < 0x20 || code === 0x7f) {
      return true;
    }
  }
  return false;
}

const PurposeSchema = z
  .string()
  .trim()
  .min(1)
  .refine((value) => Buffer.byteLength(value, "utf8") <= 1024)
  .refine((value) => !hasControlCharacter(value));
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

export const RecipientsSchema = z.array(RecipientSchema).min(1);
export const RouteSchema = z.discriminatedUnion("kind", [
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

const ensuredDatabases = new WeakSet<DelegateArtifactDatabaseHandle>();

export function artifactDb(db: DelegateArtifactDatabaseHandle) {
  return getNodeSqliteKysely<DelegateArtifactDatabase>(db);
}

export function ensureDelegateArtifactsSchema(options: OpenClawStateDatabaseOptions): void {
  const database = openOpenClawStateDatabase(options);
  if (ensuredDatabases.has(database.db)) {
    return;
  }
  runOpenClawStateWriteTransaction(
    ({ db }) => {
      // sqlite-allow-raw -- feature-local additive schema DDL; artifact rows use Kysely.
      db.exec(DELEGATE_ARTIFACTS_SCHEMA_SQL);
    },
    options,
    { operationLabel: "delegate-artifacts.schema.ensure" },
  );
  ensuredDatabases.add(database.db);
}

export function parseRecipients(
  row: Pick<PolicyRow, "recipients_json">,
): DelegateArtifactRecipientV1[] {
  return RecipientsSchema.parse(JSON.parse(row.recipients_json));
}

export function parseRoute(row: Pick<PolicyRow, "route_json">): DelegateArtifactRouteV1 {
  return RouteSchema.parse(JSON.parse(row.route_json));
}

export function policyRequiresCrossSessionGate(
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

export function isAllowedMime(mimeType: string, allowedPatterns: readonly string[]): boolean {
  if (!MIME_PATTERN.test(mimeType)) {
    return false;
  }
  return allowedPatterns.some((pattern) =>
    pattern.endsWith("/*") ? mimeType.startsWith(pattern.slice(0, -1)) : mimeType === pattern,
  );
}

export function parseAllowedMimePatterns(policy: PolicyRow): string[] | undefined {
  try {
    const parsed = AllowedMimePatternsSchema.safeParse(JSON.parse(policy.allowed_mimes_json));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

export function classifyArtifact(mimeType: string): { type: string; title: string } {
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

export function toClaim(row: ClaimRow): DelegateArtifactClaim {
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
    hasControlCharacter(value) ||
    value.includes("/") ||
    value.includes("\\") ||
    value.includes("://") ||
    /^[a-z][a-z0-9+.-]*:/i.test(value) ||
    /^bearer(?:\s|$)/i.test(value);
  if (unsafe || (field === "mimeType" && !MIME_PATTERN.test(value))) {
    throw new Error("invalid delegate artifact " + field);
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
    // SAFETY: sizeBytes is always supplied above from claim.sizeBytes, so despite SummarySchema marking it optional (for unrelated reuse), the parsed output always matches this type.
  }) as DelegateArtifactSummaryV1;
}

export function claimRowsForFlow(db: DelegateArtifactDatabaseHandle, flowId: string): ClaimRow[] {
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

export function projectionsForCompletedPolicy(params: {
  db: DelegateArtifactDatabaseHandle;
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

export function projectionMatchesDurableFacts(
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

export function auditOperation(params: {
  db: DelegateArtifactDatabaseHandle;
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

export function resolveClaimForRecipient(params: {
  db: DelegateArtifactDatabaseHandle;
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
