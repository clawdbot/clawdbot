// Gateway Protocol schema module defines protocol validation shapes.
import type { Static, TSchema } from "typebox";
import { Type } from "typebox";
import { closedObject } from "./closed-object.js";
import type { PluginDeclaredSurfaceGroup } from "./plugin-declared-surface-groups.js";
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
  icon: Type.Optional(Type.String()),
  path: Type.Optional(Type.String()),
  placement: Type.Optional(Type.String()),
  group: Type.Optional(Type.Union([Type.Literal("control"), Type.Literal("agent")])),
  order: Type.Optional(Type.Number()),
  schema: Type.Optional(PluginJsonValueSchema),
  requiredScopes: Type.Optional(Type.Array(NonEmptyString)),
});

/** Empty request payload for listing plugin UI descriptors. */
export const PluginsUiDescriptorsParamsSchema = closedObject({});

export const ControlUiPluginTabSchema = closedObject({
  pluginId: NonEmptyString,
  id: NonEmptyString,
  label: NonEmptyString,
  description: Type.Optional(Type.String()),
  icon: Type.Optional(Type.String()),
  path: Type.Optional(Type.String()),
  placement: Type.Optional(Type.String()),
  requiresGatewayAuth: Type.Optional(Type.Boolean()),
  group: Type.Optional(Type.Union([Type.Literal("control"), Type.Literal("agent")])),
  order: Type.Optional(Type.Number()),
});

export const ControlUiPluginWidgetKindSchema = closedObject({
  pluginId: NonEmptyString,
  kind: NonEmptyString,
  label: NonEmptyString,
});

/** Response payload containing all plugin UI descriptors visible to the client. */
export const PluginsUiDescriptorsResultSchema = closedObject({
  ok: Type.Literal(true),
  descriptors: Type.Array(PluginControlUiDescriptorSchema),
  generation: Type.Optional(Type.Integer({ minimum: 0 })),
  methods: Type.Optional(Type.Array(NonEmptyString)),
  controlUiTabs: Type.Optional(Type.Array(ControlUiPluginTabSchema)),
  controlUiWidgetKinds: Type.Optional(Type.Array(ControlUiPluginWidgetKindSchema)),
  pluginSurfaceUrls: Type.Optional(Type.Record(NonEmptyString, NonEmptyString)),
});

/** One immutable browser build owned by an active native plugin. */
export const PluginControlUiModuleSchema = closedObject({
  pluginId: NonEmptyString,
  name: NonEmptyString,
  revision: NonEmptyString,
  entryUrl: NonEmptyString,
  styles: Type.Array(NonEmptyString, { maxItems: 16 }),
});

export const PluginControlUiDiagnosticSchema = closedObject({
  pluginId: NonEmptyString,
  message: Type.String({ maxLength: 512 }),
  code: Type.Optional(Type.Literal("custom-plugin-ui-disabled")),
});

/** Lists browser builds; reading this catalog never reloads backend plugin code. */
export const PluginsControlUiListParamsSchema = closedObject({});
export const PluginsControlUiReloadParamsSchema = closedObject({
  pluginId: Type.Optional(NonEmptyString),
});
export const PluginsControlUiCatalogSchema = closedObject({
  revision: NonEmptyString,
  plugins: Type.Array(PluginControlUiModuleSchema, { maxItems: 64 }),
  diagnostics: Type.Array(PluginControlUiDiagnosticSchema, { maxItems: 64 }),
});
export const PluginsControlUiChangedEventSchema = closedObject({ revision: NonEmptyString });
export const PluginsControlUiReportParamsSchema = closedObject({
  pluginId: NonEmptyString,
  revision: NonEmptyString,
  status: Type.Union([Type.Literal("activated"), Type.Literal("failed")]),
  error: Type.Optional(Type.String({ maxLength: 512 })),
});
export const PluginsControlUiStatusParamsSchema = closedObject({
  pluginId: Type.Optional(NonEmptyString),
});
export const PluginsControlUiStatusResultSchema = closedObject({
  clients: Type.Array(
    closedObject({
      connId: NonEmptyString,
      activations: Type.Array(PluginsControlUiReportParamsSchema, { maxItems: 64 }),
    }),
    { maxItems: 128 },
  ),
});

