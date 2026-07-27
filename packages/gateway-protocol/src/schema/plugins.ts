// Gateway Protocol schema module defines protocol validation shapes.
import type { Static } from "typebox";
import { Type } from "typebox";
import { closedObject } from "./closed-object.js";
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
export const PluginControlUiDescriptorSchema = closedObject({
  id: NonEmptyString,
  pluginId: NonEmptyString,
  pluginName: Type.Optional(NonEmptyString),
  surface: Type.Union([
    Type.Literal("session"),
    Type.Literal("tool"),
    Type.Literal("run"),
    Type.Literal("settings"),
    Type.Literal("tab"),
    Type.Literal("widget"),
  ]),
  label: NonEmptyString,
  description: Type.Optional(Type.String()),
  placement: Type.Optional(Type.String()),
  schema: Type.Optional(PluginJsonValueSchema),
  requiredScopes: Type.Optional(Type.Array(NonEmptyString)),
});

/** Empty request payload for listing plugin UI descriptors. */
export const PluginsUiDescriptorsParamsSchema = closedObject({});

/** Response payload containing all plugin UI descriptors visible to the client. */
export const PluginsUiDescriptorsResultSchema = closedObject({
  ok: Type.Literal(true),
  descriptors: Type.Array(PluginControlUiDescriptorSchema),
});

/** Request payload for invoking one plugin-owned session action. */
export const PluginsSessionActionParamsSchema = closedObject({
  pluginId: NonEmptyString,
  actionId: NonEmptyString,
  sessionKey: Type.Optional(NonEmptyString),
  payload: Type.Optional(PluginJsonValueSchema),
});

/** Successful plugin action result, optionally continuing the agent turn. */
export const PluginsSessionActionSuccessResultSchema = closedObject({
  ok: Type.Literal(true),
  result: Type.Optional(PluginJsonValueSchema),
  continueAgent: Type.Optional(Type.Boolean()),
  reply: Type.Optional(PluginJsonValueSchema),
});

/** Failed plugin action result with plugin-owned detail payload. */
export const PluginsSessionActionFailureResultSchema = closedObject({
  ok: Type.Literal(false),
  error: Type.String(),
  code: Type.Optional(Type.String()),
  details: Type.Optional(PluginJsonValueSchema),
});

/** Discriminated plugin action result returned to gateway clients. */
export const PluginsSessionActionResultSchema = Type.Union([
  PluginsSessionActionSuccessResultSchema,
  PluginsSessionActionFailureResultSchema,
]);

/** ClawHub-backed install action for one catalog entry. */
export const PluginCatalogClawHubInstallSchema = closedObject({
  source: Type.Literal("clawhub"),
  packageName: NonEmptyString,
});

/** Official-catalog install action for one catalog entry. */
export const PluginCatalogOfficialInstallSchema = closedObject({
  source: Type.Literal("official"),
  pluginId: NonEmptyString,
});

// Branches stay named schemas: the Swift generator only emits discriminated
// unions whose branches resolve to registered types (see PluginsSessionActionResult).
export const PluginCatalogInstallActionSchema = Type.Union([
  PluginCatalogClawHubInstallSchema,
  PluginCatalogOfficialInstallSchema,
]);

/** Cold control-plane representation of an installed or available plugin. */
export const PluginCatalogEntrySchema = closedObject({
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
  featuredAt: Type.Optional(Type.Integer({ minimum: 0 })),
  order: Type.Optional(Type.Number()),
  /** True when the gateway can resolve a manifest or catalog icon for this plugin identity. */
  hasIcon: Type.Optional(Type.Boolean()),
  install: Type.Optional(PluginCatalogInstallActionSchema),
  error: Type.Optional(Type.String()),
  /** Coarse manifest-derived grouping (channel, provider, memory, ...) for catalog UIs. */
  category: Type.Optional(NonEmptyString),
  /** True when the plugin has an install record and can be removed via plugins.uninstall. */
  removable: Type.Optional(Type.Boolean()),
});

