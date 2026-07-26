// Validates and normalizes durable session delivery queue payloads.
import { z } from "zod";
import {
  DelegateArtifactRecipientProjectionSchema,
  type DelegateArtifactRecipientProjectionV1,
} from "../agents/delegate-artifacts.js";
import {
  normalizeContinuationTargetKey,
  normalizeContinuationTargetKeys,
} from "../auto-reply/continuation/targeting-pure.js";
import type { SourceReplyDeliveryMode } from "../auto-reply/source-reply-delivery-mode.types.js";
import type { ChatType } from "../channels/chat-type.js";
import type { InputProvenance } from "../sessions/input-provenance.js";
import {
  parseInlineAttachmentMountPath,
  validateInlineAttachmentSnapshots,
  type InlineAttachment,
  type InlineAttachmentMount,
} from "../shared/inline-attachments.js";
import type {
  DeliveryQueueCompletionRetention,
  DeliveryQueueEntryLoadResult,
  DeliveryQueueRowMetadata,
} from "./delivery-queue-sqlite.js";
import { normalizeDiagnosticTraceparent } from "./diagnostic-trace-context.js";
import {
  normalizeQueuedAttachmentRefs,
  stripQueuedAttachmentMountWithoutAttachments,
  type QueuedSessionDeliveryCommonMetadata,
  type QueuedSessionDeliveryPayloadMetadata,
} from "./session-delivery-queue-attachment-metadata.js";

export type SessionDeliveryContext = {
  channel?: string;
  to?: string;
  accountId?: string;
  threadId?: string | number;
};

export type DelegateArtifactDeliveryReceipt = {
  kind: "delegate-artifact";
  dispatchId: string;
  recipientSessionKey: string;
  recipientSessionId: string;
};

export type ManagedDelegateArtifactDelivery = {
  receipt: DelegateArtifactDeliveryReceipt;
  projection: DelegateArtifactRecipientProjectionV1;
};

type SessionDeliveryRetryPolicy = {
  maxRetries?: number;
  /** Retain terminal ownership when the durable producer can replay forever. */
  completionRetention?: DeliveryQueueCompletionRetention;
};

export type SessionDeliveryRoute = {
  channel: string;
  to: string;
  accountId?: string;
  replyToId?: string;
  threadId?: string;
  chatType: ChatType;
};

export type SessionDeliverySettledOutcome = "recovered" | "moved-to-failed";

/**
 * Durable payloads whose metadata can contain only descriptor references.
 * Inline attachment bytes are deliberately excluded from generic delivery
 * records: they are accepted only by the post-compaction handoff below.
 */
type QueuedSessionDeliveryGenericPayload =
  | ({
      kind: "systemEvent";
      sessionKey: string;
      text: string;
      expectedSessionId?: string;
      managedDelegateArtifactDelivery?: ManagedDelegateArtifactDelivery;
      deliveryContext?: SessionDeliveryContext;
      idempotencyKey?: string;
    } & QueuedSessionDeliveryPayloadMetadata)
  | ({
      kind: "agentTurn";
      sessionKey: string;
      message: string;
      messageId: string;
      expectedSessionId?: string;
      route?: SessionDeliveryRoute;
      deliveryContext?: SessionDeliveryContext;
      inputProvenance?: InputProvenance;
      sourceReplyDeliveryMode?: SourceReplyDeliveryMode;
      expectedMediaUrls?: string[];
      suppressTextDelivery?: true;
      idempotencyKey?: string;
    } & QueuedSessionDeliveryPayloadMetadata);

/**
 * The sole durable queue payload permitted to retain raw inline attachments.
 * It is consumed at the post-compaction seam and must not be widened into the
 * generic system-event/agent-turn metadata contract.
 */
type QueuedPostCompactionDelegatePayload = {
  kind: "postCompactionDelegate";
  sessionKey: string;
  task: string;
  createdAt: number;
  firstArmedAt?: number;
  silent?: boolean;
  silentWake?: boolean;
  targetSessionKey?: string;
  targetSessionKeys?: string[];
  fanoutMode?: "tree" | "all";
  returnOptions?: {
    artifacts?: "forbidden" | "optional" | "required";
  };
  recipientContext?: {
    purpose: string;
  };
  model?: string;
  attachments?: InlineAttachment[];
  attachAs?: InlineAttachmentMount;
  sourceFlowId?: string;
  sourceExpectedRevision?: number;
  deliveryContext?: SessionDeliveryContext;
  idempotencyKey?: string;
} & QueuedSessionDeliveryCommonMetadata;

export type QueuedSessionDeliveryPayload = (
  | QueuedSessionDeliveryGenericPayload
  | QueuedPostCompactionDelegatePayload
) &
  SessionDeliveryRetryPolicy;

