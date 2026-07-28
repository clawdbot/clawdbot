// Gateway Protocol schema module defines protocol validation shapes.
import { Type, type Static } from "typebox";
import { closedObject } from "./closed-object.js";
import { NonEmptyString } from "./primitives.js";

/**
 * Secret-provider protocol schemas.
 *
 * These payloads request secret materialization from the gateway while keeping
 * caller scope, allowed paths, and provider overrides explicit.
 */
/** Empty request payload for reloading configured secret providers. */
export const SecretsReloadParamsSchema = closedObject({});

/** Request payload for resolving the secrets needed by one command invocation. */
export const SecretsResolveParamsSchema = closedObject({
  commandName: NonEmptyString,
  targetIds: Type.Array(NonEmptyString),
  allowedPaths: Type.Optional(Type.Array(NonEmptyString)),
  forcedActivePaths: Type.Optional(Type.Array(NonEmptyString)),
  optionalActivePaths: Type.Optional(Type.Array(NonEmptyString)),
  providerOverrides: Type.Optional(
    closedObject({
      webSearch: Type.Optional(NonEmptyString),
      webFetch: Type.Optional(NonEmptyString),
    }),
  ),
});

/** Static type for secret resolution requests. */
export type SecretsResolveParams = Static<typeof SecretsResolveParamsSchema>;

/** One resolved secret assignment path plus its provider-owned value. */
export const SecretsResolveAssignmentSchema = closedObject({
  path: Type.Optional(NonEmptyString),
  pathSegments: Type.Array(NonEmptyString),
  value: Type.Unknown(),
});

/** Secret resolution response with assignments and safe diagnostics. */
export const SecretsResolveResultSchema = closedObject({
  ok: Type.Optional(Type.Boolean()),
  assignments: Type.Optional(Type.Array(SecretsResolveAssignmentSchema)),
  diagnostics: Type.Optional(Type.Array(NonEmptyString)),
  inactiveRefPaths: Type.Optional(Type.Array(NonEmptyString)),
});

/** Static type for secret resolution responses. */
export type SecretsResolveResult = Static<typeof SecretsResolveResultSchema>;
