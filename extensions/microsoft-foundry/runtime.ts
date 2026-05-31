import type { ProviderPrepareRuntimeAuthContext } from "openclaw/plugin-sdk/core";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import {
  asDateTimestampMs,
  resolveDateTimestampMs,
  resolveExpiresAtMsFromDurationMs,
} from "openclaw/plugin-sdk/number-runtime";
import { ensureAuthProfileStore } from "openclaw/plugin-sdk/provider-auth";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import { getAccessTokenResultAsync } from "./cli.js";
import {
  type CachedTokenEntry,
  TOKEN_REFRESH_MARGIN_MS,
  buildFoundryProviderBaseUrl,
  extractFoundryEndpoint,
  getFoundryTokenCacheKey,
  isFoundryProviderApi,
  resolveConfiguredModelNameHint,
} from "./shared-runtime.js";

const cachedTokens = new Map<string, CachedTokenEntry>();
const refreshPromises = new Map<string, Promise<{ apiKey: string; expiresAt: number }>>();
const FOUNDRY_TOKEN_FALLBACK_LIFETIME_MS = 55 * 60 * 1000;

export function resetFoundryRuntimeAuthCaches(): void {
  cachedTokens.clear();
  refreshPromises.clear();
}

async function refreshEntraToken(params?: {
  subscriptionId?: string;
  tenantId?: string;
}): Promise<{ apiKey: string; expiresAt: number }> {
  const result = await getAccessTokenResultAsync(params);
  const rawExpiry = result.expiresOn ? new Date(result.expiresOn).getTime() : Number.NaN;
  const now = resolveDateTimestampMs(Date.now());
  const expiresAt =
    asDateTimestampMs(rawExpiry) ??
    resolveExpiresAtMsFromDurationMs(FOUNDRY_TOKEN_FALLBACK_LIFETIME_MS, { nowMs: now }) ??
    now;
  cachedTokens.set(getFoundryTokenCacheKey(params), {
    token: result.accessToken,
    expiresAt,
  });
  return { apiKey: result.accessToken, expiresAt };
}

export async function prepareFoundryRuntimeAuth(ctx: ProviderPrepareRuntimeAuthContext) {
  if (ctx.apiKey !== "__entra_id_dynamic__") {
    return null;
  }
  try {
    const authStore = ensureAuthProfileStore(ctx.agentDir, {
      allowKeychainPrompt: false,
    });
    const credential = ctx.profileId ? authStore.profiles[ctx.profileId] : undefined;
    const metadata = credential?.type === "api_key" ? credential.metadata : undefined;
    const modelId =
      normalizeOptionalString(ctx.modelId) ??
      normalizeOptionalString(metadata?.modelId) ??
      ctx.modelId;
    const activeModelNameHint = ctx.modelId === metadata?.modelId ? metadata?.modelName : undefined;
    const modelNameHint = resolveConfiguredModelNameHint(
      modelId,
      ctx.model.name ?? activeModelNameHint,
    );
    const configuredApi =
      typeof metadata?.api === "string" && isFoundryProviderApi(metadata.api)
        ? metadata.api
        : isFoundryProviderApi(ctx.model.api)
          ? ctx.model.api
          : undefined;
    const endpoint =
      normalizeOptionalString(metadata?.endpoint) ??
      extractFoundryEndpoint(ctx.model.baseUrl ?? "");
    const baseUrl = endpoint
      ? buildFoundryProviderBaseUrl(endpoint, modelId, modelNameHint, configuredApi)
      : undefined;
    const cacheKey = getFoundryTokenCacheKey({
      subscriptionId: metadata?.subscriptionId,
      tenantId: metadata?.tenantId,
    });
    const cachedToken = cachedTokens.get(cacheKey);
    const rawNow = Date.now();
    const hasValidClock = asDateTimestampMs(rawNow) !== undefined;
    const now = resolveDateTimestampMs(rawNow);
    const refreshAfterMs =
      resolveExpiresAtMsFromDurationMs(TOKEN_REFRESH_MARGIN_MS, { nowMs: now }) ?? now;
    if (cachedToken && hasValidClock && cachedToken.expiresAt > refreshAfterMs) {
      return {
        apiKey: cachedToken.token,
        expiresAt: cachedToken.expiresAt,
        ...(baseUrl ? { baseUrl } : {}),
      };
    }
    let refreshPromise = refreshPromises.get(cacheKey);
    if (!refreshPromise) {
      refreshPromise = refreshEntraToken({
        subscriptionId: metadata?.subscriptionId,
        tenantId: metadata?.tenantId,
      }).finally(() => {
        refreshPromises.delete(cacheKey);
      });
      refreshPromises.set(cacheKey, refreshPromise);
    }
    const token = await refreshPromise;
    return {
      ...token,
      ...(baseUrl ? { baseUrl } : {}),
    };
  } catch (err) {
    const details = formatErrorMessage(err);
    throw new Error(`Failed to refresh Azure Entra ID token via az CLI: ${details}`, {
      cause: err,
    });
  }
}