/** Request payload for invoking one plugin-owned session action. */
export const PluginsSessionActionParamsSchema = closedObject({
  pluginId: NonEmptyString,
  actionId: NonEmptyString,
  sessionKey: Type.Optional(NonEmptyString),
  agentId: Type.Optional(NonEmptyString),
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

/** Observed state of the plugin in the current Gateway runtime generation. */
export const PluginRuntimeStatusSchema = closedObject({
  state: Type.Union([
    Type.Literal("unloaded"),
    Type.Literal("disabled"),
    Type.Literal("active"),
    Type.Literal("service-failed"),
  ]),
  error: Type.Optional(Type.String()),
});

/** Catalog metadata and desired enablement, with optional observed runtime state. */
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
  runtime: Type.Optional(PluginRuntimeStatusSchema),
  /** Coarse manifest-derived grouping (channel, provider, memory, ...) for catalog UIs. */
  category: Type.Optional(NonEmptyString),
  /** True when the plugin has an install record and can be removed via plugins.uninstall. */
  removable: Type.Optional(Type.Boolean()),
});

/** Empty request payload for the cold plugin catalog. */
export const PluginsListParamsSchema = closedObject({});

/** Installed and curated plugin catalog visible to the current gateway client. */
export const PluginsListResultSchema = closedObject({
  generation: Type.Optional(Type.Integer({ minimum: 0 })),
  plugins: Type.Array(PluginCatalogEntrySchema),
  diagnostics: Type.Array(Type.Unknown()),
  mutationAllowed: Type.Boolean(),
});

/** Request payload for inspecting one plugin's declared capability surface. */
export const PluginsInspectParamsSchema = closedObject({
  pluginId: NonEmptyString,
});

/** Effective operator hook-policy grant with optional explicit config value. */
export const PluginHookGrantSchema = closedObject({
  /** Effective policy after origin defaults and operator config. */
  effective: Type.Boolean(),
  /** Present only when plugins.entries.<id>.hooks sets the flag explicitly. */
  configured: Type.Optional(Type.Boolean()),
});

/** Install provenance and pinned artifact integrity for one plugin. */
export const PluginInspectSourceSchema = closedObject({
  kind: Type.Union([
    Type.Literal("bundled"),
    Type.Literal("clawhub"),
    Type.Literal("npm"),
    Type.Literal("git"),
    Type.Literal("path"),
    Type.Literal("archive"),
    Type.Literal("marketplace"),
    Type.Literal("official-catalog"),
  ]),
  spec: Type.Optional(NonEmptyString),
  packageName: Type.Optional(NonEmptyString),
  /** Pinned artifact integrity recorded at install (npm SSRI, sha-256, or git commit). */
  integrity: Type.Optional(NonEmptyString),
  integrityKind: Type.Optional(
    Type.Union([Type.Literal("ssri"), Type.Literal("sha256"), Type.Literal("git-commit")]),
  ),
});

/** Manifest-declared capability surface in enumerable terms. All arrays sorted. */
export const PluginDeclaredSurfaceSchema = closedObject({
  channels: Type.Array(NonEmptyString),
  providers: Type.Array(NonEmptyString),
  tools: Type.Array(NonEmptyString),
  /** Manifest contract families and identifiers, rendered as `family: id`. */
  contracts: Type.Array(NonEmptyString),
  /** Bundle-format hook names; code plugins register hooks at runtime and list nothing here. */
  hooks: Type.Array(NonEmptyString),
  mcpServers: Type.Array(NonEmptyString),
  cliCommands: Type.Array(NonEmptyString),
  cliBackends: Type.Array(NonEmptyString),
  skills: Type.Array(NonEmptyString),
  /** Dot paths from configContracts.dangerousFlags. */
  dangerousConfigFlags: Type.Array(NonEmptyString),
} satisfies Record<PluginDeclaredSurfaceGroup, TSchema>);