export type QueuedSessionDeliveryPayloadWithRetry = QueuedSessionDeliveryPayload &
  SessionDeliveryRetryPolicy;

export type QueuedSessionDelivery = QueuedSessionDeliveryPayloadWithRetry & {
  id: string;
  enqueuedAt: number;
  agentRunAttempt?: number;
  lastChargedAgentRunAttempt?: number;
  retryCount: number;
  lastAttemptAt?: number;
  lastError?: string;
  deliveryStartedAt?: number;
  acknowledgedAt?: number;
  settlementOutcome?: SessionDeliverySettledOutcome;
  availableAt?: number;
};

const QueuedInlineAttachmentSchema = z
  .object({
    name: z.string(),
    content: z.string(),
    encoding: z.enum(["utf8", "base64"]).optional(),
    mimeType: z.string().optional(),
  })
  .strict();

const QueuedInlineAttachmentMountSchema = z
  .object({
    mountPath: z.string().optional(),
  })
  .strict()
  .transform((mount, ctx) => {
    const parsed = parseInlineAttachmentMountPath(mount.mountPath);
    if (parsed.status === "invalid") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "invalid attachment mount path",
      });
      return z.NEVER;
    }
    return parsed.status === "valid" ? { mountPath: parsed.mountPath } : undefined;
  });

const QueuedContinuationTargetKeySchema = z
  .string()
  .trim()
  .min(1)
  .transform((value) => normalizeContinuationTargetKey(value));

const QueuedContinuationTargetKeysSchema = z.array(z.string().trim().min(1)).transform((values) => {
  const normalized = normalizeContinuationTargetKeys(values);
  return normalized.length > 0 ? normalized : undefined;
});

const QueuedGenericDeliveryContextSchema = z
  .object({
    channel: z.string().optional(),
    to: z.string().optional(),
    accountId: z.string().optional(),
    threadId: z.union([z.string(), z.number()]).optional(),
  })
  .strict();

const QueuedGenericRouteSchema = z
  .object({
    channel: z.string(),
    to: z.string(),
    accountId: z.string().optional(),
    replyToId: z.string().optional(),
    threadId: z.string().optional(),
    chatType: z.enum(["direct", "group", "channel"]),
  })
  .strict();

const QueuedInputProvenanceSchema = z
  .object({
    kind: z.enum(["external_user", "inter_session", "internal_system"]),
    originSessionId: z.string().optional(),
    sourceSessionKey: z.string().optional(),
    sourceChannel: z.string().optional(),
    sourceTool: z.string().optional(),
  })
  .strict();

const QueuedGenericCommonSchema = {
  traceparent: z.string().optional(),
  traceparentProvenance: z.literal("internal").optional(),
  attachments: z.array(z.unknown()).optional(),
  maxRetries: z.number().int().nonnegative().optional(),
  completionRetention: z.literal("permanent").optional(),
  id: z.string().min(1),
  enqueuedAt: z.number(),
  retryCount: z.number().int().nonnegative(),
  agentRunAttempt: z.number().int().nonnegative().optional(),
  lastChargedAgentRunAttempt: z.number().int().nonnegative().optional(),
  lastAttemptAt: z.number().optional(),
  lastError: z.string().optional(),
  deliveryStartedAt: z.number().optional(),
  acknowledgedAt: z.number().optional(),
  settlementOutcome: z.enum(["recovered", "moved-to-failed"]).optional(),
  availableAt: z.number().optional(),
};

const DelegateArtifactDeliveryReceiptSchema = z
  .object({
    kind: z.literal("delegate-artifact"),
    dispatchId: z.string().min(1),
    recipientSessionKey: z.string().min(1),
    recipientSessionId: z.string().min(1),
  })
  .strict();

const QueuedSystemEventSchema = z
  .object({
    ...QueuedGenericCommonSchema,
    kind: z.literal("systemEvent"),
    sessionKey: z.string(),
    text: z.string(),
    expectedSessionId: z.string().optional(),
    managedDelegateArtifactDelivery: z
      .object({
        receipt: DelegateArtifactDeliveryReceiptSchema,
        projection: DelegateArtifactRecipientProjectionSchema,
      })
      .strict()
      .optional(),
    deliveryContext: QueuedGenericDeliveryContextSchema.optional(),
    idempotencyKey: z.string().optional(),
  })
  .strict()
  .superRefine((entry, ctx) => {
    const managed = entry.managedDelegateArtifactDelivery;
    if (!managed) {
      return;
    }
    if (
      entry.expectedSessionId !== managed.receipt.recipientSessionId ||
      entry.sessionKey !== managed.receipt.recipientSessionKey ||
      managed.projection.arrivalContext.dispatchId !== managed.receipt.dispatchId ||
      managed.projection.arrivalContext.binding.recipientSessionKey !==
        managed.receipt.recipientSessionKey ||
      managed.projection.arrivalContext.binding.recipientSessionId !==
        managed.receipt.recipientSessionId
    ) {
      ctx.addIssue({
        code: "custom",
        message: "managed delegate artifact delivery binding mismatch",
      });
    }
  });

