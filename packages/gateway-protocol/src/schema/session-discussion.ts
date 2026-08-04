// Gateway Protocol schema module defines session discussion validation shapes.
import type { Static } from "typebox";
import { Type } from "typebox";
import { closedObject } from "./closed-object.js";
import { NonEmptyString } from "./primitives.js";

export const SessionDiscussionStateSchema = Type.Union([
  Type.Literal("none"),
  Type.Literal("available"),
  Type.Literal("open"),
]);

export const SessionDiscussionInfoSchema = closedObject({
  state: SessionDiscussionStateSchema,
  embedUrl: Type.Optional(Type.String()),
  openUrl: Type.Optional(Type.String()),
});

export const SessionDiscussionInfoParamsSchema = closedObject({
  sessionKey: NonEmptyString,
});

export const SessionDiscussionOpenParamsSchema = closedObject({
  sessionKey: NonEmptyString,
});

export const SessionDiscussionInfoResultSchema = SessionDiscussionInfoSchema;
export const SessionDiscussionOpenResultSchema = SessionDiscussionInfoSchema;

export type SessionDiscussionState = Static<typeof SessionDiscussionStateSchema>;
export type SessionDiscussionInfo = Static<typeof SessionDiscussionInfoSchema>;
export type SessionDiscussionInfoParams = Static<typeof SessionDiscussionInfoParamsSchema>;
export type SessionDiscussionOpenParams = Static<typeof SessionDiscussionOpenParamsSchema>;
export type SessionDiscussionInfoResult = Static<typeof SessionDiscussionInfoResultSchema>;
export type SessionDiscussionOpenResult = Static<typeof SessionDiscussionOpenResultSchema>;
