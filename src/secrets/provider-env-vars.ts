/** Resolves provider environment variable candidates and auth evidence from core/plugin metadata. */
import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import { uniqueStrings } from "@openclaw/normalization-core/string-normalization";
import { resolveProviderAuthAliasMap } from "../agents/provider-auth-aliases.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { normalizePluginsConfig } from "../plugins/config-state.js";
import { getCurrentPluginMetadataSnapshot } from "../plugins/current-plugin-metadata-snapshot.js";
import { isInstalledPluginEnabled } from "../plugins/installed-plugin-index.js";
import type { PluginManifestRecord } from "../plugins/manifest-registry.js";
import {
  isWorkspacePluginAllowedByConfig,
  normalizePluginConfigId,
} from "../plugins/plugin-config-trust.js";
import {
  loadPluginMetadataSnapshot,
  type PluginMetadataSnapshot,
} from "../plugins/plugin-metadata-snapshot.js";
import { listSetupProviderIds } from "../plugins/setup-descriptors.js";
import { hasKind } from "../plugins/slots.js";
import { appendUniqueEnvVarCandidates } from "../shared/env-var-candidates.js";

const CORE_PROVIDER_AUTH_ENV_VAR_CANDIDATES = {
  anthropic: ["ANTHROPIC_OAUTH_TOKEN", "ANTHROPIC_API_KEY"],
  openai: ["CODEX_API_KEY", "OPENAI_API_KEY"],
  voyage: ["VOYAGE_API_KEY"],
  cerebras: ["CEREBRAS_API_KEY"],
  "anthropic-openai": ["ANTHROPIC_API_KEY"],
  "qwen-dashscope": ["DASHSCOPE_API_KEY"],
} as const;

const CORE_PROVIDER_SETUP_ENV_VAR_OVERRIDES = {
  minimax: ["MINIMAX_API_KEY"],
  "minimax-cn": ["MINIMAX_API_KEY"],
} as const;

export type ProviderEnvVarLookupParams = {
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  includeUntrustedWorkspacePlugins?: boolean;
  metadataSnapshot?: PluginMetadataSnapshot;
};

/** Manifest-provided evidence that a provider auth credential exists outside config. */
export type ProviderAuthEvidence = {
  type: "local-file-with-env";
  fileEnvVar?: string;
  fallbackPaths?: readonly string[];
  requiresAnyEnv?: readonly string[];
  requiresAllEnv?: readonly string[];
  credentialMarker: string;
  source?: string;
};

/** Provider auth lookup maps resolved from plugin metadata and core fallback rules. */
export type ProviderAuthLookupMaps = {
  aliasMap: Readonly<Record<string, string>>;
  envCandidateMap: Readonly<Record<string, readonly string[]>>;
  authEvidenceMap: Readonly<Record<string, readonly ProviderAuthEvidence[]>>;
  setupProviderFallbackRefs: readonly string[];
};

function isWorkspacePluginTrustedForProviderEnvVars(
  plugin: PluginManifestRecord,
  config: OpenClawConfig | undefined,
): boolean {
  return isWorkspacePluginAllowedByConfig({
    config,
    isImplicitlyAllowed: (pluginId) =>
      hasKind(plugin.kind, "context-engine") &&
      normalizePluginConfigId(config?.plugins?.slots?.contextEngine) === pluginId,
    plugin,
  });
}

function shouldUsePluginProviderEnvVars(
  plugin: PluginManifestRecord,
  params: ProviderEnvVarLookupParams | undefined,
): boolean {
  if (plugin.origin !== "workspace" || params?.includeUntrustedWorkspacePlugins !== false) {
    return true;
  }
  // Env-var candidates are hints for lookup/scrubbing, but callers can opt into the same
  // workspace trust filter used for stronger auth evidence when probing scoped workspaces.
  return isWorkspacePluginTrustedForProviderEnvVars(plugin, params?.config);
}

function shouldUsePluginProviderAuthEvidence(
  plugin: PluginManifestRecord,
  params: ProviderEnvVarLookupParams | undefined,
): boolean {
  if (plugin.origin !== "workspace") {
    return true;
  }
  // Auth evidence can point at local credential files, so workspace plugins must be explicitly
  // trusted through config before their evidence participates in auth discovery.
  return isWorkspacePluginTrustedForProviderEnvVars(plugin, params?.config);
}

