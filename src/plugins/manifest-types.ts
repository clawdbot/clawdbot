import type { ModelPricingProvider } from "@openclaw/model-catalog-core/model-catalog-pricing";
import type { ModelCatalog } from "@openclaw/model-catalog-core/model-catalog-types";
import type { ChannelConfigRuntimeSchema } from "../channels/plugins/types.config.js";
import type { ConfigUiPresentation } from "../shared/config-ui-hints-types.js";
import type { JsonSchemaObject } from "../shared/json-schema.types.js";
import type { DoctorSessionRouteStateOwner } from "./doctor-session-route-state-owner-types.js";
import type { PluginManifestCommandAlias } from "./manifest-command-aliases.js";
import type { PluginKind } from "./plugin-kind.types.js";

/** UI hint metadata for plugin config schema fields. */
export type PluginConfigUiHint = {
  label?: string;
  help?: string;
  tags?: string[];
  advanced?: boolean;
  sensitive?: boolean;
  placeholder?: string;
  presentation?: ConfigUiPresentation;
};

/** Top-level plugin manifest format. */
export type PluginFormat = "openclaw" | "bundle";

/** Supported external bundle manifest formats. */
export type PluginBundleFormat = "agent" | "codex" | "claude" | "cursor";

/**
 * Closed classification codes for plugin diagnostics. Health surfaces branch
 * on these instead of matching freeform diagnostic message text.
 */
export type PluginDiagnosticCode =
  | "backup-resource-declaration-invalid"
  | "channel-setup-failure"
  | "dashboard-declaration-invalid"
  | "plugin-verification"
  | "workspace-scope-omitted";

/** Diagnostic emitted while discovering or validating plugins. */
export type PluginDiagnostic = {
  level: "warn" | "error";
  message: string;
  pluginId?: string;
  source?: string;
  code?: PluginDiagnosticCode;
};

export type PluginManifestChannelConfig = {
  schema: JsonSchemaObject;
  uiHints?: Record<string, PluginConfigUiHint>;
  runtime?: ChannelConfigRuntimeSchema;
  label?: string;
  description?: string;
  preferOver?: string[];
  commands?: PluginManifestChannelCommandDefaults;
};

export type PluginManifestChannelCommandDefaults = {
  nativeCommandsAutoEnabled?: boolean;
  nativeSkillsAutoEnabled?: boolean;
};

export type PluginManifestModelSupport = {
  /**
   * Cheap manifest-owned model-id prefixes for transparent provider activation
   * from shorthand model refs such as `gpt-5.4` or `claude-sonnet-4.6`.
   */
  modelPrefixes?: string[];
  /**
   * Regex sources matched against the raw model id after profile suffixes are
   * stripped. Use this when simple prefixes are not expressive enough.
   */
  modelPatterns?: string[];
};

export type PluginManifestModelCatalog = ModelCatalog;

export type PluginManifestModelPricing = {
  providers?: Record<string, ModelPricingProvider>;
};

export type PluginManifestModelIdPrefixRule = {
  modelPrefix: string;
  prefix: string;
};

export type PluginManifestModelIdNormalizationProvider = {
  aliases?: Record<string, string>;
  stripPrefixes?: string[];
  prefixWhenBare?: string;
  prefixWhenBareAfterAliasStartsWith?: PluginManifestModelIdPrefixRule[];
};

export type PluginManifestModelIdNormalization = {
  providers?: Record<string, PluginManifestModelIdNormalizationProvider>;
};

export type PluginManifestProviderEndpoint = {
  /**
   * Core endpoint class this plugin-owned endpoint should map to. Core must
   * already know the class; manifests own host/baseUrl matching metadata.
   */
  endpointClass: string;
  /** Hostnames that should resolve to this endpoint class. */
  hosts?: string[];
  /** Host suffixes that should resolve to this endpoint class. */
  hostSuffixes?: string[];
  /** Exact normalized base URLs that should resolve to this endpoint class. */
  baseUrls?: string[];
  /** Static Google Vertex region metadata for exact global hosts. */
  googleVertexRegion?: string;
  /** Host suffix whose prefix should be exposed as the Google Vertex region. */
  googleVertexRegionHostSuffix?: string;
};