/** Operator-granted capability flags with effective values. */
export const PluginOperatorGrantsSchema = closedObject({
  hooks: closedObject({
    allowPromptInjection: PluginHookGrantSchema,
    allowConversationAccess: PluginHookGrantSchema,
  }),
  llm: Type.Optional(
    closedObject({
      allowModelOverride: Type.Optional(Type.Boolean()),
      allowedModels: Type.Optional(Type.Array(NonEmptyString)),
      allowedCompletionModels: Type.Optional(Type.Array(NonEmptyString)),
      allowAuthProfileOverride: Type.Optional(Type.Boolean()),
      allowAgentIdOverride: Type.Optional(Type.Boolean()),
    }),
  ),
  subagent: Type.Optional(
    closedObject({
      allowModelOverride: Type.Optional(Type.Boolean()),
      allowedModels: Type.Optional(Type.Array(NonEmptyString)),
    }),
  ),
});

/** Persisted ClawHub per-release trust verdict from the install record. */
export const PluginInstallTrustSchema = closedObject({
  disposition: Type.Union([
    Type.Literal("clean"),
    Type.Literal("review-recommended"),
    Type.Literal("review-required"),
    Type.Literal("blocked"),
  ]),
  reasons: Type.Optional(Type.Array(Type.String())),
  checkedAt: Type.Optional(NonEmptyString),
  acknowledgedAt: Type.Optional(NonEmptyString),
  pending: Type.Optional(Type.Boolean()),
  stale: Type.Optional(Type.Boolean()),
});

/** Newly declared capability items grouped by their existing manifest surface. */
export const PluginDeclaredSurfaceWideningSchema = Type.Partial(PluginDeclaredSurfaceSchema, {
  additionalProperties: false,
});

/** Typed failure payload that lets clients review and acknowledge plugin capabilities. */
export const CapabilityConsentErrorDetailsSchema = closedObject({
  capabilityConsentCode: Type.Literal("PLUGIN_CAPABILITY_CONSENT_REQUIRED"),
  pluginId: NonEmptyString,
  reviewToken: NonEmptyString,
  widened: Type.Optional(PluginDeclaredSurfaceWideningSchema),
  acceptedAt: Type.Optional(NonEmptyString),
});

/** Consent-relevant snapshot of one plugin for install/enable review. */
export const PluginsInspectResultSchema = closedObject({
  ok: Type.Literal(true),
  plugin: closedObject({
    id: NonEmptyString,
    name: NonEmptyString,
    version: Type.Optional(NonEmptyString),
    description: Type.Optional(Type.String()),
    origin: Type.Optional(NonEmptyString),
    installed: Type.Boolean(),
    enabled: Type.Boolean(),
  }),
  source: Type.Optional(PluginInspectSourceSchema),
  declared: PluginDeclaredSurfaceSchema,
  reviewToken: NonEmptyString,
  grants: PluginOperatorGrantsSchema,
  trust: Type.Optional(PluginInstallTrustSchema),
});

