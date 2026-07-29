import type { Static } from "typebox";
// Gateway Protocol schema module defines durable cross-surface approval shapes.
import { Type } from "typebox";
import { APPROVAL_ID_WELL_FORMED_UNICODE_PATTERN } from "./approval-id.js";
import { closedObject } from "./closed-object.js";
import { NonEmptyString } from "./primitives.js";
import { withSince } from "./since.js";

export { isWellFormedApprovalId } from "./approval-id.js";

const ApprovalIdSchema = Type.String({
  minLength: 1,
  pattern: APPROVAL_ID_WELL_FORMED_UNICODE_PATTERN,
  description: "Exact full approval id encoded safely in deep-link paths.",
});

/** Approval owner used to select the safe presentation payload. */
export const ApprovalKindSchema = Type.Union([
  Type.Literal("exec"),
  Type.Literal("plugin"),
  Type.Literal("system-agent"),
]);

/** Reviewer decisions accepted by the unified approval resolver. */
export const ApprovalDecisionSchema = Type.Union([
  Type.Literal("allow-once"),
  Type.Literal("allow-always"),
  Type.Literal("deny"),
]);

/** Reviewer decisions that permit an operation to proceed. */
export const ApprovalAllowDecisionSchema = Type.Union([
  Type.Literal("allow-once"),
  Type.Literal("allow-always"),
]);

/** Closed reason recorded for a terminal approval transition. */
export const ApprovalTerminalReasonSchema = Type.Union([
  Type.Literal("user"),
  Type.Literal("timeout"),
  Type.Literal("malformed-verdict"),
  Type.Literal("no-route"),
  Type.Literal("run-aborted"),
  Type.Literal("gateway-restart"),
  Type.Literal("storage-corrupt"),
]);

/** Terminal reason accepted for an allowed approval. */
export const ApprovalAllowedReasonSchema = Type.Union([Type.Literal("user")]);

/** Terminal reasons accepted for a denied approval. */
export const ApprovalDeniedReasonSchema = Type.Union([
  Type.Literal("user"),
  Type.Literal("malformed-verdict"),
  Type.Literal("no-route"),
  Type.Literal("storage-corrupt"),
]);

/** Terminal reason accepted for an expired approval. */
export const ApprovalExpiredReasonSchema = Type.Union([Type.Literal("timeout")]);

/** Terminal reasons accepted for a cancelled approval. */
export const ApprovalCancelledReasonSchema = Type.Union([
  Type.Literal("run-aborted"),
  Type.Literal("gateway-restart"),
]);

/** Reviewer-facing severity for plugin-owned approval requests. */
export const PluginApprovalSeveritySchema = Type.Union([
  Type.Literal("info"),
  Type.Literal("warning"),
  Type.Literal("critical"),
]);

const ApprovalAllowedDecisionsSchema = Type.Array(ApprovalDecisionSchema, {
  minItems: 1,
  maxItems: 3,
  uniqueItems: true,
  contains: Type.Literal("deny"),
  description:
    "Available reviewer decisions. Deny is always available so malformed or unsafe input can fail closed.",
});

const SystemAgentApprovalAllowedDecisionsSchema = Type.Tuple([
  Type.Literal("allow-once"),
  Type.Literal("deny"),
]);

/** Redacted exec details safe to persist and render outside the requesting runtime. */
export const ExecApprovalPresentationSchema = Type.Object(
  {
    kind: Type.Literal("exec"),
    commandText: NonEmptyString,
    commandPreview: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    warningText: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    host: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    nodeId: Type.Optional(Type.Union([NonEmptyString, Type.Null()])),
    agentId: Type.Optional(Type.Union([NonEmptyString, Type.Null()])),
    allowedDecisions: ApprovalAllowedDecisionsSchema,
  },
  {
    additionalProperties: false,
    description:
      "Reviewer-safe exec presentation. Runtime cwd, environment, system-run binding, and execution plan are intentionally excluded.",
  },
);

/** Plugin-supplied reviewer text safe to persist and render across surfaces. */
export const PluginApprovalPresentationSchema = closedObject({
  kind: Type.Literal("plugin"),
  title: Type.String({ minLength: 1, maxLength: 80 }),
  description: Type.String({ minLength: 1, maxLength: 512 }),
  detail: Type.Optional(Type.String({ minLength: 1, maxLength: 16_384 })),
  severity: PluginApprovalSeveritySchema,
  pluginId: Type.Optional(Type.Union([NonEmptyString, Type.Null()])),
  toolName: Type.Optional(Type.Union([NonEmptyString, Type.Null()])),
  agentId: Type.Optional(Type.Union([NonEmptyString, Type.Null()])),
  allowedDecisions: ApprovalAllowedDecisionsSchema,
});

