// Gateway Protocol schema module defines protocol validation shapes.
import { Type, type Static } from "typebox";
import { NonEmptyString } from "./primitives.js";

/**
 * Secret-provider protocol schemas.
 *
 * These payloads request secret materialization from the gateway while keeping
 * caller scope, allowed paths, and provider overrides explicit.
 */
/** Empty request payload for reloading configured secret providers. */
export const SecretsReloadParamsSchema = Type.Object({}, { additionalProperties: false });

/** Request payload for resolving the secrets needed by one command invocation. */
export const SecretsResolveParamsSchema = Type.Object(
  {
    commandName: NonEmptyString,
    targetIds: Type.Array(NonEmptyString),
    allowedPaths: Type.Optional(Type.Array(NonEmptyString)),
    forcedActivePaths: Type.Optional(Type.Array(NonEmptyString)),
    optionalActivePaths: Type.Optional(Type.Array(NonEmptyString)),
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

/** Static type for secret resolution requests. */
export type SecretsResolveParams = Static<typeof SecretsResolveParamsSchema>;

/** One resolved secret assignment path plus its provider-owned value. */
export const SecretsResolveAssignmentSchema = Type.Object(
  {
    path: Type.Optional(NonEmptyString),
    pathSegments: Type.Array(NonEmptyString),
    value: Type.Unknown(),
  },
  { additionalProperties: false },
);

/** Secret resolution response with assignments and safe diagnostics. */
export const SecretsResolveResultSchema = Type.Object(
  {
    ok: Type.Optional(Type.Boolean()),
    assignments: Type.Optional(Type.Array(SecretsResolveAssignmentSchema)),
    diagnostics: Type.Optional(Type.Array(NonEmptyString)),
    inactiveRefPaths: Type.Optional(Type.Array(NonEmptyString)),
  },
  { additionalProperties: false },
);

/** Static type for secret resolution responses. */
export type SecretsResolveResult = Static<typeof SecretsResolveResultSchema>;
