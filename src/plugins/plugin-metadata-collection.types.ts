import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PreparedPluginChannelCatalog } from "./channel-catalog-registry.types.js";
import type {
  PluginMetadataSnapshot,
  PluginMetadataSnapshotPluginIdScope,
  ResolvePluginMetadataSnapshotParams,
} from "./plugin-metadata-snapshot.types.js";

export type ConfigWidePluginMetadataView = Pick<
  PluginMetadataSnapshot,
  "manifestRegistry" | "plugins" | "byPluginId" | "owners" | "diagnostics"
>;

/** Config-wide metadata has no single executable index or workspace identity. */
export type PreparedPluginMetadata = ConfigWidePluginMetadataView & {
  /** Configured-workspace inventory for validation and management, never execution. */
  readonly unionSnapshot: PluginMetadataSnapshot;
  readonly workspaces: ReadonlyMap<string | undefined, PluginMetadataSnapshot>;
  readonly agentWorkspaceDirs: ReadonlyMap<string, string>;
  readonly configWorkspaceDirs: readonly (string | undefined)[];
  readonly envFingerprint: string;
  readonly installRecordsGeneration: number;
  readonly bundledDiscoveryMode?: "compat" | "allowlist";
  readonly selectedSnapshot: PluginMetadataSnapshot;
  readonly channelCatalog: PreparedPluginChannelCatalog;
};

export type PreparePluginMetadataParams = {
  config: OpenClawConfig;
  workspaceDir?: string;
  additionalWorkspaceDirs?: readonly string[];
  env?: NodeJS.ProcessEnv;
  stateDir?: string;
  allowCurrent?: boolean;
  seed?: PreparedPluginMetadata;
};

export type PluginMetadataScope = {
  pluginIds?: readonly string[];
  pluginIdScope?: PluginMetadataSnapshotPluginIdScope;
};

export type PluginMetadataOwner = {
  prepare: (params: PreparePluginMetadataParams) => PreparedPluginMetadata;
  publish: (
    metadata: PreparedPluginMetadata,
    params: { config: OpenClawConfig; sourceConfig?: OpenClawConfig; env?: NodeJS.ProcessEnv },
  ) => void;
  getActive: () => PreparedPluginMetadata | undefined;
  isPreparedCurrent: (metadata: PreparedPluginMetadata) => boolean;
  readSnapshot: (params: ResolvePluginMetadataSnapshotParams) => PluginMetadataSnapshot | undefined;
  readConfigWide: (params: PreparePluginMetadataParams) => PreparedPluginMetadata | undefined;
  invalidatePreparation: () => void;
  dispose: () => void;
};
