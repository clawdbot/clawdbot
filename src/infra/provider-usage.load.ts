// Loads provider usage snapshots from built-in and plugin providers.
import pLimit from "p-limit";
import { ensureAuthProfileStore, type AuthProfileStore } from "../agents/auth-profiles.js";
import { getRuntimeConfig, type OpenClawConfig } from "../config/config.js";
import {
  listProviderUsagePluginDescriptors,
  resolveProviderUsageSnapshotWithPlugin,
  type ProviderUsagePluginDescriptor,
} from "../plugins/provider-runtime.js";
import { trackAsyncWork } from "../shared/async-work-scope.js";
import { formatErrorMessage } from "./errors.js";
import { resolveFetch } from "./fetch.js";
import { resolveProxyFetchFromEnv } from "./net/proxy-fetch.js";
import {
  type ProviderAuth,
  resolveProviderAuths,
  resolveProviderProfileUsageAuth,
} from "./provider-usage.auth.js";
import {
  PROVIDER_USAGE_TIMEOUT_MS,
  ignoredErrors,
  providerUsageLabel,
  raceUsageTimeout,
} from "./provider-usage.shared.js";
import type {
  ProviderUsageSnapshot,
  UsageProviderId,
  UsageSummary,
} from "./provider-usage.types.js";

const PROFILE_USAGE_REFRESH_CONCURRENCY = 3;
const profileUsageRefreshLimit = pLimit(PROFILE_USAGE_REFRESH_CONCURRENCY);
let profileUsageRefreshProgress = 0;

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
    displayName: providerUsageLabel(params.auth.provider) ?? params.auth.provider,
    windows: [],
    error: "Unsupported provider",
  };
}

type UsageSummaryOptions = {
  now?: number;
  timeoutMs?: number;
  providers?: UsageProviderId[];
  auth?: ProviderAuth[];
  providerOnly?: boolean;
  authProfile?: { provider: UsageProviderId; profileId: string };
  /** Closure-bound cache ownership check, evaluated immediately before provider I/O. */
  isAuthProfileCurrent?: () => boolean;
  authStore?: AuthProfileStore;
  agentDir?: string;
  workspaceDir?: string;
  config?: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  fetch?: typeof fetch;
};

