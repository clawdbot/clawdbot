// Gateway Protocol schema module defines protocol validation shapes.
import { Type } from "typebox";
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
const PLUGIN_APPROVAL_DESCRIPTION_MAX_LENGTH = 256;

/** Approval request raised by a plugin before a sensitive tool action proceeds. */
export const PluginApprovalRequestParamsSchema = Type.Object(
  {
    pluginId: Type.Optional(NonEmptyString),
    title: Type.String({ minLength: 1, maxLength: PLUGIN_APPROVAL_TITLE_MAX_LENGTH }),
    description: Type.String({ minLength: 1, maxLength: PLUGIN_APPROVAL_DESCRIPTION_MAX_LENGTH }),
    severity: Type.Optional(Type.String({ enum: ["info", "warning", "critical"] })),
    toolName: Type.Optional(Type.String()),
    toolCallId: Type.Optional(Type.String()),
    allowedDecisions: Type.Optional(
      Type.Array(Type.String({ enum: ["allow-once", "allow-always", "deny"] }), {
        minItems: 1,
        maxItems: 3,
      }),
    ),
    agentId: Type.Optional(Type.String()),
    sessionKey: Type.Optional(Type.String()),
    turnSourceChannel: Type.Optional(Type.String()),
    turnSourceTo: Type.Optional(Type.String()),
    turnSourceAccountId: Type.Optional(Type.String()),
    turnSourceThreadId: Type.Optional(Type.Union([Type.String(), Type.Number()])),
    timeoutMs: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_PLUGIN_APPROVAL_TIMEOUT_MS })),
    twoPhase: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
);

/** Reviewer decision payload resolving one pending plugin approval request. */
export const PluginApprovalResolveParamsSchema = Type.Object(
  {
    id: NonEmptyString,
    decision: NonEmptyString,
  },
  { additionalProperties: false },
);
