import type { OpenClawConfig } from "../config/types.openclaw.js";
import { shouldLoadChannelPluginInSetupRuntime } from "./loader-channel-setup.js";
import type { PluginManifestRecord } from "./manifest-registry.js";
import type { PluginRegistrationMode } from "./types.js";

export type PluginRegistrationPlan = {
  /** Public compatibility label passed to plugin register(api). */
  mode: PluginRegistrationMode;
  /** Load a setup entry instead of the normal runtime entry. */
  loadSetupEntry: boolean;
  /** Setup flow also needs the runtime channel entry for runtime setters/plugin shape. */
  loadSetupRuntimeEntry: boolean;
  /** Apply runtime capability policy such as memory-slot selection. */
  runRuntimeCapabilityPolicy: boolean;
  /** Register metadata that only belongs to live activation. */
  runFullActivationOnlyRegistrations: boolean;
};

/** Converts loader intent into explicit entrypoint and activation behavior. */
export function resolvePluginRegistrationPlan(params: {
  canLoadScopedSetupOnlyChannelPlugin: boolean;
  scopedSetupOnlyChannelPluginRequested: boolean;
  requireSetupEntryForSetupOnlyChannelPlugins: boolean;
  enableStateEnabled: boolean;
  shouldLoadModules: boolean;
  validateOnly: boolean;
  shouldActivate: boolean;
  manifestRecord: PluginManifestRecord;
  cfg: OpenClawConfig;
  env: NodeJS.ProcessEnv;
  preferSetupRuntimeForChannelPlugins: boolean;
  forceFullRuntimeForChannelPlugins: boolean;
  toolDiscovery: boolean;
}): PluginRegistrationPlan | null {
  if (params.canLoadScopedSetupOnlyChannelPlugin) {
    return {
      mode: "setup-only",
      loadSetupEntry: true,
      loadSetupRuntimeEntry: false,
      runRuntimeCapabilityPolicy: false,
      runFullActivationOnlyRegistrations: false,
    };
  }
  if (
    params.scopedSetupOnlyChannelPluginRequested &&
    params.requireSetupEntryForSetupOnlyChannelPlugins
  ) {
    return null;
  }
  if (!params.enableStateEnabled) {
    return null;
  }
  if (params.toolDiscovery) {
    return {
      mode: "tool-discovery",
      loadSetupEntry: false,
      loadSetupRuntimeEntry: false,
      runRuntimeCapabilityPolicy: true,
      runFullActivationOnlyRegistrations: false,
    };
  }
  const loadSetupRuntimeEntry =
    !params.forceFullRuntimeForChannelPlugins &&
    params.shouldLoadModules &&
    !params.validateOnly &&
    shouldLoadChannelPluginInSetupRuntime({
      manifestChannels: params.manifestRecord.channels,
      setupSource: params.manifestRecord.setupSource,
      startupDeferConfiguredChannelFullLoadUntilAfterListen:
        params.manifestRecord.startupDeferConfiguredChannelFullLoadUntilAfterListen,
      cfg: params.cfg,
      env: params.env,
      preferSetupRuntimeForChannelPlugins: params.preferSetupRuntimeForChannelPlugins,
    });
  if (loadSetupRuntimeEntry) {
    return {
      mode: "setup-runtime",
      loadSetupEntry: true,
      loadSetupRuntimeEntry: true,
      runRuntimeCapabilityPolicy: false,
      runFullActivationOnlyRegistrations: false,
    };
  }
  const mode = params.shouldActivate ? "full" : "discovery";
  return {
    mode,
    loadSetupEntry: false,
    loadSetupRuntimeEntry: false,
    runRuntimeCapabilityPolicy: true,
    runFullActivationOnlyRegistrations: mode === "full",
  };
}
