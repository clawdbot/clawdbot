import { Type } from "typebox";
import { closedObject } from "./closed-object.js";
import { ErrorShapeSchema } from "./frames.js";
import { NonEmptyString } from "./primitives.js";

/** Recovers one restart-tombstoned session into a fresh same-agent session. */
export const SessionsRecoverParamsSchema = closedObject({
  key: NonEmptyString,
  agentId: Type.Optional(NonEmptyString),
});

const SessionRecoveryContinuationOutcomeSchema = Type.Union([
  closedObject({
    status: Type.Literal("started"),
    runId: NonEmptyString,
  }),
  closedObject({
    status: Type.Literal("rejected"),
    error: ErrorShapeSchema,
  }),
]);

export const SessionsRecoverResultSchema = closedObject({
  ok: Type.Literal(true),
  key: NonEmptyString,
  sessionId: NonEmptyString,
  continuation: SessionRecoveryContinuationOutcomeSchema,
});
