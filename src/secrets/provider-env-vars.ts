import { resolveProviderAuthAliasMap } from "../agents/provider-auth-aliases.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { loadPluginManifestRegistry } from "../plugins/manifest-registry.js";
import type { PluginManifestRecord } from "../plugins/manifest-registry.js";
import { hasKind } from "../plugins/slots.js";
import { normalizeOptionalLowercaseString } from "../shared/string-coerce.js";

const CORE_PROVIDER_AUTH_ENV_VAR_CANDIDATES = {
  anthropic: ["ANTHROPIC_OAUTH_TOKEN", "ANTHROPIC_API_KEY"],
  openai: ["OPENAI_API_KEY"],
  voyage: ["VOYAGE_API_KEY"],
  cerebras: ["CEREBRAS_API_KEY"],
  "anthropic-openai": ["ANTHROPIC_API_KEY"],
  "qwen-dashscope": ["DASHSCOPE_API_KEY"],
} as const;

const CORE_PROVIDER_SETUP_ENV_VAR_OVERRIDES = {
  "minimax-cn": ["MINIMAX_API_KEY"],
} as const;

export type ProviderEnvVarLookupParams = {
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  includeUntrustedWorkspacePlugins?: boolean;
};

type PluginEntriesConfig = NonNullable<NonNullable<OpenClawConfig["plugins"]>["entries"]>;

function normalizePluginConfigId(id: unknown): string {
  return normalizeOptionalLowercaseString(id) ?? "";
}

function hasPluginId(list: unknown, pluginId: string): boolean {
  return Array.isArray(list) && list.some((entry) => normalizePluginConfigId(entry) === pluginId);
}

function findPluginEntry(
  entries: PluginEntriesConfig | undefined,
  pluginId: string,
): { enabled?: boolean } | undefined {
  if (!entries || typeof entries !== "object" || Array.isArray(entries)) {
    return undefined;
  }
  for (const [key, value] of Object.entries(entries)) {
    if (normalizePluginConfigId(key) !== pluginId) {
      continue;
    }
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as { enabled?: boolean })
      : {};
  }
  return undefined;
}

function isWorkspacePluginTrustedForProviderEnvVars(
  plugin: PluginManifestRecord,
  config: OpenClawConfig | undefined,
): boolean {
  const pluginsConfig = config?.plugins;
  if (pluginsConfig?.enabled === false) {
    return false;
  }

  const pluginId = normalizePluginConfigId(plugin.id);
  if (!pluginId || hasPluginId(pluginsConfig?.deny, pluginId)) {
    return false;
  }

  const entry = findPluginEntry(pluginsConfig?.entries, pluginId);
  if (entry?.enabled === false) {
    return false;
  }
  if (entry?.enabled === true || hasPluginId(pluginsConfig?.allow, pluginId)) {
    return true;
  }
  return (
    hasKind(plugin.kind, "context-engine") &&
    normalizePluginConfigId(pluginsConfig?.slots?.contextEngine) === pluginId
  );
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

function resolveManifestProviderAuthEnvVarCandidates(
  params?: ProviderEnvVarLookupParams,
): Record<string, string[]> {
  const registry = loadPluginManifestRegistry({
    config: params?.config,
    workspaceDir: params?.workspaceDir,
    env: params?.env,
  });
  const candidates: Record<string, string[]> = {};
  for (const plugin of registry.plugins) {
    if (!shouldUsePluginProviderEnvVars(plugin, params)) {
      continue;
    }
    if (!plugin.providerAuthEnvVars) {
      continue;
    }
    for (const [providerId, keys] of Object.entries(plugin.providerAuthEnvVars).toSorted(
      ([left], [right]) => left.localeCompare(right),
    )) {
      appendUniqueEnvVarCandidates(candidates, providerId, keys);
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

export function resolveProviderAuthEnvVarCandidates(
  params?: ProviderEnvVarLookupParams,
): Record<string, readonly string[]> {
  return {
    ...resolveManifestProviderAuthEnvVarCandidates(params),
    ...CORE_PROVIDER_AUTH_ENV_VAR_CANDIDATES,
  };
}

export function resolveProviderEnvVars(
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

export function getProviderEnvVars(
  providerId: string,
  params?: ProviderEnvVarLookupParams,
): string[] {
  const providerEnvVars = resolveProviderEnvVars(params);
  const envVars = Object.hasOwn(providerEnvVars, providerId)
    ? providerEnvVars[providerId]
    : undefined;
  return Array.isArray(envVars) ? [...envVars] : [];
}

const EXTRA_PROVIDER_AUTH_ENV_VARS = ["MINIMAX_CODE_PLAN_KEY", "MINIMAX_CODING_API_KEY"] as const;

// OPENCLAW_API_KEY authenticates the local OpenClaw bridge itself and must
// remain available to child bridge/runtime processes.
export function listKnownProviderAuthEnvVarNames(params?: ProviderEnvVarLookupParams): string[] {
  return [
    ...new Set([
      ...Object.values(resolveProviderAuthEnvVarCandidates(params)).flatMap((keys) => keys),
      ...Object.values(resolveProviderEnvVars(params)).flatMap((keys) => keys),
      ...EXTRA_PROVIDER_AUTH_ENV_VARS,
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
