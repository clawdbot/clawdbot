import type { Static } from "typebox";
// Gateway Protocol schema module defines durable cross-surface approval shapes.
import { Type } from "typebox";
import { APPROVAL_ID_WELL_FORMED_UNICODE_PATTERN } from "./approval-id.js";
import { NonEmptyString } from "./primitives.js";

export { isWellFormedApprovalId } from "./approval-id.js";

const ApprovalIdSchema = Type.String({
  minLength: 1,
  pattern: APPROVAL_ID_WELL_FORMED_UNICODE_PATTERN,
  description: "Exact full approval id encoded safely in deep-link paths.",
});

/** Approval owner used to select the safe presentation payload. */
export const ApprovalKindSchema = Type.Union([Type.Literal("exec"), Type.Literal("plugin")]);

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
export const PluginApprovalPresentationSchema = Type.Object(
  {
    kind: Type.Literal("plugin"),
    title: Type.String({ minLength: 1, maxLength: 80 }),
    description: Type.String({ minLength: 1, maxLength: 512 }),
    severity: PluginApprovalSeveritySchema,
    pluginId: Type.Optional(Type.Union([NonEmptyString, Type.Null()])),
    toolName: Type.Optional(Type.Union([NonEmptyString, Type.Null()])),
    agentId: Type.Optional(Type.Union([NonEmptyString, Type.Null()])),
    allowedDecisions: ApprovalAllowedDecisionsSchema,
  },
  { additionalProperties: false },
);

/** Reviewer-safe presentation discriminated by the approval owner. */
export const ApprovalPresentationSchema = Type.Union([
  ExecApprovalPresentationSchema,
  PluginApprovalPresentationSchema,
]);

const ApprovalRecordCommonFields = {
  id: ApprovalIdSchema,
  urlPath: NonEmptyString,
  createdAtMs: Type.Integer({ minimum: 0 }),
  expiresAtMs: Type.Integer({ minimum: 0 }),
  presentation: ApprovalPresentationSchema,
};

const ApprovalResolutionFields = {
  resolvedAtMs: Type.Integer({ minimum: 0 }),
  reason: ApprovalTerminalReasonSchema,
};

/** Approval that has not yet accepted a reviewer decision. */
export const PendingApprovalSnapshotSchema = Type.Object(
  { ...ApprovalRecordCommonFields, status: Type.Literal("pending") },
  { additionalProperties: false },
);

/** Approval whose first recorded reviewer decision allows the operation. */
export const AllowedApprovalSnapshotSchema = Type.Object(
  {
    ...ApprovalRecordCommonFields,
    ...ApprovalResolutionFields,
    status: Type.Literal("allowed"),
    decision: ApprovalAllowDecisionSchema,
  },
  { additionalProperties: false },
);

/** Approval whose first recorded reviewer decision denies the operation. */
export const DeniedApprovalSnapshotSchema = Type.Object(
  {
    ...ApprovalRecordCommonFields,
    ...ApprovalResolutionFields,
    status: Type.Literal("denied"),
    decision: Type.Literal("deny"),
  },
  { additionalProperties: false },
);

/** Approval that reached its deadline and therefore failed closed. */
export const ExpiredApprovalSnapshotSchema = Type.Object(
  {
    ...ApprovalRecordCommonFields,
    ...ApprovalResolutionFields,
    status: Type.Literal("expired"),
  },
  { additionalProperties: false },
);

/** Approval cancelled by its runtime owner before a reviewer decision. */
export const CancelledApprovalSnapshotSchema = Type.Object(
  {
    ...ApprovalRecordCommonFields,
    ...ApprovalResolutionFields,
    status: Type.Literal("cancelled"),
  },
  { additionalProperties: false },
);

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
export const ApprovalGetParamsSchema = Type.Object(
  { id: ApprovalRecordCommonFields.id },
  { additionalProperties: false },
);

/** Current durable state for one authorized approval lookup. */
export const ApprovalGetResultSchema = Type.Object(
  { approval: ApprovalSnapshotSchema },
  { additionalProperties: false },
);

/** Reviewer decision for one approval identified by its exact full id. */
export const ApprovalResolveParamsSchema = Type.Object(
  {
    id: ApprovalRecordCommonFields.id,
    kind: ApprovalKindSchema,
    decision: ApprovalDecisionSchema,
  },
  { additionalProperties: false },
);

/** First-answer outcome plus the canonical recorded state returned to all contenders. */
export const ApprovalResolveResultSchema = Type.Object(
  {
    applied: Type.Boolean(),
    approval: TerminalApprovalSnapshotSchema,
  },
  { additionalProperties: false },
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
export type ApprovalPresentation = Static<typeof ApprovalPresentationSchema>;
export type PendingApprovalSnapshot = Static<typeof PendingApprovalSnapshotSchema>;
export type ApprovalSnapshot = Static<typeof ApprovalSnapshotSchema>;
export type ApprovalGetParams = Static<typeof ApprovalGetParamsSchema>;
export type ApprovalGetResult = Static<typeof ApprovalGetResultSchema>;
export type ApprovalResolveParams = Static<typeof ApprovalResolveParamsSchema>;
export type ApprovalResolveResult = Static<typeof ApprovalResolveResultSchema>;
export type AllowedApprovalSnapshot = Static<typeof AllowedApprovalSnapshotSchema>;
export type DeniedApprovalSnapshot = Static<typeof DeniedApprovalSnapshotSchema>;
export type ExpiredApprovalSnapshot = Static<typeof ExpiredApprovalSnapshotSchema>;
export type CancelledApprovalSnapshot = Static<typeof CancelledApprovalSnapshotSchema>;
export type TerminalApprovalSnapshot = Static<typeof TerminalApprovalSnapshotSchema>;
