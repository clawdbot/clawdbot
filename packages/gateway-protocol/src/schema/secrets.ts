// Gateway Protocol schema module defines protocol validation shapes.
import { Type, type Static } from "typebox";
import { closedObject } from "./closed-object.js";
import { NonEmptyString } from "./primitives.js";
import { withSince } from "./since.js";

/**
 * Secret-provider protocol schemas.
 *
 * These payloads request secret materialization from the gateway while keeping
 * caller scope, allowed paths, and provider overrides explicit.
 */
/** Empty request payload for reloading configured secret providers. */
export const SecretsReloadParamsSchema = closedObject({});

const SecretStoreNameSchema = Type.String({
  minLength: 1,
  maxLength: 128,
  pattern: "^[A-Z][A-Z0-9_]{0,127}$",
});

export const GitHubSetupHandleSchema = Type.String({
  pattern: "^github-setup-[a-f0-9]{32}$",
});

const SecretStoreMutationNameSchema = Type.String({
  minLength: 1,
  maxLength: 128,
  pattern: "^(?:[A-Z][A-Z0-9_]{0,127}|github-setup-[a-f0-9]{32})$",
});

const SecretStoreEntryMetadataProperties = {
  name: SecretStoreNameSchema,
  scopeKind: Type.Literal("team"),
  scopeId: Type.Literal(""),
  createdAtMs: Type.Integer({ minimum: 0 }),
  updatedAtMs: Type.Integer({ minimum: 0 }),
  updatedBy: Type.Optional(Type.String()),
} as const;

const SecretStoreAllowedHostsSchema = Type.Array(Type.String({ minLength: 1, maxLength: 253 }), {
  maxItems: 128,
  uniqueItems: true,
});

/** Secret metadata never structurally carries the stored value. */
export const SecretStoreSecretEntrySchema = closedObject({
  ...SecretStoreEntryMetadataProperties,
  kind: Type.Literal("secret"),
  allowedHosts: Type.Optional(withSince("2026.8", SecretStoreAllowedHostsSchema)),
});

/** Environment entries include their value because they are intentionally visible. */
export const SecretStoreEnvEntrySchema = closedObject({
  ...SecretStoreEntryMetadataProperties,
  kind: Type.Literal("env"),
  value: Type.String({ maxLength: 64 * 1024 }),
});

/** Team secret-store list entry, discriminated by disclosure behavior. */
export const SecretStoreEntrySchema = Type.Union([
  SecretStoreSecretEntrySchema,
  SecretStoreEnvEntrySchema,
]);

/** Empty request payload for listing the team secret store. */
export const SecretsStoreListParamsSchema = closedObject({});

/** Team secret-store inventory. */
export const SecretsStoreListResultSchema = closedObject({
  entries: Type.Array(SecretStoreEntrySchema),
});

/** Create or replace one team secret-store entry. */
export const SecretsStoreSetParamsSchema = closedObject({
  name: SecretStoreMutationNameSchema,
  value: Type.String({ maxLength: 64 * 1024 }),
  kind: Type.Union([Type.Literal("secret"), Type.Literal("env")]),
  allowedHosts: Type.Optional(withSince("2026.8", SecretStoreAllowedHostsSchema)),
});

/** Soft-delete one team secret-store entry. */
export const SecretsStoreDeleteParamsSchema = closedObject({
  name: SecretStoreMutationNameSchema,
});

/** Mutation acknowledgement including whether the active runtime was refreshed. */
export const SecretsStoreMutationResultSchema = closedObject({
  ok: Type.Literal(true),
  reloaded: Type.Boolean(),
  warningCount: Type.Optional(Type.Integer({ minimum: 0 })),
});

export type SecretStoreEntry = Static<typeof SecretStoreEntrySchema>;
export type SecretsStoreListResult = Static<typeof SecretsStoreListResultSchema>;
export type SecretsStoreSetParams = Static<typeof SecretsStoreSetParamsSchema>;
export type SecretsStoreDeleteParams = Static<typeof SecretsStoreDeleteParamsSchema>;
export type SecretsStoreMutationResult = Static<typeof SecretsStoreMutationResultSchema>;

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
