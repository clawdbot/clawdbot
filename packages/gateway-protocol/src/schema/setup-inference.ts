import type { Static } from "typebox";
import { Type } from "typebox";
import { closedObject } from "./closed-object.js";

export const SetupInferenceFailureStatusSchema = Type.Union([
  Type.Literal("auth"),
  Type.Literal("rate_limit"),
  Type.Literal("billing"),
  Type.Literal("timeout"),
  Type.Literal("format"),
  Type.Literal("unavailable"),
  Type.Literal("unknown"),
]);

/** Finalized rejection before model/credential promotion; preparatory effects may remain. */
export const SetupInferenceActivationRejectionSchema = closedObject({
  disposition: Type.Literal("rejected-before-promotion"),
  status: SetupInferenceFailureStatusSchema,
});

export type SetupInferenceFailureStatus = Static<typeof SetupInferenceFailureStatusSchema>;
export type SetupInferenceActivationRejection = Static<
  typeof SetupInferenceActivationRejectionSchema
>;
