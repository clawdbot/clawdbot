import { z } from "zod";
import {
  normalizeAutomation,
  normalizeDiagnosticAction,
} from "./metadata-contract-normalization.ts";
import {
  WORKBOARD_ATTEMPT_STATUSES,
  WORKBOARD_DIAGNOSTIC_KINDS,
  WORKBOARD_DIAGNOSTIC_SEVERITIES,
  WORKBOARD_EVENT_KINDS,
  WORKBOARD_EXECUTION_MODES,
  WORKBOARD_EXECUTION_STATUSES,
  WORKBOARD_LINK_TYPES,
  WORKBOARD_NOTIFICATION_KINDS,
  WORKBOARD_PROOF_STATUSES,
  WORKBOARD_STATUSES,
  WORKBOARD_TEMPLATE_IDS,
  type WorkboardDiagnosticAction,
  type WorkboardEvent,
  type WorkboardExecution,
  type WorkboardMetadata,
} from "./types.ts";

const optionalStringSchema = z.string().optional().catch(undefined);
const optionalNumberSchema = z.number().optional().catch(undefined);
const trimmedRequiredStringSchema = z
  .string()
  .transform((value) => value.trim())
  .pipe(z.string().min(1));
const invalidArrayItemSchema = z.unknown().transform(() => null);

function tolerantArray<T>(schema: z.ZodType<T>) {
  return z
    .array(z.union([schema, invalidArrayItemSchema]))
    .transform((items) => items.filter((item): item is T => item !== null))
    .optional()
    .catch(undefined);
}

const workboardExecutionSchema = z
  .object({
    id: trimmedRequiredStringSchema,
    engine: optionalStringSchema.transform((value) => value?.trim() || undefined),
    mode: z.enum(WORKBOARD_EXECUTION_MODES),
    status: z.enum(WORKBOARD_EXECUTION_STATUSES).catch("idle"),
    model: optionalStringSchema.transform((value) => value?.trim() || undefined),
    sessionKey: optionalStringSchema,
    runId: optionalStringSchema,
    startedAt: z.number().refine((value) => value !== 0),
    updatedAt: optionalNumberSchema,
  })
  .transform(
    (value): WorkboardExecution => ({
      id: value.id,
      kind: "agent-session",
      mode: value.mode,
      status: value.status,
      startedAt: value.startedAt,
      updatedAt: value.updatedAt ?? value.startedAt,
      ...(value.engine ? { engine: value.engine } : {}),
      ...(value.model ? { model: value.model } : {}),
      ...(value.sessionKey !== undefined ? { sessionKey: value.sessionKey } : {}),
      ...(value.runId !== undefined ? { runId: value.runId } : {}),
    }),
  );

const workboardEventSchema = z
  .object({
    id: trimmedRequiredStringSchema,
    kind: z.enum(WORKBOARD_EVENT_KINDS),
    at: z
      .number()
      .finite()
      .refine((value) => value !== 0),
    fromStatus: z.enum(WORKBOARD_STATUSES).optional().catch(undefined),
    toStatus: z.enum(WORKBOARD_STATUSES).optional().catch(undefined),
    sessionKey: optionalStringSchema,
    runId: optionalStringSchema,
  })
  .transform(
    (value): WorkboardEvent => ({
      id: value.id,
      kind: value.kind,
      at: value.at,
      ...(value.fromStatus ? { fromStatus: value.fromStatus } : {}),
      ...(value.toStatus ? { toStatus: value.toStatus } : {}),
      ...(value.sessionKey !== undefined ? { sessionKey: value.sessionKey } : {}),
      ...(value.runId !== undefined ? { runId: value.runId } : {}),
    }),
  );

const attemptSchema = z
  .object({
    id: z.string(),
    status: z.enum(WORKBOARD_ATTEMPT_STATUSES).catch("running"),
    startedAt: z.number(),
    endedAt: optionalNumberSchema,
    engine: optionalStringSchema.transform((value) => value?.trim() || undefined),
    mode: z.enum(WORKBOARD_EXECUTION_MODES).optional().catch(undefined),
    model: optionalStringSchema,
    sessionKey: optionalStringSchema,
    runId: optionalStringSchema,
    error: optionalStringSchema,
  })
  .transform((value) => ({
    id: value.id,
    status: value.status,
    startedAt: value.startedAt,
    ...(value.endedAt !== undefined ? { endedAt: value.endedAt } : {}),
    ...(value.engine ? { engine: value.engine } : {}),
    ...(value.mode ? { mode: value.mode } : {}),
    ...(value.model !== undefined ? { model: value.model } : {}),
    ...(value.sessionKey !== undefined ? { sessionKey: value.sessionKey } : {}),
    ...(value.runId !== undefined ? { runId: value.runId } : {}),
    ...(value.error !== undefined ? { error: value.error } : {}),
  }));