export type PluginManifestProviderRequestProvider = {
  family?: string;
  compatibilityFamily?: "moonshot";
  openAICompletions?: {
    supportsStreamingUsage?: boolean;
  };
};

export type PluginManifestProviderRequest = {
  providers?: Record<string, PluginManifestProviderRequestProvider>;
};

export type PluginManifestSecretProviderIntegration = {
  providerAlias?: string;
  displayName?: string;
  description?: string;
  source: "exec";
  command: "${node}";
  args?: string[];
  timeoutMs?: number;
  noOutputTimeoutMs?: number;
  maxOutputBytes?: number;
  jsonOnly?: boolean;
  env?: Record<string, string>;
  passEnv?: string[];
};

export type PluginManifestActivationCapability = "provider" | "channel" | "tool" | "hook";

export type PluginManifestActivation = {
  /**
   * Explicit Gateway startup activation. Set true when the plugin must be
   * imported during Gateway startup; set false when narrower activation
   * triggers should load it on demand.
   */
  onStartup?: boolean;
  /**
   * Provider ids that should include this plugin in activation/load plans.
   * This is planner metadata only; runtime behavior still comes from register().
   */
  onProviders?: string[];
  /** Agent harness runtime ids that should include this plugin in activation/load plans. */
  onAgentHarnesses?: string[];
  /** Command ids that should include this plugin in activation/load plans. */
  onCommands?: string[];
  /** Channel ids that should include this plugin in activation/load plans. */
  onChannels?: string[];
  /** Route kinds that should include this plugin in activation/load plans. */
  onRoutes?: string[];
  /** Root-relative config paths that should include this plugin in startup/load plans. */
  onConfigPaths?: string[];
  /** Broad capability hints for activation/load plans. Prefer narrower ownership metadata. */
  onCapabilities?: PluginManifestActivationCapability[];
};

/** Root CLI command metadata available before plugin code is imported. */
export type PluginManifestCliCommand = {
  name: string;
  description: string;
  hasSubcommands: boolean;
};

export type PluginManifestDefaultPlatform = NodeJS.Platform;

export type PluginManifestSetupProvider = {
  /** Provider id surfaced during setup/onboarding. */
  id: string;
  /** Setup/auth methods that this provider supports. */
  authMethods?: string[];
  /** Environment variables that can satisfy setup without runtime loading. */
  envVars?: string[];
  /**
   * Cheap local evidence that a provider can authenticate without loading
   * runtime code. Evidence checks must not read secrets, shell out, or call
   * provider APIs.
   */
  authEvidence?: PluginManifestSetupProviderAuthEvidence[];
};

export type PluginManifestSetupProviderAuthEvidence = {
  /** Generic local file evidence gated by required environment metadata. */
  type: "local-file-with-env";
  /** Optional env var containing an explicit credential file path. */
  fileEnvVar?: string;
  /** Optional fallback credential file paths. Supports `${HOME}` and `${APPDATA}`. */
  fallbackPaths?: string[];
  /** At least one of these env vars must be non-empty when provided. */
  requiresAnyEnv?: string[];
  /** Every env var listed here must be non-empty when provided. */
  requiresAllEnv?: string[];
  /** Non-secret marker returned when this evidence is present. */
  credentialMarker: string;
  /** Human-readable auth source label. */
  source?: string;
};

export type PluginManifestSetup = {
  /** Cheap provider setup metadata exposed before runtime loads. */
  providers?: PluginManifestSetupProvider[];
  /** Setup-time backend ids available without full runtime activation. */
  cliBackends?: string[];
  /** Config migration ids owned by this plugin's setup surface. */
  configMigrations?: string[];
  /**
   * Whether setup still needs plugin runtime execution after descriptor lookup.
   * Explicit false disables setup runtime; omission preserves the legacy fallback.
   */
  requiresRuntime?: boolean;
};

