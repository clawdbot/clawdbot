// Validates and normalizes durable session delivery queue payloads.
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { z } from "zod";
import {
  DelegateArtifactRecipientProjectionSchema,
  type DelegateArtifactRecipientProjectionV1,
} from "../agents/delegate-artifacts.js";
import {
  normalizeContinuationTargetKey,
  normalizeContinuationTargetKeys,
} from "../auto-reply/continuation/targeting-pure.js";
import type { ContinuationTrigger } from "../auto-reply/get-reply-options.types.js";
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
  hasOnlyGenericAttachmentRefs,
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

type ManagedDelegateArtifactDelivery = {
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

type SessionDeliveryOwnerReference = {
  kind: "subagent_completion";
  runId: string;
  taskId: string;
  generation: number;
  deadlineAt: number;
};

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
      managedDelegateArtifactDelivery?: never;
      deliveryContext?: SessionDeliveryContext;
      idempotencyKey?: string;
      /**
       * Keep the durable row pending until the prompt actually adopts the event
       * and acknowledges it, instead of completing the row as soon as the
       * in-memory enqueue makes the prompt eligible. Same contract the managed
       * delegate-return path relies on; opt-in so existing producers, whose
       * notices are reconstructible from their own durable state, keep the
       * cheaper fire-and-complete behavior.
       */
      awaitPromptAdoption?: boolean;
    } & QueuedSessionDeliveryPayloadMetadata)
  | ({
      kind: "systemEvent";
      sessionKey: string;
      text: string;
      expectedSessionId: string;
      managedDelegateArtifactDelivery: ManagedDelegateArtifactDelivery;
      deliveryContext?: SessionDeliveryContext;
      idempotencyKey?: string;
      /** Always implied for managed rows; declared so the union stays readable. */
      awaitPromptAdoption?: boolean;
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
      continuationTrigger?: ContinuationTrigger;
      expectedMediaUrls?: string[];
      suppressTextDelivery?: true;
      idempotencyKey?: string;
      owner?: SessionDeliveryOwnerReference;
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

type QueuedSessionDeliveryPayloadWithRetry = QueuedSessionDeliveryPayload &
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

function parseQueuedAttachmentMountPath(
  value: unknown,
  options: { requireCanonicalInput?: boolean } = {},
) {
  const parsed = parseInlineAttachmentMountPath(value);
  if (parsed.status !== "valid") {
    if (
      parsed.status === "absent" &&
      options.requireCanonicalInput === true &&
      value !== undefined &&
      value !== null
    ) {
      return { status: "invalid" } as const;
    }
    return parsed;
  }
  if (
    (options.requireCanonicalInput === true && value !== parsed.mountPath) ||
    parsed.mountPath.startsWith("/") ||
    parsed.mountPath.endsWith("/") ||
    parsed.mountPath.includes("//") ||
    !/^[A-Za-z0-9._\-/]+$/.test(parsed.mountPath) ||
    parsed.mountPath.split("/").some((segment) => segment === "." || segment === "..")
  ) {
    return { status: "invalid" } as const;
  }
  return parsed;
}

const QueuedInlineAttachmentMountSchema = z
  .object({
    mountPath: z.string().optional(),
  })
  .strict()
  .transform((mount, ctx) => {
    const parsed = parseQueuedAttachmentMountPath(mount.mountPath, {
      requireCanonicalInput: true,
    });
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

const QueuedPlainSystemEventSchema = z
  .object({
    ...QueuedGenericCommonSchema,
    kind: z.literal("systemEvent"),
    sessionKey: z.string(),
    text: z.string(),
    expectedSessionId: z.string().optional(),
    managedDelegateArtifactDelivery: z.never().optional(),
    deliveryContext: QueuedGenericDeliveryContextSchema.optional(),
    idempotencyKey: z.string().optional(),
    awaitPromptAdoption: z.boolean().optional(),
  })
  .strict();

const QueuedManagedSystemEventSchema = z
  .object({
    ...QueuedGenericCommonSchema,
    kind: z.literal("systemEvent"),
    sessionKey: z.string(),
    text: z.string(),
    expectedSessionId: z.string().min(1),
    managedDelegateArtifactDelivery: z
      .object({
        receipt: DelegateArtifactDeliveryReceiptSchema,
        projection: DelegateArtifactRecipientProjectionSchema,
      })
      .strict(),
    deliveryContext: QueuedGenericDeliveryContextSchema.optional(),
    idempotencyKey: z.string().optional(),
    awaitPromptAdoption: z.boolean().optional(),
  })
  .strict()
  .superRefine((entry, ctx) => {
    const managed = entry.managedDelegateArtifactDelivery;
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
    continuationTrigger: z.enum(["work-wake", "delegate-return", "subagent-return"]).optional(),
    expectedMediaUrls: z.array(z.string()).optional(),
    suppressTextDelivery: z.literal(true).optional(),
    idempotencyKey: z.string().optional(),
    owner: z
      .object({
        kind: z.literal("subagent_completion"),
        runId: z.string().min(1),
        taskId: z.string().min(1),
        generation: z.number().int().positive(),
        deadlineAt: z.number(),
      })
      .strict()
      .optional(),
  })
  .strict();

const QueuedGenericDeliverySchema = z.union([
  QueuedPlainSystemEventSchema,
  QueuedManagedSystemEventSchema,
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
    if ((entry.sourceFlowId === undefined) !== (entry.sourceExpectedRevision === undefined)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: entry.sourceFlowId === undefined ? ["sourceFlowId"] : ["sourceExpectedRevision"],
        message: "source flow id and expected revision must be provided together",
      });
    }
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

function normalizeQueuedPostCompactionMountForPersistence(
  entry: QueuedSessionDelivery,
): QueuedSessionDelivery {
  if (entry.kind !== "postCompactionDelegate") {
    return entry;
  }
  const rawAttachAs = entry.attachAs;
  if (
    rawAttachAs === undefined ||
    !rawAttachAs ||
    typeof rawAttachAs !== "object" ||
    Array.isArray(rawAttachAs)
  ) {
    return entry;
  }
  const mountPath = rawAttachAs.mountPath;
  const parsed = parseQueuedAttachmentMountPath(mountPath);
  if (parsed.status === "invalid") {
    return entry;
  }
  if (parsed.status === "absent") {
    const normalized = { ...entry };
    delete normalized.attachAs;
    return normalized;
  }
  if (mountPath === parsed.mountPath) {
    return entry;
  }
  return {
    ...entry,
    attachAs: { ...rawAttachAs, mountPath: parsed.mountPath },
  };
}

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

type DecodedSessionDelivery =
  | { status: "loaded"; entry: QueuedSessionDelivery }
  | { status: "invalid"; entry: InvalidSessionDelivery; error: string; entryJson: string };

// `entryJson` carries the persisted text unchanged so the dead-letter write can
// guard on the exact pending row it rejected. `entry` stays reduced to the
// payload-free identity fields, so no rejected bytes survive into the terminal row.
function invalidSessionDelivery(
  entry: InvalidSessionDelivery,
  error: string,
  entryJson: string,
): DecodedSessionDelivery {
  return { status: "invalid", entry, error, entryJson };
}

function decodeLoadedSessionDelivery(
  result: Extract<DeliveryQueueEntryLoadResult, { status: "loaded" }>,
): DecodedSessionDelivery {
  const item: Record<string, unknown> = isRecord(result.entry) ? result.entry : {};
  const payloadKind = typeof item.kind === "string" ? item.kind : undefined;
  if (result.entryKind !== payloadKind) {
    return invalidSessionDelivery(
      result.entry,
      result.entryKind === "postCompactionDelegate" || payloadKind === "postCompactionDelegate"
        ? INVALID_POST_COMPACTION_DELIVERY_SHAPE
        : INVALID_GENERIC_DELIVERY_SHAPE,
      result.entryJson,
    );
  }
  if (payloadKind !== "postCompactionDelegate") {
    const parsed = QueuedGenericDeliverySchema.safeParse(result.entry);
    if (!parsed.success) {
      return invalidSessionDelivery(result.entry, INVALID_GENERIC_DELIVERY_SHAPE, result.entryJson);
    }
    // SAFETY: parsed.success above confirms result.entry structurally matches QueuedSessionDelivery.
    const validatedEntry = result.entry as QueuedSessionDelivery;
    const attachmentNormalized = normalizeQueuedAttachmentRefs(validatedEntry);
    if (
      attachmentNormalized !== result.entry ||
      !hasOnlyGenericAttachmentRefs(attachmentNormalized)
    ) {
      return invalidSessionDelivery(
        result.entry,
        INVALID_GENERIC_DELIVERY_ATTACHMENTS,
        result.entryJson,
      );
    }
    const traceparentNormalized = normalizeQueuedSessionDeliveryTraceparent(attachmentNormalized);
    // SAFETY: normalizeQueuedSessionDeliveryTraceparent only rewrites traceparent fields, preserving all other input properties including the identity fields QueuedSessionDelivery adds.
    const normalized = traceparentNormalized as QueuedSessionDelivery;
    return { status: "loaded", entry: normalized };
  }
  const parsed = QueuedPostCompactionDelegateSchema.safeParse(result.entry);
  if (!parsed.success) {
    return invalidSessionDelivery(
      result.entry,
      INVALID_POST_COMPACTION_DELIVERY_SHAPE,
      result.entryJson,
    );
  }
  // SAFETY: parsed.success above confirms result.entry structurally matches QueuedSessionDelivery.
  return { status: "loaded", entry: parsed.data as QueuedSessionDelivery };
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
    result.entryJson,
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
    if (!hasOnlyGenericAttachmentRefs(parsed.data)) {
      throw new Error(INVALID_GENERIC_DELIVERY_ATTACHMENTS);
    }
    // SAFETY: parsed.success above confirms normalized structurally matches QueuedSessionDelivery.
    return parsed.data as QueuedSessionDelivery;
  }
  const parsed = QueuedPostCompactionDelegateSchema.safeParse(
    normalizeQueuedPostCompactionMountForPersistence(entry),
  );
  if (!parsed.success) {
    throw new Error(INVALID_POST_COMPACTION_DELIVERY_SHAPE);
  }
  // SAFETY: parsed.success above confirms the normalized entry structurally matches QueuedSessionDelivery.
  return parsed.data as QueuedSessionDelivery;
}

export function normalizeQueuedSessionDeliveryTraceparent(
  payload: QueuedSessionDeliveryPayload,
): QueuedSessionDeliveryPayload {
  const normalizedTraceparent =
    (payload.kind !== "postCompactionDelegate" && payload.kind !== "agentTurn") ||
    payload.traceparentProvenance === "internal"
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
