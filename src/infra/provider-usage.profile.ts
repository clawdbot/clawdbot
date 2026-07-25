// Exact-profile, read-only provider usage service for trusted plugin runtimes.
import { normalizeProviderId } from "../agents/model-selection.js";
import { getRuntimeConfig, type OpenClawConfig } from "../config/config.js";
import {
  resolveProviderUsageAuthWithPlugin,
  resolveProviderUsageSnapshotWithPlugin,
} from "../plugins/provider-runtime.js";
import { resolveFetch } from "./fetch.js";
import { resolveProxyFetchFromEnv } from "./net/proxy-fetch.js";
import { resolveProviderAuthProfile } from "./provider-usage.auth.js";
import {
  DEFAULT_TIMEOUT_MS,
  resolveProviderUsageDisplayName,
  resolveUsageProviderId,
  withTimeout,
} from "./provider-usage.shared.js";
import type {
  ProviderUsageBilling,
  ProviderUsageCostHistory,
  ProviderUsageProfileReadParams,
  ProviderUsageProfileSnapshot,
  ProviderUsageSnapshot,
  UsageWindow,
} from "./provider-usage.types.js";

const MAX_PROFILE_USAGE_TIMEOUT_MS = 60_000;

type ProviderUsageProfileReadOptions = {
  agentDir?: string;
  workspaceDir?: string;
  config?: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  fetch?: typeof fetch;
};

function normalizeReadTimeout(timeoutMs: number | undefined): number {
  const value = timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isInteger(value) || value <= 0 || value > MAX_PROFILE_USAGE_TIMEOUT_MS) {
    throw new TypeError(
      `provider usage timeoutMs must be an integer between 1 and ${MAX_PROFILE_USAGE_TIMEOUT_MS}`,
    );
  }
  return value;
}

function cloneWindows(windows: UsageWindow[]): UsageWindow[] {
  return windows.map((window) => ({
    label: window.label,
    usedPercent: window.usedPercent,
    ...(window.resetAt !== undefined ? { resetAt: window.resetAt } : {}),
  }));
}

function cloneBilling(
  billing: ProviderUsageBilling[] | undefined,
): ProviderUsageBilling[] | undefined {
  if (!billing) {
    return undefined;
  }
  return billing.map((entry) => {
    const label = entry.label !== undefined ? { label: entry.label } : {};
    if (entry.type === "balance") {
      return {
        type: "balance",
        ...label,
        amount: entry.amount,
        unit: entry.unit,
      };
    }
    const period = entry.period !== undefined ? { period: entry.period } : {};
    const resetAt = entry.resetAt !== undefined ? { resetAt: entry.resetAt } : {};
    if (entry.type === "spend") {
      return {
        type: "spend",
        ...label,
        amount: entry.amount,
        unit: entry.unit,
        ...period,
        ...resetAt,
      };
    }
    return {
      type: "budget",
      ...label,
      used: entry.used,
      limit: entry.limit,
      unit: entry.unit,
      ...period,
      ...resetAt,
    };
  });
}

function cloneCostHistory(
  history: ProviderUsageCostHistory | undefined,
): ProviderUsageCostHistory | undefined {
  if (!history) {
    return undefined;
  }
  return {
    unit: history.unit,
    periodDays: history.periodDays,
    ...(history.scope !== undefined ? { scope: history.scope } : {}),
    daily: history.daily.map((entry) => ({
      date: entry.date,
      amount: entry.amount,
      ...(entry.requests !== undefined ? { requests: entry.requests } : {}),
      inputTokens: entry.inputTokens,
      cacheReadTokens: entry.cacheReadTokens,
      cacheWriteTokens: entry.cacheWriteTokens,
      outputTokens: entry.outputTokens,
      totalTokens: entry.totalTokens,
    })),
    models: history.models.map((entry) => ({
      name: entry.name,
      ...(entry.requests !== undefined ? { requests: entry.requests } : {}),
      inputTokens: entry.inputTokens,
      cacheReadTokens: entry.cacheReadTokens,
      cacheWriteTokens: entry.cacheWriteTokens,
      outputTokens: entry.outputTokens,
      totalTokens: entry.totalTokens,
    })),
    categories: history.categories.map((entry) => ({
      name: entry.name,
      amount: entry.amount,
    })),
  };
}

function sanitizeProfileSnapshot(params: {
  snapshot: ProviderUsageSnapshot;
  provider: string;
  authProfileId: string;
  capturedAt: number;
}): ProviderUsageProfileSnapshot {
  const billing = cloneBilling(params.snapshot.billing);
  const costHistory = cloneCostHistory(params.snapshot.costHistory);
  return {
    provider: params.provider,
    authProfileId: params.authProfileId,
    capturedAt: params.capturedAt,
    displayName: params.snapshot.displayName,
    windows: cloneWindows(params.snapshot.windows),
    ...(billing ? { billing } : {}),
    ...(costHistory ? { costHistory } : {}),
    ...(params.snapshot.summary !== undefined ? { summary: params.snapshot.summary } : {}),
    ...(params.snapshot.plan !== undefined ? { plan: params.snapshot.plan } : {}),
    ...(params.snapshot.error !== undefined ? { error: params.snapshot.error } : {}),
  };
}

