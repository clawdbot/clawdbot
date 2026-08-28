import type { Static } from "typebox";
import { Type } from "typebox";
import { closedObject } from "./closed-object.js";
import { NonEmptyString, SessionLabelString } from "./primitives.js";

/** Resolves a session by key, raw session id, label, short URL id, or parent/agent scope. */
export const SessionsResolveParamsSchema = closedObject({
  key: Type.Optional(NonEmptyString),
  sessionId: Type.Optional(NonEmptyString),
  label: Type.Optional(SessionLabelString),
  /** Bare 8-32 character hexadecimal prefix of a session key's trailing UUID. */
  shortId: Type.Optional(NonEmptyString),
  /** Optional display-name slug used only to narrow ambiguous shortId matches. */
  slugHint: Type.Optional(NonEmptyString),
  agentId: Type.Optional(NonEmptyString),
  spawnedBy: Type.Optional(NonEmptyString),
  includeGlobal: Type.Optional(Type.Boolean()),
  includeUnknown: Type.Optional(Type.Boolean()),
  /** Return a successful `{ ok: false }` response when the selector does not match a session. */
  allowMissing: Type.Optional(Type.Boolean()),
});

export type SessionsResolveParams = Static<typeof SessionsResolveParamsSchema>;

export const SessionsResolveCandidateSchema = closedObject({
  key: NonEmptyString,
  agentId: NonEmptyString,
  displayName: Type.Optional(Type.String()),
  boardFace: Type.Optional(Type.Union([Type.Literal("chat"), Type.Literal("dashboard")])),
});

export const SessionsResolveResultSchema = Type.Union([
  closedObject({ ok: Type.Literal(true), ...SessionsResolveCandidateSchema.properties }),
  closedObject({
    ok: Type.Literal(false),
    candidates: Type.Optional(Type.Array(SessionsResolveCandidateSchema, { maxItems: 10 })),
  }),
]);

export type SessionsResolveCandidate = Static<typeof SessionsResolveCandidateSchema>;
export type SessionsResolveResult = Static<typeof SessionsResolveResultSchema>;
