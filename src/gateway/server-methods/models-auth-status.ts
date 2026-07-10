// Model auth status methods report provider credential health, profile expiry,
// usage windows, cleanup actions, and auth-state refreshes.
import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import { ErrorCodes, errorShape } from "../../../packages/gateway-protocol/src/index.js";
import { resolveDefaultAgentDir } from "../../agents/agent-scope.js";
import {
  type AuthHealthSummary,
  type AuthProfileHealthStatus,
  type AuthProviderHealth,
  type AuthProviderHealthStatus,
  buildAuthHealthSummary,
  formatRemainingShort,
} from "../../agents/auth-health.js";
import {
  clearRuntimeAuthProfileStoreSnapshots,
  ensureAuthProfileStore,
  ensureAuthProfileStoreWithoutExternalProfiles,
  externalCliDiscoveryForConfigStatus,
  listProfilesForProvider,
  removeProviderAuthProfilesWithLock,
  resolvePersistedAuthProfileOwnerAgentDir,
} from "../../agents/auth-profiles.js";
import type { AuthCredentialReasonCode } from "../../agents/auth-profiles/credential-state.js";
import {
  clearCurrentProviderAuthState,
  warmCurrentProviderAuthStateOffMainThread,
} from "../../agents/model-provider-auth.js";
import { resolveProviderIdForAuth } from "../../agents/provider-auth-aliases.js";
import type { OpenClawConfig } from "../../config/config.js";
import { isSecretRef } from "../../config/types.secrets.js";
import { loadProviderUsageSummary } from "../../infra/provider-usage.load.js";
import { PROVIDER_LABELS, resolveUsageProviderId } from "../../infra/provider-usage.shared.js";
import type {
  ProviderUsageBilling,
  ProviderUsageSnapshot,
  UsageProviderId,
  UsageWindow,
} from "../../infra/provider-usage.types.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { refreshActiveSecretsRuntimeSnapshot } from "../../secrets/runtime.js";
import { asDateTimestampMs } from "../../shared/number-coercion.js";
import { abortChatRunsForProvider, type ChatAbortOps } from "../chat-abort.js";
import { formatForLog } from "../ws-log.js";
import type { GatewayRequestContext, GatewayRequestHandlers } from "./types.js";

const log = createSubsystemLogger("models-auth-status");
const apiKeyUsageStatusProviders = new Set<UsageProviderId>(["clawrouter", "deepseek"]);

type ProviderUsageStatus = Pick<ProviderUsageSnapshot, "windows" | "summary" | "plan" | "billing">;

/**
 * Models-auth status wire types. Mirrored in ui/src/ui/types.ts via an
 * `import(...)` re-export — edit here and the UI picks up the change.
 *
 * Expiry fields are grouped into a sub-object so they're present together or
 * not at all: a profile either has a time-bounded credential or it doesn't.
 */
export type ModelAuthExpiry = {
  /** Absolute expiry timestamp, ms since epoch. */
  at: number;
  /** Remaining time in ms (negative if already expired). */
  remainingMs: number;
  /** Human-readable remaining time (e.g. "10d", "2h", "45m"). */
  label: string;
};

export type ModelAuthStatusProfile = {
  profileId: string;
  type: "oauth" | "token" | "api_key";
  status: AuthProfileHealthStatus;
  reasonCode?: AuthCredentialReasonCode;
  expiry?: ModelAuthExpiry;
};

export type ModelAuthStatusProvider = {
  provider: string;
  displayName: string;
  status: AuthProviderHealthStatus;
  expiry?: ModelAuthExpiry;
  profiles: ModelAuthStatusProfile[];
  usage?: {
    /**
     * Normalized usage provider id this payload was fetched under (e.g.
     * "anthropic" for a claude-cli auth row). Session rows report canonical
     * model providers, so consumers must match against both ids.
     */
    providerId: UsageProviderId;
    windows: UsageWindow[];
    summary?: string;
    plan?: string;
    billing?: ProviderUsageBilling[];
  };
};

export type ModelAuthStatusResult = {
  /** Snapshot build time, ms since epoch. 0 = never loaded (UI fallback sentinel). */
  ts: number;
  providers: ModelAuthStatusProvider[];
};

