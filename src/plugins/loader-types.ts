import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PluginInstallRecord } from "../config/types.plugins.js";
import type { GatewayRequestHandler } from "../gateway/server-methods/types.js";
import type { PluginDiscoveryResult } from "./discovery.js";
import type { PluginManifestRegistry } from "./manifest-registry.js";
import type { PluginRegistryParams } from "./registry-types.js";
import type { CreatePluginRuntimeOptions } from "./runtime/types.js";
import type { PluginSdkResolutionPreference } from "./sdk-alias.js";
import type { PluginLogger } from "./types.js";

export type PluginRuntimeSubagentMode = "default" | "explicit" | "gateway-bindable";

/** Inputs shared by runtime, snapshot, and CLI-metadata plugin loading. */
export type PluginLoadOptions = {
  config?: OpenClawConfig;
  activationSourceConfig?: OpenClawConfig;
  autoEnabledReasons?: Readonly<Record<string, string[]>>;
  workspaceDir?: string;
  installRecords?: Record<string, PluginInstallRecord>;
  /** Resolve plugin roots and load paths against an explicit environment. */
  env?: NodeJS.ProcessEnv;
  /** Apply the config IO env-substitution pass to direct raw-config callers. */
  resolveRawConfigEnvVars?: boolean;
  logger?: PluginLogger;
  coreGatewayHandlers?: Record<string, GatewayRequestHandler>;
  coreGatewayMethodNames?: readonly string[];
  hostServices?: PluginRegistryParams["hostServices"];
  runtimeOptions?: CreatePluginRuntimeOptions;
  startupTrace?: {
    detail: (name: string, metrics: ReadonlyArray<readonly [string, number | string]>) => void;
  };
  pluginSdkResolution?: PluginSdkResolutionPreference;
  cache?: boolean;
  mode?: "full" | "validate";
  onlyPluginIds?: string[];
  includeSetupOnlyChannelPlugins?: boolean;
  forceSetupOnlyChannelPlugins?: boolean;
  requireSetupEntryForSetupOnlyChannelPlugins?: boolean;
  /** Prefer opted-in channel setup entries for the pre-listen startup surface. */
  preferSetupRuntimeForChannelPlugins?: boolean;
  /** Load channel runtime entries even when setup entries are available. */
  forceFullRuntimeForChannelPlugins?: boolean;
  /** Prefer bundled JavaScript artifacts over source TypeScript entrypoints. */
  preferBuiltPluginArtifacts?: boolean;
  toolDiscovery?: boolean;
  activate?: boolean;
  loadModules?: boolean;
  throwOnLoadError?: boolean;
  manifestRegistry?: PluginManifestRegistry;
  discovery?: PluginDiscoveryResult;
};
