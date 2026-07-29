import type { ChannelLegacyStateMigrationPlan } from "../channels/plugins/legacy-state-migration.types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PluginModuleLoaderFactory } from "../plugins/plugin-module-loader-cache.js";

/** Legacy session helpers used while bundled channels migrate old session key formats. */
export type BundledChannelLegacySessionSurface = {
  isLegacyGroupSessionKey?: (key: string) => boolean;
  canonicalizeLegacySessionKey?: (params: {
    key: string;
    agentId: string;
  }) => string | null | undefined;
};

/** Detects channel-owned state migrations needed before a bundled channel starts. */
export type BundledChannelLegacyStateMigrationDetector = (params: {
  cfg: OpenClawConfig;
  env: NodeJS.ProcessEnv;
  stateDir: string;
  oauthDir: string;
}) =>
  | ChannelLegacyStateMigrationPlan[]
  | Promise<ChannelLegacyStateMigrationPlan[] | null | undefined>
  | null
  | undefined;

/** Test hook for swapping the source-module loader used by bundled entry imports. */
export type BundledEntryModuleLoadOptions = {
  createLoaderForTest?: PluginModuleLoaderFactory;
};
