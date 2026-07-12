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
import { readProviderJsonResponse } from "../agents/provider-http-errors.js";
import type { OpenClawConfig } from "../config/config.js";
import { resolveStateDir } from "../config/paths.js";
import { loadJsonFile, saveJsonFile } from "../infra/json-file.js";
import { logWarn } from "../logger.js";
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

/** @deprecated GitHub Copilot provider-owned helper; do not use from third-party plugins. */
export const DEFAULT_COPILOT_API_BASE_URL = "https://api.individual.githubcopilot.com";

/**
 * Data-residency GitHub Enterprise (`*.ghe.com`) support.
 *
 * Copilot on a data-residency GHE tenant lives at `<domain>` / `api.<domain>` /
 * `copilot-api.<domain>` rather than the public github.com endpoints. The host
 * is resolved (in priority order) from the `COPILOT_GITHUB_DOMAIN` env override,
 * the persisted `models.providers.github-copilot.params.githubDomain` config, and
 * finally public `github.com`.
 */
const COPILOT_PROVIDER_ID = "github-copilot";

const DEFAULT_GITHUB_COPILOT_DOMAIN = "github.com";
const COPILOT_TOKEN_EXCHANGE_TIMEOUT_MS = 30_000;

// Matches a data-residency GHE tenant root (`<tenant>.ghe.com`, single label).
// GitHub defines a GHE.com enterprise as a dedicated `SUBDOMAIN.ghe.com` domain;
// nested hosts (`api.<tenant>.ghe.com`, `copilot-api.<tenant>.ghe.com`) are
// derived service endpoints, not tenants — accepting one would template broken
// hosts like `api.api.<tenant>.ghe.com` for the token exchange. Bare `ghe.com`
// is likewise excluded: it is not a tenant and hosts no Copilot endpoint.
const GHE_DATA_RESIDENCY_HOST = /^[a-z0-9-]+\.ghe\.com$/;

/**
 * Coerce a user/config-supplied GitHub host to a safe bare lowercase hostname.
 *
 * Fails closed to public `github.com`: only the public host and data-residency
 * GHE tenants (`*.ghe.com`) are trusted. Any other value falls back to the
 * default rather than being used verbatim, because the resolved host becomes the
 * `api.<host>` endpoint that receives the GitHub OAuth token during exchange — a
 * typo or injected value like `evil.com` must never redirect that token.
 * (Classic self-hosted GHE Server uses arbitrary hostnames but does not host
 * Copilot, so it is deliberately out of scope.)
 */
export function normalizeGithubCopilotDomain(raw: string | undefined | null): string {
  const trimmed = (raw ?? "").trim().toLowerCase();
  if (!trimmed) {
    return DEFAULT_GITHUB_COPILOT_DOMAIN;
  }
  // Reject scheme/path/credentials so template URL construction cannot be hijacked.
  if (!/^[a-z0-9.-]+$/.test(trimmed)) {
    return DEFAULT_GITHUB_COPILOT_DOMAIN;
  }
  if (trimmed === DEFAULT_GITHUB_COPILOT_DOMAIN || GHE_DATA_RESIDENCY_HOST.test(trimmed)) {
    return trimmed;
  }
  return DEFAULT_GITHUB_COPILOT_DOMAIN;
}

function readGithubCopilotDomainFromConfig(config?: OpenClawConfig): string | undefined {
  const params = config?.models?.providers?.[COPILOT_PROVIDER_ID]?.params;
  const value = params && typeof params === "object" ? params.githubDomain : undefined;
  if (typeof value !== "string" || value.trim().length === 0) {
    return undefined;
  }
  const trimmed = value.trim();
  warnOnceOnRejectedConfigDomain(trimmed);
  return trimmed;
}

// Configured `githubDomain` values that fail the allowlist fall back to public
// github.com (fail-closed for the token). That silent fallback turns a typo like
// `acme.ghe.co` into an opaque 401 (tenant token vs public endpoint), so warn the
// user loudly — once per distinct bad value — that their config was ignored.
const warnedRejectedConfigDomains = new Set<string>();
function warnOnceOnRejectedConfigDomain(configured: string): void {
  const lowered = configured.toLowerCase();
  if (lowered === DEFAULT_GITHUB_COPILOT_DOMAIN) {
    return;
  }
  if (normalizeGithubCopilotDomain(configured) !== DEFAULT_GITHUB_COPILOT_DOMAIN) {
    return;
  }
  if (warnedRejectedConfigDomains.has(lowered)) {
    return;
  }
  warnedRejectedConfigDomains.add(lowered);
  logWarn(
    `Ignoring configured GitHub Copilot domain "${configured}": only github.com and *.ghe.com tenants are accepted. Falling back to github.com.`,
  );
}