const QueuedAgentTurnSchema = z
  .object({
    ...QueuedGenericCommonSchema,
    kind: z.literal("agentTurn"),
    sessionKey: z.string(),
    message: z.string(),
    messageId: z.string(),
    expectedSessionId: z.string().optional(),
    route: QueuedGenericRouteSchema.optional(),
    deliveryContext: QueuedGenericDeliveryContextSchema.optional(),
    inputProvenance: QueuedInputProvenanceSchema.optional(),
    sourceReplyDeliveryMode: z.enum(["automatic", "message_tool_only"]).optional(),
    expectedMediaUrls: z.array(z.string()).optional(),
    suppressTextDelivery: z.literal(true).optional(),
    idempotencyKey: z.string().optional(),
  })
  .strict();

const QueuedGenericDeliverySchema = z.discriminatedUnion("kind", [
  QueuedSystemEventSchema,
  QueuedAgentTurnSchema,
]);

const QueuedPostCompactionDelegateSchema = z
  .object({
    kind: z.literal("postCompactionDelegate"),
    sessionKey: z.string().trim().min(1),
    task: z.string().trim().min(1).max(4096),
    createdAt: z.number(),
    firstArmedAt: z.number().optional(),
    silent: z.boolean().optional(),
    silentWake: z.boolean().optional(),
    targetSessionKey: QueuedContinuationTargetKeySchema.optional(),
    targetSessionKeys: QueuedContinuationTargetKeysSchema.optional(),
    fanoutMode: z.enum(["tree", "all"]).optional(),
    returnOptions: z
      .object({
        artifacts: z.enum(["forbidden", "optional", "required"]).optional(),
      })
      .strict()
      .optional(),
    recipientContext: z
      .object({
        purpose: z.string().trim().min(1).max(1024),
      })
      .strict()
      .optional(),
    model: z.string().trim().min(1).optional(),
    attachments: z
      .array(QueuedInlineAttachmentSchema)
      .max(50)
      .transform((attachments) => (attachments.length > 0 ? attachments : undefined))
      .optional(),
    attachAs: QueuedInlineAttachmentMountSchema.optional(),
    sourceFlowId: z.string().optional(),
    sourceExpectedRevision: z.number().int().optional(),
    deliveryContext: z
      .object({
        channel: z.string().optional(),
        to: z.string().optional(),
        accountId: z.string().optional(),
        threadId: z.union([z.string(), z.number()]).optional(),
      })
      .strict()
      .optional(),
    idempotencyKey: z.string().optional(),
    traceparent: z.string().optional(),
    traceparentProvenance: z.literal("internal").optional(),
    maxRetries: z.number().int().nonnegative().optional(),
    completionRetention: z.literal("permanent").optional(),
    id: z.string().min(1),
    enqueuedAt: z.number(),
    retryCount: z.number().int().nonnegative(),
    agentRunAttempt: z.number().int().nonnegative().optional(),
    lastChargedAgentRunAttempt: z.number().int().nonnegative().optional(),
    lastAttemptAt: z.number().optional(),
    lastError: z.string().optional(),
    deliveryStartedAt: z.number().optional(),
    acknowledgedAt: z.number().optional(),
    settlementOutcome: z.enum(["recovered", "moved-to-failed"]).optional(),
    availableAt: z.number().optional(),
  })
  .strict()
  .superRefine((entry, ctx) => {
    if (
      entry.fanoutMode &&
      (entry.targetSessionKey || (entry.targetSessionKeys?.length ?? 0) > 0)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["fanoutMode"],
        message: "fanoutMode cannot be combined with explicit target keys",
      });
    }
    if (validateInlineAttachmentSnapshots({ attachments: entry.attachments })) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["attachments"],
        message: "invalid inline attachment snapshot",
      });
    }
  })
  .transform(stripQueuedAttachmentMountWithoutAttachments);

const INVALID_POST_COMPACTION_DELIVERY_JSON =
  "invalid postCompactionDelegate delivery payload: invalid JSON";
const INVALID_POST_COMPACTION_DELIVERY_SHAPE =
  "invalid postCompactionDelegate delivery payload: invalid shape";
const INVALID_GENERIC_DELIVERY_JSON = "invalid generic session delivery payload: invalid JSON";
const INVALID_GENERIC_DELIVERY_SHAPE = "invalid generic session delivery payload: invalid shape";
const INVALID_GENERIC_DELIVERY_ATTACHMENTS = "invalid generic session delivery attachment metadata";

