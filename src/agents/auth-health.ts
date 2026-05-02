import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  DEFAULT_OAUTH_REFRESH_MARGIN_MS,
  type AuthCredentialReasonCode,
  evaluateStoredCredentialEligibility,
  resolveTokenExpiryState,
} from "./auth-profiles/credential-state.js";
import { resolveAuthProfileDisplayLabel } from "./auth-profiles/display.js";
import { resolveEffectiveOAuthCredential } from "./auth-profiles/effective-oauth.js";
import type { AuthProfileCredential, AuthProfileStore } from "./auth-profiles/types.js";
import { normalizeProviderId } from "./provider-id.js";

type AuthProfileSource = "store";

export type AuthProfileHealthStatus = "ok" | "expiring" | "expired" | "missing" | "static";

type AuthProfileHealth = {
  profileId: string;
  provider: string;
  type: "oauth" | "token" | "api_key";
  status: AuthProfileHealthStatus;
  reasonCode?: AuthCredentialReasonCode;
  expiresAt?: number;
  remainingMs?: number;
  source: AuthProfileSource;
  label: string;
};

export type AuthProviderHealthStatus = "ok" | "expiring" | "expired" | "missing" | "static";

export type AuthProviderHealth = {
  provider: string;
  status: AuthProviderHealthStatus;
  expiresAt?: number;
  remainingMs?: number;
  profiles: AuthProfileHealth[];
};

export type AuthHealthSummary = {
  now: number;
  warnAfterMs: number;
  profiles: AuthProfileHealth[];
  providers: AuthProviderHealth[];
};

export const DEFAULT_OAUTH_WARN_MS = 24 * 60 * 60 * 1000;

function resolveAuthProfileSource(_profileId: string): AuthProfileSource {
  return "store";
}

export function formatRemainingShort(
  remainingMs?: number,
  opts?: {
    underMinuteLabel?: string;
  },
): string {
  if (remainingMs === undefined || Number.isNaN(remainingMs)) {
    return "unknown";
  }
  if (remainingMs <= 0) {
    return "0m";
  }
  const roundedMinutes = Math.round(remainingMs / 60_000);
  if (roundedMinutes < 1) {
    return opts?.underMinuteLabel ?? "1m";
  }
  const minutes = roundedMinutes;
  if (minutes < 60) {
    return `${minutes}m`;
  }
  const hours = Math.round(minutes / 60);
  if (hours < 48) {
    return `${hours}h`;
  }
  const days = Math.round(hours / 24);
  return `${days}d`;
}

function resolveOAuthStatus(
  expiresAt: number | undefined,
  now: number,
  expiringWithinMs: number,
): { status: AuthProfileHealthStatus; remainingMs?: number } {
  if (!expiresAt || !Number.isFinite(expiresAt) || expiresAt <= 0) {
    return { status: "missing" };
  }
  const remainingMs = expiresAt - now;
  const expiryState = resolveTokenExpiryState(expiresAt, now, {
    expiringWithinMs,
  });
  if (expiryState === "invalid_expires" || expiryState === "missing") {
    return { status: "missing" };
  }
  if (expiryState === "expired") {
    return { status: "expired", remainingMs };
  }
  if (expiryState === "expiring") {
    return { status: "expiring", remainingMs };
  }
  return { status: "ok", remainingMs };
}