// Provider-internal host resolver (env > explicit caller value > persisted
// config), always passed through the fail-closed allowlist. Not exported: the
// provider extension owns its own copy so the SDK surface stays minimal.
function resolveGithubCopilotDomain(params?: {
  env?: NodeJS.ProcessEnv;
  explicit?: string;
  config?: OpenClawConfig;
}): string {
  const env = params?.env ?? process.env;
  const fromEnv = env.COPILOT_GITHUB_DOMAIN?.trim();
  if (fromEnv) {
    return normalizeGithubCopilotDomain(fromEnv);
  }
  if (params?.explicit) {
    return normalizeGithubCopilotDomain(params.explicit);
  }
  return normalizeGithubCopilotDomain(readGithubCopilotDomainFromConfig(params?.config));
}

/**
 * Data-residency GHE Copilot tokens carry no `proxy-ep`, so the completions base
 * URL cannot be derived from the token. Point it at the tenant Copilot proxy
 * (`copilot-api.<domain>`) instead of the public individual endpoint.
 */
function copilotTokenUrl(domain: string): string {
  return `https://api.${domain}/copilot_internal/v2/token`;
}

function copilotApiBaseFallback(domain: string): string {
  return domain === DEFAULT_GITHUB_COPILOT_DOMAIN
    ? DEFAULT_COPILOT_API_BASE_URL
    : `https://copilot-api.${domain}`;
}

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
  /**
   * GitHub host this token was minted for. Guards against reusing a public
   * `github.com` Copilot token against a `*.ghe.com` tenant host (or vice
   * versa) after a domain switch. Shipped caches predate this field and were
   * only ever minted for public github.com, so a missing value means
   * `github.com` (keeps valid public entries usable across upgrade).
   */
  domain?: string;
};

function resolveCopilotTokenCachePath(env: NodeJS.ProcessEnv = process.env) {
  return path.join(resolveStateDir(env), "credentials", "github-copilot.token.json");
}

