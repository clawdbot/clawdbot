/** Detects when secrets runtime preparation can safely use a fast path. */
import { existsSync } from "node:fs";
import path from "node:path";
import { uniqueStrings } from "@openclaw/normalization-core/string-normalization";
import {
  listAgentIds,
  resolveAgentDir,
  resolveDefaultAgentDir,
} from "../agents/agent-scope-config.js";
import {
  AUTH_PROFILE_FILENAME,
  AUTH_STATE_FILENAME,
  LEGACY_AUTH_FILENAME,
} from "../agents/auth-profiles/path-constants.js";
import { getRuntimeAuthProfileStoreCredentialsRevision } from "../agents/auth-profiles/runtime-snapshots.js";
import { resolveAuthProfileDatabasePath } from "../agents/auth-profiles/sqlite.js";
import type { AuthProfileStore } from "../agents/auth-profiles/types.js";
import { resolveOAuthPath } from "../config/paths.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PluginManifestRegistry } from "../plugins/manifest-registry.js";
import type { PluginOrigin } from "../plugins/plugin-origin.types.js";
import { resolveUserPath } from "../utils.js";
import { hasCredentialBearingObjectValue, hasSecretRefCandidate } from "./runtime-secret-scan.js";
import type { SecretDefaults } from "./runtime-shared.js";
import type {
  PreparedSecretsRuntimeSnapshot,
  SecretsRuntimeRefreshContext,
} from "./runtime-state.js";
import type { RuntimeWebToolsMetadata } from "./runtime-web-tools.types.js";

const RUNTIME_PATH_ENV_KEYS = [
  "HOME",
  "USERPROFILE",
  "HOMEDRIVE",
  "HOMEPATH",
  "OPENCLAW_HOME",
  "OPENCLAW_STATE_DIR",
  "OPENCLAW_CONFIG_PATH",
  "OPENCLAW_AGENT_DIR",
  "OPENCLAW_TEST_FAST",
] as const;

/**
 * Merges caller env with process path env needed for config and agent-dir resolution.
 */
export function mergeSecretsRuntimeEnv(
  env: NodeJS.ProcessEnv | Record<string, string | undefined> | undefined,
): Record<string, string | undefined> {
  const merged = { ...(env ?? process.env) } as Record<string, string | undefined>;
  for (const key of RUNTIME_PATH_ENV_KEYS) {
    if (merged[key] !== undefined) {
      continue;
    }
    // Tests often pass narrow env objects; path resolution still needs host path variables.
    const processValue = process.env[key];
    if (processValue !== undefined) {
      merged[key] = processValue;
    }
  }
  return merged;
}

/**
 * Collects default and named agent directories that may contain auth profile stores.
 */
export function collectCandidateAgentDirs(
  config: OpenClawConfig,
  env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env,
): string[] {
  const dirs = new Set<string>();
  dirs.add(resolveUserPath(resolveDefaultAgentDir(config, env), env));
  for (const agentId of listAgentIds(config)) {
    dirs.add(resolveUserPath(resolveAgentDir(config, agentId, env), env));
  }
  return [...dirs];
}

/**
 * Combines explicit refresh agent dirs with config-derived dirs for runtime refresh.
 */
export function resolveRefreshAgentDirs(
  config: OpenClawConfig,
  context: SecretsRuntimeRefreshContext,
): string[] {
  const configDerived = collectCandidateAgentDirs(config, context.env);
  if (!context.explicitAgentDirs || context.explicitAgentDirs.length === 0) {
    return configDerived;
  }
  return uniqueStrings([...context.explicitAgentDirs, ...configDerived]);
}

function resolveCandidateAgentDirs(params: {
  config: OpenClawConfig;
  env: NodeJS.ProcessEnv | Record<string, string | undefined>;
  agentDirs?: string[];
}): string[] {
  return params.agentDirs?.length
    ? uniqueStrings(params.agentDirs.map((entry) => resolveUserPath(entry, params.env)))
    : collectCandidateAgentDirs(params.config, params.env);
}

function hasCandidateAuthProfileStoreSource(agentDir: string): boolean {
  return (
    existsSync(resolveAuthProfileDatabasePath(agentDir)) ||
    existsSync(path.join(agentDir, AUTH_PROFILE_FILENAME)) ||
    existsSync(path.join(agentDir, AUTH_STATE_FILENAME)) ||
    existsSync(path.join(agentDir, LEGACY_AUTH_FILENAME))
  );
}

/**
 * Returns whether auth profile files or OAuth state exist for candidate agent dirs.
 */
function hasCandidateAuthProfileStoreSources(params: {
  config: OpenClawConfig;
  env: NodeJS.ProcessEnv | Record<string, string | undefined>;
  agentDirs?: string[];
}): boolean {
  const candidateDirs = resolveCandidateAgentDirs(params);
  const mainAgentDir = resolveUserPath(resolveDefaultAgentDir({}, params.env), params.env);
  return (
    candidateDirs.some((agentDir) => hasCandidateAuthProfileStoreSource(agentDir)) ||
    hasCandidateAuthProfileStoreSource(mainAgentDir) ||
    existsSync(resolveOAuthPath(params.env as NodeJS.ProcessEnv))
  );
}

/**
 * Creates empty web-tool metadata for snapshots that do not need secret resolution.
 */
export function createEmptyRuntimeWebToolsMetadata(): RuntimeWebToolsMetadata {
  return {
    search: {
      providerSource: "none",
      diagnostics: [],
    },
    fetch: {
      providerSource: "none",
      diagnostics: [],
    },
    diagnostics: [],
  };
}

