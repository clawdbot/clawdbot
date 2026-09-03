import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.types.js";
import type { PreparedProviderAuth } from "./agent-auth-credential-modes.js";
import type { AuthProfileStore } from "./auth-profiles/types.js";
import type { ModelCatalogSnapshot } from "./model-catalog.types.js";

export type PublishedModelCatalogOwnerCandidate = Readonly<{
  /** Captured during preparation; undefined is a known-unbound runtime. */
  catalogOwner: Readonly<{ agentId: string; workspaceDir: string }> | undefined;
  agentId?: string;
  agentDir: string;
  workspaceDir?: string;
  config: OpenClawConfig;
  providerAuth: PreparedProviderAuth;
  authStore?: AuthProfileStore;
  metadataSnapshot: PluginMetadataSnapshot;
  oauthRefreshProviderIds: readonly string[];
  modelCatalog: ModelCatalogSnapshot;
}>;

export type ResolvedPublishedModelCatalogOwner = Readonly<{
  catalogOwner: NonNullable<PublishedModelCatalogOwnerCandidate["catalogOwner"]>;
  agentId: string;
  agentDir: string;
  workspaceDir: string;
  config: OpenClawConfig;
  providerAuth: PreparedProviderAuth;
  authStore: AuthProfileStore;
  metadataSnapshot: PluginMetadataSnapshot;
  oauthRefreshProviderIds: readonly string[];
  modelCatalog: ModelCatalogSnapshot;
}>;
