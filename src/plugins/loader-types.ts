import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PluginInstallRecord } from "../config/types.plugins.js";
import type { GatewayRequestHandler } from "../gateway/server-methods/types.js";
import type { PluginCapabilityCatalogContext } from "./capability-catalog-context.types.js";
import type { PluginCapabilityCatalog } from "./capability-catalog.types.js";
import type { PluginDiscoveryResult } from "./discovery.js";
import type { PluginManifestRegistry } from "./manifest-registry.js";
import type { PluginRegistryParams } from "./registry-types.js";
import type { CreatePluginRuntimeOptions } from "./runtime/types.js";
import type { PluginSdkResolutionPreference } from "./sdk-alias.js";
import type { PluginLogger } from "./types.js";

export type PluginRuntimeSubagentMode = "default" | "explicit" | "gateway-bindable";
export type ChannelPluginLoadIntent = "full" | "setup";

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
  /** Registry-construction fact supplied by the process composition root. */
  allowProcessHomeSessionCatalogs?: boolean;
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
  /** Select full runtime registration or the lightweight unconfigured-channel setup path. */
  channelPluginLoadIntent?: ChannelPluginLoadIntent;
  /** Built hosts prefer canonical checkout artifacts by default; false retains source execution. */
  preferBuiltPluginArtifacts?: boolean;
  toolDiscovery?: boolean;
  /** Native host operations supplied by a runtime composition root. */
  capabilityCatalogContext?: PluginCapabilityCatalogContext;
  /** Resolve declared descriptors for this family without full runtime registration. */
  capabilityCatalog?: {
    family: keyof PluginCapabilityCatalog;
    context: PluginCapabilityCatalogContext;
  };
  activate?: boolean;
  loadModules?: boolean;
  throwOnLoadError?: boolean;
  manifestRegistry?: PluginManifestRegistry;
  discovery?: PluginDiscoveryResult;
};