function hasActiveRuntimeWebFetchProviderSurface(
  fetch: unknown,
  defaults: SecretDefaults | undefined,
): boolean {
  if (!fetch || typeof fetch !== "object" || Array.isArray(fetch)) {
    return false;
  }
  const fetchConfig = fetch as Record<string, unknown>;
  if (fetchConfig.enabled === false) {
    return false;
  }
  if (typeof fetchConfig.provider === "string" && fetchConfig.provider.trim()) {
    return true;
  }
  return hasCredentialBearingObjectValue(fetchConfig, defaults);
}

function hasRuntimeWebToolConfigSurface(config: OpenClawConfig): boolean {
  const web = config.tools?.web;
  const defaults = config.secrets?.defaults;
  const fetchExplicitlyDisabled =
    web &&
    typeof web === "object" &&
    !Array.isArray(web) &&
    typeof (web as Record<string, unknown>).fetch === "object" &&
    (web as { fetch?: { enabled?: unknown } }).fetch?.enabled === false;
  if (web && typeof web === "object" && !Array.isArray(web)) {
    const webRecord = web as Record<string, unknown>;
    if ("search" in webRecord) {
      return true;
    }
    if (
      "fetch" in webRecord &&
      hasActiveRuntimeWebFetchProviderSurface(webRecord.fetch, defaults)
    ) {
      return true;
    }
  }
  const entries = config.plugins?.entries;
  if (!entries || typeof entries !== "object" || Array.isArray(entries)) {
    return false;
  }
  return Object.values(entries).some((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      return false;
    }
    const pluginConfig = (entry as { config?: unknown }).config;
    return (
      pluginConfig !== null &&
      typeof pluginConfig === "object" &&
      !Array.isArray(pluginConfig) &&
      ("webSearch" in pluginConfig || (!fetchExplicitlyDisabled && "webFetch" in pluginConfig))
    );
  });
}

/**
 * Returns whether a snapshot can skip full SecretRef/web-tool resolution.
 */
/** Returns whether current config/auth/plugin state allows skipping full secret preparation. */
export function canUseSecretsRuntimeFastPath(params: {
  sourceConfig: OpenClawConfig;
  authStores: Array<{ agentDir: string; store: AuthProfileStore }>;
}): boolean {
  if (hasRuntimeWebToolConfigSurface(params.sourceConfig)) {
    return false;
  }
  const defaults = params.sourceConfig.secrets?.defaults;
  if (hasSecretRefCandidate(params.sourceConfig, defaults)) {
    return false;
  }
  return !params.authStores.some((entry) => hasSecretRefCandidate(entry.store, defaults));
}

/**
 * Prepares a runtime snapshot without resolving refs when config and auth stores contain none.
 */
export function prepareSecretsRuntimeFastPathSnapshot(params: {
  config: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  agentDirs?: string[];
  includeAuthStoreRefs?: boolean;
  loadAuthStore?: (agentDir?: string) => AuthProfileStore;
  loadablePluginOrigins?: ReadonlyMap<string, PluginOrigin>;
  manifestRegistry?: Pick<PluginManifestRegistry, "plugins">;
}): {
  snapshot: PreparedSecretsRuntimeSnapshot;
  refreshContext: SecretsRuntimeRefreshContext;
  usesAuthStoreFallback: boolean;
} | null {
  const runtimeEnv = mergeSecretsRuntimeEnv(params.env);
  const authStoreCredentialsRevision = getRuntimeAuthProfileStoreCredentialsRevision();
  const sourceConfig = structuredClone(params.config);
  const resolvedConfig = structuredClone(params.config);
  const includeAuthStoreRefs = params.includeAuthStoreRefs ?? true;
  const candidateDirs = resolveCandidateAgentDirs({
    config: resolvedConfig,
    env: runtimeEnv,
    agentDirs: params.agentDirs,
  });
  let authStores: Array<{ agentDir: string; store: AuthProfileStore }> = [];
  if (includeAuthStoreRefs) {
    if (!params.loadAuthStore) {
      if (
        hasCandidateAuthProfileStoreSources({
          config: resolvedConfig,
          env: runtimeEnv,
          agentDirs: candidateDirs,
        })
      ) {
        return null;
      }
      authStores = candidateDirs.map((agentDir) => ({
        agentDir,
        store: { version: 1, profiles: {} },
      }));
    } else {
      const loadAuthStore = params.loadAuthStore;
      authStores = candidateDirs.map((agentDir) => ({
        agentDir,
        store: structuredClone(loadAuthStore(agentDir)),
      }));
    }
  }
  if (!canUseSecretsRuntimeFastPath({ sourceConfig, authStores })) {
    return null;
  }
  const snapshot = {
    sourceConfig,
    config: resolvedConfig,
    authStores,
    authStoreCredentialsRevision,
    warnings: [],
    degradedOwners: [],
    secretOwners: [],
    webTools: createEmptyRuntimeWebToolsMetadata(),
  };
  return {
    snapshot,
    usesAuthStoreFallback: !params.loadAuthStore,
    refreshContext: {
      env: runtimeEnv,
      explicitAgentDirs: params.agentDirs?.length ? [...candidateDirs] : null,
      includeAuthStoreRefs,
      loadablePluginOrigins: params.loadablePluginOrigins ?? new Map<string, PluginOrigin>(),
      ...(params.manifestRegistry ? { manifestRegistry: params.manifestRegistry } : {}),
      ...(params.loadAuthStore ? { loadAuthStore: params.loadAuthStore } : {}),
    },
  };
}