const commentSchema = z
  .object({
    id: z.string(),
    body: z.string(),
    createdAt: z.number(),
    updatedAt: optionalNumberSchema,
  })
  .transform((value) => ({
    id: value.id,
    body: value.body,
    createdAt: value.createdAt,
    ...(value.updatedAt !== undefined ? { updatedAt: value.updatedAt } : {}),
  }));
const linkSchema = z
  .object({
    id: z.string(),
    type: z.enum(WORKBOARD_LINK_TYPES).catch("relates_to"),
    createdAt: z.number(),
    targetCardId: optionalStringSchema,
    title: optionalStringSchema,
    url: optionalStringSchema,
  })
  .transform((value) => ({
    id: value.id,
    type: value.type,
    createdAt: value.createdAt,
    ...(value.targetCardId !== undefined ? { targetCardId: value.targetCardId } : {}),
    ...(value.title !== undefined ? { title: value.title } : {}),
    ...(value.url !== undefined ? { url: value.url } : {}),
  }));
const proofSchema = z
  .object({
    id: z.string(),
    status: z.enum(WORKBOARD_PROOF_STATUSES).catch("unknown"),
    createdAt: z.number(),
    label: optionalStringSchema,
    command: optionalStringSchema,
    url: optionalStringSchema,
    note: optionalStringSchema,
  })
  .transform((value) => ({
    id: value.id,
    status: value.status,
    createdAt: value.createdAt,
    ...(value.label !== undefined ? { label: value.label } : {}),
    ...(value.command !== undefined ? { command: value.command } : {}),
    ...(value.url !== undefined ? { url: value.url } : {}),
    ...(value.note !== undefined ? { note: value.note } : {}),
  }));
const artifactSchema = z
  .object({
    id: z.string(),
    createdAt: z.number(),
    label: optionalStringSchema,
    url: optionalStringSchema,
    path: optionalStringSchema,
    mimeType: optionalStringSchema,
  })
  .transform((value) => ({
    id: value.id,
    createdAt: value.createdAt,
    ...(value.label !== undefined ? { label: value.label } : {}),
    ...(value.url !== undefined ? { url: value.url } : {}),
    ...(value.path !== undefined ? { path: value.path } : {}),
    ...(value.mimeType !== undefined ? { mimeType: value.mimeType } : {}),
  }));
const attachmentSchema = z
  .object({
    id: z.string(),
    cardId: z.string(),
    fileName: z.string(),
    byteSize: z.number(),
    createdAt: z.number(),
    mimeType: optionalStringSchema,
    note: optionalStringSchema,
  })
  .transform((value) => ({
    id: value.id,
    cardId: value.cardId,
    fileName: value.fileName,
    byteSize: value.byteSize,
    createdAt: value.createdAt,
    ...(value.mimeType !== undefined ? { mimeType: value.mimeType } : {}),
    ...(value.note !== undefined ? { note: value.note } : {}),
  }));
const workerLogSchema = z
  .object({
    id: z.string(),
    level: z.enum(["info", "warning", "error"]).catch("info"),
    message: z.string(),
    createdAt: z.number(),
    sessionKey: optionalStringSchema,
    runId: optionalStringSchema,
  })
  .transform((value) => ({
    id: value.id,
    level: value.level,
    message: value.message,
    createdAt: value.createdAt,
    ...(value.sessionKey !== undefined ? { sessionKey: value.sessionKey } : {}),
    ...(value.runId !== undefined ? { runId: value.runId } : {}),
  }));
const workerProtocolSchema = z
  .object({
    state: z.enum(["idle", "running", "completed", "blocked", "violated"]),
    updatedAt: z.number().catch(() => Date.now()),
    detail: optionalStringSchema,
  })
  .transform((value) => ({
    state: value.state,
    updatedAt: value.updatedAt,
    ...(value.detail !== undefined ? { detail: value.detail } : {}),
  }))
  .optional()
  .catch(undefined);
const claimSchema = z
  .object({
    ownerId: z.string(),
    token: z.string(),
    claimedAt: z.number(),
    lastHeartbeatAt: z.number(),
    expiresAt: optionalNumberSchema,
  })
  .transform((value) => ({
    ownerId: value.ownerId,
    token: value.token,
    claimedAt: value.claimedAt,
    lastHeartbeatAt: value.lastHeartbeatAt,
    ...(value.expiresAt !== undefined ? { expiresAt: value.expiresAt } : {}),
  }))
  .optional()
  .catch(undefined);
const diagnosticSchema = z
  .object({
    kind: z.enum(WORKBOARD_DIAGNOSTIC_KINDS),
    severity: z.enum(WORKBOARD_DIAGNOSTIC_SEVERITIES),
    title: z.string(),
    detail: optionalStringSchema,
    firstSeenAt: optionalNumberSchema,
    lastSeenAt: optionalNumberSchema,
    count: optionalNumberSchema,
    actions: z
      .array(z.unknown())
      .transform((actions) =>
        actions
          .map(normalizeDiagnosticAction)
          .filter((action): action is WorkboardDiagnosticAction => action !== null),
      )
      .optional()
      .catch(undefined),
  })
  .transform((value) => ({
    kind: value.kind,
    severity: value.severity,
    title: value.title,
    detail: value.detail ?? value.title,
    firstSeenAt: value.firstSeenAt ?? Date.now(),
    lastSeenAt: value.lastSeenAt ?? Date.now(),
    count: value.count ?? 1,
    actions: value.actions ?? [],
  }));
