// Provider auth helpers define auth methods, credential resolution, and setup status contracts.
import path from "node:path";
import {
  asDateTimestampMs,
  resolveExpiresAtMsFromEpochSeconds,
  parseStrictNonNegativeInteger,
} from "../../packages/normalization-core/src/number-coercion.js";
import { normalizeLowercaseStringOrEmpty } from "../../packages/normalization-core/src/string-coerce.js";
import { resolveDefaultAgentDir } from "../agents/agent-scope-config.js";
import { externalCliDiscoveryForProviderAuth } from "../agents/auth-profiles/external-cli-discovery.js";
import { resolveApiKeyForProfile } from "../agents/auth-profiles/oauth.js";
import { resolveAuthProfileOrder } from "../agents/auth-profiles/order.js";
import { listProfilesForProvider } from "../agents/auth-profiles/profiles.js";
import {
  ensureAuthProfileStore,
  loadAuthProfileStoreForSecretsRuntime,
  loadAuthProfileStoreWithoutExternalProfiles,
} from "../agents/auth-profiles/store.js";
import type { AuthProfileStore } from "../agents/auth-profiles/types.js";
import type { AuthProfileCredential } from "../agents/auth-profiles/types.js";
import {
  COPILOT_INTEGRATION_ID,
  buildCopilotIdeHeaders,
} from "../agents/copilot-dynamic-headers.js";
import { resolveEnvApiKey } from "../agents/model-auth-env.js";
import type { OpenClawConfig } from "../config/config.js";
import { resolveStateDir } from "../config/paths.js";
import { loadJsonFile, saveJsonFile } from "../infra/json-file.js";
import { resolveProviderEndpoint } from "./provider-model-shared.js";

export type { OpenClawConfig } from "../config/config.js";
export type { SecretInput } from "../config/types.secrets.js";
export type { SecretInputMode } from "../plugins/provider-auth-types.js";
export type { ProviderAuthResult } from "../plugins/types.js";
export type { ProviderAuthContext } from "../plugins/types.js";
export type { AuthProfileStore, OAuthCredential } from "../agents/auth-profiles/types.js";

export { CLAUDE_CLI_PROFILE_ID, CODEX_CLI_PROFILE_ID } from "../agents/auth-profiles/constants.js";
export {
  ensureAuthProfileStore,
  ensureAuthProfileStoreForLocalUpdate,
  updateAuthProfileStoreWithLock,
} from "../agents/auth-profiles/store.js";
export {
  listProfilesForProvider,
  removeProviderAuthProfilesWithLock,
  upsertAuthProfile,
  upsertAuthProfileWithLock,
} from "../agents/auth-profiles/profiles.js";
export { resolveEnvApiKey } from "../agents/model-auth-env.js";
export {
  readClaudeCliCredentialsCached,
  readCodexCliCredentialsCached,
} from "../agents/cli-credentials.js";
export { suggestOAuthProfileIdForLegacyDefault } from "../agents/auth-profiles/repair.js";
export {
  CUSTOM_LOCAL_AUTH_MARKER,
  MINIMAX_OAUTH_MARKER,
  isKnownEnvApiKeyMarker,
  isNonSecretApiKeyMarker,
  resolveOAuthApiKeyMarker,
  resolveNonEnvSecretRefApiKeyMarker,
} from "../agents/model-auth-markers.js";
export {
  formatApiKeyPreview,
  normalizeApiKeyInput,
  validateApiKeyInput,
} from "../plugins/provider-auth-input.js";
export {
  ensureApiKeyFromEnvOrPrompt,
  ensureApiKeyFromOptionEnvOrPrompt,
  normalizeSecretInputModeInput,
  promptSecretRefForSetup,
  resolveSecretInputModeForEnvSelection,
} from "../plugins/provider-auth-input.js";
export { normalizeApiKeyConfig } from "../agents/models-config.providers.secrets.js";
export {
  buildTokenProfileId,
  validateAnthropicSetupToken,
} from "../plugins/provider-auth-token.js";
export {
  applyAuthProfileConfig,
  buildApiKeyCredential,
  upsertApiKeyProfile,
  writeOAuthCredentials,
  type ApiKeyStorageOptions,
  type WriteOAuthCredentialsOptions,
} from "../plugins/provider-auth-helpers.js";
export { createProviderApiKeyAuthMethod } from "../plugins/provider-api-key-auth.js";
export { coerceSecretRef, hasConfiguredSecretInput } from "../config/types.secrets.js";
export { resolveDefaultSecretProviderAlias } from "../secrets/ref-contract.js";
export { resolveRequiredHomeDir } from "../infra/home-dir.js";
export { resolveOpenClawAgentDir } from "./agent-dir-compat.js";
export {
  normalizeOptionalSecretInput,
  normalizeSecretInput,
} from "../utils/normalize-secret-input.js";
export {
  listKnownProviderAuthEnvVarNames,
  omitEnvKeysCaseInsensitive,
} from "../secrets/provider-env-vars.js";
export { buildOauthProviderAuthResult } from "./provider-auth-result.js";
export {
  buildOpenAICodexCredentialExtra,
  decodeOpenAICodexJwtPayload,
  resolveOpenAICodexAccessTokenExpiry,
  resolveOpenAICodexAuthIdentity,
  resolveOpenAICodexImportProfileName,
  type OpenAICodexAuthIdentity,
} from "./provider-openai-chatgpt-auth.js";
export {
  generateHexPkceVerifierChallenge,
  generatePkceVerifierChallenge,
  toFormUrlEncoded,
} from "./oauth-utils.js";
export {
  DEFAULT_OAUTH_REFRESH_MARGIN_MS,
  hasUsableOAuthCredential,
} from "../agents/auth-profiles/credential-state.js";
export {
  COPILOT_EDITOR_PLUGIN_VERSION,
  COPILOT_EDITOR_VERSION,
  COPILOT_GITHUB_API_VERSION,
  COPILOT_INTEGRATION_ID,
  COPILOT_USER_AGENT,
  buildCopilotIdeHeaders,
} from "../agents/copilot-dynamic-headers.js";

