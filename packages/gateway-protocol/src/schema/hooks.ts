import type { Static } from "typebox";
import { Type } from "typebox";
import { closedObject } from "./closed-object.js";
import { NonEmptyString } from "./primitives.js";

/** Request payload for one agent's live Gateway hook status report. */
export const HooksStatusParamsSchema = closedObject({
  agentId: Type.Optional(NonEmptyString),
});

export type HooksStatusParams = Static<typeof HooksStatusParamsSchema>;
