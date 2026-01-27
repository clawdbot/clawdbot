import type { MoltbotConfig } from "../config/config.js";
import {
  type AuthProfileCredential,
  type AuthProfileStore,
  resolveAuthProfileDisplayLabel,
} from "./auth-profiles.js";

export type AuthProfileSource = "store";

export type AuthProfileHealthStatus = "ok" | "expiring" | "expired" | "missing" | "static";

export type AuthProfileHealth = {
  profileId: string;
  provider: string;
  type: "oauth" | "token" | "api_key";
  status: AuthProfileHealthStatus;
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

export function resolveAuthProfileSource(_profileId: string): AuthProfileSource {
  return "store";
}

export function formatRemainingShort(remainingMs?: number): string {
  if (remainingMs === undefined || Number.isNaN(remainingMs)) return "unknown";
  if (remainingMs <= 0) return "0m";
  const minutes = Math.max(1, Math.round(remainingMs / 60_000));
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h`;
  const days = Math.round(hours / 24);
  return `${days}d`;
}

function resolveOAuthStatus(
  expiresAt: number | undefined,
  now: number,
  warnAfterMs: number,
): { status: AuthProfileHealthStatus; remainingMs?: number } {
  if (!expiresAt || !Number.isFinite(expiresAt) || expiresAt <= 0) {
    return { status: "missing" };
  }
  const remainingMs = expiresAt - now;
  if (remainingMs <= 0) {
    return { status: "expired", remainingMs };
  }
  if (remainingMs <= warnAfterMs) {
    return { status: "expiring", remainingMs };
  }
  return { status: "ok", remainingMs };
}

function buildProfileHealth(params: {
  profileId: string;
  credential: AuthProfileCredential;
  store: AuthProfileStore;
  cfg?: MoltbotConfig;
  now: number;
  warnAfterMs: number;
}): AuthProfileHealth {
  const { profileId, credential, store, cfg, now, warnAfterMs } = params;
  const label = resolveAuthProfileDisplayLabel({ cfg, store, profileId });
  const source = resolveAuthProfileSource(profileId);

  if (credential.type === "api_key") {
    return {
      profileId,
      provider: credential.provider,
      type: "api_key",
      status: "static",
      source,
      label,
    };
  }

  if (credential.type === "token") {
    const expiresAt =
      typeof credential.expires === "number" && Number.isFinite(credential.expires)
        ? credential.expires
        : undefined;
    if (!expiresAt || expiresAt <= 0) {
      return {
        profileId,
        provider: credential.provider,
        type: "token",
        status: "static",
        source,
        label,
      };
    }
    const { status, remainingMs } = resolveOAuthStatus(expiresAt, now, warnAfterMs);
    return {
      profileId,
      provider: credential.provider,
      type: "token",
      status,
      expiresAt,
      remainingMs,
      source,
      label,
    };
  }

  const { status, remainingMs } = resolveOAuthStatus(credential.expires, now, warnAfterMs);
  return {
    profileId,
    provider: credential.provider,
    type: "oauth",
    status,
    expiresAt: credential.expires,
    remainingMs,
    source,
    label,
  };
}

export function buildAuthHealthSummary(params: {
  store: AuthProfileStore;
  cfg?: MoltbotConfig;
  warnAfterMs?: number;
  providers?: string[];
}): AuthHealthSummary {
  const now = Date.now();
  const warnAfterMs = params.warnAfterMs ?? DEFAULT_OAUTH_WARN_MS;
  const providerFilter = params.providers
    ? new Set(params.providers.map((p) => p.trim()).filter(Boolean))
    : null;

  const profiles = Object.entries(params.store.profiles)
    .filter(([_, cred]) => (providerFilter ? providerFilter.has(cred.provider) : true))
    .map(([profileId, credential]) =>
      buildProfileHealth({
        profileId,
        credential,
        store: params.store,
        cfg: params.cfg,
        now,
        warnAfterMs,
      }),
    )
    .sort((a, b) => {
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

    const statuses = expirable.map((p) => p.status);
    if (statuses.includes("expired") || statuses.includes("missing")) {
      provider.status = "expired";
    } else if (statuses.includes("expiring")) {
      provider.status = "expiring";
    } else {
      provider.status = "ok";
    }
  }

  const providers = Array.from(providersMap.values()).sort((a, b) =>
    a.provider.localeCompare(b.provider),
  );

  return { now, warnAfterMs, profiles, providers };
}