/** Reviewer-safe OpenClaw system change. Exact operation stays host-local. */
export const SystemAgentApprovalPresentationSchema = closedObject({
  kind: Type.Literal("system-agent"),
  title: Type.String({ minLength: 1, maxLength: 80 }),
  description: Type.String({ minLength: 1, maxLength: 512 }),
  proposalHash: Type.String({ pattern: "^[a-f0-9]{64}$" }),
  agentId: Type.Optional(Type.Union([NonEmptyString, Type.Null()])),
  allowedDecisions: SystemAgentApprovalAllowedDecisionsSchema,
});

/** Reviewer-safe presentation discriminated by the approval owner. */
export const ApprovalPresentationSchema = Type.Union([
  ExecApprovalPresentationSchema,
  PluginApprovalPresentationSchema,
  SystemAgentApprovalPresentationSchema,
]);

const ApprovalRecordCommonFields = {
  id: ApprovalIdSchema,
  urlPath: NonEmptyString,
  createdAtMs: Type.Integer({ minimum: 0 }),
  expiresAtMs: Type.Integer({ minimum: 0 }),
  presentation: ApprovalPresentationSchema,
};

/** Reviewer-safe origin attribution for terminal approval history. */
const ApprovalHistorySourceAttributionSchema = closedObject({
  agentId: Type.Optional(NonEmptyString),
  sessionKey: Type.Optional(NonEmptyString),
});

/** Reviewer attribution recorded by the durable approval ledger. */
const ApprovalHistoryResolverAttributionSchema = closedObject({
  kind: Type.Union([
    Type.Literal("device"),
    Type.Literal("channel"),
    Type.Literal("runtime"),
    Type.Literal("system"),
  ]),
  id: Type.Optional(NonEmptyString),
});

const ApprovalResolutionFields = {
  resolvedAtMs: Type.Integer({ minimum: 0 }),
  source: Type.Optional(ApprovalHistorySourceAttributionSchema),
  resolver: Type.Optional(ApprovalHistoryResolverAttributionSchema),
};

/** Approval that has not yet accepted a reviewer decision. */
export const PendingApprovalSnapshotSchema = closedObject({
  ...ApprovalRecordCommonFields,
  status: Type.Literal("pending"),
});

/** Approval whose first recorded reviewer decision allows the operation. */
export const AllowedApprovalSnapshotSchema = closedObject({
  ...ApprovalRecordCommonFields,
  ...ApprovalResolutionFields,
  status: Type.Literal("allowed"),
  decision: ApprovalAllowDecisionSchema,
  reason: ApprovalAllowedReasonSchema,
});

/** Approval whose first recorded reviewer decision denies the operation. */
export const DeniedApprovalSnapshotSchema = closedObject({
  ...ApprovalRecordCommonFields,
  ...ApprovalResolutionFields,
  status: Type.Literal("denied"),
  decision: Type.Literal("deny"),
  reason: ApprovalDeniedReasonSchema,
});

/** Approval that reached its deadline and therefore failed closed. */
export const ExpiredApprovalSnapshotSchema = closedObject({
  ...ApprovalRecordCommonFields,
  ...ApprovalResolutionFields,
  status: Type.Literal("expired"),
  reason: ApprovalExpiredReasonSchema,
});

/** Approval cancelled by its runtime owner before a reviewer decision. */
export const CancelledApprovalSnapshotSchema = closedObject({
  ...ApprovalRecordCommonFields,
  ...ApprovalResolutionFields,
  status: Type.Literal("cancelled"),
  reason: ApprovalCancelledReasonSchema,
});

/** Durable approval projection returned identically to every authorized surface. */
export const ApprovalSnapshotSchema = Type.Union([
  PendingApprovalSnapshotSchema,
  AllowedApprovalSnapshotSchema,
  DeniedApprovalSnapshotSchema,
  ExpiredApprovalSnapshotSchema,
  CancelledApprovalSnapshotSchema,
]);

/** Durable terminal approval state returned after a resolution attempt. */
export const TerminalApprovalSnapshotSchema = Type.Union([
  AllowedApprovalSnapshotSchema,
  DeniedApprovalSnapshotSchema,
  ExpiredApprovalSnapshotSchema,
  CancelledApprovalSnapshotSchema,
]);

/** Lookup payload for one approval by its exact full id. */
export const ApprovalGetParamsSchema = closedObject({ id: ApprovalRecordCommonFields.id });

/** Current durable state for one authorized approval lookup. */
export const ApprovalGetResultSchema = closedObject({ approval: ApprovalSnapshotSchema });

/** Cursor-based query for the retained terminal approval ledger. */
export const ApprovalHistoryParamsSchema = closedObject({
  cursor: Type.Optional(Type.String({ minLength: 1, maxLength: 512 })),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
  kind: Type.Optional(ApprovalKindSchema),
});

