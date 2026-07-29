import type { Static } from "typebox";
import { Type } from "typebox";
import { closedObject } from "./closed-object.js";
import { NonEmptyString } from "./primitives.js";
import { SessionSharingIdentitySchema, SessionSharingRoleSchema } from "./sessions-sharing.js";

const SessionSuggestionTargetParamsSchema = {
  sessionKey: NonEmptyString,
  agentId: Type.Optional(NonEmptyString),
};

export const SessionSuggestionStateSchema = Type.Union([
  Type.Literal("pending"),
  Type.Literal("accepted"),
  Type.Literal("dismissed"),
]);

export const SessionSuggestionResolutionSchema = Type.Union([
  Type.Literal("send"),
  Type.Literal("queue"),
  Type.Literal("edit"),
  Type.Literal("dismiss"),
]);

export const SessionSuggestionActionSchema = Type.Union([
  Type.Literal("added"),
  Type.Literal("resolved"),
]);

export const SessionSuggestionSchema = closedObject({
  id: NonEmptyString,
  sessionKey: NonEmptyString,
  agentId: NonEmptyString,
  author: SessionSharingIdentitySchema,
  text: Type.String({ minLength: 1, maxLength: 32_768 }),
  createdAt: Type.Integer({ minimum: 0 }),
  state: SessionSuggestionStateSchema,
});

export const SessionSuggestionsAddParamsSchema = closedObject({
  ...SessionSuggestionTargetParamsSchema,
  text: Type.String({ minLength: 1, maxLength: 32_768 }),
});

export const SessionSuggestionsListParamsSchema = closedObject(SessionSuggestionTargetParamsSchema);

export const SessionSuggestionsResolveParamsSchema = closedObject({
  ...SessionSuggestionTargetParamsSchema,
  id: NonEmptyString,
  resolution: SessionSuggestionResolutionSchema,
});

export const SessionSuggestionsAddResultSchema = closedObject({
  suggestion: SessionSuggestionSchema,
});

export const SessionSuggestionsListResultSchema = closedObject({
  suggestions: Type.Array(SessionSuggestionSchema),
  role: SessionSharingRoleSchema,
});

export const SessionSuggestionsResolveResultSchema = closedObject({
  suggestion: SessionSuggestionSchema,
});

export const SessionSuggestionEventSchema = closedObject({
  action: SessionSuggestionActionSchema,
  suggestion: SessionSuggestionSchema,
});

export const SessionTypingParamsSchema = closedObject({
  ...SessionSuggestionTargetParamsSchema,
  sessionId: NonEmptyString,
  typing: Type.Boolean(),
});

export const SessionTypingResultSchema = closedObject({
  ok: Type.Literal(true),
  broadcast: Type.Boolean(),
});

export const SessionTypingEventSchema = closedObject({
  sessionKey: NonEmptyString,
  sessionId: NonEmptyString,
  agentId: NonEmptyString,
  actor: SessionSharingIdentitySchema,
  typing: Type.Boolean(),
  ts: Type.Integer({ minimum: 0 }),
});

export type SessionSuggestionState = Static<typeof SessionSuggestionStateSchema>;
export type SessionSuggestionResolution = Static<typeof SessionSuggestionResolutionSchema>;
export type SessionSuggestionAction = Static<typeof SessionSuggestionActionSchema>;
export type SessionSuggestion = Static<typeof SessionSuggestionSchema>;
export type SessionSuggestionsAddParams = Static<typeof SessionSuggestionsAddParamsSchema>;
export type SessionSuggestionsListParams = Static<typeof SessionSuggestionsListParamsSchema>;
export type SessionSuggestionsResolveParams = Static<typeof SessionSuggestionsResolveParamsSchema>;
export type SessionSuggestionsAddResult = Static<typeof SessionSuggestionsAddResultSchema>;
export type SessionSuggestionsListResult = Static<typeof SessionSuggestionsListResultSchema>;
export type SessionSuggestionsResolveResult = Static<typeof SessionSuggestionsResolveResultSchema>;
export type SessionSuggestionEvent = Static<typeof SessionSuggestionEventSchema>;
export type SessionTypingParams = Static<typeof SessionTypingParamsSchema>;
export type SessionTypingResult = Static<typeof SessionTypingResultSchema>;
export type SessionTypingEvent = Static<typeof SessionTypingEventSchema>;
