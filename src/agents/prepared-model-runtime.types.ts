import type { PreparedMessageToolCatalog } from "../channels/plugins/message-action-discovery.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { prepareMediaCapabilityProviders } from "../plugins/capability-provider-runtime.js";
import type { PluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.types.js";
import type { InlineModelEntry } from "./embedded-agent-runner/model.inline-provider.js";
import type { ModelCatalogSnapshot } from "./model-catalog.types.js";
import type { PreparedConfiguredRuntimeModel } from "./prepared-model-runtime.configured.js";
import type { AuthStorage } from "./sessions/auth-storage.js";
import type { ModelRegistry } from "./sessions/model-registry.js";

export type PreparedModelRuntimeCatalogMode = "live" | "static";

export type PreparedModelRuntimeSnapshot = Readonly<{
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
  metadataSnapshot: PluginMetadataSnapshot;
  messageToolCatalog?: PreparedMessageToolCatalog;
  mediaCapabilityProviders?: ReturnType<typeof prepareMediaCapabilityProviders>;
  /**
   * Configured model projection used by turn admission and synchronous callers.
   * Full inventory discovery is deliberately outside the startup publication boundary.
   */
  modelCatalog: ModelCatalogSnapshot;
  /** Builds this generation's full control-plane catalog without replacing turn facts. */
  loadFullModelCatalog?: () => Promise<ModelCatalogSnapshot>;
  /** Full static models for configured refs, resolved once at the lifecycle boundary. */
  configuredRuntimeModels: readonly PreparedConfiguredRuntimeModel[];
  /** Inline provider projection prepared once for all resolutions owned by this snapshot. */
  inlineProviderModels: readonly InlineModelEntry[];
  createStores: () => PreparedModelRuntimeStores;
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
  skipCredentials?: boolean;
  env?: NodeJS.ProcessEnv;
  config: OpenClawConfig;
};

export type PreparedModelRuntimeLease = Readonly<{
  snapshot: PreparedModelRuntimeSnapshot;
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
  environmentFingerprint: string;
  catalogMode: PreparedModelRuntimeCatalogMode;
  provenance: "configured" | "standalone" | "explicit" | "run" | "ephemeral";
  generation: number;
  needsRefresh: boolean;
  refreshError?: Error;
  snapshot?: PreparedModelRuntimeSnapshot;
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
