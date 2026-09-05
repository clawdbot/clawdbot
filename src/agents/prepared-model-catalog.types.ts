import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.types.js";
import type { PluginRegistry } from "../plugins/registry-types.js";
import type { PreparedAgentCredentialModes } from "./agent-auth-credential-modes.js";
import type { AuthProfileStore } from "./auth-profiles/types.js";
import type { ModelCatalogSnapshot } from "./model-catalog.types.js";

export type PublishedModelCatalogOwnerCandidate = Readonly<{
  /** Captured during preparation; undefined is a known-unbound runtime. */
  catalogOwner: Readonly<{ agentId: string; workspaceDir: string }> | undefined;
  agentId?: string;
  agentDir: string;
  workspaceDir?: string;
  config: OpenClawConfig;
  observationConfig: OpenClawConfig;
  authModes: PreparedAgentCredentialModes;
  authStore?: AuthProfileStore;
  metadataSnapshot: PluginMetadataSnapshot;
  /** Registry owned by this prepared generation; omitted from read-only builds. */
  pluginRegistry?: PluginRegistry;
  /** Reports whether this exact lifecycle generation is still published. */
  isCurrent: () => boolean;
  modelCatalog: ModelCatalogSnapshot;
}>;

export type ResolvedPublishedModelCatalogOwner = Readonly<{
  catalogOwner: NonNullable<PublishedModelCatalogOwnerCandidate["catalogOwner"]>;
  agentId: string;
  agentDir: string;
  workspaceDir: string;
  config: OpenClawConfig;
  observationConfig: OpenClawConfig;
  authModes: PreparedAgentCredentialModes;
  authStore: AuthProfileStore;
  metadataSnapshot: PluginMetadataSnapshot;
  pluginRegistry?: PluginRegistry;
  isCurrent: () => boolean;
  modelCatalog: ModelCatalogSnapshot;
}>;