export type ModelAuthLogoutResult = {
  provider: string;
  removedProfiles: string[];
  abortedRunIds: string[];
};

const CACHE_TTL_MS = 60_000;
let cached: { ts: number; result: ModelAuthStatusResult } | null = null;

/**
 * Invalidate the in-memory cache. Reserved for future gateway-side auth
 * mutation handlers (login, logout, token rotation) so the next read returns
 * fresh data. Today those mutations happen via the CLI and the 60s TTL plus
 * `{refresh: true}` param cover the stale-data window.
 */
export function invalidateModelAuthStatusCache(): void {
  cached = null;
  // The prepared provider-auth map (model-provider-auth.ts) was built from
  // the pre-mutation auth state, so it must be invalidated alongside this
  // cache whenever an auth-profile mutation lands (logout, login, token
  // rotation, etc.). Without this, `/models` and pickers keep advertising
  // providers the running gateway can no longer authenticate.
  clearCurrentProviderAuthState();
}

async function refreshModelAuthStatusRuntimeState(): Promise<void> {
  invalidateModelAuthStatusCache();
  try {
    if (await refreshActiveSecretsRuntimeSnapshot()) {
      return;
    }
  } catch (err) {
    log.warn(`runtime auth snapshot refresh before auth status failed: ${formatForLog(err)}`);
    return;
  }
  // Explicit status refresh follows CLI/doctor repairs. If no secrets runtime is
  // active, drop runtime auth snapshots so the next status read observes disk.
  clearRuntimeAuthProfileStoreSnapshots();
}

function readProviderParam(params: Record<string, unknown>): string | null {
  const raw = params.provider;
  if (typeof raw !== "string") {
    return null;
  }
  const provider = normalizeProviderId(raw);
  return provider || null;
}

function createAuthLogoutAbortOps(context: GatewayRequestContext): ChatAbortOps {
  return {
    chatAbortControllers: context.chatAbortControllers,
    chatRunBuffers: context.chatRunBuffers,
    chatAbortedRuns: context.chatAbortedRuns,
    clearChatRunState: context.clearChatRunState,
    removeChatRun: context.removeChatRun,
    agentRunSeq: context.agentRunSeq,
    broadcast: context.broadcast,
    nodeSendToSession: context.nodeSendToSession,
  };
}

// Auth profiles can be adopted by a provider-specific owner agent dir. Logout
// must remove every owning store or stale profiles reappear on the next status
// read and provider-auth warmup.
async function removeProviderAuthProfilesAcrossOwnerStores(params: {
  provider: string;
  agentDir: string;
  profileIds: string[];
}): Promise<boolean> {
  const ownerAgentDirs = new Set<string | undefined>([params.agentDir]);
  for (const profileId of params.profileIds) {
    ownerAgentDirs.add(
      resolvePersistedAuthProfileOwnerAgentDir({
        agentDir: params.agentDir,
        profileId,
      }),
    );
  }
  for (const ownerAgentDir of ownerAgentDirs) {
    const updatedStore = await removeProviderAuthProfilesWithLock({
      provider: params.provider,
      agentDir: ownerAgentDir,
    });
    if (!updatedStore) {
      return false;
    }
  }
  return true;
}

// UI expiry fields are emitted only when both timestamp and remaining duration
// are valid, keeping profile/provider expiry shapes all-or-nothing.
function buildExpiry(
  remainingMs: number | undefined,
  expiresAt: number | undefined,
): ModelAuthExpiry | undefined {
  const normalizedExpiresAt = asDateTimestampMs(expiresAt);
  if (normalizedExpiresAt === undefined || typeof remainingMs !== "number") {
    return undefined;
  }
  return { at: normalizedExpiresAt, remainingMs, label: formatRemainingShort(remainingMs) };
}

function providerDisplayName(provider: string): string {
  const usageId = resolveUsageProviderId(provider);
  if (usageId && PROVIDER_LABELS[usageId]) {
    return PROVIDER_LABELS[usageId];
  }
  return provider;
}

