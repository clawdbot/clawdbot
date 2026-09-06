import { Type, type Static } from "typebox";
import { closedObject } from "./closed-object.js";
import { NonEmptyString } from "./primitives.js";

/** Released v4 wire bound for the compact session-row participant summary. */
export const SESSION_PARTICIPANT_LIMIT = 4;

/** Storage and expanded-projection bound for one session's retained participant identities. */
export const SESSION_EXPANDED_PARTICIPANT_LIMIT = 32;

/** Product identity, independent of display metadata and authorization. */
export const SessionParticipantIdentitySchema = Type.Union([
  closedObject({ type: Type.Literal("profile"), id: NonEmptyString }),
  closedObject({ type: Type.Literal("agent"), id: NonEmptyString }),
  closedObject({
    type: Type.Literal("remote"),
    pluginId: NonEmptyString,
    domain: NonEmptyString,
    idKind: NonEmptyString,
    id: NonEmptyString,
  }),
  closedObject({
    type: Type.Literal("observation"),
    pluginId: Type.Union([NonEmptyString, Type.Null()]),
    accountId: Type.Union([NonEmptyString, Type.Null()]),
    senderKind: Type.Union([Type.Literal("human"), Type.Literal("bot"), Type.Literal("unknown")]),
    id: NonEmptyString,
  }),
  closedObject({
    type: Type.Literal("legacy"),
    actorType: Type.String(),
    source: Type.Union([Type.String(), Type.Null()]),
    id: Type.String(),
  }),
]);

export const SessionParticipantSchema = closedObject({
  identity: SessionParticipantIdentitySchema,
  label: Type.Optional(NonEmptyString),
  avatarUrl: Type.Optional(NonEmptyString),
});

export type SessionParticipantIdentity = Static<typeof SessionParticipantIdentitySchema>;
export type SessionParticipant = Static<typeof SessionParticipantSchema>;

export const SessionPersonSchema = closedObject({
  identity: closedObject({ type: Type.Literal("profile"), id: NonEmptyString }),
  label: Type.Optional(NonEmptyString),
  avatarUrl: Type.Optional(NonEmptyString),
  sessionCount: Type.Integer({ minimum: 1 }),
});
export type SessionPerson = Static<typeof SessionPersonSchema>;
