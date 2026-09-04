// Applies plugin auto-enable decisions to normalized config objects.
import type { AmbientEnvTriggerPolicy } from "../channels/config-presence.js";
import type { PluginDiscoveryResult } from "../plugins/discovery.js";
import type { PluginManifestRegistry } from "../plugins/manifest-registry.js";
import { registerPluginMetadataProcessMemoLifecycleClear } from "../plugins/plugin-metadata-lifecycle.js";
import { detectPluginAutoEnableCandidates } from "./plugin-auto-enable.detect.js";
import {
  materializePluginAutoEnableCandidatesInternal,
  resolvePluginAutoEnableManifestRegistry,
} from "./plugin-auto-enable.shared.js";
import type {
  PluginAutoEnableCandidate,
  PluginAutoEnableResult,
} from "./plugin-auto-enable.types.js";
import type { OpenClawConfig } from "./types.openclaw.js";

type PluginAutoEnableCacheEntry = {
  discoveryFingerprint: string;
  registryFingerprint: string;
  ambientEnvTriggers: AmbientEnvTriggerPolicy;
  result: PluginAutoEnableResult;
};
type PluginAutoEnableDiscoveryCache = WeakMap<object, PluginAutoEnableCacheEntry>;
type PluginAutoEnableRegistryCache = WeakMap<object, PluginAutoEnableDiscoveryCache>;
type PluginAutoEnableEnvCache = WeakMap<object, PluginAutoEnableRegistryCache>;
type PluginAutoEnableConfigCache = WeakMap<object, PluginAutoEnableEnvCache>;

let sameTurnApplyCache: PluginAutoEnableConfigCache | undefined;
let sameTurnApplyCacheClearScheduled = false;
let stableFingerprintMemo = new WeakMap<object, string>();

// Metadata arrays use replacement snapshots; lifecycle clear refreshes their identity memo.
// Config/env identity is already enforced by the nested same-turn cache.
registerPluginMetadataProcessMemoLifecycleClear(() => {
  stableFingerprintMemo = new WeakMap();
  sameTurnApplyCache = undefined;
});

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
  const cached = stableFingerprintMemo.get(value);
  if (cached !== undefined) {
    return cached;
  }
  const fingerprint = Array.isArray(value)
    ? `[${value.map((entry) => stableFingerprintValue(entry)).join(",")}]`
    : (() => {
        const record = value as Record<string, unknown>;
        return `{${Object.keys(record)
          .toSorted((left, right) => left.localeCompare(right))
          .map((key) => `${JSON.stringify(key)}:${stableFingerprintValue(record[key])}`)
          .join(",")}}`;
      })();
  stableFingerprintMemo.set(value, fingerprint);
  return fingerprint;
}

function createPluginAutoEnableCacheEntry(params: {
  discovery: PluginDiscoveryResult;
  manifestRegistry: PluginManifestRegistry;
  result: PluginAutoEnableResult;
  ambientEnvTriggers: AmbientEnvTriggerPolicy;
}): PluginAutoEnableCacheEntry {
  return {
    discoveryFingerprint: stableFingerprintValue(params.discovery.candidates),
    registryFingerprint: stableFingerprintValue(params.manifestRegistry.plugins),
    ambientEnvTriggers: params.ambientEnvTriggers,
    result: params.result,
  };
}

function isPluginAutoEnableCacheEntryFresh(params: {
  entry: PluginAutoEnableCacheEntry;
  discovery: PluginDiscoveryResult;
  manifestRegistry: PluginManifestRegistry;
  ambientEnvTriggers: AmbientEnvTriggerPolicy;
}): boolean {
  return (
    params.entry.discoveryFingerprint === stableFingerprintValue(params.discovery.candidates) &&
    params.entry.registryFingerprint === stableFingerprintValue(params.manifestRegistry.plugins) &&
    params.entry.ambientEnvTriggers === params.ambientEnvTriggers
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
  ambientEnvTriggers?: AmbientEnvTriggerPolicy;
}): PluginAutoEnableResult {
  const config = params.config;
  if (config && typeof config === "object" && params.manifestRegistry && params.discovery) {
    const env = params.env ?? process.env;
    const ambientEnvTriggers = params.ambientEnvTriggers ?? "allow";
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
        discovery: params.discovery,
        manifestRegistry: params.manifestRegistry,
        ambientEnvTriggers,
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
        discovery: params.discovery,
        manifestRegistry: params.manifestRegistry,
        result,
        ambientEnvTriggers,
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
