import type { Static } from "typebox";
import { Type } from "typebox";
import { closedObject } from "./closed-object.js";
import { NonEmptyString } from "./primitives.js";
import { SessionSharingRoleSchema, SessionVisibilitySchema } from "./sessions-sharing-values.js";
import { SessionCreatedActorSchema } from "./sessions.js";

/** A selectable sharing identity is a created actor with a durable id. */
export const SessionSharingIdentitySchema = closedObject({
  ...SessionCreatedActorSchema.properties,
  id: NonEmptyString,
});

export {
  SESSION_VISIBILITY_VALUES,
  SessionSharingRoleSchema,
  SessionVisibilitySchema,
  type SessionSharingRole,
  type SessionVisibility,
} from "./sessions-sharing-values.js";

export const SessionSharingActionSchema = Type.Union([
  Type.Literal("visibility"),
  Type.Literal("member-added"),
  Type.Literal("member-removed"),
]);

const SessionSharingTargetParamsSchema = {
  sessionKey: NonEmptyString,
  agentId: Type.Optional(NonEmptyString),
};

export const SessionVisibilitySetParamsSchema = closedObject({
  ...SessionSharingTargetParamsSchema,
  visibility: SessionVisibilitySchema,
});

export const SessionVisibilitySetResultSchema = closedObject({
  ok: Type.Literal(true),
  sessionKey: NonEmptyString,
  visibility: SessionVisibilitySchema,
});

export const SessionMembersListParamsSchema = closedObject(SessionSharingTargetParamsSchema);

export const SessionMemberSchema = closedObject({
  identityId: NonEmptyString,
  addedBy: NonEmptyString,
  addedAt: Type.Integer({ minimum: 0 }),
});

export const SessionMembersListResultSchema = closedObject({
  sessionKey: NonEmptyString,
  owner: Type.Optional(SessionSharingIdentitySchema),
  members: Type.Array(SessionMemberSchema),
  identities: Type.Array(SessionSharingIdentitySchema),
  role: SessionSharingRoleSchema,
  allowedVisibilities: Type.Array(SessionVisibilitySchema),
});

export const SessionMemberAddParamsSchema = closedObject({
  ...SessionSharingTargetParamsSchema,
  identityId: NonEmptyString,
});

export const SessionMemberRemoveParamsSchema = SessionMemberAddParamsSchema;

export const SessionMemberMutationResultSchema = closedObject({
  ok: Type.Literal(true),
  sessionKey: NonEmptyString,
  identityId: NonEmptyString,
});

export const SessionSharingEventSchema = closedObject({
  action: SessionSharingActionSchema,
  sessionKey: NonEmptyString,
  agentId: NonEmptyString,
  actor: SessionSharingIdentitySchema,
  visibility: Type.Optional(SessionVisibilitySchema),
  identityId: Type.Optional(NonEmptyString),
  ts: Type.Integer({ minimum: 0 }),
});

export type SessionSharingIdentity = Static<typeof SessionSharingIdentitySchema>;
export type SessionSharingAction = Static<typeof SessionSharingActionSchema>;
export type SessionVisibilitySetParams = Static<typeof SessionVisibilitySetParamsSchema>;
export type SessionVisibilitySetResult = Static<typeof SessionVisibilitySetResultSchema>;
export type SessionMembersListParams = Static<typeof SessionMembersListParamsSchema>;
export type SessionMember = Static<typeof SessionMemberSchema>;
export type SessionMembersListResult = Static<typeof SessionMembersListResultSchema>;
export type SessionMemberAddParams = Static<typeof SessionMemberAddParamsSchema>;
export type SessionMemberRemoveParams = Static<typeof SessionMemberRemoveParamsSchema>;
export type SessionMemberMutationResult = Static<typeof SessionMemberMutationResultSchema>;
export type SessionSharingEvent = Static<typeof SessionSharingEventSchema>;
