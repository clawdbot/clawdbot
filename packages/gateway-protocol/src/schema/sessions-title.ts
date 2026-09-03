import type { Static } from "typebox";
import { Type } from "typebox";
import { closedObject } from "./closed-object.js";
import { NonEmptyString } from "./primitives.js";

/** Optional creation-only inference; never creates or renames a session. */
export const SessionsTitlePrepareParamsSchema = closedObject({
  agentId: NonEmptyString,
  message: Type.String({ maxLength: 1_000 }),
  model: Type.Optional(NonEmptyString),
  catalogId: Type.Optional(NonEmptyString),
  incognito: Type.Optional(Type.Boolean()),
});

export const SessionsTitlePrepareResultSchema = closedObject({
  title: Type.Union([Type.String({ minLength: 1, maxLength: 60 }), Type.Null()]),
});

export type SessionsTitlePrepareParams = Static<typeof SessionsTitlePrepareParamsSchema>;
export type SessionsTitlePrepareResult = Static<typeof SessionsTitlePrepareResultSchema>;
