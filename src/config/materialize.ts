// Materializes normalized config into runtime-ready settings.
import type { PluginManifestRegistry } from "../plugins/manifest-registry.js";
import {
  applyCompactionDefaults,
  applyContextPruningDefaults,
  applyAgentDefaults,
  applyMessageDefaults,
  applyModelDefaults,
  applySessionDefaults,
} from "./defaults.js";
import { inheritLegacyDefaultAgentId } from "./legacy.default-agent-owner.js";
import { normalizeExecSafeBinProfilesInConfig } from "./normalize-exec-safe-bin.js";
import { normalizeConfigPaths } from "./normalize-paths.js";
import { normalizeTalkConfig } from "./talk.js";
import type { OpenClawConfig, ResolvedSourceConfig, RuntimeConfig } from "./types.js";

// Snapshot and load must materialize identically: prepared-runtime exact-config
// resolution compares the startup-published (snapshot) config against the reply-path
// (load) config, and any divergence permanently fails that resolve for affected configs.

export function asResolvedSourceConfig(config: OpenClawConfig): ResolvedSourceConfig {
  return config as ResolvedSourceConfig;
}

export function asRuntimeConfig(config: OpenClawConfig): RuntimeConfig {
  return config as RuntimeConfig;
}

export function materializeRuntimeConfig(
  config: OpenClawConfig,
  options: {
    env?: NodeJS.ProcessEnv;
    homedir?: () => string;
    manifestRegistry?: Pick<PluginManifestRegistry, "plugins">;
    loadManifestRegistry?: () => Pick<PluginManifestRegistry, "plugins"> | undefined;
  } = {},
): RuntimeConfig {
  let next = applyMessageDefaults(config);
  next = applySessionDefaults(next);
  next = applyAgentDefaults(next);
  next = applyContextPruningDefaults(next, options);
  next = applyCompactionDefaults(next);
  next = applyModelDefaults(next, {
    manifestRegistry: options.manifestRegistry,
    loadManifestRegistry: options.loadManifestRegistry,
  });
  next = normalizeTalkConfig(next);
  normalizeConfigPaths(next, options);
  normalizeExecSafeBinProfilesInConfig(next);
  return asRuntimeConfig(inheritLegacyDefaultAgentId(config, next));
}
