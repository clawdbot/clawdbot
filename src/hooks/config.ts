// Hook config helpers read, normalize, and update hook configuration.
import type { OpenClawConfig, HookConfig } from "../config/config.js";
import {
  evaluateRuntimeEligibility,
  hasBinary,
  isConfigPathTruthyWithDefaults,
} from "../shared/config-eval.js";
import { resolveHookConfig, resolveHookEnableState } from "./policy.js";
import type { HookEligibilityContext, HookEntry } from "./types.js";

const DEFAULT_CONFIG_VALUES: Record<string, boolean> = {
  "browser.enabled": true,
  "browser.evaluateEnabled": true,
  "workspace.dir": true,
};

export { hasBinary };

/** Evaluate a config path with hook-specific defaults for legacy runtime requirements. */
export function isHookConfigPathTruthy(
  config: OpenClawConfig | undefined,
  pathStr: string,
): boolean {
  return isConfigPathTruthyWithDefaults(config, pathStr, DEFAULT_CONFIG_VALUES);
}

export { resolveHookConfig };

export function isHookEnvSatisfied(envName: string, hookConfig?: HookConfig): boolean {
  return Boolean(process.env[envName]?.trim() || hookConfig?.env?.[envName]?.trim());
}

function evaluateHookRuntimeEligibility(params: {
  entry: HookEntry;
  config?: OpenClawConfig;
  hookConfig?: HookConfig;
  eligibility?: HookEligibilityContext;
}): boolean {
  const { entry, config, hookConfig, eligibility } = params;
  const remote = eligibility?.remote;
  // Hook metadata uses the same requirement language as plugins, but hook env
  // can also come from the per-hook config block.
  const base = {
    os: entry.metadata?.os,
    remotePlatforms: remote?.platforms,
    always: entry.metadata?.always,
    requires: entry.metadata?.requires,
    hasRemoteBin: remote?.hasBin,
    hasAnyRemoteBin: remote?.hasAnyBin,
  };
  return evaluateRuntimeEligibility({
    ...base,
    hasBin: hasBinary,
    hasEnv: (envName) => isHookEnvSatisfied(envName, hookConfig),
    isConfigPathTruthy: (configPath) => isHookConfigPathTruthy(config, configPath),
  });
}

/** Return true when a hook passes enable policy and runtime requirements. */
export function shouldIncludeHook(params: {
  entry: HookEntry;
  config?: OpenClawConfig;
  eligibility?: HookEligibilityContext;
}): boolean {
  const { entry, config, eligibility } = params;
  const hookConfig = resolveHookConfig(
    config,
    params.entry.metadata?.hookKey ?? params.entry.hook.name,
  );
  if (!resolveHookEnableState({ entry, config, hookConfig }).enabled) {
    return false;
  }

  return evaluateHookRuntimeEligibility({
    entry,
    config,
    hookConfig,
    eligibility,
  });
}