/** Empty request payload for the cold plugin catalog. */
export const PluginsListParamsSchema = closedObject({});

/** Installed and curated plugin catalog visible to the current gateway client. */
export const PluginsListResultSchema = closedObject({
  plugins: Type.Array(PluginCatalogEntrySchema),
  diagnostics: Type.Array(Type.Unknown()),
  mutationAllowed: Type.Boolean(),
});

/** Request payload for searching installable ClawHub plugin families. */
export const PluginsSearchParamsSchema = closedObject({
  query: NonEmptyString,
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
});

/** ClawHub package fields exposed by plugin search. */
export const PluginSearchPackageSchema = closedObject({
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
});

/** Ranked ClawHub plugin search hit. */
export const PluginSearchResultEntrySchema = closedObject({
  score: Type.Number(),
  package: PluginSearchPackageSchema,
});

/** Ranked installable plugin packages matching the query. */
export const PluginsSearchResultSchema = closedObject({
  results: Type.Array(PluginSearchResultEntrySchema),
});

/** Trusted official-catalog or acknowledged ClawHub install request. */
export const PluginsInstallParamsSchema = Type.Union([
  closedObject({
    source: Type.Literal("clawhub"),
    packageName: NonEmptyString,
    version: Type.Optional(NonEmptyString),
    acknowledgeClawHubRisk: Type.Optional(Type.Boolean()),
  }),
  closedObject({
    source: Type.Literal("official"),
    pluginId: NonEmptyString,
  }),
]);

/** Successful plugin installation result. */
export const PluginsInstallResultSchema = closedObject({
  ok: Type.Literal(true),
  plugin: PluginCatalogEntrySchema,
  restartRequired: Type.Literal(true),
  warnings: Type.Optional(Type.Array(Type.String())),
});

/** Internal signal that persisted plugin metadata changed outside the Gateway process. */
export const PluginsRefreshParamsSchema = closedObject({});

/** Successful plugin metadata refresh admission. */
export const PluginsRefreshResultSchema = closedObject({
  ok: Type.Literal(true),
});

/** Request payload for removing one installed plugin and its managed files. */
export const PluginsUninstallParamsSchema = closedObject({
  pluginId: NonEmptyString,
});

/** Successful plugin removal result listing the cleanup actions that ran. */
export const PluginsUninstallResultSchema = closedObject({
  ok: Type.Literal(true),
  pluginId: NonEmptyString,
  restartRequired: Type.Literal(true),
  removed: Type.Array(Type.String()),
  warnings: Type.Optional(Type.Array(Type.String())),
});

/** Request payload for changing one installed plugin's policy state. */
export const PluginsSetEnabledParamsSchema = closedObject({
  pluginId: NonEmptyString,
  enabled: Type.Boolean(),
});

/** Successful plugin enablement policy update. */
export const PluginsSetEnabledResultSchema = closedObject({
  ok: Type.Literal(true),
  plugin: PluginCatalogEntrySchema,
  restartRequired: Type.Boolean(),
  warnings: Type.Optional(Type.Array(Type.String())),
});

export type PluginCatalogEntry = Static<typeof PluginCatalogEntrySchema>;
export type PluginsListParams = Static<typeof PluginsListParamsSchema>;
export type PluginsListResult = Static<typeof PluginsListResultSchema>;
export type PluginsSearchParams = Static<typeof PluginsSearchParamsSchema>;
export type PluginsSearchResult = Static<typeof PluginsSearchResultSchema>;
export type PluginsInstallParams = Static<typeof PluginsInstallParamsSchema>;
export type PluginsInstallResult = Static<typeof PluginsInstallResultSchema>;
export type PluginsRefreshParams = Static<typeof PluginsRefreshParamsSchema>;
export type PluginsRefreshResult = Static<typeof PluginsRefreshResultSchema>;
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
