import type { Static } from "typebox";
import { Type } from "typebox";
import { SESSION_AGENT_ATTENTION_ICON_IDS } from "../session-icon.js";
import { closedObject } from "./closed-object.js";
import { ErrorShapeSchema } from "./frames.js";
import { NonEmptyString, SessionLabelString } from "./primitives.js";
import { SessionToolOverridesSchema } from "./sessions-row.js";

export const SESSIONS_PATCH_MANY_MAX_TARGETS = 100;

const SessionsPatchMutationProperties = {
  label: Type.Optional(Type.Union([SessionLabelString, Type.Null()])),
  /** User-defined organization bucket ("category", not chat-group); null clears it. */
  category: Type.Optional(Type.Union([SessionLabelString, Type.Null()])),
  boardFace: Type.Optional(Type.Union([Type.Literal("chat"), Type.Literal("dashboard")])),
  icon: Type.Optional(
    Type.Union([NonEmptyString, Type.Null()], {
      description: "Sidebar icon: one emoji, name:<id>, or svg:<svg ...>...</svg>.",
    }),
  ),
  statusNote: Type.Optional(
    Type.Union([Type.String({ maxLength: 120 }), Type.Null()], {
      description: "Short expiring sidebar status note; null clears it and any declared attention.",
    }),
  ),
  attention: Type.Optional(
    Type.Union([Type.String({ enum: [...SESSION_AGENT_ATTENTION_ICON_IDS] }), Type.Null()]),
  ),
  ttlMinutes: Type.Optional(Type.Integer({ minimum: 1, maximum: 120 })),
  archived: Type.Optional(Type.Boolean()),
  pinned: Type.Optional(Type.Boolean()),
  unread: Type.Optional(
    Type.Boolean({ description: "Set true to mark unread; false records the session as read." }),
  ),
  thinkingLevel: Type.Optional(Type.Union([NonEmptyString, Type.Null()])),
  fastMode: Type.Optional(Type.Union([Type.Boolean(), Type.Literal("auto"), Type.Null()])),
  toolOverrides: Type.Optional(Type.Union([SessionToolOverridesSchema, Type.Null()])),
  verboseLevel: Type.Optional(Type.Union([NonEmptyString, Type.Null()])),
  traceLevel: Type.Optional(Type.Union([NonEmptyString, Type.Null()])),
  reasoningLevel: Type.Optional(Type.Union([NonEmptyString, Type.Null()])),
  responseUsage: Type.Optional(
    Type.Union([
      Type.Literal("off"),
      Type.Literal("tokens"),
      Type.Literal("full"),
      // Backward compat with older clients/stores.
      Type.Literal("on"),
      Type.Null(),
    ]),
  ),
  elevatedLevel: Type.Optional(Type.Union([NonEmptyString, Type.Null()])),
  execHost: Type.Optional(Type.Union([NonEmptyString, Type.Null()])),
  execSecurity: Type.Optional(Type.Union([NonEmptyString, Type.Null()])),
  execAsk: Type.Optional(Type.Union([NonEmptyString, Type.Null()])),
  execNode: Type.Optional(Type.Union([NonEmptyString, Type.Null()])),
  model: Type.Optional(Type.Union([NonEmptyString, Type.Null()])),
  completionOwnerSessionKey: Type.Optional(Type.Union([NonEmptyString, Type.Null()])),
  inheritedToolPolicyVersion: Type.Optional(Type.Union([Type.Literal(1), Type.Null()])),
  inheritedToolAllow: Type.Optional(Type.Union([Type.Array(NonEmptyString), Type.Null()])),
  inheritedToolDeny: Type.Optional(Type.Union([Type.Array(NonEmptyString), Type.Null()])),
  sendPolicy: Type.Optional(Type.Union([Type.Literal("allow"), Type.Literal("deny"), Type.Null()])),
  groupActivation: Type.Optional(
    Type.Union([Type.Literal("mention"), Type.Literal("always"), Type.Null()]),
  ),
};

/** Mutable per-session preferences and routing metadata. */
export const SessionsPatchParamsSchema = closedObject({
  key: NonEmptyString,
  agentId: Type.Optional(NonEmptyString),
  /** Reject the mutation if the session was reset or replaced before it commits. */
  expectedSessionId: Type.Optional(NonEmptyString),
  expectedLifecycleRevision: Type.Optional(NonEmptyString),
  ...SessionsPatchMutationProperties,
});

export const SessionsPatchMutationSchema = Type.Object(SessionsPatchMutationProperties, {
  additionalProperties: false,
  minProperties: 1,
});

export const SessionsPatchManyTargetSchema = closedObject({
  key: NonEmptyString,
  agentId: Type.Optional(NonEmptyString),
  expectedSessionId: Type.Optional(NonEmptyString),
  expectedLifecycleRevision: Type.Optional(NonEmptyString),
});

export const SessionsPatchManyParamsSchema = closedObject({
  targets: Type.Array(SessionsPatchManyTargetSchema, {
    minItems: 1,
    maxItems: SESSIONS_PATCH_MANY_MAX_TARGETS,
  }),
  patch: SessionsPatchMutationSchema,
});

const SessionsPatchManyOutcomeIdentitySchema = {
  key: NonEmptyString,
  agentId: Type.Optional(NonEmptyString),
};

export const SessionsPatchManyResultSchema = closedObject({
  outcomes: Type.Array(
    Type.Union([
      closedObject({
        ok: Type.Literal(true),
        ...SessionsPatchManyOutcomeIdentitySchema,
      }),
      closedObject({
        ok: Type.Literal(false),
        ...SessionsPatchManyOutcomeIdentitySchema,
        error: ErrorShapeSchema,
      }),
    ]),
  ),
});

export type SessionsPatchParams = Static<typeof SessionsPatchParamsSchema>;
export type SessionsPatchMutation = Static<typeof SessionsPatchMutationSchema>;
export type SessionsPatchManyTarget = Static<typeof SessionsPatchManyTargetSchema>;
export type SessionsPatchManyParams = Static<typeof SessionsPatchManyParamsSchema>;
export type SessionsPatchManyResult = Static<typeof SessionsPatchManyResultSchema>;
