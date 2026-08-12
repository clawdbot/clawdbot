// Applies plugin auto-enable decisions to normalized config objects.
import type { AmbientEnvTriggerPolicy } from "../channels/config-presence.js";
import type { PluginDiscoveryResult } from "../plugins/discovery.js";
import type { PluginManifestRegistry } from "../plugins/manifest-registry.js";
import { registerPluginMetadataProcessMemoLifecycleClear } from "../plugins/plugin-metadata-lifecycle.js";
import { normalizePluginPolicyId } from "../plugins/plugin-policy-id.js";
import {
  channelClaimSuppressionKey,
  resolveFoldedPluginEntry,
} from "./channel-claimant-plugins.js";
import { detectPluginAutoEnableCandidates } from "./plugin-auto-enable.detect.js";
import {
  planPluginAutoEnable,
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
let configFingerprintMemo = new WeakMap<object, string>();

// Gateway metadata/config use replacement snapshots, and process.env selection is generation-fixed.
// The plugin metadata lifecycle clear is the freshness boundary for these identity memos.
registerPluginMetadataProcessMemoLifecycleClear(() => {
  stableFingerprintMemo = new WeakMap();
  configFingerprintMemo = new WeakMap();
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

/** Fingerprints config snapshots used by plugin auto-enable detection. */
export function fingerprintPluginAutoEnableConfig(config: OpenClawConfig): string {
  const cached = configFingerprintMemo.get(config);
  if (cached !== undefined) {
    return cached;
  }
  const fingerprint = hashRuntimeConfigValue(config);
  configFingerprintMemo.set(config, fingerprint);
  return fingerprint;
}

/** Fingerprints environment snapshots used by plugin auto-enable detection. */
export function fingerprintPluginAutoEnableEnv(env: NodeJS.ProcessEnv): string {
  return stableFingerprintValue(env);
}

function createPluginAutoEnableCacheEntry(params: {
  config: OpenClawConfig;
  discovery: PluginDiscoveryResult;
  env: NodeJS.ProcessEnv;
  manifestRegistry: PluginManifestRegistry;
  result: PluginAutoEnableResult;
  ambientEnvTriggers: AmbientEnvTriggerPolicy;
}): PluginAutoEnableCacheEntry {
  return {
    configFingerprint: fingerprintPluginAutoEnableConfig(params.config),
    discoveryFingerprint: stableFingerprintValue(params.discovery.candidates),
    envFingerprint: fingerprintPluginAutoEnableEnv(params.env),
    registryFingerprint: stableFingerprintValue(params.manifestRegistry.plugins),
    ambientEnvTriggers: params.ambientEnvTriggers,
    result: params.result,
  };
}

function isPluginAutoEnableCacheEntryFresh(params: {
  entry: PluginAutoEnableCacheEntry;
  config: OpenClawConfig;
  discovery: PluginDiscoveryResult;
  env: NodeJS.ProcessEnv;
  manifestRegistry: PluginManifestRegistry;
  ambientEnvTriggers: AmbientEnvTriggerPolicy;
}): boolean {
  return (
    params.entry.configFingerprint === fingerprintPluginAutoEnableConfig(params.config) &&
    params.entry.discoveryFingerprint === stableFingerprintValue(params.discovery.candidates) &&
    params.entry.envFingerprint === fingerprintPluginAutoEnableEnv(params.env) &&
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
  // Return the declared public shape only: the plan's projection extras (per-channel decisions,
  // the claimant-liveness closure) are for the schema-ownership collector, and a closure in the
  // result would defeat same-turn cache result equality.
  const plan = planPluginAutoEnable({
    config,
    candidates: params.candidates,
    env,
    manifestRegistry,
  });
  return {
    config: plan.config,
    changes: plan.changes,
    autoEnabledReasons: plan.autoEnabledReasons,
  };
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
        config,
        discovery: params.discovery,
        env,
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
        config,
        discovery: params.discovery,
        env,
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

/**
 * Channel claims auto-enable superseded WITHOUT an explicit operator selection, keyed by
 * `channelClaimSuppressionKey`. The loader suppresses these claims' channel registrations: an
 * implicitly superseded plugin can stay loaded for its provider capability, and without
 * suppression its dead claim either wins first-wins registration over the planned replacement or
 * lands in the channel-conflict set and silently drops the plugin's remaining tool
 * registrations. `supersede-keep` claims are deliberately NOT suppressed: the manifest contract
 * preserves both explicitly selected plugins and reports duplicate channel/tool diagnostics
 * instead of silently changing the requested plugin set. Probe-less like the validation
 * projection (plugin setup code must not run here), but unlike validation this replan runs
 * AFTER the applied pass, whose `enabled: true` write for a probe-fired setup plugin is the
 * recorded probe outcome — those plugins rejoin the plan below as the capability candidates
 * the pass ranked, so suppression mirrors the applied pass where projected ownership stays
 * probe-blind and falls back to its predictive tiers.
 */
export function collectSupersededChannelClaims(params: {
  config: OpenClawConfig;
  env: NodeJS.ProcessEnv;
  manifestRegistry: PluginManifestRegistry;
  /** Authored config whose entries count as operator selections (see `planPluginAutoEnable`). */
  selectionConfig?: OpenClawConfig;
  /** Ambient env-trigger policy of the pass being mirrored; env-only channels obey it. */
  ambientEnvTriggers?: AmbientEnvTriggerPolicy;
}): ReadonlySet<string> {
  const suppressed = new Set<string>();
  if (params.config.plugins?.enabled === false) {
    return suppressed;
  }
  const candidates = detectPluginAutoEnableCandidates({
    config: params.config,
    env: params.env,
    manifestRegistry: params.manifestRegistry,
    setupProbes: "skip",
    ...(params.ambientEnvTriggers ? { ambientEnvTriggers: params.ambientEnvTriggers } : {}),
  });
  // Supported external setup auto-enable probes ran only in the applied pass; a plugin with a
  // declared runtime setup surface that the completed config enables while the authored
  // selection config does not was enabled BY that pass (its probe fired — the write is the
  // recorded outcome). Re-seat it as the same capability candidate the pass planned with, or
  // its replacement edges vanish here and a claim the pass superseded races first-wins
  // registration over the setup-provided channel. A declined probe writes nothing, so it can
  // never suppress an incumbent on a replacement the runtime did not enable.
  if (params.selectionConfig) {
    const coveredPolicyIds = new Set(
      candidates.map((candidate) => normalizePluginPolicyId(candidate.pluginId)),
    );
    for (const record of params.manifestRegistry.plugins) {
      const declaresRuntimeSetupSurface =
        (record.setup !== undefined || record.setupSource !== undefined) &&
        record.setup?.requiresRuntime !== false;
      if (
        declaresRuntimeSetupSurface &&
        !coveredPolicyIds.has(normalizePluginPolicyId(record.id)) &&
        resolveFoldedPluginEntry(params.config, record.id, params.manifestRegistry)?.enabled ===
          true &&
        resolveFoldedPluginEntry(params.selectionConfig, record.id, params.manifestRegistry)
          ?.enabled !== true
      ) {
        candidates.push({
          pluginId: record.id,
          kind: "setup-auto-enable",
          reason: "recorded setup activation",
        });
      }
    }
  }
  const plan = planPluginAutoEnable({
    config: params.config,
    candidates,
    env: params.env,
    manifestRegistry: params.manifestRegistry,
    ...(params.selectionConfig ? { selectionConfig: params.selectionConfig } : {}),
  });
  for (const [channelId, decisions] of plan.channelDecisions) {
    for (const [pluginId, decision] of decisions) {
      if (decision === "supersede-disable") {
        suppressed.add(channelClaimSuppressionKey(pluginId, channelId));
      }
    }
  }
  return suppressed;
}