type ModelAuthStatusRollup = {
  status: AuthProviderHealthStatus;
  expiresAt?: number;
  remainingMs?: number;
};

function aggregateProfileStatus(
  profiles: AuthProviderHealth["profiles"],
  now: number,
): ModelAuthStatusRollup {
  const statuses = new Set<AuthProfileHealthStatus>(profiles.map((profile) => profile.status));
  const status = (["expired", "missing", "expiring", "ok", "static"] as const).find((candidate) =>
    statuses.has(candidate),
  );
  const expirable = profiles
    .map((p) => p.expiresAt)
    .filter((v): v is number => asDateTimestampMs(v) !== undefined);
  const expiresAt = expirable.length > 0 ? Math.min(...expirable) : undefined;
  const remainingMs = expiresAt !== undefined ? expiresAt - now : undefined;
  return { status: status ?? "static", expiresAt, remainingMs };
}

/**
 * Aggregate the effective refreshable credential status for the dashboard.
 * OAuth remains authoritative when present; token credentials are the
 * supported fallback after an OAuth-to-token migration. Explicit auth-order
 * exclusions remain authoritative through `effectiveProfiles`.
 *
 * `expectsOAuth` keeps an API-key-only provider `missing` after config switches
 * to OAuth but login has not completed.
 */
export function aggregateRefreshableAuthStatus(
  prov: AuthProviderHealth,
  now: number = Date.now(),
  expectsOAuth = false,
): ModelAuthStatusRollup {
  const profiles = prov.effectiveProfiles ?? prov.profiles;
  const oauth = profiles.filter((profile) => profile.type === "oauth");
  if (oauth.length > 0) {
    return aggregateProfileStatus(oauth, now);
  }
  const tokens = profiles.filter((profile) => profile.type === "token");
  if (tokens.length > 0) {
    return aggregateProfileStatus(tokens, now);
  }
  if (expectsOAuth) {
    return { status: "missing" };
  }
  return { status: prov.status, expiresAt: prov.expiresAt, remainingMs: prov.remainingMs };
}

function mapProvider(
  prov: AuthProviderHealth,
  usageByProvider: Map<string, ProviderUsageStatus>,
  expectsOAuthSet: Set<string>,
): ModelAuthStatusProvider {
  const usageProfile =
    prov.profiles.find((profile) => profile.type === "oauth" || profile.type === "token") ??
    prov.profiles.find((profile) => profile.type === "api_key");
  const usageKey = resolveUsageProviderId(prov.provider, {
    credentialType: usageProfile?.type,
  });
  const usage = usageKey ? usageByProvider.get(usageKey) : undefined;
  const rollup = aggregateRefreshableAuthStatus(
    prov,
    Date.now(),
    expectsOAuthSet.has(prov.provider),
  );
  return {
    provider: prov.provider,
    displayName: providerDisplayName(prov.provider),
    status: rollup.status,
    expiry: buildExpiry(rollup.remainingMs, rollup.expiresAt),
    profiles: prov.profiles.map((prof) => ({
      profileId: prof.profileId,
      type: prof.type,
      status: prof.status,
      reasonCode: prof.reasonCode,
      expiry: buildExpiry(prof.remainingMs, prof.expiresAt),
    })),
    usage:
      usage && usageKey
        ? {
            providerId: usageKey,
            windows: usage.windows,
            ...(usage.summary ? { summary: usage.summary } : {}),
            ...(usage.plan ? { plan: usage.plan } : {}),
            ...(usage.billing?.length ? { billing: usage.billing } : {}),
          }
        : undefined,
  };
}

/**
 * Collect provider IDs with refreshable credentials (OAuth or bearer token)
 * so a configured-but-not-logged-in provider surfaces as `missing` rather
 * than being silently absent. API-key and AWS-SDK providers are excluded —
 * their credentials don't expire on a schedule this endpoint can meaningfully
 * monitor, and surfacing them here would flash a red alert on a healthy
 * API-key setup.
 *
 * Providers with `models.providers.<id>.apiKey` set (commonly via a
 * SecretRef env binding) are excluded from the "missing" synthesis even
 * when their `auth` mode is `oauth` or `token` — an env-backed credential
 * is already present, so flagging the dashboard as missing would cry wolf
 * for a working auth path. They can still show up with real status if the
 * profile store has an entry for them.
 */