function appendUniqueAuthEvidence(
  target: Record<string, ProviderAuthEvidence[]>,
  providerId: string,
  evidence: readonly ProviderAuthEvidence[],
) {
  const normalizedProviderId = providerId.trim();
  if (!normalizedProviderId || evidence.length === 0) {
    return;
  }
  const bucket = (target[normalizedProviderId] ??= []);
  const seen = new Set(bucket.map((entry) => JSON.stringify(entry)));
  for (const entry of evidence) {
    const key = JSON.stringify(entry);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    bucket.push(entry);
  }
}

function appendUniqueProviderRef(target: Set<string>, providerId: string): void {
  const normalized = normalizeProviderId(providerId);
  if (normalized) {
    target.add(normalized);
  }
}

function resolveProviderMetadataSnapshot(
  params?: ProviderEnvVarLookupParams,
): PluginMetadataSnapshot {
  if (params?.metadataSnapshot) {
    return params.metadataSnapshot;
  }
  const config = params?.config;
  const env = params?.env ?? process.env;
  let current: PluginMetadataSnapshot | undefined;
  if (config) {
    current = getCurrentPluginMetadataSnapshot({
      config,
      env,
      ...(params?.workspaceDir !== undefined ? { workspaceDir: params.workspaceDir } : {}),
      allowWorkspaceScopedSnapshot: true,
    });
  } else {
    current = getCurrentPluginMetadataSnapshot({
      env,
      ...(params?.workspaceDir !== undefined ? { workspaceDir: params.workspaceDir } : {}),
      allowWorkspaceScopedSnapshot: true,
      requireDefaultDiscoveryContext: true,
    });
  }
  if (current) {
    return current;
  }
  if (config && normalizePluginsConfig(config.plugins).loadPaths.length === 0) {
    // Configs without explicit load paths can reuse the process-scoped snapshot; plugin-scoped
    // configs need fresh metadata so workspace allow/deny decisions are not bypassed.
    const unscopedCurrent = getCurrentPluginMetadataSnapshot({
      env,
      ...(params?.workspaceDir !== undefined ? { workspaceDir: params.workspaceDir } : {}),
      allowWorkspaceScopedSnapshot: true,
      requireDefaultDiscoveryContext: true,
    });
    if (unscopedCurrent) {
      return unscopedCurrent;
    }
  }
  return loadPluginMetadataSnapshot({
    config: config ?? {},
    workspaceDir: params?.workspaceDir,
    env,
    preferPersisted: false,
  });
}

function resolveManifestProviderAuthEnvVarCandidates(
  params?: ProviderEnvVarLookupParams,
): Record<string, string[]> {
  const snapshot = resolveProviderMetadataSnapshot(params);
  const aliases = resolveProviderAuthAliasMap({
    ...params,
    metadataSnapshot: snapshot,
  });
  return resolveManifestProviderAuthEnvVarCandidatesFromSnapshot(params, snapshot, aliases);
}

function resolveManifestProviderUsageAuthEnvVarNames(
  params?: ProviderEnvVarLookupParams,
): string[] {
  const snapshot = resolveProviderMetadataSnapshot(params);
  return uniqueStrings(
    snapshot.plugins
      .filter((plugin) => shouldUsePluginProviderEnvVars(plugin, params))
      .flatMap((plugin) => Object.values(plugin.providerUsageAuthEnvVars ?? {}).flat()),
  );
}

function resolveManifestProviderAuthEnvVarCandidatesFromSnapshot(
  params: ProviderEnvVarLookupParams | undefined,
  snapshot: PluginMetadataSnapshot,
  aliases: Readonly<Record<string, string>>,
): Record<string, string[]> {
  const candidates: Record<string, string[]> = {};
  for (const plugin of snapshot.plugins) {
    if (!shouldUsePluginProviderEnvVars(plugin, params)) {
      continue;
    }
    if (plugin.providerAuthEnvVars) {
      for (const [providerId, keys] of Object.entries(plugin.providerAuthEnvVars).toSorted(
        ([left], [right]) => left.localeCompare(right),
      )) {
        appendUniqueEnvVarCandidates(candidates, providerId, keys);
      }
    }
    for (const provider of plugin.setup?.providers ?? []) {
      appendUniqueEnvVarCandidates(candidates, provider.id, provider.envVars ?? []);
    }
  }
  for (const [alias, target] of Object.entries(aliases).toSorted(([left], [right]) =>
    left.localeCompare(right),
  )) {
    const keys = candidates[target];
    if (keys) {
      appendUniqueEnvVarCandidates(candidates, alias, keys);
    }
  }
  return candidates;
}

