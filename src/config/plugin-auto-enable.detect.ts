// Detects plugin auto-enable candidates from config and discovery results.
import type { AmbientEnvTriggerPolicy } from "../channels/config-presence.js";
import type { PluginDiscoveryResult } from "../plugins/discovery.js";
import type { PluginManifestRegistry } from "../plugins/manifest-registry.js";
import {
  resolveConfiguredPluginAutoEnableCandidates,
  resolvePluginAutoEnableReadiness,
  resolvePluginAutoEnableManifestRegistry,
  type PluginSetupProbePolicy,
} from "./plugin-auto-enable.shared.js";
import type { PluginAutoEnableCandidate } from "./plugin-auto-enable.types.js";
import type { OpenClawConfig } from "./types.openclaw.js";

/** Detects installed plugins that should become enabled from existing config usage. */
export function detectPluginAutoEnableCandidates(params: {
  config?: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  manifestRegistry?: PluginManifestRegistry;
  discovery?: PluginDiscoveryResult;
  ambientEnvTriggers?: AmbientEnvTriggerPolicy;
  setupProbes?: PluginSetupProbePolicy;
}): PluginAutoEnableCandidate[] {
  const env = params.env ?? process.env;
  const config = params.config ?? ({} as OpenClawConfig);
  const readiness = resolvePluginAutoEnableReadiness(
    config,
    env,
    params.discovery,
    params.ambientEnvTriggers,
    params.setupProbes,
  );
  if (!readiness.mayNeedAutoEnable) {
    return [];
  }
  const registry = resolvePluginAutoEnableManifestRegistry({
    config,
    env,
    manifestRegistry: params.manifestRegistry,
  });
  return resolveConfiguredPluginAutoEnableCandidates({
    config,
    env,
    registry,
    configuredChannelIds: readiness.configuredChannelIds,
    setupProbes: params.setupProbes,
  });
}