export type PluginManifestDoctorContract = {
  configRepair?: boolean;
  resolveSessionStoreAgentIds?: boolean;
  /**
   * @deprecated Declare static ownership in top-level sessionRouteStateOwners instead.
   * Removal plan: remove the module fallback in OpenClaw 2027.1 after external plugins migrate.
   */
  sessionRouteStateOwners?: boolean;
  stateMigrations?: boolean;
};

export type PluginManifestQaRunner = {
  /** Subcommand mounted beneath `openclaw qa`, for example `matrix`. */
  commandName: string;
  /** Optional user-facing help text for fallback host stubs. */
  description?: string;
};

export type PluginManifestDashboardDataBinding = {
  /** Plugin-local id. Widget grants receive the plugin-id prefix. */
  id: string;
  /** Read-scoped Gateway method registered by this plugin. */
  method: string;
  description: string;
};

export type PluginManifestDashboardActionVerb = {
  /** Plugin-local id. Widget grants receive the plugin-id prefix. */
  id: string;
  /** Write-scoped Gateway method registered by this plugin. */
  method: string;
  description: string;
  /** Optional JSON Schema for the action params object. */
  paramShape?: JsonSchemaObject;
};

export type PluginManifestDashboard = {
  dataBindings?: PluginManifestDashboardDataBinding[];
  actionVerbs?: PluginManifestDashboardActionVerb[];
};

/** Built browser assets activated by the trusted native Control UI host. */
export type PluginManifestControlUi = {
  /** JavaScript entry in a dedicated dist subdirectory, relative to the plugin root. */
  entry: string;
  /** Stylesheets in the same asset directory, loaded before activation. */
  styles?: string[];
};

export type PluginManifestMcpServer = Record<string, unknown>;

export type PluginManifestConfigLiteral = string | number | boolean | null;

export type PluginManifestDangerousConfigFlag = {
  /**
   * Dot-separated config path relative to `plugins.entries.<id>.config`.
   * Supports `*` wildcards for map/array segments.
   */
  path: string;
  /** Exact literal that marks this config value as dangerous. */
  equals: PluginManifestConfigLiteral;
};

export type PluginManifestSecretInputPath = {
  /**
   * Dot-separated config path relative to `plugins.entries.<id>.config`.
   * Supports `*` wildcards for map/array segments.
   */
  path: string;
  /** Expected resolved type for SecretRef materialization. */
  expected?: "string";
  /** Runtime owner kind used to isolate this surface when resolution fails. */
  ownerKind?: "capability" | "route";
};

export type PluginManifestSecretInputContracts = {
  /**
   * Override bundled-plugin default enablement when deciding whether this
   * SecretRef surface is active. Use this when the plugin is bundled but the
   * surface should stay inactive until explicitly enabled in config.
   */
  bundledDefaultEnabled?: boolean;
  paths: PluginManifestSecretInputPath[];
};

export type PluginManifestConfigContracts = {
  /**
   * Root-relative config paths that indicate this plugin's setup-time
   * compatibility migrations might apply. Use this to keep generic runtime
   * config reads from loading every plugin setup surface when the config does
   * not reference the plugin at all.
   */
  compatibilityMigrationPaths?: string[];
  /**
   * Root-relative compatibility paths that this plugin can service during
   * runtime before plugin code fully activates. Use this for legacy surfaces
   * that should cheaply narrow bundled candidate sets without importing every
   * compatible plugin runtime.
   */
  compatibilityRuntimePaths?: string[];
  dangerousFlags?: PluginManifestDangerousConfigFlag[];
  secretInputs?: PluginManifestSecretInputContracts;
};

export type PluginManifestCatalog = {
  featured?: boolean;
  order?: number;
};