function resolveManifestProviderAuthEvidenceFromSnapshot(
  params: ProviderEnvVarLookupParams | undefined,
  snapshot: PluginMetadataSnapshot,
  aliases: Readonly<Record<string, string>>,
): Record<string, ProviderAuthEvidence[]> {
  const evidenceByProvider: Record<string, ProviderAuthEvidence[]> = {};
  for (const plugin of snapshot.plugins) {
    if (
      snapshot.index.plugins.length > 0 &&
      !isInstalledPluginEnabled(snapshot.index, plugin.id, params?.config)
    ) {
      continue;
    }
    if (!shouldUsePluginProviderAuthEvidence(plugin, params)) {
      continue;
    }
    for (const provider of plugin.setup?.providers ?? []) {
      appendUniqueAuthEvidence(evidenceByProvider, provider.id, provider.authEvidence ?? []);
    }
  }
  for (const [alias, target] of Object.entries(aliases).toSorted(([left], [right]) =>
    left.localeCompare(right),
  )) {
    const evidence = evidenceByProvider[target];
    if (evidence) {
      appendUniqueAuthEvidence(evidenceByProvider, alias, evidence);
    }
  }
  return evidenceByProvider;
}

function resolveManifestSetupProviderFallbackRefsFromSnapshot(
  params: ProviderEnvVarLookupParams | undefined,
  snapshot: PluginMetadataSnapshot,
  aliases: Readonly<Record<string, string>>,
): string[] {
  const refs = new Set<string>();
  for (const plugin of snapshot.plugins) {
    if (
      snapshot.index.plugins.length > 0 &&
      !isInstalledPluginEnabled(snapshot.index, plugin.id, params?.config)
    ) {
      continue;
    }
    if (plugin.setup?.requiresRuntime === false) {
      continue;
    }
    // Setup fallback refs are only useful for providers that may be reached at runtime.
    if (plugin.setup?.providers === undefined && plugin.providers === undefined) {
      continue;
    }
    for (const providerId of listSetupProviderIds(plugin)) {
      appendUniqueProviderRef(refs, providerId);
    }
  }
  for (const [alias, target] of Object.entries(aliases)) {
    if (refs.has(target)) {
      appendUniqueProviderRef(refs, alias);
    }
  }
  return [...refs].toSorted((a, b) => a.localeCompare(b));
}

/** Resolves provider env-var candidates used by generic auth lookup. */
/** Resolves provider auth env-var candidates from core fallbacks and plugin metadata. */
export function resolveProviderAuthEnvVarCandidates(
  params?: ProviderEnvVarLookupParams,
): Record<string, readonly string[]> {
  return {
    ...resolveManifestProviderAuthEnvVarCandidates(params),
    ...CORE_PROVIDER_AUTH_ENV_VAR_CANDIDATES,
  };
}

/** Resolves all provider auth lookup maps from a single metadata snapshot. */
export function resolveProviderAuthLookupMaps(
  params?: ProviderEnvVarLookupParams,
): ProviderAuthLookupMaps {
  const snapshot = resolveProviderMetadataSnapshot(params);
  const lookupParams = {
    ...params,
    metadataSnapshot: snapshot,
  };
  const aliasMap = resolveProviderAuthAliasMap(lookupParams);
  return {
    aliasMap,
    envCandidateMap: {
      ...resolveManifestProviderAuthEnvVarCandidatesFromSnapshot(params, snapshot, aliasMap),
      ...CORE_PROVIDER_AUTH_ENV_VAR_CANDIDATES,
    },
    authEvidenceMap: resolveManifestProviderAuthEvidenceFromSnapshot(params, snapshot, aliasMap),
    setupProviderFallbackRefs: resolveManifestSetupProviderFallbackRefsFromSnapshot(
      params,
      snapshot,
      aliasMap,
    ),
  };
}

