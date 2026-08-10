import type { Static } from "typebox";
import { closedObject } from "./closed-object.js";

/** Empty request payload for the live Gateway hook status report. */
export const HooksStatusParamsSchema = closedObject({});

export type HooksStatusParams = Static<typeof HooksStatusParamsSchema>;
