// Gateway Protocol schema module defines protocol validation shapes.
import type { Static } from "typebox";
import { Type } from "typebox";
import { NonEmptyString } from "./primitives.js";

/**
 * Plugin control-surface protocol schemas.
 *
 * These payloads let the gateway expose plugin-provided UI actions without
 * baking plugin-specific payload shapes into the core protocol.
 */
/** Arbitrary plugin-owned JSON payload carried opaquely through the gateway. */
export const PluginJsonValueSchema = Type.Unknown();

/** Descriptor for one plugin-provided control UI action or surface. */
export const PluginControlUiDescriptorSchema = Type.Object(
  {
    id: NonEmptyString,
    pluginId: NonEmptyString,
    pluginName: Type.Optional(NonEmptyString),
    surface: Type.Union([
      Type.Literal("session"),
      Type.Literal("tool"),
      Type.Literal("run"),
      Type.Literal("settings"),
    ]),
    label: NonEmptyString,
    description: Type.Optional(Type.String()),
    placement: Type.Optional(Type.String()),
    schema: Type.Optional(PluginJsonValueSchema),
    requiredScopes: Type.Optional(Type.Array(NonEmptyString)),
  },
  { additionalProperties: false },
);

/** Empty request payload for listing plugin UI descriptors. */
export const PluginsUiDescriptorsParamsSchema = Type.Object({}, { additionalProperties: false });

/** Response payload containing all plugin UI descriptors visible to the client. */
export const PluginsUiDescriptorsResultSchema = Type.Object(
  {
    ok: Type.Literal(true),
    descriptors: Type.Array(PluginControlUiDescriptorSchema),
  },
  { additionalProperties: false },
);

/** Request payload for invoking one plugin-owned session action. */
export const PluginsSessionActionParamsSchema = Type.Object(
  {
    pluginId: NonEmptyString,
    actionId: NonEmptyString,
    sessionKey: Type.Optional(NonEmptyString),
    payload: Type.Optional(PluginJsonValueSchema),
  },
  { additionalProperties: false },
);

/** Successful plugin action result, optionally continuing the agent turn. */
export const PluginsSessionActionSuccessResultSchema = Type.Object(
  {
    ok: Type.Literal(true),
    result: Type.Optional(PluginJsonValueSchema),
    continueAgent: Type.Optional(Type.Boolean()),
    reply: Type.Optional(PluginJsonValueSchema),
  },
  { additionalProperties: false },
);

/** Failed plugin action result with plugin-owned detail payload. */
export const PluginsSessionActionFailureResultSchema = Type.Object(
  {
    ok: Type.Literal(false),
    error: Type.String(),
    code: Type.Optional(Type.String()),
    details: Type.Optional(PluginJsonValueSchema),
  },
  { additionalProperties: false },
);

/** Discriminated plugin action result returned to gateway clients. */
export const PluginsSessionActionResultSchema = Type.Union([
  PluginsSessionActionSuccessResultSchema,
  PluginsSessionActionFailureResultSchema,
]);

/** ClawHub-backed install action for one catalog entry. */
export const PluginCatalogClawHubInstallSchema = Type.Object(
  {
    source: Type.Literal("clawhub"),
    packageName: NonEmptyString,
  },
  { additionalProperties: false },
);

/** Official-catalog install action for one catalog entry. */
export const PluginCatalogOfficialInstallSchema = Type.Object(
  {
    source: Type.Literal("official"),
    pluginId: NonEmptyString,
  },
  { additionalProperties: false },
);

// Branches stay named schemas: the Swift generator only emits discriminated
// unions whose branches resolve to registered types (see PluginsSessionActionResult).
export const PluginCatalogInstallActionSchema = Type.Union([
  PluginCatalogClawHubInstallSchema,
  PluginCatalogOfficialInstallSchema,
]);