/** Newest-first page from the retained terminal approval ledger. */
export const ApprovalHistoryResultSchema = closedObject({
  items: Type.Array(TerminalApprovalSnapshotSchema),
  nextCursor: Type.Optional(Type.String({ minLength: 1, maxLength: 512 })),
});

/** Reviewer decision for one approval identified by its exact full id. */
export const ApprovalResolveParamsSchema = closedObject({
  id: ApprovalRecordCommonFields.id,
  kind: ApprovalKindSchema,
  decision: ApprovalDecisionSchema,
});

/** First-answer outcome plus the canonical recorded state returned to all contenders. */
export const ApprovalResolveResultSchema = closedObject({
  applied: Type.Boolean(),
  approval: TerminalApprovalSnapshotSchema,
});

const SessionApprovalEventCommonFields = {
  sessionKey: NonEmptyString,
  sourceSessionKey: Type.Optional(NonEmptyString),
  updatedAtMs: Type.Integer({ minimum: 0 }),
};

/** Sanitized pending transition delivered only to an opted-in session audience. */
export const PendingSessionApprovalEventSchema = withSince(
  "2026.7",
  closedObject({
    ...SessionApprovalEventCommonFields,
    phase: Type.Literal("pending"),
    approval: PendingApprovalSnapshotSchema,
  }),
);

/** Sanitized terminal transition delivered only to an opted-in session audience. */
export const TerminalSessionApprovalEventSchema = withSince(
  "2026.7",
  closedObject({
    ...SessionApprovalEventCommonFields,
    phase: Type.Literal("terminal"),
    approval: TerminalApprovalSnapshotSchema,
  }),
);

/** Sanitized approval transition delivered only to an opted-in session audience. */
export const SessionApprovalEventSchema = withSince(
  "2026.7",
  Type.Union([PendingSessionApprovalEventSchema, TerminalSessionApprovalEventSchema]),
);

/** Authoritative pending approval set returned when a session stream subscribes. */
export const SessionApprovalReplaySchema = withSince(
  "2026.7",
  closedObject({
    sessionKey: NonEmptyString,
    updatedAtMs: Type.Integer({ minimum: 0 }),
    approvals: Type.Array(PendingApprovalSnapshotSchema),
    truncated: Type.Boolean(),
  }),
);

// Owner-local wire types derived directly from local schema consts so the
// public plugin-sdk declaration graph never pulls in the ProtocolSchemas registry.
export type ApprovalKind = Static<typeof ApprovalKindSchema>;
export type ApprovalDecision = Static<typeof ApprovalDecisionSchema>;
export type ApprovalAllowDecision = Static<typeof ApprovalAllowDecisionSchema>;
export type ApprovalTerminalReason = Static<typeof ApprovalTerminalReasonSchema>;
export type PluginApprovalSeverity = Static<typeof PluginApprovalSeveritySchema>;
export type ExecApprovalPresentation = Static<typeof ExecApprovalPresentationSchema>;
export type PluginApprovalPresentation = Static<typeof PluginApprovalPresentationSchema>;
export type SystemAgentApprovalPresentation = Static<typeof SystemAgentApprovalPresentationSchema>;
export type ApprovalPresentation = Static<typeof ApprovalPresentationSchema>;
export type PendingApprovalSnapshot = Static<typeof PendingApprovalSnapshotSchema>;
export type ApprovalSnapshot = Static<typeof ApprovalSnapshotSchema>;
export type ApprovalGetParams = Static<typeof ApprovalGetParamsSchema>;
export type ApprovalGetResult = Static<typeof ApprovalGetResultSchema>;
export type ApprovalHistoryParams = Static<typeof ApprovalHistoryParamsSchema>;
export type ApprovalHistoryResult = Static<typeof ApprovalHistoryResultSchema>;
export type ApprovalResolveParams = Static<typeof ApprovalResolveParamsSchema>;
export type ApprovalResolveResult = Static<typeof ApprovalResolveResultSchema>;
export type AllowedApprovalSnapshot = Static<typeof AllowedApprovalSnapshotSchema>;
export type DeniedApprovalSnapshot = Static<typeof DeniedApprovalSnapshotSchema>;
export type ExpiredApprovalSnapshot = Static<typeof ExpiredApprovalSnapshotSchema>;
export type CancelledApprovalSnapshot = Static<typeof CancelledApprovalSnapshotSchema>;
export type TerminalApprovalSnapshot = Static<typeof TerminalApprovalSnapshotSchema>;
export type SessionApprovalEvent = Static<typeof SessionApprovalEventSchema>;
export type SessionApprovalReplay = Static<typeof SessionApprovalReplaySchema>;
