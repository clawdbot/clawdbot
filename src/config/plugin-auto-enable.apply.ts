// Applies plugin auto-enable decisions to normalized config objects.
import type { PluginDiscoveryResult } from "../plugins/discovery.js";
import type { PluginManifestRegistry } from "../plugins/manifest-registry.js";
import { detectPluginAutoEnableCandidates } from "./plugin-auto-enable.detect.js";
import {
  materializePluginAutoEnableCandidatesInternal,
  resolvePluginAutoEnableManifestRegistry,
} from "./plugin-auto-enable.shared.js";
import type {
  PluginAutoEnableCandidate,
  PluginAutoEnableResult,
} from "./plugin-auto-enable.types.js";
import { hashRuntimeConfigValue } from "./runtime-snapshot.js";
import type { OpenClawConfig } from "./types.openclaw.js";

type PluginAutoEnableCacheEntry = {
  configFingerprint: string;
  discoveryFingerprint: string;
  envFingerprint: string;
  registryFingerprint: string;
  result: PluginAutoEnableResult;
};
type PluginAutoEnableDiscoveryCache = WeakMap<object, PluginAutoEnableCacheEntry>;
type PluginAutoEnableRegistryCache = WeakMap<object, PluginAutoEnableDiscoveryCache>;
type PluginAutoEnableEnvCache = WeakMap<object, PluginAutoEnableRegistryCache>;
type PluginAutoEnableConfigCache = WeakMap<object, PluginAutoEnableEnvCache>;

let sameTurnApplyCache: PluginAutoEnableConfigCache | undefined;
let sameTurnApplyCacheClearScheduled = false;

function scheduleSameTurnApplyCacheClear(): void {
  if (sameTurnApplyCacheClearScheduled) {
    return;
  }
  sameTurnApplyCacheClearScheduled = true;
  // process.env and discovery inputs can mutate; only dedupe one RPC fanout turn.
  const handle = setImmediate(() => {
    sameTurnApplyCache = undefined;
    sameTurnApplyCacheClearScheduled = false;
  });
  handle.unref?.();
}

function getOrCreateWeakMap<K extends object, V>(
  parent: WeakMap<K, V>,
  key: K,
  create: () => V,
): V {
  const existing = parent.get(key);
  if (existing) {
    return existing;
  }
  const next = create();
  parent.set(key, next);
  return next;
}

function stableFingerprintValue(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "null";
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableFingerprintValue(entry)).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .toSorted((left, right) => left.localeCompare(right))
    .map((key) => `${JSON.stringify(key)}:${stableFingerprintValue(record[key])}`)
    .join(",")}}`;
}

/** Fingerprints mutable config inputs used by plugin auto-enable detection. */
export function fingerprintPluginAutoEnableConfig(config: OpenClawConfig): string {
  return hashRuntimeConfigValue(config);
}

/** Fingerprints mutable environment inputs used by plugin auto-enable detection. */
export function fingerprintPluginAutoEnableEnv(env: NodeJS.ProcessEnv): string {
  return stableFingerprintValue(env);
}

function createPluginAutoEnableCacheEntry(params: {
  config: OpenClawConfig;
  discovery: PluginDiscoveryResult;
  env: NodeJS.ProcessEnv;
  manifestRegistry: PluginManifestRegistry;
  result: PluginAutoEnableResult;
}): PluginAutoEnableCacheEntry {
  return {
    configFingerprint: fingerprintPluginAutoEnableConfig(params.config),
    discoveryFingerprint: stableFingerprintValue(params.discovery.candidates),
    envFingerprint: fingerprintPluginAutoEnableEnv(params.env),
    registryFingerprint: stableFingerprintValue(params.manifestRegistry.plugins),
    result: params.result,
  };
}

function isPluginAutoEnableCacheEntryFresh(params: {
  entry: PluginAutoEnableCacheEntry;
  config: OpenClawConfig;
  discovery: PluginDiscoveryResult;
  env: NodeJS.ProcessEnv;
  manifestRegistry: PluginManifestRegistry;
}): boolean {
  return (
    params.entry.configFingerprint === fingerprintPluginAutoEnableConfig(params.config) &&
    params.entry.discoveryFingerprint === stableFingerprintValue(params.discovery.candidates) &&
    params.entry.envFingerprint === fingerprintPluginAutoEnableEnv(params.env) &&
    params.entry.registryFingerprint === stableFingerprintValue(params.manifestRegistry.plugins)
  );
}

/** Applies already detected plugin auto-enable candidates to config. */
export function materializePluginAutoEnableCandidates(params: {
  config?: OpenClawConfig;
  candidates: readonly PluginAutoEnableCandidate[];
  env?: NodeJS.ProcessEnv;
  manifestRegistry?: PluginManifestRegistry;
}): PluginAutoEnableResult {
  const env = params.env ?? process.env;
  const config = params.config ?? {};
  const entries = config.plugins?.entries;
  const hasRestrictiveAllowlistWithEntries =
    Array.isArray(config.plugins?.allow) &&
    config.plugins.allow.length > 0 &&
    entries !== undefined &&
    typeof entries === "object";
  if (params.candidates.length === 0 && !hasRestrictiveAllowlistWithEntries) {
    return { config, changes: [], autoEnabledReasons: {} };
  }
  const manifestRegistry = resolvePluginAutoEnableManifestRegistry({
    config,
    env,
    manifestRegistry: params.manifestRegistry,
  });
  return materializePluginAutoEnableCandidatesInternal({
    config,
    candidates: params.candidates,
    env,
    manifestRegistry,
  });
}

export function applyPluginAutoEnable(params: {
  config?: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  manifestRegistry?: PluginManifestRegistry;
  discovery?: PluginDiscoveryResult;
}): PluginAutoEnableResult {
  const config = params.config;
  if (config && typeof config === "object" && params.manifestRegistry && params.discovery) {
    const env = params.env ?? process.env;
    const envCache = getOrCreateWeakMap(
      (sameTurnApplyCache ??= new WeakMap()),
      config,
      () => new WeakMap<object, PluginAutoEnableRegistryCache>(),
    );
    const registryCache = getOrCreateWeakMap(
      envCache,
      env,
      () => new WeakMap<object, PluginAutoEnableDiscoveryCache>(),
    );
    const discoveryCache = getOrCreateWeakMap(
      registryCache,
      params.manifestRegistry,
      () => new WeakMap<object, PluginAutoEnableCacheEntry>(),
    );
    const cached = discoveryCache.get(params.discovery);
    if (
      cached &&
      isPluginAutoEnableCacheEntryFresh({
        entry: cached,
        config,
        discovery: params.discovery,
        env,
        manifestRegistry: params.manifestRegistry,
      })
    ) {
      return cached.result;
    }
    const candidates = detectPluginAutoEnableCandidates(params);
    const result = materializePluginAutoEnableCandidates({
      config,
      candidates,
      env: params.env,
      manifestRegistry: params.manifestRegistry,
    });
    discoveryCache.set(
      params.discovery,
      createPluginAutoEnableCacheEntry({
        config,
        discovery: params.discovery,
        env,
        manifestRegistry: params.manifestRegistry,
        result,
      }),
    );
    scheduleSameTurnApplyCacheClear();
    return result;
  }

  const candidates = detectPluginAutoEnableCandidates(params);
  return materializePluginAutoEnableCandidates({
    config: params.config,
    candidates,
    env: params.env,
    manifestRegistry: params.manifestRegistry,
  });
}
