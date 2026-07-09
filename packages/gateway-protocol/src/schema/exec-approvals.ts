// Gateway Protocol schema module defines protocol validation shapes.
import { Type } from "typebox";
import { NonEmptyString } from "./primitives.js";

/**
 * Exec approval protocol schemas.
 *
 * These payloads cross the security-review boundary for command execution, so
 * persisted policy, request snapshots, and resolve decisions stay explicit.
 */
/** One persisted allowlist entry for a command pattern or resolved executable. */
export const ExecApprovalsAllowlistEntrySchema = Type.Object(
  {
    id: Type.Optional(NonEmptyString),
    pattern: Type.String(),
    source: Type.Optional(Type.Literal("allow-always")),
    commandText: Type.Optional(Type.String()),
    argPattern: Type.Optional(Type.String()),
    lastUsedAt: Type.Optional(Type.Number({ minimum: 0 })),
    lastUsedCommand: Type.Optional(Type.String()),
    lastResolvedPath: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

const ExecApprovalsPolicyFields = {
  security: Type.Optional(Type.String()),
  ask: Type.Optional(Type.String()),
  askFallback: Type.Optional(Type.String()),
  autoAllowSkills: Type.Optional(Type.Boolean()),
};

/** Default exec approval policy shared by all agents unless overridden. */
export const ExecApprovalsDefaultsSchema = Type.Object(ExecApprovalsPolicyFields, {
  additionalProperties: false,
});

/** Agent-specific exec approval policy and allowlist. */
export const ExecApprovalsAgentSchema = Type.Object(
  {
    ...ExecApprovalsPolicyFields,
    allowlist: Type.Optional(Type.Array(ExecApprovalsAllowlistEntrySchema)),
  },
  { additionalProperties: false },
);

/** Versioned exec approvals config file edited through gateway APIs. */
export const ExecApprovalsFileSchema = Type.Object(
  {
    version: Type.Literal(1),
    socket: Type.Optional(
      Type.Object(
        {
          path: Type.Optional(Type.String()),
          token: Type.Optional(Type.String()),
        },
        { additionalProperties: false },
      ),
    ),
    defaults: Type.Optional(ExecApprovalsDefaultsSchema),
    agents: Type.Optional(Type.Record(Type.String(), ExecApprovalsAgentSchema)),
  },
  { additionalProperties: false },
);

/** File-backed read snapshot with path/hash metadata for optimistic writes. */
export const ExecApprovalsSnapshotSchema = Type.Object(
  {
    path: NonEmptyString,
    exists: Type.Boolean(),
    hash: NonEmptyString,
    file: ExecApprovalsFileSchema,
  },
  { additionalProperties: false },
);

const NativeExecApprovalActionSchema = Type.Union([
  Type.Literal("allow"),
  Type.Literal("deny"),
  Type.Literal("prompt"),
]);

/** One rule owned and enforced by a host-native exec policy implementation. */
const NativeExecApprovalRuleSchema = Type.Object(
  {
    pattern: NonEmptyString,
    action: NativeExecApprovalActionSchema,
    shells: Type.Optional(Type.Array(NonEmptyString)),
    description: Type.Optional(Type.String()),
    enabled: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
);

const NativeExecApprovalConstraintsSchema = Type.Object(
  {
    baseHashRequired: Type.Optional(Type.Boolean()),
    defaultAllowAllowed: Type.Optional(Type.Boolean()),
    broadAllowRulesAllowed: Type.Optional(Type.Boolean()),
    dangerousAllowRulesAllowed: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
);

/** Node read snapshot supporting file-backed and host-native approval owners. */
export const ExecApprovalsNodeSnapshotSchema = Type.Object(
  {
    path: Type.Optional(Type.String()),
    exists: Type.Optional(Type.Boolean()),
    hash: Type.Optional(Type.String()),
    file: Type.Optional(ExecApprovalsFileSchema),
    enabled: Type.Optional(Type.Boolean()),
    baseHash: Type.Optional(NonEmptyString),
    defaultAction: Type.Optional(NativeExecApprovalActionSchema),
    rules: Type.Optional(Type.Array(NativeExecApprovalRuleSchema)),
    constraints: Type.Optional(NativeExecApprovalConstraintsSchema),
    message: Type.Optional(Type.String()),
  },
  {
    additionalProperties: false,
    oneOf: [
      {
        required: ["path", "exists", "hash", "file"],
        not: {
          anyOf: [
            { required: ["enabled"] },
            { required: ["baseHash"] },
            { required: ["defaultAction"] },
            { required: ["rules"] },
            { required: ["constraints"] },
            { required: ["message"] },
          ],
        },
      },
      {
        properties: { enabled: { const: true }, hash: { minLength: 1 } },
        required: ["enabled", "hash", "defaultAction", "rules"],
        not: {
          anyOf: [
            { required: ["path"] },
            { required: ["exists"] },
            { required: ["file"] },
            { required: ["message"] },
          ],
        },
      },
      {
        properties: { enabled: { const: false } },
        required: ["enabled"],
        not: {
          anyOf: [
            { required: ["path"] },
            { required: ["exists"] },
            { required: ["hash"] },
            { required: ["file"] },
            { required: ["baseHash"] },
            { required: ["defaultAction"] },
            { required: ["rules"] },
            { required: ["constraints"] },
          ],
        },
      },
    ],
  },
);

/** Empty request payload for reading local exec approval policy. */
export const ExecApprovalsGetParamsSchema = Type.Object({}, { additionalProperties: false });

/** Local exec approval policy write request with optional base hash guard. */
export const ExecApprovalsSetParamsSchema = Type.Object(
  {
    file: ExecApprovalsFileSchema,
    baseHash: Type.Optional(NonEmptyString),
  },
  { additionalProperties: false },
);

/** Node-scoped request payload for reading exec approval policy. */
export const ExecApprovalsNodeGetParamsSchema = Type.Object(
  {
    nodeId: NonEmptyString,
  },
  { additionalProperties: false },
);

/** Writable host-native policy fields; the node remains the validation authority. */
const NativeExecApprovalPolicySchema = Type.Object(
  {
    defaultAction: Type.Optional(NativeExecApprovalActionSchema),
    // Windows treats set as full replacement; omission would silently clear the rule list.
    rules: Type.Array(NativeExecApprovalRuleSchema),
  },
  { additionalProperties: false },
);

/** Node-scoped write for exactly one file-backed or host-native approval owner. */
export const ExecApprovalsNodeSetParamsSchema = Type.Object(
  {
    nodeId: NonEmptyString,
    file: Type.Optional(ExecApprovalsFileSchema),
    native: Type.Optional(NativeExecApprovalPolicySchema),
    baseHash: Type.Optional(NonEmptyString),
  },
  {
    additionalProperties: false,
    oneOf: [
      { required: ["file"], not: { required: ["native"] } },
      {
        required: ["native", "baseHash"],
        not: { required: ["file"] },
      },
    ],
  },
);

/** Lookup request for one pending exec approval by id. */
export const ExecApprovalGetParamsSchema = Type.Object(
  {
    id: NonEmptyString,
  },
  { additionalProperties: false },
);

/** Pending command execution approval request shown to reviewers. */
export const ExecApprovalRequestParamsSchema = Type.Object(
  {
    id: Type.Optional(NonEmptyString),
    command: Type.Optional(NonEmptyString),
    commandArgv: Type.Optional(Type.Array(Type.String())),
    systemRunPlan: Type.Optional(
      Type.Object(
        {
          argv: Type.Array(Type.String()),
          cwd: Type.Union([Type.String(), Type.Null()]),
          commandText: Type.String(),
          commandPreview: Type.Optional(Type.Union([Type.String(), Type.Null()])),
          agentId: Type.Union([Type.String(), Type.Null()]),
          sessionKey: Type.Union([Type.String(), Type.Null()]),
          mutableFileOperand: Type.Optional(
            Type.Union([
              Type.Object(
                {
                  argvIndex: Type.Integer({ minimum: 0 }),
                  path: Type.String(),
                  sha256: Type.String(),
                },
                { additionalProperties: false },
              ),
              Type.Null(),
            ]),
          ),
        },
        { additionalProperties: false },
      ),
    ),
    env: Type.Optional(Type.Record(NonEmptyString, Type.String())),
    cwd: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    nodeId: Type.Optional(Type.Union([NonEmptyString, Type.Null()])),
    host: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    security: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    ask: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    warningText: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    unavailableDecisions: Type.Optional(
      Type.Array(Type.String({ enum: ["allow-always"] }), {
        minItems: 1,
        maxItems: 1,
      }),
    ),
    commandSpans: Type.Optional(
      Type.Array(
        Type.Object(
          {
            startIndex: Type.Integer({
              minimum: 0,
              description: "Inclusive UTF-16 code unit offset into command.",
            }),
            endIndex: Type.Integer({
              minimum: 1,
              description:
                "Exclusive UTF-16 code unit offset into command; must be greater than startIndex and no greater than command.length.",
            }),
          },
          { additionalProperties: false },
        ),
      ),
    ),
    agentId: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    resolvedPath: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    sessionKey: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    turnSourceChannel: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    turnSourceTo: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    turnSourceAccountId: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    turnSourceThreadId: Type.Optional(Type.Union([Type.String(), Type.Number(), Type.Null()])),
    approvalReviewerDeviceIds: Type.Optional(
      Type.Array(NonEmptyString, {
        description:
          "Trusted approval-runtime metadata naming operator devices that may review this approval; ordinary Gateway clients may send the field, but the Gateway only binds it for internal approval-runtime requests.",
      }),
    ),
    requireDeliveryRoute: Type.Optional(Type.Boolean()),
    suppressDelivery: Type.Optional(Type.Boolean()),
    timeoutMs: Type.Optional(Type.Integer({ minimum: 1 })),
    twoPhase: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
);

/** Reviewer decision payload for one pending exec approval. */
export const ExecApprovalResolveParamsSchema = Type.Object(
  {
    id: NonEmptyString,
    decision: NonEmptyString,
  },
  { additionalProperties: false },
);