const COPILOT_TOKEN_URL = "https://api.github.com/copilot_internal/v2/token";

/** @deprecated GitHub Copilot provider-owned helper; do not use from third-party plugins. */
export const DEFAULT_COPILOT_API_BASE_URL = "https://api.individual.githubcopilot.com";

/** @deprecated GitHub Copilot provider-owned helper; do not use from third-party plugins. */
export type CachedCopilotToken = {
  /** Copilot API token returned by GitHub's internal exchange endpoint. */
  token: string;
  /** Absolute epoch milliseconds when the Copilot API token expires. */
  expiresAt: number;
  /** Absolute epoch milliseconds when this cache entry was written. */
  updatedAt: number;
  /** Copilot integration id that produced this cached token. */
  integrationId?: string;
};

function resolveCopilotTokenCachePath(env: NodeJS.ProcessEnv = process.env) {
  return path.join(resolveStateDir(env), "credentials", "github-copilot.token.json");
}

function isCopilotTokenUsable(cache: CachedCopilotToken, now = Date.now()): boolean {
  const expiresAt = asDateTimestampMs(cache.expiresAt);
  return (
    cache.integrationId === COPILOT_INTEGRATION_ID &&
    expiresAt !== undefined &&
    expiresAt - now > 5 * 60 * 1000
  );
}

function resolveCopilotTokenExpiresAtMs(expiresAt: unknown): number | undefined {
  const parsed =
    typeof expiresAt === "number" && Number.isFinite(expiresAt)
      ? expiresAt
      : typeof expiresAt === "string" && expiresAt.trim().length > 0
        ? parseStrictNonNegativeInteger(expiresAt)
        : undefined;
  if (parsed === undefined) {
    return undefined;
  }
  return parsed < 100_000_000_000
    ? resolveExpiresAtMsFromEpochSeconds(parsed)
    : asDateTimestampMs(parsed);
}

function parseCopilotTokenResponse(value: unknown): {
  token: string;
  expiresAt: number;
} {
  if (!value || typeof value !== "object") {
    throw new Error("Unexpected response from GitHub Copilot token endpoint");
  }
  const asRecord = value as Record<string, unknown>;
  const token = asRecord.token;
  const expiresAt = asRecord.expires_at;
  if (typeof token !== "string" || token.trim().length === 0) {
    throw new Error("Copilot token response missing token");
  }

  const expiresAtMs = resolveCopilotTokenExpiresAtMs(expiresAt);
  if (
    expiresAt === undefined ||
    expiresAt === null ||
    (typeof expiresAt === "string" && expiresAt.trim().length === 0)
  ) {
    throw new Error("Copilot token response missing expires_at");
  }
  if (expiresAtMs === undefined) {
    throw new Error("Copilot token response has invalid expires_at");
  }

  return { token, expiresAt: expiresAtMs };
}

function resolveCopilotProxyHost(proxyEp: string): string | null {
  const trimmed = proxyEp.trim();
  if (!trimmed) {
    return null;
  }

  const urlText = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  try {
    const url = new URL(urlText);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return null;
    }
    return normalizeLowercaseStringOrEmpty(url.hostname);
  } catch {
    return null;
  }
}