/** Read one exact auth profile without credential refresh, fallback, or identity output. */
export async function readProviderUsageProfile(
  params: ProviderUsageProfileReadParams,
  options: ProviderUsageProfileReadOptions = {},
): Promise<ProviderUsageProfileSnapshot> {
  const includeIdentity = (params as { includeIdentity?: unknown }).includeIdentity;
  if (includeIdentity !== undefined && includeIdentity !== false) {
    throw new TypeError("provider usage identity inclusion is not supported");
  }
  const refreshCredentials = (params as { refreshCredentials?: unknown }).refreshCredentials;
  if (refreshCredentials !== undefined && refreshCredentials !== false) {
    throw new TypeError("provider usage credential refresh is not supported");
  }
  if (typeof params.providerId !== "string") {
    throw new TypeError("provider usage providerId must be a string");
  }
  if (typeof params.authProfileId !== "string") {
    throw new TypeError("provider usage authProfileId must be a string");
  }

  const normalizedProvider = normalizeProviderId(params.providerId);
  const provider = resolveUsageProviderId(normalizedProvider) ?? normalizedProvider;
  const authProfileId = params.authProfileId.trim();
  if (!provider) {
    throw new TypeError("provider usage providerId must not be empty");
  }
  if (!authProfileId || authProfileId !== params.authProfileId) {
    throw new TypeError("provider usage authProfileId must be a canonical non-empty string");
  }

  const timeoutMs = normalizeReadTimeout(params.timeoutMs);
  const config = options.config ?? getRuntimeConfig();
  const env = options.env ?? process.env;
  const fetchFn = options.fetch
    ? resolveFetch(options.fetch)
    : (resolveProxyFetchFromEnv(env) ?? resolveFetch());
  if (!fetchFn) {
    throw new Error("fetch is not available");
  }

  const auth = await resolveProviderAuthProfile({
    provider,
    authProfileId,
    agentDir: options.agentDir,
    config,
  });
  if (!auth) {
    throw new Error("provider usage auth profile unavailable");
  }

  const failureSnapshot = (error: string): ProviderUsageSnapshot => ({
    provider,
    displayName: resolveProviderUsageDisplayName(provider),
    windows: [],
    error,
  });
  const exactUsageToken = {
    token: auth.token,
    ...(auth.accountId ? { accountId: auth.accountId } : {}),
    ...(auth.subscriptionType ? { subscriptionType: auth.subscriptionType } : {}),
    ...(auth.rateLimitTier ? { rateLimitTier: auth.rateLimitTier } : {}),
    ...(auth.email ? { email: auth.email } : {}),
  };
  const isApiKeyCredential = auth.credentialType === "api_key" || auth.credentialType === "token";
  const isOAuthCredential = auth.credentialType === "oauth" || auth.credentialType === "token";
  const matchesExactProvider = (providerIds: string[] | undefined): boolean =>
    providerIds === undefined ||
    providerIds.some((providerId) => {
      const normalized = normalizeProviderId(providerId);
      return (resolveUsageProviderId(normalized) ?? normalized) === provider;
    });
  const snapshot = await withTimeout(
    (async () => {
      const providerAuth = await resolveProviderUsageAuthWithPlugin({
        provider,
        config,
        workspaceDir: options.workspaceDir,
        env,
        context: {
          config,
          agentDir: options.agentDir,
          workspaceDir: options.workspaceDir,
          // Exact-profile reads must not let provider auth policy switch to an
          // ambient credential. Only the scoped resolver callbacks below can
          // return secret material.
          env: {},
          provider,
          resolveApiKeyFromConfigAndStore: (request) =>
            isApiKeyCredential && matchesExactProvider(request?.providerIds)
              ? auth.token
              : undefined,
          resolveApiKeyCandidatesFromConfigAndStore: async (request) =>
            isApiKeyCredential && matchesExactProvider(request?.providerIds) ? [auth.token] : [],
          resolveOAuthToken: async (request) => {
            if (!isOAuthCredential) {
              return null;
            }
            if (request?.provider) {
              const normalizedRequestedProvider = normalizeProviderId(request.provider);
              const requestedProvider =
                resolveUsageProviderId(normalizedRequestedProvider, {
                  credentialType: auth.credentialType,
                }) ?? normalizedRequestedProvider;
              if (requestedProvider !== provider) {
                return null;
              }
            }
            return exactUsageToken;
          },
        },
      });
      if (providerAuth && "handled" in providerAuth) {
        return failureSnapshot("Provider usage auth unavailable");
      }
      const fetchAuth = providerAuth ?? exactUsageToken;
      const value = await resolveProviderUsageSnapshotWithPlugin({
        provider,
        config,
        workspaceDir: options.workspaceDir,
        env,
        context: {
          config,
          agentDir: options.agentDir,
          workspaceDir: options.workspaceDir,
          env,
          provider,
          token: fetchAuth.token,
          accountId: fetchAuth.accountId,
          authProfileId,
          subscriptionType: fetchAuth.subscriptionType,
          rateLimitTier: fetchAuth.rateLimitTier,
          email: fetchAuth.email,
          timeoutMs,
          fetchFn,
        },
      });
      return value ?? failureSnapshot("Unsupported provider");
    })(),
    timeoutMs + 1_000,
    failureSnapshot("Timeout"),
  ).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    return failureSnapshot(message.trim() || "Fetch failed");
  });

  if (normalizeProviderId(snapshot.provider) !== provider) {
    throw new Error("provider usage snapshot provider mismatch");
  }
  return sanitizeProfileSnapshot({
    snapshot,
    provider,
    authProfileId,
    capturedAt: Date.now(),
  });
}
