import { Type, type Static } from "typebox";
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
  /**
   * Read a bounded transcript head projection to derive a title from the first user message.
   * Use `limit` to bound projection work on large stores.
   */
  includeDerivedTitles: Type.Optional(Type.Boolean()),
  /**
   * Read a bounded transcript tail projection for the latest visible user or assistant text.
   * The returned short preview excludes tool, system, reasoning, and silent rows.
   */
  includeLastMessage: Type.Optional(Type.Boolean()),
  label: Type.Optional(SessionLabelString),
  /** Limit rows to sessions with an explicitly stored Control UI face preference. */
  boardFace: Type.Optional(Type.Union([Type.Literal("chat"), Type.Literal("dashboard")])),
  /** Filter rows by their immutable creator provenance. */
  creatorId: Type.Optional(NonEmptyString),
  /** Filter rows by their current assignable owner identity. */
  ownerId: Type.Optional(NonEmptyString),
  /** Prepend the authenticated viewer's owned rows to the normal first page. */
  ownerFirst: Type.Optional(Type.Boolean()),
  /** Limit rows to sessions owned by or previously prompted by the authenticated viewer. */
  involvingMe: Type.Optional(Type.Boolean()),
  /** Profile association filter, applied to visible retained identities before pagination. */
  involvingProfileId: Type.Optional(NonEmptyString),
  /** Include a bounded people facet over visible matching sessions before the profile filter. */
  includePeople: Type.Optional(Type.Boolean()),
  spawnedBy: Type.Optional(NonEmptyString),
  agentId: Type.Optional(NonEmptyString),
  search: Type.Optional(Type.String()),
  /**
   * True lists archived sessions; "all" lists archived and active;
   * false or omitted lists active sessions.
   */
  archived: Type.Optional(Type.Union([Type.Boolean(), Type.Literal("all")])),
});

export type SessionsListParams = Static<typeof SessionsListParamsSchema>;