/** Declarative backup ownership rooted at host-managed state or each configured agent. */
export type PluginManifestBackupResource = {
  disposition: "include" | "regenerable";
  scope: "state" | "agent";
  relativePath: string;
};

export type PluginManifest = {
  id: string;
  configSchema: JsonSchemaObject;
  /** Static backup inclusion/exclusion declarations; resolved without loading plugin runtime. */
  backupResources?: PluginManifestBackupResource[];
  /** Plugin ids that must also be installed for this plugin to have effect. */
  requiresPlugins?: string[];
  enabledByDefault?: boolean;
  enabledByDefaultOnPlatforms?: PluginManifestDefaultPlatform[];
  /** Legacy plugin ids that should normalize to this plugin id. */
  legacyPluginIds?: string[];
  /** Provider ids that should auto-enable this plugin when referenced in auth/config/models. */
  autoEnableWhenConfiguredProviders?: string[];
  kind?: PluginKind | PluginKind[];
  channels?: string[];
  providers?: string[];
  /**
   * Optional lightweight module that exports provider plugin metadata for
   * auth/catalog discovery. It should not import the full plugin runtime.
   */
  providerCatalogEntry?: string;
  /**
   * Cheap model-family ownership metadata used before plugin runtime loads.
   * Use this for shorthand model refs that omit an explicit provider prefix.
   */
  modelSupport?: PluginManifestModelSupport;
  /**
   * Declarative model catalog metadata used by future read-only listing,
   * onboarding, and model picker surfaces before provider runtime loads.
   */
  modelCatalog?: PluginManifestModelCatalog;
  /** Manifest-owned external pricing lookup policy for provider refs. */
  modelPricing?: PluginManifestModelPricing;
  /** Manifest-owned model-id normalization used before provider runtime loads. */
  modelIdNormalization?: PluginManifestModelIdNormalization;
  /** Cheap provider endpoint metadata used before provider runtime loads. */
  providerEndpoints?: PluginManifestProviderEndpoint[];
  /** Cheap provider request metadata used before provider runtime loads. */
  providerRequest?: PluginManifestProviderRequest;
  /** Declarative SecretRef provider presets owned by this plugin. */
  secretProviderIntegrations?: Record<string, PluginManifestSecretProviderIntegration>;
  /** Cheap startup activation lookup for plugin-owned CLI inference backends. */
  cliBackends?: string[];
  /**
   * Provider or CLI backend refs whose plugin-owned synthetic auth hook should
   * be probed during cold model discovery before the runtime registry exists.
   */
  syntheticAuthRefs?: string[];
  /**
   * Bundled-plugin-owned placeholder API key values that represent non-secret
   * local, OAuth, or ambient credential state.
   */
  nonSecretAuthMarkers?: string[];
  /**
   * Plugin-owned command aliases that should resolve to this plugin during
   * config diagnostics before runtime loads.
   */
  commandAliases?: PluginManifestCommandAlias[];
  /** Root commands advertised by help and activation planning before runtime loads. */
  cliCommands?: PluginManifestCliCommand[];
  /** Usage/billing credentials excluded from inference auth but included in secret scrubbing. */
  providerUsageAuthEnvVars?: Record<string, string[]>;
  /** Provider ids that should reuse another provider id for auth lookup. */
  providerAuthAliases?: Record<string, string>;
  /**
   * Cheap onboarding/auth-choice metadata used by config validation, CLI help,
   * and non-runtime auth-choice routing before provider runtime loads.
   */
  providerAuthChoices?: PluginManifestProviderAuthChoice[];
  /** Cheap activation planner metadata exposed before plugin runtime loads. */
  activation?: PluginManifestActivation;
  /** Cheap setup/onboarding metadata exposed before plugin runtime loads. */
  setup?: PluginManifestSetup;
  /** Doctor contract surfaces available without loading the plugin artifact. */
  doctorContract?: PluginManifestDoctorContract;
  /** Whether the plugin public API registers structured health checks. */
  doctorHealthChecks?: boolean;
  /** Static ownership metadata for doctor session-route state repairs. */
  sessionRouteStateOwners?: DoctorSessionRouteStateOwner[];
  /** Cheap QA runner metadata exposed before plugin runtime loads. */
  qaRunners?: PluginManifestQaRunner[];
  /** Widget data and action capabilities validated against runtime registrations. */
  dashboard?: PluginManifestDashboard;
  controlUi?: PluginManifestControlUi;
  /** Static MCP servers contributed while this plugin is enabled. */
  mcpServers?: Record<string, PluginManifestMcpServer>;
  skills?: string[];
  name?: string;
  description?: string;
  /** Optional presentation hints for plugin catalog surfaces. */
  catalog?: PluginManifestCatalog;
  version?: string;
  uiHints?: Record<string, PluginConfigUiHint>;
  /**
   * Static capability ownership snapshot used for manifest-driven discovery,
   * compat wiring, and contract coverage without importing plugin runtime.
   */
  contracts?: PluginManifestContracts;
  /** Cheap media-understanding provider defaults without importing plugin runtime. */
  mediaUnderstandingProviderMetadata?: Record<
    string,
    PluginManifestMediaUnderstandingProviderMetadata
  >;
  /** Cheap image-generation provider auth metadata without importing plugin runtime. */
  imageGenerationProviderMetadata?: Record<string, PluginManifestCapabilityProviderMetadata>;
  /** Cheap video-generation provider auth metadata without importing plugin runtime. */
  videoGenerationProviderMetadata?: Record<string, PluginManifestCapabilityProviderMetadata>;
  /** Cheap music-generation provider auth metadata without importing plugin runtime. */
  musicGenerationProviderMetadata?: Record<string, PluginManifestCapabilityProviderMetadata>;
  /** Cheap plugin-tool availability metadata without importing plugin runtime. */
  toolMetadata?: Record<string, PluginManifestToolMetadata>;
  /** Manifest-owned config behavior consumed by generic core helpers. */
  configContracts?: PluginManifestConfigContracts;
  channelConfigs?: Record<string, PluginManifestChannelConfig>;
};

