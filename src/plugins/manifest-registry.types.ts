import type { DoctorSessionRouteStateOwner } from "./doctor-session-route-state-owner-types.js";
import type { PluginManifestCommandAlias } from "./manifest-command-aliases.js";
import type {
  PluginBundleFormat,
  PluginConfigUiHint,
  PluginDiagnostic,
  PluginFormat,
  PluginManifestBackupResource,
  PluginManifestDoctorContract,
  PluginManifestActivation,
  PluginManifestCatalog,
  PluginManifestConfigContracts,
  PluginManifest,
  PluginManifestCapabilityProviderMetadata,
  PluginManifestChannelCommandDefaults,
  PluginManifestChannelConfig,
  PluginManifestContracts,
  PluginManifestControlUi,
  PluginManifestDashboard,
  PluginManifestMediaUnderstandingProviderMetadata,
  PluginManifestMcpServer,
  PluginManifestModelCatalog,
  PluginManifestModelIdNormalization,
  PluginManifestModelPricing,
  PluginManifestModelSupport,
  PluginManifestProviderEndpoint,
  PluginManifestProviderRequest,
  PluginManifestQaRunner,
  PluginManifestSecretProviderIntegration,
  PluginManifestSetup,
  PluginManifestToolMetadata,
} from "./manifest-types.js";
import type {
  OpenClawPackageManifest,
  PluginPackageChannel,
  PluginPackageInstall,
} from "./package-manifest.types.js";
import type { PluginKind } from "./plugin-kind.types.js";
import type { PluginOrigin } from "./plugin-origin.types.js";
import type { PluginDependencySpecMap } from "./status-dependencies-core.js";

export type PluginManifestContractListKey =
  | "speechProviders"
  | "externalAuthProviders"
  | "embeddingProviders"
  | "mediaUnderstandingProviders"
  | "transcriptSourceProviders"
  | "documentExtractors"
  | "realtimeVoiceProviders"
  | "realtimeTranscriptionProviders"
  | "imageGenerationProviders"
  | "videoGenerationProviders"
  | "musicGenerationProviders"
  | "webContentExtractors"
  | "webFetchProviders"
  | "webSearchProviders"
  | "workerProviders"
  | "usageProviders"
  | "migrationProviders"
  | "gatewayMethodDispatch";

export type PluginManifestRecord = {
  id: string;
  /** Process-local source selection, never persisted in the installed index. */
  sourcePreferred?: true;
  backupResources?: PluginManifestBackupResource[];
  name?: string;
  description?: string;
  catalog?: PluginManifestCatalog;
  iconPath?: string;
  version?: string;
  packageName?: string;
  packageVersion?: string;
  packageDescription?: string;
  enabledByDefault?: boolean;
  enabledByDefaultOnPlatforms?: string[];
  autoEnableWhenConfiguredProviders?: string[];
  legacyPluginIds?: string[];
  format?: PluginFormat;
  bundleFormat?: PluginBundleFormat;
  bundleCapabilities?: string[];
  kind?: PluginKind | PluginKind[];
  channels: string[];
  providers: string[];
  providerDiscoverySource?: string;
  modelSupport?: PluginManifestModelSupport;
  modelCatalog?: PluginManifestModelCatalog;
  modelPricing?: PluginManifestModelPricing;
  modelIdNormalization?: PluginManifestModelIdNormalization;
  providerEndpoints?: PluginManifestProviderEndpoint[];
  providerRequest?: PluginManifestProviderRequest;
  secretProviderIntegrations?: Record<string, PluginManifestSecretProviderIntegration>;
  cliBackends: string[];
  syntheticAuthRefs?: string[];
  nonSecretAuthMarkers?: string[];
  commandAliases?: PluginManifestCommandAlias[];
  cliCommands?: PluginManifest["cliCommands"];
  providerUsageAuthEnvVars?: Record<string, string[]>;
  providerAuthAliases?: Record<string, string>;
  providerAuthChoices?: PluginManifest["providerAuthChoices"];
  activation?: PluginManifestActivation;
  setup?: PluginManifestSetup;
  doctorContract?: PluginManifestDoctorContract;
  doctorHealthChecks?: boolean;
  sessionRouteStateOwners?: DoctorSessionRouteStateOwner[];
  packageManifest?: OpenClawPackageManifest;
  packageDependencies?: PluginDependencySpecMap;
  packageOptionalDependencies?: PluginDependencySpecMap;
  packageChannel?: PluginPackageChannel;
  packageInstall?: PluginPackageInstall;
  trustedOfficialInstall?: boolean;
  qaRunners?: PluginManifestQaRunner[];
  dashboard?: PluginManifestDashboard;
  controlUi?: PluginManifestControlUi;
  mcpServers?: Record<string, PluginManifestMcpServer>;
  skills: string[];
  settingsFiles?: string[];
  hooks: string[];
  origin: PluginOrigin;
  workspaceDir?: string;
  rootDir: string;
  source: string;
  setupSource?: string;
  manifestPath: string;
  schemaCacheKey?: string;
  configSchema?: Record<string, unknown>;
  configUiHints?: Record<string, PluginConfigUiHint>;
  contracts?: PluginManifestContracts;
  mediaUnderstandingProviderMetadata?: Record<
    string,
    PluginManifestMediaUnderstandingProviderMetadata
  >;
  imageGenerationProviderMetadata?: Record<string, PluginManifestCapabilityProviderMetadata>;
  videoGenerationProviderMetadata?: Record<string, PluginManifestCapabilityProviderMetadata>;
  musicGenerationProviderMetadata?: Record<string, PluginManifestCapabilityProviderMetadata>;
  toolMetadata?: Record<string, PluginManifestToolMetadata>;
  configContracts?: PluginManifestConfigContracts;
  channelConfigs?: Record<string, PluginManifestChannelConfig>;
  channelCatalogMeta?: {
    id: string;
    label?: string;
    blurb?: string;
    preferOver?: readonly string[];
    commands?: PluginManifestChannelCommandDefaults;
  };
};

export type PluginManifestRegistry = {
  plugins: PluginManifestRecord[];
  diagnostics: PluginDiagnostic[];
};

export type BundledChannelConfigCollector = (params: {
  pluginDir: string;
  manifest: PluginManifest;
  packageManifest?: OpenClawPackageManifest;
}) => Record<string, PluginManifestChannelConfig> | undefined;