function resolveConfiguredProviders(cfg: OpenClawConfig): {
  providers: string[];
  expectsOAuth: Set<string>;
} {
  const out = new Set<string>();
  const expectsOAuth = new Set<string>();
  // Providers with a resolvable apiKey (inline or SecretRef pointing at a
  // set env var) are treated as env-backed and skipped from the "missing"
  // synthesis. Captured once up front so both the models.providers scan
  // and the auth.profiles scan apply the escape hatch consistently.
  const envBacked = new Set<string>();
  for (const [id, provider] of Object.entries(cfg.models?.providers ?? {})) {
    const apiKey = provider?.apiKey;
    if (!id || apiKey === undefined || apiKey === null) {
      continue;
    }
    // Treat as env-backed when the credential is currently resolvable:
    // - inline string literal → always resolvable (satisfies auth today)
    // - env SecretRef → check process.env for the referenced id (the only
    //   source we can cheaply verify synchronously on a dashboard read)
    // - file/exec SecretRef → conservatively treat as env-backed; we can't
    //   read files or run commands here without making this a heavy async
    //   path, and the alternative is crying wolf on valid configs
    // A SecretRef pointing at an unset env var falls through to the normal
    // "missing" synthesis so the dashboard surfaces the broken config.
    let resolvable = false;
    if (typeof apiKey === "string" && apiKey.length > 0) {
      resolvable = true;
    } else if (isSecretRef(apiKey)) {
      if (apiKey.source === "env") {
        const envValue = process.env[apiKey.id];
        resolvable = typeof envValue === "string" && envValue.length > 0;
      } else {
        resolvable = true;
      }
    }
    if (resolvable) {
      envBacked.add(normalizeProviderId(id));
    }
  }
  for (const [id, provider] of Object.entries(cfg.models?.providers ?? {})) {
    if (!id) {
      continue;
    }
    // Only include providers whose configured auth mode is refreshable.
    // `undefined` / "api-key" / "aws-sdk" are deliberately skipped.
    const mode = provider?.auth;
    if (mode !== "oauth" && mode !== "token") {
      continue;
    }
    if (envBacked.has(normalizeProviderId(id))) {
      continue;
    }
    out.add(id);
    if (mode === "oauth") {
      // Store normalized id so lookups against `AuthProviderHealth.provider`
      // (which is already normalized by buildAuthHealthSummary) match despite
      // case-only differences in config provider keys.
      expectsOAuth.add(normalizeProviderId(id));
    }
  }
  // auth.profiles entries explicitly opt into the refreshable set via
  // `mode: oauth | token`. api_key profiles are excluded (no lifecycle).
  for (const profile of Object.values(cfg.auth?.profiles ?? {})) {
    const provider = profile?.provider;
    const mode = profile?.mode;
    if (
      typeof provider !== "string" ||
      provider.length === 0 ||
      (mode !== "oauth" && mode !== "token")
    ) {
      continue;
    }
    if (envBacked.has(normalizeProviderId(provider))) {
      continue;
    }
    out.add(provider);
    if (mode === "oauth") {
      expectsOAuth.add(normalizeProviderId(provider));
    }
  }
  return { providers: Array.from(out), expectsOAuth };
}