function buildProfileHealth(params: {
  profileId: string;
  credential: AuthProfileCredential;
  runtimeCredential?: AuthProfileCredential;
  store: AuthProfileStore;
  cfg?: OpenClawConfig;
  now: number;
  warnAfterMs: number;
}): AuthProfileHealth {
  const { profileId, credential, runtimeCredential, store, cfg, now, warnAfterMs } = params;
  const label = resolveAuthProfileDisplayLabel({ cfg, store, profileId });
  const source = resolveAuthProfileSource(profileId);
  const healthCredential = runtimeCredential ?? credential;
  const provider = normalizeProviderId(healthCredential.provider);

  if (healthCredential.type === "api_key") {
    return {
      profileId,
      provider,
      type: "api_key",
      status: "static",
      source,
      label,
    };
  }

  if (healthCredential.type === "token") {
    const eligibility = evaluateStoredCredentialEligibility({
      credential: healthCredential,
      now,
    });
    if (!eligibility.eligible) {
      const status: AuthProfileHealthStatus =
        eligibility.reasonCode === "expired" ? "expired" : "missing";
      return {
        profileId,
        provider,
        type: "token",
        status,
        reasonCode: eligibility.reasonCode,
        source,
        label,
      };
    }
    const expiryState = resolveTokenExpiryState(healthCredential.expires, now);
    const expiresAt = expiryState === "valid" ? healthCredential.expires : undefined;
    if (!expiresAt) {
      return {
        profileId,
        provider,
        type: "token",
        status: "static",
        source,
        label,
      };
    }
    const { status, remainingMs } = resolveOAuthStatus(expiresAt, now, warnAfterMs);
    return {
      profileId,
      provider,
      type: "token",
      status,
      reasonCode: status === "expired" ? "expired" : undefined,
      expiresAt,
      remainingMs,
      source,
      label,
    };
  }

  const effectiveCredential = resolveEffectiveOAuthCredential({
    profileId,
    credential: healthCredential,
  });
  const oauthWarnAfterMs = Math.max(warnAfterMs, DEFAULT_OAUTH_REFRESH_MARGIN_MS);
  const { status: rawStatus, remainingMs } = resolveOAuthStatus(
    effectiveCredential.expires,
    now,
    oauthWarnAfterMs,
  );
  return {
    profileId,
    provider,
    type: "oauth",
    status: rawStatus,
    expiresAt: effectiveCredential.expires,
    remainingMs,
    source,
    label,
  };
}

export function buildAuthHealthSummary(params: {
  store: AuthProfileStore;
  cfg?: OpenClawConfig;
  warnAfterMs?: number;
  providers?: string[];
  runtimeCredentialsByProvider?: ReadonlyMap<string, AuthProfileCredential>;
}): AuthHealthSummary {
  const now = Date.now();
  const warnAfterMs = params.warnAfterMs ?? DEFAULT_OAUTH_WARN_MS;
  const providerFilter = params.providers
    ? new Set(params.providers.map((p) => normalizeProviderId(p)).filter(Boolean))
    : null;

  const profiles = Object.entries(params.store.profiles)
    .filter(([_, cred]) =>
      providerFilter ? providerFilter.has(normalizeProviderId(cred.provider)) : true,
    )
    .map(([profileId, credential]) =>
      buildProfileHealth({
        profileId,
        credential,
        runtimeCredential: params.runtimeCredentialsByProvider?.get(
          normalizeProviderId(credential.provider),
        ),
        store: params.store,
        cfg: params.cfg,
        now,
        warnAfterMs,
      }),
    )
    .toSorted((a, b) => {
      if (a.provider !== b.provider) {
        return a.provider.localeCompare(b.provider);
      }
      return a.profileId.localeCompare(b.profileId);
    });

  const providersMap = new Map<string, AuthProviderHealth>();
  for (const profile of profiles) {
    const existing = providersMap.get(profile.provider);
    if (!existing) {
      providersMap.set(profile.provider, {
        provider: profile.provider,
        status: "missing",
        profiles: [profile],
      });
    } else {
      existing.profiles.push(profile);
    }
  }

  if (providerFilter) {
    for (const provider of providerFilter) {
      if (!providersMap.has(provider)) {
        providersMap.set(provider, {
          provider,
          status: "missing",
          profiles: [],
        });
      }
    }
  }

  for (const provider of providersMap.values()) {
    if (provider.profiles.length === 0) {
      provider.status = "missing";
      continue;
    }

    const oauthProfiles = provider.profiles.filter((p) => p.type === "oauth");
    const tokenProfiles = provider.profiles.filter((p) => p.type === "token");
    const apiKeyProfiles = provider.profiles.filter((p) => p.type === "api_key");

    const expirable = [...oauthProfiles, ...tokenProfiles];
    if (expirable.length === 0) {
      provider.status = apiKeyProfiles.length > 0 ? "static" : "missing";
      continue;
    }

    const expiryCandidates = expirable
      .map((p) => p.expiresAt)
      .filter((v): v is number => typeof v === "number" && Number.isFinite(v));
    if (expiryCandidates.length > 0) {
      provider.expiresAt = Math.min(...expiryCandidates);
      provider.remainingMs = provider.expiresAt - now;
    }

    const statuses = new Set(expirable.map((p) => p.status));
    if (statuses.has("expired") || statuses.has("missing")) {
      provider.status = "expired";
    } else if (statuses.has("expiring")) {
      provider.status = "expiring";
    } else {
      provider.status = "ok";
    }
  }

  const providers = Array.from(providersMap.values()).toSorted((a, b) =>
    a.provider.localeCompare(b.provider),
  );

  return { now, warnAfterMs, profiles, providers };
}
