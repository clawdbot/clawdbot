import { formatRemainingShort } from "../../agents/auth-health.js";
import { resolveAuthProfileDisplayLabel } from "../../agents/auth-profiles/display.js";
import { resolveAuthStorePathForDisplay } from "../../agents/auth-profiles/paths.js";
import { listProfilesForProvider } from "../../agents/auth-profiles/profiles.js";
import type { AuthProfileStore } from "../../agents/auth-profiles/types.js";
import { resolveProfileUnusableUntilForDisplay } from "../../agents/auth-profiles/usage.js";
import { isNonSecretApiKeyMarker } from "../../agents/model-auth-markers.js";
import {
  getCustomProviderApiKey,
  resolveEnvApiKey,
  resolveUsableCustomProviderApiKey,
} from "../../agents/model-auth.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "../../shared/string-coerce.js";
import { shortenHomePath } from "../../utils.js";
import { maskApiKey } from "./list.format.js";
import type { ProviderAuthOverview } from "./list.types.js";

function formatMarkerOrSecret(value: string): string {
  return isNonSecretApiKeyMarker(value, { includeEnvVarName: false })
    ? `marker(${value.trim()})`
    : maskApiKey(value);
}

function formatProfileSecretLabel(params: {
  value: string | undefined;
  ref: { source: string; id: string } | undefined;
  kind: "api-key" | "token";
}): string {
  const value = normalizeOptionalString(params.value) ?? "";
  if (value) {
    const display = formatMarkerOrSecret(value);
    return params.kind === "token" ? `token:${display}` : display;
  }
  if (params.ref) {
    const refLabel = `ref(${params.ref.source}:${params.ref.id})`;
    return params.kind === "token" ? `token:${refLabel}` : refLabel;
  }
  return params.kind === "token" ? "token:missing" : "missing";
}

export function resolveProviderAuthOverview(params: {
  provider: string;
  cfg: OpenClawConfig;
  store: AuthProfileStore;
  modelsPath: string;
  syntheticAuth?: { value: string; source: string };
}): ProviderAuthOverview {
  const { provider, cfg, store } = params;
  const now = Date.now();
  const profiles = listProfilesForProvider(store, provider);
  const withUnusableSuffix = (base: string, profileId: string) => {
    const unusableUntil = resolveProfileUnusableUntilForDisplay(store, profileId);
    if (!unusableUntil || now >= unusableUntil) {
      return base;
    }
    const stats = store.usageStats?.[profileId];
    const kind =
      typeof stats?.disabledUntil === "number" && now < stats.disabledUntil
        ? `disabled${stats.disabledReason ? `:${stats.disabledReason}` : ""}`
        : "cooldown";
    const remaining = formatRemainingShort(unusableUntil - now);
    return `${base} [${kind} ${remaining}]`;
  };
  const labels = profiles.map((profileId) => {
    const profile = store.profiles[profileId];
    if (!profile) {
      return `${profileId}=missing`;
    }
    if (profile.type === "api_key") {
      return withUnusableSuffix(
        `${profileId}=${formatProfileSecretLabel({
          value: profile.key,
          ref: profile.keyRef,
          kind: "api-key",
        })}`,
        profileId,
      );
    }
    if (profile.type === "token") {
      return withUnusableSuffix(
        `${profileId}=${formatProfileSecretLabel({
          value: profile.token,
          ref: profile.tokenRef,
          kind: "token",
        })}`,
        profileId,
      );
    }
    const display = resolveAuthProfileDisplayLabel({ cfg, store, profileId });
    const suffix =
      display === profileId
        ? ""
        : display.startsWith(profileId)
          ? display.slice(profileId.length).trim()
          : `(${display})`;
    const base = `${profileId}=OAuth${suffix ? ` ${suffix}` : ""}`;
    return withUnusableSuffix(base, profileId);
  });
  const oauthCount = profiles.filter((id) => store.profiles[id]?.type === "oauth").length;
  const tokenCount = profiles.filter((id) => store.profiles[id]?.type === "token").length;
  const apiKeyCount = profiles.filter((id) => store.profiles[id]?.type === "api_key").length;

  const envKey = resolveEnvApiKey(provider);
  const customKey = getCustomProviderApiKey(cfg, provider);
  const usableCustomKey = resolveUsableCustomProviderApiKey({ cfg, provider });

  const effective: ProviderAuthOverview["effective"] = (() => {
    if (profiles.length > 0) {
      return {
        kind: "profiles",
        detail: shortenHomePath(resolveAuthStorePathForDisplay()),
      };
    }
    if (envKey) {
      const normalizedSource = normalizeLowercaseStringOrEmpty(envKey.source);
      const isOAuthEnv =
        envKey.source.includes("OAUTH_TOKEN") || normalizedSource.includes("oauth");
      return {
        kind: "env",
        detail: isOAuthEnv ? "OAuth (env)" : maskApiKey(envKey.apiKey),
      };
    }
    if (usableCustomKey) {
      return { kind: "models.json", detail: formatMarkerOrSecret(usableCustomKey.apiKey) };
    }
    if (params.syntheticAuth) {
      return { kind: "synthetic", detail: params.syntheticAuth.source };
    }
    return { kind: "missing", detail: "missing" };
  })();

  return {
    provider,
    effective,
    profiles: {
      count: profiles.length,
      oauth: oauthCount,
      token: tokenCount,
      apiKey: apiKeyCount,
      labels,
    },
    ...(envKey
      ? {
          env: {
            value: (() => {
              const normalizedSource = normalizeLowercaseStringOrEmpty(envKey.source);
              return envKey.source.includes("OAUTH_TOKEN") || normalizedSource.includes("oauth")
                ? "OAuth (env)"
                : maskApiKey(envKey.apiKey);
            })(),
            source: envKey.source,
          },
        }
      : {}),
    ...(customKey
      ? {
          modelsJson: {
            value: formatMarkerOrSecret(customKey),
            source: `models.json: ${shortenHomePath(params.modelsPath)}`,
          },
        }
      : {}),
    ...(params.syntheticAuth ? { syntheticAuth: params.syntheticAuth } : {}),
  };
}