const notificationSchema = z
  .object({
    id: z.string(),
    kind: z.enum(WORKBOARD_NOTIFICATION_KINDS),
    message: z.string(),
    createdAt: z.number(),
    sequence: optionalNumberSchema,
    sessionKey: optionalStringSchema,
    runId: optionalStringSchema,
  })
  .transform((value) => ({
    id: value.id,
    kind: value.kind,
    message: value.message,
    createdAt: value.createdAt,
    ...(value.sequence !== undefined ? { sequence: value.sequence } : {}),
    ...(value.sessionKey !== undefined ? { sessionKey: value.sessionKey } : {}),
    ...(value.runId !== undefined ? { runId: value.runId } : {}),
  }));
const staleSchema = z
  .object({
    detectedAt: optionalNumberSchema,
    lastSessionUpdatedAt: optionalNumberSchema,
    reason: optionalStringSchema,
  })
  .transform((value) => ({
    detectedAt: value.detectedAt ?? Date.now(),
    ...(value.lastSessionUpdatedAt !== undefined
      ? { lastSessionUpdatedAt: value.lastSessionUpdatedAt }
      : {}),
    reason: value.reason ?? "Session has not reported recent activity.",
  }))
  .optional()
  .catch(undefined);

const workboardMetadataSchema = z
  .object({
    attempts: tolerantArray(attemptSchema),
    comments: tolerantArray(commentSchema),
    links: tolerantArray(linkSchema),
    proof: tolerantArray(proofSchema),
    artifacts: tolerantArray(artifactSchema),
    attachments: tolerantArray(attachmentSchema),
    workerLogs: tolerantArray(workerLogSchema),
    workerProtocol: workerProtocolSchema,
    automation: z.unknown().transform(normalizeAutomation).optional(),
    claim: claimSchema,
    diagnostics: tolerantArray(diagnosticSchema),
    notifications: tolerantArray(notificationSchema),
    templateId: z.enum(WORKBOARD_TEMPLATE_IDS).optional().catch(undefined),
    archivedAt: optionalNumberSchema,
    stale: staleSchema,
    lifecycleStatusSourceUpdatedAt: z
      .number()
      .finite()
      .transform((value) => Math.max(0, Math.trunc(value)))
      .optional()
      .catch(undefined),
    failureCount: optionalNumberSchema,
  })
  .transform((value): WorkboardMetadata | undefined => {
    const metadata: WorkboardMetadata = {
      ...(value.attempts?.length ? { attempts: value.attempts } : {}),
      ...(value.comments?.length ? { comments: value.comments } : {}),
      ...(value.links?.length ? { links: value.links } : {}),
      ...(value.proof?.length ? { proof: value.proof } : {}),
      ...(value.artifacts?.length ? { artifacts: value.artifacts } : {}),
      ...(value.attachments?.length ? { attachments: value.attachments } : {}),
      ...(value.workerLogs?.length ? { workerLogs: value.workerLogs } : {}),
      ...(value.workerProtocol ? { workerProtocol: value.workerProtocol } : {}),
      ...(value.automation ? { automation: value.automation } : {}),
      ...(value.claim ? { claim: value.claim } : {}),
      ...(value.diagnostics?.length ? { diagnostics: value.diagnostics } : {}),
      ...(value.notifications?.length ? { notifications: value.notifications } : {}),
      ...(value.templateId ? { templateId: value.templateId } : {}),
      ...(value.archivedAt !== undefined ? { archivedAt: value.archivedAt } : {}),
      ...(value.stale ? { stale: value.stale } : {}),
      ...(value.lifecycleStatusSourceUpdatedAt !== undefined
        ? { lifecycleStatusSourceUpdatedAt: value.lifecycleStatusSourceUpdatedAt }
        : {}),
      ...(value.failureCount !== undefined ? { failureCount: value.failureCount } : {}),
    };
    return Object.keys(metadata).length ? metadata : undefined;
  });

export function normalizeExecution(value: unknown): WorkboardExecution | undefined {
  const result = workboardExecutionSchema.safeParse(value);
  return result.success ? result.data : undefined;
}

export function normalizeEvents(value: unknown): WorkboardEvent[] {
  const result = tolerantArray(workboardEventSchema).safeParse(value);
  return result.success ? (result.data ?? []) : [];
}

export function normalizeMetadata(value: unknown): WorkboardMetadata | undefined {
  const result = workboardMetadataSchema.safeParse(value);
  return result.success ? result.data : undefined;
}