function isCopilotTokenUsable(
  cache: CachedCopilotToken,
  domain: string,
  now = Date.now(),
): boolean {
  const expiresAt = asDateTimestampMs(cache.expiresAt);
  // Legacy entries (pre domain-stamp) could only have been minted for public
  // github.com; defaulting keeps them usable across upgrade while tenant
  // requests still force a re-exchange.
  const cacheDomain = cache.domain ?? DEFAULT_GITHUB_COPILOT_DOMAIN;
  return (
    cache.integrationId === COPILOT_INTEGRATION_ID &&
    cacheDomain === domain &&
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

async function cancelUnreadResponseBody(response: Response): Promise<void> {
  if (!response.bodyUsed) {
    await response.body?.cancel().catch(() => undefined);
  }
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
  /**
   * Data-residency GitHub Enterprise host (e.g. `acme.ghe.com`). Resolved from
   * config by callers that have it; the `COPILOT_GITHUB_DOMAIN` env override
   * still wins. Defaults to `github.com`.
   */
  githubDomain?: string;
  /**
   * OpenClaw config used to resolve the persisted `githubDomain` provider
   * param when an explicit `githubDomain` is not supplied. Precedence is
   * `COPILOT_GITHUB_DOMAIN` env > explicit `githubDomain` > config.
   */
  config?: OpenClawConfig;
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
  const domain = resolveGithubCopilotDomain({
    env,
    explicit: params.githubDomain,
    config: params.config,
  });
  const cachePath = params.cachePath?.trim() || resolveCopilotTokenCachePath(env);
  const tokenUrl = copilotTokenUrl(domain);
  const apiBaseFallback = copilotApiBaseFallback(domain);
  const loadJsonFileFn = params.loadJsonFileImpl ?? loadJsonFile;
  const saveJsonFileFn = params.saveJsonFileImpl ?? saveJsonFile;
  const cached = loadJsonFileFn(cachePath) as CachedCopilotToken | undefined;
  if (cached && typeof cached.token === "string" && typeof cached.expiresAt === "number") {
    // Token cache entries are scoped to the current Copilot integration id and
    // GitHub host so stale tokens from older editor identities or a different
    // domain are exchanged again.
    if (isCopilotTokenUsable(cached, domain)) {
      return {
        token: cached.token,
        expiresAt: cached.expiresAt,
        source: `cache:${cachePath}`,
        baseUrl: deriveCopilotApiBaseUrlFromToken(cached.token) ?? apiBaseFallback,
      };
    }
  }

  const fetchImpl = params.fetchImpl ?? fetch;
  const signal = AbortSignal.timeout(COPILOT_TOKEN_EXCHANGE_TIMEOUT_MS);
  let json: ReturnType<typeof parseCopilotTokenResponse>;
  try {
    const res = await fetchImpl(tokenUrl, {
      method: "GET",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${params.githubToken}`,
        "Copilot-Integration-Id": COPILOT_INTEGRATION_ID,
        ...buildCopilotIdeHeaders({ includeApiVersion: true }),
      },
      signal,
    });

    if (!res.ok) {
      await cancelUnreadResponseBody(res);
      throw new Error(`Copilot token exchange failed: HTTP ${res.status}`);
    }

    json = parseCopilotTokenResponse(await readProviderJsonResponse(res, "github-copilot.token"));
  } catch (error) {
    // Normalize only the deadline owned by this exchange. Callers still need
    // transport aborts and provider failures unchanged for correct recovery.
    if (signal.aborted && error === signal.reason) {
      throw new Error(
        `Copilot token exchange failed: timed out after ${COPILOT_TOKEN_EXCHANGE_TIMEOUT_MS}ms`,
        { cause: error },
      );
    }
    throw error;
  }
  const payload: CachedCopilotToken = {
    token: json.token,
    expiresAt: json.expiresAt,
    updatedAt: Date.now(),
    integrationId: COPILOT_INTEGRATION_ID,
    domain,
  };
  saveJsonFileFn(cachePath, payload);

  return {
    token: payload.token,
    expiresAt: payload.expiresAt,
    source: `fetched:${tokenUrl}`,
    baseUrl: deriveCopilotApiBaseUrlFromToken(payload.token) ?? apiBaseFallback,
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
  /** Optional allowed profile credential types. */
  profileTypes?: readonly AuthProfileCredential["type"][];
  /** Whether profile store reads may prompt for keychain-backed credentials. */
  allowKeychainPrompt?: boolean;
  /** Whether external CLI auth profiles may be discovered and included. */
  includeExternalCliAuth?: boolean;
}): { agentDir: string; profileIds: string[] } {
  try {
    const { agentDir, profileIds, store } = resolveUsableProviderAuthProfiles(params);
    return { agentDir, profileIds: filterAuthProfileIdsByType(store, profileIds, params) };
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
  /** Optional allowed profile credential types. */
  profileTypes?: readonly AuthProfileCredential["type"][];
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
  /** Optional allowed profile credential types. */
  profileTypes?: readonly AuthProfileCredential["type"][];
  /** Whether profile store reads may prompt for keychain-backed credentials. */
  allowKeychainPrompt?: boolean;
  /** Whether external CLI auth profiles may be discovered and included. */
  includeExternalCliAuth?: boolean;
}): Promise<string | undefined> {
  const { agentDir, profileIds, store } = resolveUsableProviderAuthProfiles(params);
  if (!agentDir || profileIds.length === 0) {
    return undefined;
  }
  for (const profileId of filterAuthProfileIdsByType(store, profileIds, params)) {
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

function filterAuthProfileIdsByType(
  store: AuthProfileStore,
  profileIds: readonly string[],
  params: { profileTypes?: readonly AuthProfileCredential["type"][] },
): string[] {
  if (!params.profileTypes?.length) {
    return [...profileIds];
  }
  const allowedTypes = new Set(params.profileTypes);
  return profileIds.filter((profileId) => {
    const type = store.profiles[profileId]?.type;
    return type !== undefined && allowedTypes.has(type);
  });
}