/** @deprecated GitHub Copilot provider-owned helper; do not use from third-party plugins. */
export function deriveCopilotApiBaseUrlFromToken(
  /** Copilot API token text that may contain a `proxy-ep` attribute. */
  token: string,
): string | null {
  const trimmed = token.trim();
  if (!trimmed) {
    return null;
  }

  const match = trimmed.match(/(?:^|;)\s*proxy-ep=([^;\s]+)/i);
  const proxyEp = match?.[1]?.trim();
  if (!proxyEp) {
    return null;
  }

  const proxyHost = resolveCopilotProxyHost(proxyEp);
  if (!proxyHost) {
    return null;
  }
  const host = proxyHost.replace(/^proxy\./i, "api.");

  const baseUrl = `https://${host}`;
  return resolveProviderEndpoint(baseUrl).endpointClass === "invalid" ? null : baseUrl;
}

/**
 * @deprecated GitHub Copilot provider-owned helper; do not use from third-party plugins.
 */
export async function resolveCopilotApiToken(params: {
  /** GitHub OAuth token exchanged for a Copilot API token. */
  githubToken: string;
  /** Environment used to resolve the default token cache path. */
  env?: NodeJS.ProcessEnv;
  /** Fetch implementation used for the Copilot token exchange. */
  fetchImpl?: typeof fetch;
  /** Explicit cache file path for the exchanged Copilot token. */
  cachePath?: string;
  /** Cache reader override for tests and alternate storage backends. */
  loadJsonFileImpl?: (path: string) => unknown;
  /** Cache writer override for tests and alternate storage backends. */
  saveJsonFileImpl?: (path: string, value: CachedCopilotToken) => void;
}): Promise<{
  /** Copilot API token, from cache or fresh exchange. */
  token: string;
  /** Absolute epoch milliseconds when the Copilot API token expires. */
  expiresAt: number;
  /** Source marker identifying cache path or exchange endpoint. */
  source: string;
  /** Copilot API base URL derived from token metadata or default endpoint. */
  baseUrl: string;
}> {
  const env = params.env ?? process.env;
  const cachePath = params.cachePath?.trim() || resolveCopilotTokenCachePath(env);
  const loadJsonFileFn = params.loadJsonFileImpl ?? loadJsonFile;
  const saveJsonFileFn = params.saveJsonFileImpl ?? saveJsonFile;
  const cached = loadJsonFileFn(cachePath) as CachedCopilotToken | undefined;
  if (cached && typeof cached.token === "string" && typeof cached.expiresAt === "number") {
    // Token cache entries are scoped to the current Copilot integration id so
    // stale tokens from older editor identities are exchanged again.
    if (isCopilotTokenUsable(cached)) {
      return {
        token: cached.token,
        expiresAt: cached.expiresAt,
        source: `cache:${cachePath}`,
        baseUrl: deriveCopilotApiBaseUrlFromToken(cached.token) ?? DEFAULT_COPILOT_API_BASE_URL,
      };
    }
  }

  const fetchImpl = params.fetchImpl ?? fetch;
  const res = await fetchImpl(COPILOT_TOKEN_URL, {
    method: "GET",
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${params.githubToken}`,
      "Copilot-Integration-Id": COPILOT_INTEGRATION_ID,
      ...buildCopilotIdeHeaders({ includeApiVersion: true }),
    },
  });

  if (!res.ok) {
    throw new Error(`Copilot token exchange failed: HTTP ${res.status}`);
  }

  const json = parseCopilotTokenResponse(await res.json());
  const payload: CachedCopilotToken = {
    token: json.token,
    expiresAt: json.expiresAt,
    updatedAt: Date.now(),
    integrationId: COPILOT_INTEGRATION_ID,
  };
  saveJsonFileFn(cachePath, payload);

  return {
    token: payload.token,
    expiresAt: payload.expiresAt,
    source: `fetched:${COPILOT_TOKEN_URL}`,
    baseUrl: deriveCopilotApiBaseUrlFromToken(payload.token) ?? DEFAULT_COPILOT_API_BASE_URL,
  };
}

/**
 * Checks whether a provider has either env auth or matching local auth profiles configured.
 */
export function isProviderApiKeyConfigured(params: {
  /** Provider id to check for env auth or local auth profiles. */
  provider: string;
  /** Agent directory containing auth profiles. */
  agentDir?: string;
  /** Optional allowed profile credential types. */
  profileTypes?: readonly AuthProfileCredential["type"][];
}): boolean {
  if (resolveEnvApiKey(params.provider)?.apiKey) {
    return true;
  }
  const agentDir = params.agentDir?.trim();
  if (!agentDir) {
    return false;
  }
  const store = ensureAuthProfileStore(agentDir, {
    allowKeychainPrompt: false,
  });
  const profileIds = listProfilesForProvider(store, params.provider);
  if (!params.profileTypes?.length) {
    return profileIds.length > 0;
  }
  const allowedTypes = new Set(params.profileTypes);
  return profileIds.some((profileId) => {
    const type = store.profiles[profileId]?.type;
    return type !== undefined && allowedTypes.has(type);
  });
}

/**
 * Lists auth profile ids usable for a provider without throwing on missing stores or keychain access.
 */
export function listUsableProviderAuthProfileIds(params: {
  /** Provider id whose usable auth profiles should be listed. */
  provider: string;
  /** Optional runtime config used to resolve auth profile order and default agent dir. */
  cfg?: OpenClawConfig;
  /** Agent directory containing auth profiles. */
  agentDir?: string;
  /** Whether profile store reads may prompt for keychain-backed credentials. */
  allowKeychainPrompt?: boolean;
  /** Whether external CLI auth profiles may be discovered and included. */
  includeExternalCliAuth?: boolean;
}): { agentDir: string; profileIds: string[] } {
  try {
    const { agentDir, profileIds } = resolveUsableProviderAuthProfiles(params);
    return { agentDir, profileIds };
  } catch {
    return { agentDir: "", profileIds: [] };
  }
}

/**
 * Checks whether any usable auth profile exists for a provider.
 */
export function isProviderAuthProfileConfigured(params: {
  /** Provider id to check for usable auth profiles. */
  provider: string;
  /** Optional runtime config used to resolve auth profile order and default agent dir. */
  cfg?: OpenClawConfig;
  /** Agent directory containing auth profiles. */
  agentDir?: string;
  /** Whether profile store reads may prompt for keychain-backed credentials. */
  allowKeychainPrompt?: boolean;
  /** Whether external CLI auth profiles may be discovered and included. */
  includeExternalCliAuth?: boolean;
}): boolean {
  return listUsableProviderAuthProfileIds(params).profileIds.length > 0;
}

/**
 * Resolves the first usable auth-profile API key for a provider in configured profile order.
 */
export async function resolveProviderAuthProfileApiKey(params: {
  /** Provider id whose first usable auth profile should resolve to an API key. */
  provider: string;
  /** Optional runtime config used to resolve auth profile order and secret refs. */
  cfg?: OpenClawConfig;
  /** Agent directory containing auth profiles. */
  agentDir?: string;
  /** Whether profile store reads may prompt for keychain-backed credentials. */
  allowKeychainPrompt?: boolean;
  /** Whether external CLI auth profiles may be discovered and included. */
  includeExternalCliAuth?: boolean;
}): Promise<string | undefined> {
  const { agentDir, profileIds, store } = resolveUsableProviderAuthProfiles(params);
  if (!agentDir || profileIds.length === 0) {
    return undefined;
  }
  for (const profileId of profileIds) {
    const resolved = await resolveApiKeyForProfile({
      cfg: params.cfg,
      store,
      agentDir,
      profileId,
    });
    if (resolved?.apiKey) {
      return resolved.apiKey;
    }
  }
  return undefined;
}

function resolveUsableProviderAuthProfiles(params: {
  provider: string;
  cfg?: OpenClawConfig;
  agentDir?: string;
  allowKeychainPrompt?: boolean;
  includeExternalCliAuth?: boolean;
}): { agentDir: string; profileIds: string[]; store: AuthProfileStore } {
  const agentDir = params.agentDir?.trim() || resolveDefaultAgentDir(params.cfg ?? {});
  const externalCli = params.includeExternalCliAuth
    ? externalCliDiscoveryForProviderAuth({
        cfg: params.cfg,
        provider: params.provider,
        allowKeychainPrompt: params.allowKeychainPrompt,
      })
    : undefined;
  const store = externalCli
    ? loadAuthProfileStoreForSecretsRuntime(agentDir, { externalCli })
    : loadAuthProfileStoreForSecretsRuntime(agentDir);
  const profileIds = resolveAuthProfileOrder({
    cfg: params.cfg,
    store,
    provider: params.provider,
  });
  if (profileIds.length > 0) {
    return { agentDir, profileIds, store };
  }

  const fallbackStore = loadAuthProfileStoreWithoutExternalProfiles(agentDir, {
    allowKeychainPrompt: params.allowKeychainPrompt ?? false,
  });
  return {
    agentDir,
    profileIds: resolveAuthProfileOrder({
      cfg: params.cfg,
      store: fallbackStore,
      provider: params.provider,
    }),
    store: fallbackStore,
  };
}
