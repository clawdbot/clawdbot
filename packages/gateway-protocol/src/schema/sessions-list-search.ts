import type { Static } from "typebox";
import { Type } from "typebox";
import { closedObject } from "./closed-object.js";
import { NonEmptyString, SessionLabelString } from "./primitives.js";

export const SessionsListParamsSchema = closedObject({
  /** Maximum rows to return; omitted Gateway RPC calls use a bounded default. */
  limit: Type.Optional(Type.Integer({ minimum: 1 })),
  offset: Type.Optional(Type.Integer({ minimum: 0 })),
  activeMinutes: Type.Optional(Type.Integer({ minimum: 1 })),
  /** Require a real user/channel interaction; excludes synthetic isolated heartbeat rows. */
  requireLastInteraction: Type.Optional(Type.Boolean()),
  sortBy: Type.Optional(Type.Union([Type.Literal("updatedAt"), Type.Literal("lastInteractionAt")])),
  includeGlobal: Type.Optional(Type.Boolean()),
  includeUnknown: Type.Optional(Type.Boolean()),
  /** Limit agent-scoped rows to agents currently present in config. */
  configuredAgentsOnly: Type.Optional(Type.Boolean()),
  /** Derive a title from the bounded transcript head projection. */
  includeDerivedTitles: Type.Optional(Type.Boolean()),
  /** Return the latest visible user or assistant text from a bounded transcript tail. */
  includeLastMessage: Type.Optional(Type.Boolean()),
  label: Type.Optional(SessionLabelString),
  /** Filter by custom category; null selects sessions without one. */
  category: Type.Optional(Type.Union([SessionLabelString, Type.Null()])),
  /** Limit rows to sessions with an explicitly stored Control UI face preference. */
  boardFace: Type.Optional(Type.Union([Type.Literal("chat"), Type.Literal("dashboard")])),
  /** Filter rows by their immutable creator provenance. */
  creatorId: Type.Optional(NonEmptyString),
  /** Filter rows by their current assignable owner identity. */
  ownerId: Type.Optional(NonEmptyString),
  unread: Type.Optional(Type.Boolean()),
  status: Type.Optional(
    Type.Union([
      Type.Literal("queued"),
      Type.Literal("running"),
      Type.Literal("done"),
      Type.Literal("failed"),
      Type.Literal("killed"),
      Type.Literal("timeout"),
    ]),
  ),
  projectId: Type.Optional(NonEmptyString),
  hasWorktree: Type.Optional(Type.Boolean()),
  needsAttention: Type.Optional(Type.Boolean()),
  /** Limit rows to sessions owned by or previously prompted by the authenticated viewer. */
  involvingMe: Type.Optional(Type.Boolean()),
  spawnedBy: Type.Optional(NonEmptyString),
  agentId: Type.Optional(NonEmptyString),
  search: Type.Optional(Type.String()),
  /** True selects archived rows; "all" selects archived and active rows. */
  archived: Type.Optional(Type.Union([Type.Boolean(), Type.Literal("all")])),
});

/** Searches one agent's indexed session transcripts, optionally within selected sessions. */
export const SessionsSearchParamsSchema = closedObject({
  agentId: Type.Optional(NonEmptyString),
  sessionKeys: Type.Optional(Type.Array(NonEmptyString, { minItems: 1, maxItems: 200 })),
  query: Type.String({ minLength: 1, maxLength: 4096 }),
  resultMode: Type.Optional(Type.Union([Type.Literal("messages"), Type.Literal("sessions")])),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
});

export type SessionsListParams = Static<typeof SessionsListParamsSchema>;
export type SessionsSearchParams = Static<typeof SessionsSearchParamsSchema>;