/** Cold control-plane representation of an installed or available plugin. */
export const PluginCatalogEntrySchema = Type.Object(
  {
    id: NonEmptyString,
    name: NonEmptyString,
    packageName: Type.Optional(NonEmptyString),
    description: Type.Optional(Type.String()),
    version: Type.Optional(NonEmptyString),
    kind: Type.Optional(Type.Array(NonEmptyString)),
    origin: Type.Optional(NonEmptyString),
    installed: Type.Boolean(),
    enabled: Type.Boolean(),
    state: Type.Union([
      Type.Literal("enabled"),
      Type.Literal("disabled"),
      Type.Literal("not-installed"),
      Type.Literal("error"),
    ]),
    featured: Type.Optional(Type.Boolean()),
    order: Type.Optional(Type.Number()),
    install: Type.Optional(PluginCatalogInstallActionSchema),
    error: Type.Optional(Type.String()),
    /** Coarse manifest-derived grouping (channel, provider, memory, ...) for catalog UIs. */
    category: Type.Optional(NonEmptyString),
    /** True when the plugin has an install record and can be removed via plugins.uninstall. */
    removable: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
);

/** Empty request payload for the cold plugin catalog. */
export const PluginsListParamsSchema = Type.Object({}, { additionalProperties: false });

/** Installed and curated plugin catalog visible to the current gateway client. */
export const PluginsListResultSchema = Type.Object(
  {
    plugins: Type.Array(PluginCatalogEntrySchema),
    diagnostics: Type.Array(Type.Unknown()),
    mutationAllowed: Type.Boolean(),
  },
  { additionalProperties: false },
);

/** Request payload for searching installable ClawHub plugin families. */
export const PluginsSearchParamsSchema = Type.Object(
  {
    query: NonEmptyString,
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
  },
  { additionalProperties: false },
);

/** ClawHub package fields exposed by plugin search. */
export const PluginSearchPackageSchema = Type.Object(
  {
    name: NonEmptyString,
    displayName: NonEmptyString,
    family: Type.Union([Type.Literal("code-plugin"), Type.Literal("bundle-plugin")]),
    channel: Type.Union([
      Type.Literal("official"),
      Type.Literal("community"),
      Type.Literal("private"),
    ]),
    isOfficial: Type.Boolean(),
    summary: Type.Optional(Type.String()),
    latestVersion: Type.Optional(NonEmptyString),
    runtimeId: Type.Optional(NonEmptyString),
    downloads: Type.Optional(Type.Number({ minimum: 0 })),
    verificationTier: Type.Optional(NonEmptyString),
  },
  { additionalProperties: false },
);

/** Ranked ClawHub plugin search hit. */
export const PluginSearchResultEntrySchema = Type.Object(
  {
    score: Type.Number(),
    package: PluginSearchPackageSchema,
  },
  { additionalProperties: false },
);

/** Ranked installable plugin packages matching the query. */
export const PluginsSearchResultSchema = Type.Object(
  { results: Type.Array(PluginSearchResultEntrySchema) },
  { additionalProperties: false },
);

/** Trusted official-catalog or acknowledged ClawHub install request. */
export const PluginsInstallParamsSchema = Type.Union([
  Type.Object(
    {
      source: Type.Literal("clawhub"),
      packageName: NonEmptyString,
      version: Type.Optional(NonEmptyString),
      acknowledgeClawHubRisk: Type.Optional(Type.Boolean()),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      source: Type.Literal("official"),
      pluginId: NonEmptyString,
    },
    { additionalProperties: false },
  ),
]);

/** Successful plugin installation result. */
export const PluginsInstallResultSchema = Type.Object(
  {
    ok: Type.Literal(true),
    plugin: PluginCatalogEntrySchema,
    restartRequired: Type.Literal(true),
    warnings: Type.Optional(Type.Array(Type.String())),
  },
  { additionalProperties: false },
);

/** Request payload for removing one installed plugin and its managed files. */
export const PluginsUninstallParamsSchema = Type.Object(
  {
    pluginId: NonEmptyString,
  },
  { additionalProperties: false },
);

/** Successful plugin removal result listing the cleanup actions that ran. */
export const PluginsUninstallResultSchema = Type.Object(
  {
    ok: Type.Literal(true),
    pluginId: NonEmptyString,
    restartRequired: Type.Literal(true),
    removed: Type.Array(Type.String()),
    warnings: Type.Optional(Type.Array(Type.String())),
  },
  { additionalProperties: false },
);

/** Request payload for changing one installed plugin's policy state. */
export const PluginsSetEnabledParamsSchema = Type.Object(
  {
    pluginId: NonEmptyString,
    enabled: Type.Boolean(),
  },
  { additionalProperties: false },
);

/** Successful plugin enablement policy update. */
export const PluginsSetEnabledResultSchema = Type.Object(
  {
    ok: Type.Literal(true),
    plugin: PluginCatalogEntrySchema,
    restartRequired: Type.Boolean(),
    warnings: Type.Optional(Type.Array(Type.String())),
  },
  { additionalProperties: false },
);

export type PluginCatalogEntry = Static<typeof PluginCatalogEntrySchema>;
export type PluginsListParams = Static<typeof PluginsListParamsSchema>;
export type PluginsListResult = Static<typeof PluginsListResultSchema>;
export type PluginsSearchParams = Static<typeof PluginsSearchParamsSchema>;
export type PluginsSearchResult = Static<typeof PluginsSearchResultSchema>;
export type PluginsInstallParams = Static<typeof PluginsInstallParamsSchema>;
export type PluginsInstallResult = Static<typeof PluginsInstallResultSchema>;
export type PluginsUninstallParams = Static<typeof PluginsUninstallParamsSchema>;
export type PluginsUninstallResult = Static<typeof PluginsUninstallResultSchema>;
export type PluginsSetEnabledParams = Static<typeof PluginsSetEnabledParamsSchema>;
export type PluginsSetEnabledResult = Static<typeof PluginsSetEnabledResultSchema>;

// Wire types derive directly from local schema consts so public d.ts graphs never
// pull in the ProtocolSchemas registry.
export type PluginControlUiDescriptor = Static<typeof PluginControlUiDescriptorSchema>;
export type PluginsUiDescriptorsParams = Static<typeof PluginsUiDescriptorsParamsSchema>;
export type PluginsUiDescriptorsResult = Static<typeof PluginsUiDescriptorsResultSchema>;
export type PluginsSessionActionParams = Static<typeof PluginsSessionActionParamsSchema>;
export type PluginsSessionActionResult = Static<typeof PluginsSessionActionResultSchema>;
