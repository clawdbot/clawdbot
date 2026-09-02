import type { PreparedMessageToolCatalog } from "../channels/plugins/message-action-discovery.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { prepareMediaCapabilityProviders } from "../plugins/capability-provider-runtime.js";
import type { PluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.types.js";
import type { PreparedProviderStaticCatalog } from "../plugins/provider-discovery.js";
import type { ProviderRuntimeModel } from "../plugins/provider-runtime-model.types.js";
import type { PluginRegistry } from "../plugins/registry-types.js";
import type { PreparedAgentCredentialModes } from "./agent-auth-credential-modes.js";
import type { InlineModelEntry } from "./embedded-agent-runner/model.inline-provider.js";
import type { AgentHarnessPluginSelection } from "./harness/runtime-plugin-load-plan.js";
import type { ModelCatalogEntry, ModelCatalogSnapshot } from "./model-catalog.types.js";
import type { PublishedModelCatalogOwnerCandidate } from "./prepared-model-catalog.types.js";
import type { PreparedConfiguredRuntimeModel } from "./prepared-model-runtime.configured.js";
import type { AuthStorage } from "./sessions/auth-storage.js";
import type { ModelRegistry } from "./sessions/model-registry.js";

export type PreparedModelRuntimeCatalogMode = "live" | "static";

export type PreparedModelRuntimePluginGeneration = Readonly<{
  pluginMetadataSnapshot: PluginMetadataSnapshot;
  messageToolCatalog?: PreparedMessageToolCatalog;
  mediaCapabilityProviders?: ReturnType<typeof prepareMediaCapabilityProviders>;
  preparedStaticProviderCatalog?: PreparedProviderStaticCatalog;
  /** Present for live generations, including when the resolved model set is empty. */
  providerStaticModels?: readonly ProviderRuntimeModel[];
  inlineProviderModels: readonly InlineModelEntry[];
  configuredCatalogEntries: readonly ModelCatalogEntry[];
  pluginRegistry?: PluginRegistry;
  inboundPluginRegistry?: PluginRegistry;
  /** Immutable artifact choice for every registry reuse in this generation. */
  preferBuiltPluginArtifacts?: boolean;
}>;

export type PreparedModelRuntimeSnapshot = Readonly<{
  catalogOwner: PublishedModelCatalogOwnerCandidate["catalogOwner"];
  agentId?: string;
  agentDir: string;
  inheritedAuthDir?: string;
  workspaceDir?: string;
  /** Run-prepared repository root; null means discovery completed without a match. */
  repoRoot?: string | null;
  /** Stable identity derived from repoRoot; null means the run is outside a repository. */
  projectKey?: string | null;
  /** Session active project set, ordered most-recent first; empty before run binding. */
  activeProjectKeys: readonly string[];
  config: OpenClawConfig;
  /** Secret-free usable auth modes captured by this exact lifecycle generation. */
  authModes: PreparedAgentCredentialModes;
  metadataSnapshot: PluginMetadataSnapshot;
  messageToolCatalog?: PreparedMessageToolCatalog;
  mediaCapabilityProviders?: ReturnType<typeof prepareMediaCapabilityProviders>;
  /** Registry value owned by this generation; omitted from read-only builds. */
  pluginRegistry?: PluginRegistry;
  allowGatewaySubagentBinding: boolean;
  /**
   * Configured model projection used by turn admission and synchronous callers.
   * Full inventory discovery is deliberately outside the startup publication boundary.
   */
  modelCatalog: ModelCatalogSnapshot;
  /** Reads a completed full catalog without starting provider discovery. */
  readFullModelCatalog?: () => ModelCatalogSnapshot | undefined;
  /** Builds this generation's full control-plane catalog without replacing turn facts. */
  loadFullModelCatalog?: (options?: { refresh?: boolean }) => Promise<ModelCatalogSnapshot>;
  /** Full static models for configured refs, resolved once at the lifecycle boundary. */
  configuredRuntimeModels: readonly PreparedConfiguredRuntimeModel[];
  /** Inline provider projection prepared once for all resolutions owned by this snapshot. */
  inlineProviderModels: readonly InlineModelEntry[];
  createStores: () => PreparedModelRuntimeStores;
}>;

/** Closed Gateway turn facts published atomically for one configured agent. */
export type PreparedReplyDispatchRuntime = Readonly<{
  agentId: string;
  agentDir: string;
  workspaceDir: string;
  config: OpenClawConfig;
  modelCatalog: ModelCatalogSnapshot;
  inboundPluginRegistry: PluginRegistry;
  pluginGeneration: PreparedModelRuntimePluginGeneration;
}>;

export type PreparedModelRuntimeStores = {
  authStorage: AuthStorage;
  modelRegistry: ModelRegistry;
};

export type PreparedModelRuntimeInput = {
  agentId?: string;
  agentDir: string;
  inheritedAuthDir?: string;
  workspaceDir?: string;
  preserveWorkspaceDirOnRefresh?: boolean;
  readOnly?: boolean;
  /** Load the exact runtime plugin generation for an isolated executable probe. */
  loadRuntimePlugins?: boolean;
  skipCredentials?: boolean;
  env?: NodeJS.ProcessEnv;
  allowGatewaySubagentBinding?: boolean;
  runtimePluginSelections?: readonly AgentHarnessPluginSelection[];
  config: OpenClawConfig;
};

export type PreparedModelRuntimeLease = Readonly<{
  snapshot: PreparedModelRuntimeSnapshot;
  pluginGeneration: PreparedModelRuntimePluginGeneration;
  release: () => void;
}>;

export type PreparedModelRuntimePublicationOptions = {
  force?: boolean;
  provenance?: PreparedModelRuntimeOwner["provenance"];
  catalogMode?: PreparedModelRuntimeCatalogMode;
};

export type PreparedModelRuntimeRefreshOptions = {
  gatewayLifecycle?: boolean;
  defaultWorkspaceDir?: string;
  catalogMode?: PreparedModelRuntimeCatalogMode;
  onBuildStats?: (stats: PreparedModelRuntimeBuildStats) => void;
  allowGatewaySubagentBinding?: boolean;
  pluginMetadataSnapshot?: PluginMetadataSnapshot;
  isPublicationCurrent?: () => boolean;
  /** Restricts replacement to configured owners whose normalized agent id is present. */
  agentIds?: ReadonlySet<string>;
};

export type PreparedModelRuntimeBuildStats = Readonly<{
  agentCount: number;
  workspaceGroupCount: number;
  configuredFactsGroupCount: number;
  catalogSourceCount: number;
  credentialGroupCount: number;
  catalogGroupCount: number;
  runtimeRegistryCount: number;
  configuredRuntimeModelCount: number;
  generatedCatalogPluginCount: number;
  generatedCatalogReadCount: number;
  workspaceFactsMs: number;
  runtimePluginMs: number;
  pluginMetadataMs: number;
  staticProviderCatalogMs: number;
  ambientCredentialsMs: number;
  agentFactsMs: number;
  configuredProjectionMs: number;
  catalogSourceMs: number;
  registryMs: number;
  sourceConcurrencyLimit: number;
  fullCatalogConcurrencyLimit: number;
}>;

export type PreparedModelRuntimeOwner = {
  input: PreparedModelRuntimeInput;
  catalogOwner: PublishedModelCatalogOwnerCandidate["catalogOwner"];
  environmentFingerprint: string;
  catalogMode: PreparedModelRuntimeCatalogMode;
  provenance: "configured" | "standalone" | "explicit" | "run" | "ephemeral";
  generation: number;
  needsRefresh: boolean;
  catalogStale: boolean;
  /** Completed discovery facts; runtime capability projection belongs to each generation. */
  catalogInventory?: { catalog: ModelCatalogSnapshot; key: string };
  refreshError?: Error;
  snapshot?: PreparedModelRuntimeSnapshot;
  pluginGeneration?: PreparedModelRuntimePluginGeneration;
  /** Explicit generation admitted for the current publication, when known. */
  pendingPluginGeneration?: PreparedModelRuntimePluginGeneration;
  pending?: Promise<PreparedModelRuntimeSnapshot>;
  buildCompletion?: Promise<void>;
  leaseCount?: number;
};

export type PreparedModelRuntimeReplacement = {
  gateId: PreparedModelRuntimeReplacementGateId;
  promise: Promise<void>;
  resolve: () => void;
  reject: (error: Error) => void;
};

export type PreparedModelRuntimeReplacementGateId = symbol;