async function fetchProviderUsageSnapshot(params: {
  auth: ProviderAuth;
  config: OpenClawConfig;
  env: NodeJS.ProcessEnv;
  agentDir?: string;
  workspaceDir?: string;
  timeoutMs: number;
  fetchFn: typeof fetch;
  isAuthProfileCurrent?: () => boolean;
}): Promise<ProviderUsageSnapshot> {
  const guardedFetch: typeof fetch = (input, init) => {
    if (params.isAuthProfileCurrent?.() === false) {
      return Promise.reject(new Error("Auth profile is no longer current"));
    }
    return params.fetchFn(input, init);
  };
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
      fetchFn: guardedFetch,
      ...(params.isAuthProfileCurrent ? { isAuthProfileCurrent: params.isAuthProfileCurrent } : {}),
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
  const timeoutMs = opts.timeoutMs ?? PROVIDER_USAGE_TIMEOUT_MS;
  const config = opts.config ?? getRuntimeConfig();
  const env = opts.env ?? process.env;
  const fetchFn = opts.fetch
    ? resolveFetch(opts.fetch)
    : (resolveProxyFetchFromEnv(env) ?? resolveFetch());
  if (!fetchFn) {
    throw new Error("fetch is not available");
  }

  const descriptors: ProviderUsagePluginDescriptor[] = opts.authProfile
    ? [
        {
          provider: opts.authProfile.provider,
          displayName: providerUsageLabel(opts.authProfile.provider) ?? opts.authProfile.provider,
        },
      ]
    : opts.providers
      ? opts.providers.map((provider) => ({
          provider,
          displayName: providerUsageLabel(provider) ?? provider,
        }))
      : opts.auth
        ? opts.auth.map((auth) => ({
            provider: auth.provider,
            displayName: providerUsageLabel(auth.provider) ?? auth.provider,
          }))
        : listProviderUsagePluginDescriptors({
            config,
            workspaceDir: opts.workspaceDir,
            env,
          });
  const displayNames = new Map(
    descriptors.map((descriptor) => [descriptor.provider, descriptor.displayName]),
  );
  const providerOrder = new Map(descriptors.map(({ provider }, index) => [provider, index]));
  const failureSnapshot = (provider: UsageProviderId, error: string): ProviderUsageSnapshot => ({
    provider,
    displayName: displayNames.get(provider) ?? providerUsageLabel(provider) ?? provider,
    windows: [],
    error,
  });
  let authStore = opts.authStore;
  const getAuthStore = () =>
    (authStore ??= ensureAuthProfileStore(opts.agentDir, { allowKeychainPrompt: false }));
  const tasks = descriptors.map(async ({ provider }) => {
    let providerWorkStarted = false;
    const work = async () => {
      if (opts.authProfile && opts.isAuthProfileCurrent?.() === false) {
        return undefined;
      }
      let authError: unknown;
      const auth = opts.authProfile
        ? await resolveProviderProfileUsageAuth({
            provider,
            profileId: opts.authProfile.profileId,
            store: getAuthStore(),
            agentDir: opts.agentDir,
            config,
            env,
          })
        : (opts.auth?.find((candidate) => candidate.provider === provider) ??
          (
            await resolveProviderAuths({
              providers: [provider],
              providerOnly: opts.providerOnly,
              agentDir: opts.agentDir,
              config,
              env,
              getStore: getAuthStore,
              store: opts.authStore,
              onError: (_provider, error) => {
                authError = error;
              },
            })
          )[0]);
      if (authError) {
        const message = formatErrorMessage(authError);
        return failureSnapshot(provider, message.trim() || "Auth failed");
      }
      // Provider billing must not fall back to an account quota already fetched
      // by its exact-profile owner. Plugins classify credentials before any HTTP.
      if (!auth || (opts.providerOnly && auth.authProfileId)) {
        return undefined;
      }
      // Auth resolution may await secret refresh. Recheck the owning cache generation
      // before entering the provider hook so a concurrently removed profile cannot make I/O.
      if (opts.authProfile && opts.isAuthProfileCurrent?.() === false) {
        return undefined;
      }
      providerWorkStarted = true;
      return await fetchProviderUsageSnapshot({
        auth,
        config,
        env,
        agentDir: opts.agentDir,
        workspaceDir: opts.workspaceDir,
        timeoutMs,
        fetchFn,
        ...(opts.authProfile ? { isAuthProfileCurrent: opts.isAuthProfileCurrent } : {}),
      });
    };
    // The timeout controls the caller's wait, not the real in-flight cap. A
    // timed-out provider keeps its permit until its underlying work settles.
    let workPromise: Promise<ProviderUsageSnapshot | undefined>;
    if (opts.authProfile) {
      let queued = true;
      let markStarted: (() => void) | undefined;
      const started = new Promise<void>((resolve) => {
        markStarted = resolve;
      });
      // Keep queued and timed-out work owned until its actual producer settles.
      workPromise = trackAsyncWork(() =>
        profileUsageRefreshLimit(async () => {
          if (!queued) {
            return undefined;
          }
          markStarted?.();
          try {
            return await work();
          } finally {
            if (providerWorkStarted) {
              profileUsageRefreshProgress += 1;
            }
          }
        }),
      );
      const acquired = started.then(() => true);
      let observedProgress = profileUsageRefreshProgress;
      // Healthy batches may span several queue deadlines. Only settled provider
      // work renews the wait; caller timeouts and skipped admissions cannot do so.
      while (!(await raceUsageTimeout(acquired, timeoutMs * 2, false))) {
        if (observedProgress === profileUsageRefreshProgress) {
          queued = false;
          return failureSnapshot(provider, "Refresh queue timeout");
        }
        observedProgress = profileUsageRefreshProgress;
      }
    } else {
      workPromise = trackAsyncWork(work);
    }
    return raceUsageTimeout(workPromise, timeoutMs, failureSnapshot(provider, "Timeout")).catch(
      (error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        return failureSnapshot(provider, message.trim() || "Fetch failed");
      },
    );
  });

  const snapshots = (await Promise.all(tasks))
    .filter((snapshot): snapshot is ProviderUsageSnapshot => snapshot !== undefined)
    .toSorted(
      (left, right) =>
        (providerOrder.get(left.provider) ?? Number.MAX_SAFE_INTEGER) -
        (providerOrder.get(right.provider) ?? Number.MAX_SAFE_INTEGER),
    );
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
