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
import { hasKind } from "../plugins/slots.js";

const CORE_PROVIDER_AUTH_ENV_VAR_CANDIDATES = {
  anthropic: ["ANTHROPIC_OAUTH_TOKEN", "ANTHROPIC_API_KEY"],
  openai: ["OPENAI_API_KEY"],
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
};

export type ProviderAuthEvidence = {
  type: "local-file-with-env";
  fileEnvVar?: string;
  fallbackPaths?: readonly string[];
  requiresAnyEnv?: readonly string[];
  requiresAllEnv?: readonly string[];
  credentialMarker: string;
  source?: string;
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
  return isWorkspacePluginTrustedForProviderEnvVars(plugin, params?.config);
}

function shouldUsePluginProviderAuthEvidence(
  plugin: PluginManifestRecord,
  params: ProviderEnvVarLookupParams | undefined,
): boolean {
  if (plugin.origin !== "workspace") {
    return true;
  }
  return isWorkspacePluginTrustedForProviderEnvVars(plugin, params?.config);
}

function appendUniqueEnvVarCandidates(
  target: Record<string, string[]>,
  providerId: string,
  keys: readonly string[],
) {
  const normalizedProviderId = providerId.trim();
  if (!normalizedProviderId || keys.length === 0) {
    return;
  }
  const bucket = (target[normalizedProviderId] ??= []);
  const seen = new Set(bucket);
  for (const key of keys) {
    const normalizedKey = key.trim();
    if (!normalizedKey || seen.has(normalizedKey)) {
      continue;
    }
    seen.add(normalizedKey);
    bucket.push(normalizedKey);
  }
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

function resolveProviderMetadataSnapshot(
  params?: ProviderEnvVarLookupParams,
): PluginMetadataSnapshot {
  const config = params?.config ?? {};
  const env = params?.env ?? process.env;
  const current = getCurrentPluginMetadataSnapshot({
    config,
    env,
    ...(params?.workspaceDir !== undefined ? { workspaceDir: params.workspaceDir } : {}),
    allowWorkspaceScopedSnapshot: true,
  });
  if (current) {
    return current;
  }
  if (normalizePluginsConfig(config.plugins).loadPaths.length === 0) {
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
    config,
    workspaceDir: params?.workspaceDir,
    env,
    preferPersisted: false,
  });
}

function resolveManifestProviderAuthEnvVarCandidates(
  params?: ProviderEnvVarLookupParams,
): Record<string, string[]> {
  const snapshot = resolveProviderMetadataSnapshot(params);
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
  const aliases = resolveProviderAuthAliasMap(params);
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

function resolveManifestProviderAuthEvidence(
  params?: ProviderEnvVarLookupParams,
): Record<string, ProviderAuthEvidence[]> {
  const snapshot = resolveProviderMetadataSnapshot(params);
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
  const aliases = resolveProviderAuthAliasMap(params);
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

export function resolveProviderAuthEnvVarCandidates(
  params?: ProviderEnvVarLookupParams,
): Record<string, readonly string[]> {
  return {
    ...resolveManifestProviderAuthEnvVarCandidates(params),
    ...CORE_PROVIDER_AUTH_ENV_VAR_CANDIDATES,
  };
}

export function resolveProviderAuthEvidence(
  params?: ProviderEnvVarLookupParams,
): Record<string, readonly ProviderAuthEvidence[]> {
  return resolveManifestProviderAuthEvidence(params);
}

export function resolveProviderEnvVars(
  params?: ProviderEnvVarLookupParams,
): Record<string, readonly string[]> {
  return {
    ...resolveProviderAuthEnvVarCandidates(params),
    ...CORE_PROVIDER_SETUP_ENV_VAR_OVERRIDES,
  };
}

const lazyRecordCacheResetters = new Set<() => void>();

function createLazyReadonlyRecord(
  resolve: () => Record<string, readonly string[]>,
): Record<string, readonly string[]> {
  let cached: Record<string, readonly string[]> | undefined;
  lazyRecordCacheResetters.add(() => {
    cached = undefined;
  });
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
 * Provider auth env candidates used by generic auth resolution.
 *
 * Order matters: the first non-empty value wins for helpers such as
 * `resolveEnvApiKey()`. Bundled providers source this from plugin manifest
 * metadata so auth probes do not need to load plugin runtime.
 */
export const PROVIDER_AUTH_ENV_VAR_CANDIDATES = createLazyReadonlyRecord(() =>
  resolveProviderAuthEnvVarCandidates(),
);

/**
 * Provider env vars used for setup/default secret refs and broad secret
 * scrubbing. This can include non-model providers and may intentionally choose
 * a different preferred first env var than auth resolution.
 *
 * Bundled provider auth envs come from plugin manifests. The override map here
 * is only for true core/non-plugin providers and a few setup-specific ordering
 * overrides where generic onboarding wants a different preferred env var.
 */
export const PROVIDER_ENV_VARS = createLazyReadonlyRecord(() => resolveProviderEnvVars());

export const __testing = {
  resetProviderEnvVarCachesForTests(): void {
    for (const reset of lazyRecordCacheResetters) {
      reset();
    }
  },
};

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
export function listKnownProviderAuthEnvVarNames(params?: ProviderEnvVarLookupParams): string[] {
  return [
    ...new Set([
      ...Object.values(resolveProviderAuthEnvVarCandidates(params)).flatMap((keys) => keys),
      ...Object.values(resolveProviderEnvVars(params)).flatMap((keys) => keys),
    ]),
  ];
}

export function listKnownSecretEnvVarNames(params?: ProviderEnvVarLookupParams): string[] {
  return [...new Set(Object.values(resolveProviderEnvVars(params)).flatMap((keys) => keys))];
}

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
