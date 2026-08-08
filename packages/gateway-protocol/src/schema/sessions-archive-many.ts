import type { Static } from "typebox";
import { Type } from "typebox";
import { closedObject } from "./closed-object.js";
import { ErrorShapeSchema } from "./frames.js";
import { NonEmptyString } from "./primitives.js";

export const SESSIONS_ARCHIVE_MANY_MAX_TARGETS = 100;

export const SessionsArchiveManyTargetSchema = closedObject({
  key: NonEmptyString,
  agentId: Type.Optional(NonEmptyString),
  expectedSessionId: Type.Optional(NonEmptyString),
  expectedLifecycleRevision: Type.Optional(NonEmptyString),
});

export const SessionsArchiveManyParamsSchema = closedObject({
  targets: Type.Array(SessionsArchiveManyTargetSchema, {
    minItems: 1,
    maxItems: SESSIONS_ARCHIVE_MANY_MAX_TARGETS,
  }),
  archived: Type.Boolean(),
});

const SessionsArchiveManyOutcomeIdentitySchema = {
  key: NonEmptyString,
  agentId: Type.Optional(NonEmptyString),
};

export const SessionsArchiveManyResultSchema = closedObject({
  outcomes: Type.Array(
    Type.Union([
      closedObject({
        ok: Type.Literal(true),
        ...SessionsArchiveManyOutcomeIdentitySchema,
      }),
      closedObject({
        ok: Type.Literal(false),
        ...SessionsArchiveManyOutcomeIdentitySchema,
        error: ErrorShapeSchema,
      }),
    ]),
  ),
});

export type SessionsArchiveManyParams = Static<typeof SessionsArchiveManyParamsSchema>;
export type SessionsArchiveManyResult = Static<typeof SessionsArchiveManyResultSchema>;
