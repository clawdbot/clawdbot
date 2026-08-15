import type { Static } from "typebox";
import { closedObject } from "./closed-object.js";
import { NonEmptyString } from "./primitives.js";

/** Acknowledges playback through a named realtime provider mark. */
export const TalkSessionAcknowledgeMarkParamsSchema = closedObject({
  sessionId: NonEmptyString,
  markName: NonEmptyString,
});

export type TalkSessionAcknowledgeMarkParams = Static<
  typeof TalkSessionAcknowledgeMarkParamsSchema
>;