export type PluginManifestContracts = {
  embeddedExtensionFactories?: string[];
  agentToolResultMiddleware?: string[];
  trustedToolPolicies?: string[];
  /**
   * Provider ids whose external auth profile hook can contribute runtime-only
   * credentials. Declaring this lets auth-store overlays load only the owning
   * plugin instead of every provider plugin.
   */
  externalAuthProviders?: string[];
  embeddingProviders?: string[];
  speechProviders?: string[];
  realtimeTranscriptionProviders?: string[];
  realtimeVoiceProviders?: string[];
  mediaUnderstandingProviders?: string[];
  transcriptSourceProviders?: string[];
  documentExtractors?: string[];
  imageGenerationProviders?: string[];
  videoGenerationProviders?: string[];
  musicGenerationProviders?: string[];
  webContentExtractors?: string[];
  webFetchProviders?: string[];
  webSearchProviders?: string[];
  workerProviders?: string[];
  /** Provider ids whose plugin owns usage auth and snapshot hooks. */
  usageProviders?: string[];
  migrationProviders?: string[];
  gatewayMethodDispatch?: string[];
  tools?: string[];
};

export type PluginManifestMediaUnderstandingCapability = "image" | "audio" | "video";

export type PluginManifestMediaUnderstandingProviderMetadata = {
  capabilities?: PluginManifestMediaUnderstandingCapability[];
  defaultModels?: Partial<Record<PluginManifestMediaUnderstandingCapability, string>>;
  autoPriority?: Partial<Record<PluginManifestMediaUnderstandingCapability, number>>;
  nativeDocumentInputs?: Array<"pdf">;
  documentModels?: Partial<
    Record<
      "pdf",
      {
        textExtraction?: string;
        image?: string | false;
      }
    >
  >;
};

