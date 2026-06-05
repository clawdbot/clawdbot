// Gateway Protocol schema module defines protocol validation shapes.
import { Type } from "typebox";
import { NonEmptyString } from "./primitives.js";

/**
 * Environment inventory protocol schemas.
 *
 * Environments are runtime targets such as local hosts, VMs, or remote workers;
 * this schema layer only describes their gateway-visible status summary.
 */
/** Runtime availability state for an environment target. */
export const EnvironmentStatusSchema = Type.String({
  enum: ["available", "unavailable", "starting", "stopping", "error"],
});

function createEnvironmentSummarySchema() {
  return Type.Object(
    {
      id: NonEmptyString,
      type: NonEmptyString,
      label: Type.Optional(NonEmptyString),
      status: EnvironmentStatusSchema,
      capabilities: Type.Optional(Type.Array(NonEmptyString)),
    },
    { additionalProperties: false },
  );
}

/** Public environment summary shown in listings and status responses. */
export const EnvironmentSummarySchema = createEnvironmentSummarySchema();

/** Empty request payload for listing known environments. */
export const EnvironmentsListParamsSchema = Type.Object({}, { additionalProperties: false });

/** List response containing all gateway-visible environment summaries. */
export const EnvironmentsListResultSchema = Type.Object(
  {
    environments: Type.Array(EnvironmentSummarySchema),
  },
  { additionalProperties: false },
);

/** Status lookup request for one environment id. */
export const EnvironmentsStatusParamsSchema = Type.Object(
  { environmentId: NonEmptyString },
  { additionalProperties: false },
);

/** Status lookup result for one environment id. */
export const EnvironmentsStatusResultSchema = createEnvironmentSummarySchema();
