import { Type, type Static } from "typebox";
import { NonEmptyString } from "./primitives.js";

export const SecretsReloadParamsSchema = Type.Object({}, { additionalProperties: false });

export const SecretsResolveParamsSchema = Type.Object(
  {
    commandName: NonEmptyString,
    targetIds: Type.Array(NonEmptyString),
    providerOverrides: Type.Optional(
      Type.Object(
        {
          webSearch: Type.Optional(NonEmptyString),
          webFetch: Type.Optional(NonEmptyString),
        },
        { additionalProperties: false },
      ),
    ),
  },
  { additionalProperties: false },
);

export type SecretsResolveParams = Static<typeof SecretsResolveParamsSchema>;

export const SecretsResolveAssignmentSchema = Type.Object(
  {
    path: Type.Optional(NonEmptyString),
    pathSegments: Type.Array(NonEmptyString),
    value: Type.Unknown(),
  },
  { additionalProperties: false },
);

export const SecretsResolveResultSchema = Type.Object(
  {
    ok: Type.Optional(Type.Boolean()),
    assignments: Type.Optional(Type.Array(SecretsResolveAssignmentSchema)),
    diagnostics: Type.Optional(Type.Array(NonEmptyString)),
    inactiveRefPaths: Type.Optional(Type.Array(NonEmptyString)),
  },
  { additionalProperties: false },
);

export type SecretsResolveResult = Static<typeof SecretsResolveResultSchema>;
