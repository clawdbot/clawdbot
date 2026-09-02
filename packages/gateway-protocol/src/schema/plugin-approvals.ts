import type { Static, TSchema } from "typebox";
// Gateway Protocol schema module defines protocol validation shapes.
import { Type } from "typebox";
import { ApprovalChannelReviewerSchema, ApprovalScopeSchema } from "./approvals.js";
import { closedObject } from "./closed-object.js";
import { NonEmptyString } from "./primitives.js";

/**
 * Plugin approval schemas.
 *
 * These payloads cross from plugin/tool execution into reviewer-facing UI, so
 * title, description, decision set, and timeout limits are part of the public
 * gateway contract.
 */
const MAX_PLUGIN_APPROVAL_TIMEOUT_MS = 600_000;
const PLUGIN_APPROVAL_TITLE_MAX_LENGTH = 80;
const PLUGIN_APPROVAL_DESCRIPTION_MAX_LENGTH = 512;

type SingleTypeSchema = TSchema & { type: string; enum?: readonly (string | null)[] };

// A JSON Schema type array preserves concrete generated client types while
// accepting explicit null as the same optional-metadata state as omission.
function nullableMetadata<T extends SingleTypeSchema>(schema: T) {
  return Type.Unsafe<Static<T> | null>({
    ...schema,
    type: [schema.type, "null"],
    ...(schema.enum ? { enum: [...schema.enum, null] } : {}),
  });
}

/** Approval request raised by a plugin before a sensitive tool action proceeds. */
export const PluginApprovalRequestParamsSchema = closedObject({
  pluginId: Type.Optional(nullableMetadata(NonEmptyString)),
  title: Type.String({ minLength: 1, maxLength: PLUGIN_APPROVAL_TITLE_MAX_LENGTH }),
  description: Type.String({ minLength: 1, maxLength: PLUGIN_APPROVAL_DESCRIPTION_MAX_LENGTH }),
  detail: Type.Optional(
    nullableMetadata(
      Type.String({
        minLength: 1,
        maxLength: 16_384,
        description:
          "Reviewer-surface-only detail; not delivered to channels or push notifications.",
      }),
    ),
  ),
  severity: Type.Optional(nullableMetadata(Type.String({ enum: ["info", "warning", "critical"] }))),
  scope: Type.Optional(
    Type.Unsafe<Static<typeof ApprovalScopeSchema> | null>({
      ...ApprovalScopeSchema,
      type: ["object", "null"],
      anyOf: [...ApprovalScopeSchema.anyOf, Type.Null()],
    }),
  ),
  toolName: Type.Optional(nullableMetadata(Type.String())),
  toolCallId: Type.Optional(nullableMetadata(Type.String())),
  mcpTool: Type.Optional(
    closedObject({
      server: Type.String({ minLength: 1, pattern: "\\S" }),
      tool: Type.String({ minLength: 1, pattern: "\\S" }),
    }),
  ),
  allowedDecisions: Type.Optional(
    nullableMetadata(
      Type.Array(Type.String({ enum: ["allow-once", "allow-always", "deny"] }), {
        minItems: 1,
        maxItems: 3,
      }),
    ),
  ),
  agentId: Type.Optional(nullableMetadata(Type.String())),
  sessionKey: Type.Optional(nullableMetadata(Type.String())),
  approvalReviewerDeviceIds: Type.Optional(
    nullableMetadata(
      Type.Array(NonEmptyString, {
        description:
          "Trusted approval-runtime metadata naming operator devices that may review this approval; ordinary Gateway clients may send the field, but the Gateway only binds it for internal approval-runtime requests.",
      }),
    ),
  ),
  turnSourceChannel: Type.Optional(nullableMetadata(Type.String())),
  turnSourceTo: Type.Optional(nullableMetadata(Type.String())),
  turnSourceAccountId: Type.Optional(nullableMetadata(Type.String())),
  turnSourceThreadId: Type.Optional(Type.Union([Type.String(), Type.Number(), Type.Null()])),
  timeoutMs: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_PLUGIN_APPROVAL_TIMEOUT_MS })),
  twoPhase: Type.Optional(Type.Boolean()),
});

/** Reviewer decision payload resolving one pending plugin approval request. */
export const PluginApprovalResolveParamsSchema = closedObject({
  id: NonEmptyString,
  decision: NonEmptyString,
  reviewer: Type.Optional(ApprovalChannelReviewerSchema),
});

// Owner-local wire types derived directly from local schema consts so the
// public plugin-sdk declaration graph never pulls in the ProtocolSchemas registry.
export type PluginApprovalRequestParams = Static<typeof PluginApprovalRequestParamsSchema>;
export type PluginApprovalResolveParams = Static<typeof PluginApprovalResolveParamsSchema>;
