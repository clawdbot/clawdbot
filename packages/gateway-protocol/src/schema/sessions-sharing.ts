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

export const SessionPublicShareSchema = closedObject({
  token: Type.String({ pattern: "^v1\\.[A-Za-z0-9_-]+$", maxLength: 7000 }),
  createdAt: Type.Integer({ minimum: 0 }),
});

export const SessionPublicShareSetParamsSchema = closedObject({
  ...SessionSharingTargetParamsSchema,
  expectedSessionId: NonEmptyString,
  enabled: Type.Boolean(),
});

export const SessionPublicShareSetResultSchema = closedObject({
  ok: Type.Literal(true),
  sessionKey: NonEmptyString,
  publicShare: Type.Optional(SessionPublicShareSchema),
});

export const SessionMembersListParamsSchema = closedObject(SessionSharingTargetParamsSchema);

export const SessionMemberSchema = closedObject({
  identityId: NonEmptyString,
  addedBy: NonEmptyString,
  addedAt: Type.Integer({ minimum: 0 }),
});

export const SessionMemberEvidenceSchema = Object.assign(
  closedObject({
    identityId: NonEmptyString,
    addedBy: Type.Optional(NonEmptyString),
    /** Explicit principal-less evidence; omission means no actor evidence was supplied. */
    addedByState: Type.Optional(Type.Literal("unknown")),
    addedAt: Type.Integer({ minimum: 0 }),
  }),
  { not: { required: ["addedBy", "addedByState"] } },
);

export const SessionMembersListResultSchema = closedObject({
  sessionKey: NonEmptyString,
  publicShare: Type.Optional(SessionPublicShareSchema),
  owner: Type.Optional(SessionSharingIdentitySchema),
  members: Type.Array(SessionMemberSchema),
  identities: Type.Array(SessionSharingIdentitySchema),
  role: SessionSharingRoleSchema,
  allowedVisibilities: Type.Array(SessionVisibilitySchema),
});

export const SessionMembersListEvidenceResultSchema = closedObject({
  sessionKey: NonEmptyString,
  publicShare: Type.Optional(SessionPublicShareSchema),
  owner: Type.Optional(SessionSharingIdentitySchema),
  members: Type.Array(SessionMemberEvidenceSchema),
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

const SessionSharingEventTargetFields = {
  action: SessionSharingActionSchema,
  sessionKey: NonEmptyString,
  agentId: NonEmptyString,
};

const SessionSharingEventChangeFields = {
  visibility: Type.Optional(SessionVisibilitySchema),
  identityId: Type.Optional(NonEmptyString),
  ts: Type.Integer({ minimum: 0 }),
};

/** Original sharing event contract. Older generated clients require `actor`. */
export const SessionSharingEventSchema = closedObject({
  ...SessionSharingEventTargetFields,
  actor: SessionSharingIdentitySchema,
  ...SessionSharingEventChangeFields,
});

/** Principal-less sharing changes use a distinct additive event name. */
export const SessionSharingEvidenceEventSchema = closedObject({
  ...SessionSharingEventTargetFields,
  /** Explicit principal-less evidence; omission means no actor evidence was supplied. */
  actorState: Type.Optional(Type.Literal("unknown")),
  ...SessionSharingEventChangeFields,
});

export type SessionSharingIdentity = Static<typeof SessionSharingIdentitySchema>;
export type SessionSharingAction = Static<typeof SessionSharingActionSchema>;
export type SessionVisibilitySetParams = Static<typeof SessionVisibilitySetParamsSchema>;
export type SessionVisibilitySetResult = Static<typeof SessionVisibilitySetResultSchema>;
export type SessionPublicShare = Static<typeof SessionPublicShareSchema>;
export type SessionPublicShareSetParams = Static<typeof SessionPublicShareSetParamsSchema>;
export type SessionPublicShareSetResult = Static<typeof SessionPublicShareSetResultSchema>;
export type SessionMembersListParams = Static<typeof SessionMembersListParamsSchema>;
export type SessionMember = Static<typeof SessionMemberSchema>;
export type SessionMemberEvidence = Static<typeof SessionMemberEvidenceSchema>;
export type SessionMembersListResult = Static<typeof SessionMembersListResultSchema>;
export type SessionMembersListEvidenceResult = Static<
  typeof SessionMembersListEvidenceResultSchema
>;
export type SessionMemberAddParams = Static<typeof SessionMemberAddParamsSchema>;
export type SessionMemberRemoveParams = Static<typeof SessionMemberRemoveParamsSchema>;
export type SessionMemberMutationResult = Static<typeof SessionMemberMutationResultSchema>;
export type SessionSharingEvent = Static<typeof SessionSharingEventSchema>;
export type SessionSharingEvidenceEvent = Static<typeof SessionSharingEvidenceEventSchema>;
