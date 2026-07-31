// Loads provider usage snapshots from built-in and plugin providers.
import { getRuntimeConfig, type OpenClawConfig } from "../config/config.js";
import {
  listProviderUsagePluginDescriptors,
  resolveProviderUsageSnapshotWithPlugin,
  type ProviderUsagePluginDescriptor,
} from "../plugins/provider-runtime.js";
import { resolveFetch } from "./fetch.js";
import { resolveProxyFetchFromEnv } from "./net/proxy-fetch.js";
import { type ProviderAuth, resolveProviderAuths } from "./provider-usage.auth.js";
import {
  DEFAULT_TIMEOUT_MS,
  ignoredErrors,
  resolveProviderUsageDisplayName,
  withTimeout,
} from "./provider-usage.shared.js";
import type {
  ProviderUsageSnapshot,
  UsageProviderId,
  UsageSummary,
} from "./provider-usage.types.js";

// Built-in fallback intentionally reports unsupported until a plugin supplies usage behavior.
async function fetchProviderUsageSnapshotFallback(params: {
  auth: ProviderAuth;
  timeoutMs: number;
  fetchFn: typeof fetch;
}): Promise<ProviderUsageSnapshot> {
  void params.timeoutMs;
  void params.fetchFn;
  return {
    provider: params.auth.provider,
    displayName: resolveProviderUsageDisplayName(params.auth.provider),
    windows: [],
    error: "Unsupported provider",
  };
}

type UsageSummaryOptions = {
  now?: number;
  timeoutMs?: number;
  providers?: UsageProviderId[];
  auth?: ProviderAuth[];
  agentDir?: string;
  workspaceDir?: string;
  config?: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  fetch?: typeof fetch;
  skipPluginAuthWithoutCredentialSource?: boolean;
};

async function fetchProviderUsageSnapshot(params: {
  auth: ProviderAuth;
  config: OpenClawConfig;
  env: NodeJS.ProcessEnv;
  agentDir?: string;
  workspaceDir?: string;
  timeoutMs: number;
  fetchFn: typeof fetch;
}): Promise<ProviderUsageSnapshot> {
  const pluginSnapshot = await resolveProviderUsageSnapshotWithPlugin({
    provider: params.auth.hookProvider ?? params.auth.provider,
    config: params.config,
    workspaceDir: params.workspaceDir,
    env: params.env,
    context: {
      config: params.config,
      agentDir: params.agentDir,
      workspaceDir: params.workspaceDir,
      env: params.env,
      provider: params.auth.provider,
      token: params.auth.token,
      accountId: params.auth.accountId,
      authProfileId: params.auth.authProfileId,
      subscriptionType: params.auth.subscriptionType,
      rateLimitTier: params.auth.rateLimitTier,
      email: params.auth.email,
      timeoutMs: params.timeoutMs,
      fetchFn: params.fetchFn,
    },
  });
  if (pluginSnapshot) {
    return pluginSnapshot;
  }
  return await fetchProviderUsageSnapshotFallback({
    auth: params.auth,
    timeoutMs: params.timeoutMs,
    fetchFn: params.fetchFn,
  });
}

/** Loads usage snapshots from configured provider auth and plugin-backed usage hooks. */
export async function loadProviderUsageSummary(
  opts: UsageSummaryOptions = {},
): Promise<UsageSummary> {
  const now = opts.now ?? Date.now();
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const config = opts.config ?? getRuntimeConfig();
  const env = opts.env ?? process.env;
  const fetchFn = opts.fetch
    ? resolveFetch(opts.fetch)
    : (resolveProxyFetchFromEnv(env) ?? resolveFetch());
  if (!fetchFn) {
    throw new Error("fetch is not available");
  }

  const descriptors: ProviderUsagePluginDescriptor[] = opts.providers
    ? opts.providers.map((provider) => ({
        provider,
        displayName: resolveProviderUsageDisplayName(provider),
      }))
    : opts.auth
      ? opts.auth.map((auth) => ({
          provider: auth.provider,
          displayName: resolveProviderUsageDisplayName(auth.provider),
        }))
      : listProviderUsagePluginDescriptors({
          config,
          workspaceDir: opts.workspaceDir,
          env,
        });
  const displayNames = new Map(
    descriptors.map((descriptor) => [descriptor.provider, descriptor.displayName]),
  );
  const auths = await resolveProviderAuths({
    providers: descriptors.map((descriptor) => descriptor.provider),
    auth: opts.auth,
    agentDir: opts.agentDir,
    config,
    env,
    skipPluginAuthWithoutCredentialSource: opts.skipPluginAuthWithoutCredentialSource,
  });
  if (auths.length === 0) {
    return { updatedAt: now, providers: [] };
  }

  const tasks = auths.map((auth) => {
    const failureSnapshot = (error: string): ProviderUsageSnapshot => ({
      provider: auth.provider,
      displayName:
        displayNames.get(auth.provider) ?? resolveProviderUsageDisplayName(auth.provider),
      windows: [],
      error,
    });
    return withTimeout(
      fetchProviderUsageSnapshot({
        auth,
        config,
        env,
        agentDir: opts.agentDir,
        workspaceDir: opts.workspaceDir,
        timeoutMs,
        fetchFn,
      }),
      timeoutMs + 1000,
      {
        provider: auth.provider,
        displayName:
          displayNames.get(auth.provider) ?? resolveProviderUsageDisplayName(auth.provider),
        windows: [],
        error: "Timeout",
      },
    ).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      return failureSnapshot(message.trim() || "Fetch failed");
    });
  });

  const snapshots = await Promise.all(tasks);
  const providers = snapshots.filter((entry) => {
    if (entry.windows.length > 0) {
      return true;
    }
    if (entry.billing && entry.billing.length > 0) {
      return true;
    }
    if (entry.costHistory?.daily.length) {
      return true;
    }
    if (entry.summary?.trim()) {
      return true;
    }
    if (!entry.error) {
      return true;
    }
    return !ignoredErrors.has(entry.error);
  });

  return { updatedAt: now, providers };
}
