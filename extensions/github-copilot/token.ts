// GitHub Copilot credential exchange and cache policy.
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  asDateTimestampMs,
  parseStrictNonNegativeInteger,
  resolveExpiresAtMsFromEpochSeconds,
} from "openclaw/plugin-sdk/number-runtime";
import type { PluginStateSyncKeyedStore } from "openclaw/plugin-sdk/plugin-state-runtime";
import {
  buildCopilotIdeHeaders,
  COPILOT_INTEGRATION_ID,
  deriveCopilotApiBaseUrlFromToken,
} from "openclaw/plugin-sdk/provider-auth";
import { readProviderJsonResponse } from "openclaw/plugin-sdk/provider-http";
import { PUBLIC_GITHUB_COPILOT_DOMAIN, resolveGithubCopilotDomain } from "./domain.js";
import {
  fingerprintCopilotSourceCredential,
  isCopilotTokenUsable,
  resolveCopilotTokenCache,
  type CachedCopilotToken,
} from "./token-cache.js";
import { CopilotTokenExchangeError } from "./token-exchange-error.js";
export const DEFAULT_COPILOT_API_BASE_URL = "https://api.individual.githubcopilot.com";
const COPILOT_TOKEN_EXCHANGE_TIMEOUT_MS = 30_000;
let openConfiguredCacheStore: (() => PluginStateSyncKeyedStore<CachedCopilotToken>) | undefined;

/** Bind provider-scoped SQLite state when the bundled plugin registers. */
export function configureCopilotTokenCacheStore(
  openCacheStore: () => PluginStateSyncKeyedStore<CachedCopilotToken>,
): void {
  openConfiguredCacheStore = openCacheStore;
}

function copilotTokenUrl(domain: string): string {
  return `https://api.${domain}/copilot_internal/v2/token`;
}

function copilotApiBaseFallback(domain: string): string {
  return domain === PUBLIC_GITHUB_COPILOT_DOMAIN
    ? DEFAULT_COPILOT_API_BASE_URL
    : `https://copilot-api.${domain}`;
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

function parseCopilotTokenResponse(value: unknown): { token: string; expiresAt: number } {
  if (!value || typeof value !== "object") {
    throw new Error("Unexpected response from GitHub Copilot token endpoint");
  }
  const record = value as Record<string, unknown>;
  const { token: credential, expires_at: expiresAt } = record;
  if (typeof credential !== "string" || credential.trim().length === 0) {
    throw new Error("Copilot token response missing token");
  }
  if (
    expiresAt === undefined ||
    expiresAt === null ||
    (typeof expiresAt === "string" && expiresAt.trim().length === 0)
  ) {
    throw new Error("Copilot token response missing expires_at");
  }
  const expiresAtMs = resolveCopilotTokenExpiresAtMs(expiresAt);
  if (expiresAtMs === undefined) {
    throw new Error("Copilot token response has invalid expires_at");
  }
  return { token: credential, expiresAt: expiresAtMs };
}

async function cancelUnreadResponseBody(response: Response): Promise<void> {
  if (!response.bodyUsed) {
    await response.body?.cancel().catch(() => undefined);
  }
}

export async function resolveCopilotApiToken(params: {
  githubToken: string;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  cachePath?: string;
  loadJsonFileImpl?: (path: string) => unknown;
  saveJsonFileImpl?: (path: string, value: CachedCopilotToken) => void;
  openCacheStore?: () => PluginStateSyncKeyedStore<CachedCopilotToken>;
  githubDomain?: string;
  config?: OpenClawConfig;
}): Promise<{
  token: string;
  expiresAt: number;
  source: string;
  baseUrl: string;
}> {
  const env = params.env ?? process.env;
  const domain = resolveGithubCopilotDomain({
    env,
    explicit: params.githubDomain,
    config: params.config,
  });
  const tokenUrl = copilotTokenUrl(domain);
  const apiBaseFallback = copilotApiBaseFallback(domain);
  const sourceCredentialFingerprint = fingerprintCopilotSourceCredential(params.githubToken);
  const cache = resolveCopilotTokenCache({
    domain,
    sourceCredentialFingerprint,
    ...(params.openCacheStore || openConfiguredCacheStore
      ? { openCacheStore: params.openCacheStore ?? openConfiguredCacheStore }
      : {}),
    ...(params.cachePath !== undefined ? { cachePath: params.cachePath } : {}),
    ...(params.loadJsonFileImpl ? { loadJsonFileImpl: params.loadJsonFileImpl } : {}),
    ...(params.saveJsonFileImpl ? { saveJsonFileImpl: params.saveJsonFileImpl } : {}),
  });
  const cached = cache.load();
  if (
    cached &&
    typeof cached.token === "string" &&
    typeof cached.expiresAt === "number" &&
    isCopilotTokenUsable({ cache: cached, domain, sourceCredentialFingerprint })
  ) {
    const { token: credential } = cached;
    return {
      token: credential,
      expiresAt: cached.expiresAt,
      source: `cache:${cache.path}`,
      baseUrl: deriveCopilotApiBaseUrlFromToken(cached.token) ?? apiBaseFallback,
    };
  }

  const fetchImpl = params.fetchImpl ?? fetch;
  const signal = AbortSignal.timeout(COPILOT_TOKEN_EXCHANGE_TIMEOUT_MS);
  let payload: ReturnType<typeof parseCopilotTokenResponse>;
  try {
    const response = await fetchImpl(tokenUrl, {
      method: "GET",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${params.githubToken}`,
        "Copilot-Integration-Id": COPILOT_INTEGRATION_ID,
        ...buildCopilotIdeHeaders({ includeApiVersion: true }),
      },
      signal,
    });
    if (!response.ok) {
      await cancelUnreadResponseBody(response);
      throw new CopilotTokenExchangeError({ reason: "http_error", status: response.status });
    }
    payload = parseCopilotTokenResponse(
      await readProviderJsonResponse(response, "github-copilot.token"),
    );
  } catch (error) {
    if (signal.aborted && error === signal.reason) {
      throw new CopilotTokenExchangeError({
        reason: "timeout",
        timeoutMs: COPILOT_TOKEN_EXCHANGE_TIMEOUT_MS,
        cause: error,
      });
    }
    throw error;
  }

  const cachedPayload: CachedCopilotToken = {
    token: payload.token,
    expiresAt: payload.expiresAt,
    updatedAt: Date.now(),
    integrationId: COPILOT_INTEGRATION_ID,
    sourceCredentialFingerprint,
    domain,
  };
  cache.save(cachedPayload);
  const { token: credential } = cachedPayload;
  return {
    token: credential,
    expiresAt: cachedPayload.expiresAt,
    source: `fetched:${tokenUrl}`,
    baseUrl: deriveCopilotApiBaseUrlFromToken(cachedPayload.token) ?? apiBaseFallback,
  };
}