/** Resolves env vars used by setup, default SecretRefs, and broad secret scrubbing. */
function resolveProviderEnvVars(
  params?: ProviderEnvVarLookupParams,
): Record<string, readonly string[]> {
  return {
    ...resolveProviderAuthEnvVarCandidates(params),
    ...CORE_PROVIDER_SETUP_ENV_VAR_OVERRIDES,
  };
}

function createLazyReadonlyRecord(
  resolve: () => Record<string, readonly string[]>,
): Record<string, readonly string[]> {
  let cached: Record<string, readonly string[]> | undefined;
  const getResolved = (): Record<string, readonly string[]> => {
    cached ??= resolve();
    return cached;
  };

  return new Proxy({} as Record<string, readonly string[]>, {
    get(_target, prop) {
      if (typeof prop !== "string") {
        return undefined;
      }
      return getResolved()[prop];
    },
    has(_target, prop) {
      return typeof prop === "string" && Object.hasOwn(getResolved(), prop);
    },
    ownKeys() {
      return Reflect.ownKeys(getResolved());
    },
    getOwnPropertyDescriptor(_target, prop) {
      if (typeof prop !== "string") {
        return undefined;
      }
      const value = getResolved()[prop];
      if (value === undefined) {
        return undefined;
      }
      return {
        configurable: true,
        enumerable: true,
        value,
        writable: false,
      };
    },
  });
}

/**
 * Provider env vars used for setup/default secret refs and broad secret
 * scrubbing. This can include non-model providers and may intentionally choose
 * a different preferred first env var than auth resolution.
 *
 * Bundled provider auth envs come from plugin manifests. The override map here
 * is only for true core/non-plugin providers and a few setup-specific ordering
 * overrides where generic onboarding wants a different preferred env var.
 */
const PROVIDER_ENV_VARS = createLazyReadonlyRecord(() => resolveProviderEnvVars());

/** Returns known env var candidates for a provider id or alias. */
export function getProviderEnvVars(
  providerId: string,
  params?: ProviderEnvVarLookupParams,
): string[] {
  const providerEnvVars = params ? resolveProviderEnvVars(params) : PROVIDER_ENV_VARS;
  const envVars = Object.hasOwn(providerEnvVars, providerId)
    ? providerEnvVars[providerId]
    : undefined;
  return Array.isArray(envVars) ? [...envVars] : [];
}

// OPENCLAW_API_KEY authenticates the local OpenClaw bridge itself and must
// remain available to child bridge/runtime processes.
/** Lists known provider auth env vars without bridge-only env vars. */
export function listKnownProviderAuthEnvVarNames(params?: ProviderEnvVarLookupParams): string[] {
  return uniqueStrings([
    ...Object.values(resolveProviderAuthEnvVarCandidates(params)).flat(),
    ...Object.values(resolveProviderEnvVars(params)).flat(),
    ...resolveManifestProviderUsageAuthEnvVarNames(params),
  ]);
}

/** Lists env vars that may contain provider secrets for broad scrubbing. */
export function listKnownSecretEnvVarNames(params?: ProviderEnvVarLookupParams): string[] {
  return uniqueStrings([
    ...Object.values(resolveProviderEnvVars(params)).flat(),
    ...resolveManifestProviderUsageAuthEnvVarNames(params),
  ]);
}

/** Returns a copy of an env object with denied keys removed case-insensitively. */
export function omitEnvKeysCaseInsensitive(
  baseEnv: NodeJS.ProcessEnv,
  keys: Iterable<string>,
): NodeJS.ProcessEnv {
  const env = { ...baseEnv };
  const denied = new Set<string>();
  for (const key of keys) {
    const normalizedKey = key.trim();
    if (normalizedKey) {
      denied.add(normalizedKey.toUpperCase());
    }
  }
  if (denied.size === 0) {
    return env;
  }
  for (const actualKey of Object.keys(env)) {
    if (denied.has(actualKey.toUpperCase())) {
      delete env[actualKey];
    }
  }
  return env;
}