const PluginCapabilityAcknowledgmentSchema = closedObject({
  reviewToken: NonEmptyString,
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

const pluginInstallOptions = {
  clawManaged: Type.Optional(Type.Boolean()),
  mode: Type.Optional(Type.Union([Type.Literal("install"), Type.Literal("update")])),
  acknowledgeInstallPolicyWarning: Type.Optional(Type.Literal(true)),
  acknowledgeCapabilities: Type.Optional(PluginCapabilityAcknowledgmentSchema),
};

/** Install requests share the same artifact inspection and consent boundary. */
export const PluginsInstallParamsSchema = Type.Union([
  closedObject({
    ...pluginInstallOptions,
    source: Type.Literal("clawhub"),
    packageName: NonEmptyString,
    version: Type.Optional(NonEmptyString),
    expectedPluginId: Type.Optional(NonEmptyString),
    expectedIntegrity: Type.Optional(NonEmptyString),
  }),
  closedObject({
    ...pluginInstallOptions,
    source: Type.Literal("official"),
    pluginId: NonEmptyString,
    version: Type.Optional(NonEmptyString),
    pin: Type.Optional(Type.Boolean()),
  }),
  closedObject({
    ...pluginInstallOptions,
    source: Type.Literal("bundled"),
    pluginId: NonEmptyString,
  }),
  closedObject({
    ...pluginInstallOptions,
    source: Type.Literal("local"),
    path: NonEmptyString,
    link: Type.Optional(Type.Boolean()),
  }),
  closedObject({
    ...pluginInstallOptions,
    source: Type.Literal("npm"),
    spec: NonEmptyString,
    pin: Type.Optional(Type.Boolean()),
    expectedPluginId: Type.Optional(NonEmptyString),
    expectedIntegrity: Type.Optional(NonEmptyString),
  }),
  closedObject({
    ...pluginInstallOptions,
    source: Type.Literal("git"),
    spec: NonEmptyString,
  }),
  closedObject({
    ...pluginInstallOptions,
    source: Type.Literal("npm-pack"),
    archivePath: NonEmptyString,
  }),
  closedObject({
    ...pluginInstallOptions,
    source: Type.Literal("marketplace"),
    marketplace: NonEmptyString,
    plugin: NonEmptyString,
  }),
]);

/** Receipt emitted only after the requested runtime generation was applied. */
export const PluginRuntimeApplicationSchema = closedObject({
  operationId: NonEmptyString,
  generation: Type.Integer({ minimum: 0 }),
  pluginIds: Type.Array(NonEmptyString),
  sourceDigests: Type.Optional(Type.Record(NonEmptyString, NonEmptyString)),
});

export const PluginsChangedEventSchema = closedObject({
  generation: Type.Integer({ minimum: 0 }),
});

/** Successful plugin installation result. */
export const PluginsInstallResultSchema = closedObject({
  ok: Type.Literal(true),
  plugin: PluginCatalogEntrySchema,
  restartRequired: Type.Boolean(),
  runtime: Type.Optional(PluginRuntimeApplicationSchema),
  warnings: Type.Optional(Type.Array(Type.String())),
});

/** Internal signal that persisted plugin metadata changed outside the Gateway process. */
export const PluginsRefreshParamsSchema = closedObject({});

/** Successful plugin metadata refresh admission. */
export const PluginsRefreshResultSchema = closedObject({
  ok: Type.Literal(true),
  restartRequired: Type.Optional(Type.Boolean()),
  runtime: Type.Optional(PluginRuntimeApplicationSchema),
});

/** Reload the selected installed source without changing its enabled policy. */
export const PluginsReloadParamsSchema = closedObject({
  pluginId: NonEmptyString,
  acknowledgeCapabilities: Type.Optional(PluginCapabilityAcknowledgmentSchema),
});

export const PluginsReloadResultSchema = closedObject({
  ok: Type.Literal(true),
  pluginId: NonEmptyString,
  restartRequired: Type.Boolean(),
  runtime: Type.Optional(PluginRuntimeApplicationSchema),
});

/** Request payload for removing one installed plugin and its managed files. */
export const PluginsUninstallParamsSchema = closedObject({
  pluginId: NonEmptyString,
  keepFiles: Type.Optional(Type.Boolean()),
  clawManaged: Type.Optional(Type.Boolean()),
});

/** Successful plugin removal result listing the cleanup actions that ran. */
export const PluginsUninstallResultSchema = closedObject({
  ok: Type.Literal(true),
  pluginId: NonEmptyString,
  restartRequired: Type.Boolean(),
  runtime: Type.Optional(PluginRuntimeApplicationSchema),
  removed: Type.Array(Type.String()),
  warnings: Type.Optional(Type.Array(Type.String())),
});

/** Request payload for changing one installed plugin's policy state. */
export const PluginsSetEnabledParamsSchema = closedObject({
  pluginId: NonEmptyString,
  enabled: Type.Boolean(),
  acknowledgeCapabilities: Type.Optional(PluginCapabilityAcknowledgmentSchema),
});

/** Successful plugin enablement policy update. */
export const PluginsSetEnabledResultSchema = closedObject({
  ok: Type.Literal(true),
  plugin: PluginCatalogEntrySchema,
  restartRequired: Type.Boolean(),
  runtime: Type.Optional(PluginRuntimeApplicationSchema),
  warnings: Type.Optional(Type.Array(Type.String())),
});

export type PluginCatalogEntry = Static<typeof PluginCatalogEntrySchema>;
export type PluginRuntimeStatus = Static<typeof PluginRuntimeStatusSchema>;
export type PluginsListParams = Static<typeof PluginsListParamsSchema>;
export type PluginsListResult = Static<typeof PluginsListResultSchema>;
export type PluginsInspectParams = Static<typeof PluginsInspectParamsSchema>;
export type PluginsInspectResult = Static<typeof PluginsInspectResultSchema>;
export type PluginHookGrant = Static<typeof PluginHookGrantSchema>;
export type PluginInspectSource = Static<typeof PluginInspectSourceSchema>;
export type PluginDeclaredSurface = Static<typeof PluginDeclaredSurfaceSchema>;
export type PluginOperatorGrants = Static<typeof PluginOperatorGrantsSchema>;
export type PluginInstallTrust = Static<typeof PluginInstallTrustSchema>;
export type PluginsSearchParams = Static<typeof PluginsSearchParamsSchema>;
export type PluginsSearchResult = Static<typeof PluginsSearchResultSchema>;
export type PluginsInstallParams = Static<typeof PluginsInstallParamsSchema>;
export type PluginsInstallResult = Static<typeof PluginsInstallResultSchema>;
export type PluginsRefreshParams = Static<typeof PluginsRefreshParamsSchema>;
export type PluginsRefreshResult = Static<typeof PluginsRefreshResultSchema>;
export type PluginsReloadParams = Static<typeof PluginsReloadParamsSchema>;
export type PluginsReloadResult = Static<typeof PluginsReloadResultSchema>;
export type PluginRuntimeApplication = Static<typeof PluginRuntimeApplicationSchema>;
export type PluginsChangedEvent = Static<typeof PluginsChangedEventSchema>;
export type PluginsUninstallParams = Static<typeof PluginsUninstallParamsSchema>;
export type PluginsUninstallResult = Static<typeof PluginsUninstallResultSchema>;
export type PluginsSetEnabledParams = Static<typeof PluginsSetEnabledParamsSchema>;
export type PluginsSetEnabledResult = Static<typeof PluginsSetEnabledResultSchema>;

// Wire types derive directly from local schema consts so public d.ts graphs never
// pull in the ProtocolSchemas registry.
export type PluginControlUiDescriptor = Static<typeof PluginControlUiDescriptorSchema>;
export type PluginsUiDescriptorsParams = Static<typeof PluginsUiDescriptorsParamsSchema>;
export type PluginsUiDescriptorsResult = Static<typeof PluginsUiDescriptorsResultSchema>;
export type PluginControlUiModule = Static<typeof PluginControlUiModuleSchema>;
export type PluginControlUiDiagnostic = Static<typeof PluginControlUiDiagnosticSchema>;
export type PluginsControlUiCatalog = Static<typeof PluginsControlUiCatalogSchema>;
export type PluginsControlUiReloadParams = Static<typeof PluginsControlUiReloadParamsSchema>;
export type PluginControlUiActivation = Static<typeof PluginsControlUiReportParamsSchema>;
export type PluginsSessionActionParams = Static<typeof PluginsSessionActionParamsSchema>;
export type PluginsSessionActionResult = Static<typeof PluginsSessionActionResultSchema>;
