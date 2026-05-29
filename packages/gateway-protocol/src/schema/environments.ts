import { Type } from "typebox";
import { NonEmptyString } from "./primitives.js";

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

export const EnvironmentSummarySchema = createEnvironmentSummarySchema();

export const EnvironmentsListParamsSchema = Type.Object({}, { additionalProperties: false });

export const EnvironmentsListResultSchema = Type.Object(
  {
    environments: Type.Array(EnvironmentSummarySchema),
  },
  { additionalProperties: false },
);

export const EnvironmentsStatusParamsSchema = Type.Object(
  { environmentId: NonEmptyString },
  { additionalProperties: false },
);

export const EnvironmentsStatusResultSchema = createEnvironmentSummarySchema();