export type PluginManifestProviderBaseUrlGuard = {
  provider: string;
  defaultBaseUrl?: string;
  allowedBaseUrls: string[];
};

export type PluginManifestCapabilityProviderAuthSignal = {
  provider: string;
  providerBaseUrl?: PluginManifestProviderBaseUrlGuard;
};

export type PluginManifestCapabilityProviderModeConfigSignal = {
  path?: string;
  default?: string;
  allowed?: string[];
  disallowed?: string[];
};

export type PluginManifestCapabilityProviderConfigSignal = {
  rootPath: string;
  overlayPath?: string;
  overlayMapPath?: string;
  required?: string[];
  requiredAny?: string[];
  mode?: PluginManifestCapabilityProviderModeConfigSignal;
};

export type PluginManifestCapabilityProviderMetadata = {
  aliases?: string[];
  authProviders?: string[];
  authSignals?: PluginManifestCapabilityProviderAuthSignal[];
  configSignals?: PluginManifestCapabilityProviderConfigSignal[];
  referenceAudioInputs?: boolean;
};

export type PluginManifestToolMetadata = PluginManifestCapabilityProviderMetadata & {
  optional?: boolean;
  /** Built-in tool profiles that expose this plugin tool by default. */
  profiles?: PluginManifestToolProfile[];
  /** Tool execution is safe to repeat after an incomplete model turn. */
  replaySafe?: boolean;
  /** Tool execution can change durable state and failed attempts must remain visible. */
  sideEffecting?: boolean;
};

export type PluginManifestToolProfile = "minimal" | "coding" | "messaging" | "full";

export type PluginManifestProviderAuthChoice = {
  /** Provider id owned by this manifest entry. */
  provider: string;
  /** Provider auth method id that this choice should dispatch to. */
  method: string;
  /** Stable auth-choice id used by onboarding and other CLI auth flows. */
  choiceId: string;
  /** Optional user-facing choice label/hint for grouped onboarding UI. */
  choiceLabel?: string;
  choiceHint?: string;
  /** Optional HTTPS artwork URL for native and web onboarding surfaces. */
  icon?: string;
  /** Optional HTTPS product or installation URL for onboarding surfaces. */
  website?: string;
  /** Lower values sort earlier in interactive assistant pickers. */
  assistantPriority?: number;
  /** Keep the choice out of interactive assistant pickers while preserving manual CLI support. */
  assistantVisibility?: "visible" | "manual-only";
  /** Legacy choice ids that should point users at this replacement choice. */
  deprecatedChoiceIds?: string[];
  /** Optional grouping metadata for auth-choice pickers. */
  groupId?: string;
  groupLabel?: string;
  groupHint?: string;
  /**
   * Surface this group in the featured tier of the interactive onboarding
   * picker. Featured groups appear before the "More…" entry.
   */
  onboardingFeatured?: boolean;
  /** Optional CLI flag metadata for one-flag auth flows such as API keys. */
  optionKey?: string;
  cliFlag?: string;
  cliOption?: string;
  cliDescription?: string;
  /** One pasted secret plus provider defaults is sufficient for app-guided setup. */
  appGuidedSecret?: boolean;
  /** Interactive method stages one inline credential without host login imports or persistence. */
  personalAccount?: boolean;
  /** Short provider-owned command label for starting app-guided setup. */
  appGuidedActionLabel?: string;
  /** Provider-owned interactive login that native setup clients can render generically. */
  appGuidedAuth?: "oauth" | "device-code";
  /**
   * Interactive onboarding surfaces where this auth choice should appear.
   * Defaults to `["text-inference"]` when omitted.
   */
  onboardingScopes?: PluginManifestOnboardingScope[];
  /** Provider runtime can discover and prepare an already-installed local model. */
  appGuidedDiscovery?: boolean;
};

export type PluginManifestOnboardingScope =
  | "text-inference"
  | "image-generation"
  | "music-generation";