type InvalidSessionDelivery = {
  id: string;
  enqueuedAt: number;
  retryCount: number;
};

export type DecodedSessionDelivery =
  | { status: "loaded"; entry: QueuedSessionDelivery }
  | { status: "invalid"; entry: InvalidSessionDelivery; error: string };

function invalidSessionDelivery(
  entry: InvalidSessionDelivery,
  error: string,
): DecodedSessionDelivery {
  return { status: "invalid", entry, error };
}

function decodeLoadedSessionDelivery(
  result: Extract<DeliveryQueueEntryLoadResult, { status: "loaded" }>,
): DecodedSessionDelivery {
  const item = result.entry as typeof result.entry & { kind?: unknown };
  const payloadKind = typeof item.kind === "string" ? item.kind : undefined;
  if (result.entryKind !== payloadKind) {
    return invalidSessionDelivery(
      result.entry,
      result.entryKind === "postCompactionDelegate" || payloadKind === "postCompactionDelegate"
        ? INVALID_POST_COMPACTION_DELIVERY_SHAPE
        : INVALID_GENERIC_DELIVERY_SHAPE,
    );
  }
  if (payloadKind !== "postCompactionDelegate") {
    const parsed = QueuedGenericDeliverySchema.safeParse(result.entry);
    if (!parsed.success) {
      return invalidSessionDelivery(result.entry, INVALID_GENERIC_DELIVERY_SHAPE);
    }
    const normalized = normalizeQueuedAttachmentRefs(result.entry as QueuedSessionDelivery);
    if (normalized !== result.entry) {
      return invalidSessionDelivery(result.entry, INVALID_GENERIC_DELIVERY_ATTACHMENTS);
    }
    return { status: "loaded", entry: normalized };
  }
  const parsed = QueuedPostCompactionDelegateSchema.safeParse(result.entry);
  return parsed.success
    ? { status: "loaded", entry: parsed.data as QueuedSessionDelivery }
    : invalidSessionDelivery(result.entry, INVALID_POST_COMPACTION_DELIVERY_SHAPE);
}

export function decodeSessionDeliveryResult(
  result: DeliveryQueueEntryLoadResult,
): DecodedSessionDelivery {
  if (result.status === "loaded") {
    return decodeLoadedSessionDelivery(result);
  }
  return invalidSessionDelivery(
    result.entry,
    result.entry.entryKind === "postCompactionDelegate"
      ? INVALID_POST_COMPACTION_DELIVERY_JSON
      : INVALID_GENERIC_DELIVERY_JSON,
  );
}

export function normalizeSessionDeliveryForPersistence(
  entry: QueuedSessionDelivery,
): QueuedSessionDelivery {
  if (entry.kind !== "postCompactionDelegate") {
    const normalized = normalizeQueuedAttachmentRefs(entry);
    const parsed = QueuedGenericDeliverySchema.safeParse(normalized);
    if (!parsed.success) {
      throw new Error(INVALID_GENERIC_DELIVERY_SHAPE);
    }
    return parsed.data as QueuedSessionDelivery;
  }
  const parsed = QueuedPostCompactionDelegateSchema.safeParse(entry);
  if (!parsed.success) {
    throw new Error(INVALID_POST_COMPACTION_DELIVERY_SHAPE);
  }
  return parsed.data as QueuedSessionDelivery;
}

export function normalizeQueuedSessionDeliveryTraceparent(
  payload: QueuedSessionDeliveryPayload,
): QueuedSessionDeliveryPayload {
  const normalizedTraceparent =
    payload.kind !== "postCompactionDelegate" || payload.traceparentProvenance === "internal"
      ? normalizeDiagnosticTraceparent(payload.traceparent)
      : undefined;
  const normalizedPayload: QueuedSessionDeliveryPayload = { ...payload };
  if (normalizedTraceparent) {
    normalizedPayload.traceparent = normalizedTraceparent;
    if (payload.kind === "postCompactionDelegate") {
      normalizedPayload.traceparentProvenance = "internal";
    }
  } else {
    delete normalizedPayload.traceparent;
    delete normalizedPayload.traceparentProvenance;
  }
  return normalizedPayload;
}

export function queuedSessionDeliveryMetadata(
  entry: QueuedSessionDelivery,
): DeliveryQueueRowMetadata {
  const route = entry.kind === "agentTurn" ? entry.route : undefined;
  return {
    entryKind: entry.kind,
    sessionKey: entry.sessionKey,
    channel: route?.channel ?? entry.deliveryContext?.channel,
    target: route?.to ?? entry.deliveryContext?.to,
    accountId: route?.accountId ?? entry.deliveryContext?.accountId,
  };
}