export const modelsAuthStatusHandlers: GatewayRequestHandlers = {
  "models.authLogout": async ({ params, respond, context }) => {
    const provider = readProviderParam(params);
    if (!provider) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "provider is required"));
      return;
    }
    try {
      const cfg = context.getRuntimeConfig();
      const agentDir = resolveDefaultAgentDir(cfg);
      const authProvider = resolveProviderIdForAuth(provider, { config: cfg });
      const store = ensureAuthProfileStoreWithoutExternalProfiles(agentDir);
      const removedProfiles = listProfilesForProvider(store, provider);
      const removed = await removeProviderAuthProfilesAcrossOwnerStores({
        provider,
        agentDir,
        profileIds: removedProfiles,
      });
      if (!removed) {
        respond(
          false,
          undefined,
          errorShape(
            ErrorCodes.UNAVAILABLE,
            `failed to remove saved auth profiles for provider ${provider}`,
          ),
        );
        return;
      }
      await refreshActiveSecretsRuntimeSnapshot();
      invalidateModelAuthStatusCache();
      clearCurrentProviderAuthState();
      void warmCurrentProviderAuthStateOffMainThread(context.getRuntimeConfig()).catch(
        (err: unknown) => {
          log.warn(`provider auth state rewarm after logout failed: ${formatForLog(err)}`);
        },
      );
      const { runIds: abortedRunIds } = abortChatRunsForProvider(
        createAuthLogoutAbortOps(context),
        {
          providerId: authProvider,
          stopReason: "auth-revoked",
        },
      );
      const result: ModelAuthLogoutResult = {
        provider,
        removedProfiles,
        abortedRunIds,
      };
      respond(true, result, undefined);
    } catch (err) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, formatForLog(err)));
    }
  },
  "models.authStatus": async ({ params, respond, context }) => {
    const now = Date.now();
    const bypassCache = Boolean((params as { refresh?: boolean } | undefined)?.refresh);
    if (!bypassCache && cached && now - cached.ts < CACHE_TTL_MS) {
      respond(true, cached.result, undefined, { cached: true });
      return;
    }
    try {
      if (bypassCache) {
        await refreshModelAuthStatusRuntimeState();
      }
      const cfg = context.getRuntimeConfig();
      const agentDir = resolveDefaultAgentDir(cfg);
      // Use the external-profile-aware store for status reads so the dashboard
      // reflects CLI-discovered credentials without persisting them here.
      const store = ensureAuthProfileStore(agentDir, {
        externalCli: externalCliDiscoveryForConfigStatus({ cfg }),
      });
      const configured = resolveConfiguredProviders(cfg);
      const authHealth: AuthHealthSummary = buildAuthHealthSummary({
        store,
        cfg,
        providers: configured.providers.length > 0 ? configured.providers : undefined,
        allowKeychainPrompt: false,
      });

      // Usage queries usually need refreshable credentials. Keep API-key status
      // enrichment explicit so static auth providers are not polled by default.
      const usageProviderIds = [
        ...new Set(
          authHealth.profiles
            .filter((p) => {
              if (p.type === "oauth" || p.type === "token") {
                return true;
              }
              const usageProvider = resolveUsageProviderId(p.provider, {
                credentialType: p.type,
              });
              return usageProvider ? apiKeyUsageStatusProviders.has(usageProvider) : false;
            })
            .map((p) => resolveUsageProviderId(p.provider, { credentialType: p.type }))
            .filter((id): id is UsageProviderId => Boolean(id)),
        ),
      ];

      const usageByProvider = new Map<string, ProviderUsageStatus>();
      if (usageProviderIds.length > 0) {
        try {
          const usage = await loadProviderUsageSummary({
            providers: usageProviderIds,
            agentDir,
            timeoutMs: 3500,
          });
          for (const snap of usage.providers) {
            usageByProvider.set(snap.provider, {
              windows: snap.windows,
              ...(snap.summary ? { summary: snap.summary } : {}),
              ...(snap.plan ? { plan: snap.plan } : {}),
              ...(snap.billing?.length ? { billing: snap.billing } : {}),
            });
          }
        } catch (err) {
          // Usage data is auxiliary — failing here must not block auth status,
          // but log at debug so a silently-broken usage endpoint is still
          // diagnosable in gateway logs.
          log.debug(
            `usage enrichment failed (auth status still returned): providers=${usageProviderIds.join(",")} error=${formatForLog(err)}`,
          );
        }
      }

      const providers = authHealth.providers.map((prov) =>
        mapProvider(prov, usageByProvider, configured.expectsOAuth),
      );
      const result: ModelAuthStatusResult = { ts: now, providers };
      cached = { ts: now, result };
      respond(true, result, undefined);
    } catch (err) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, formatForLog(err)));
    }
  },
};
