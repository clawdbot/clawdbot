import { formatRemainingShort } from "../../agents/auth-health.js";
import {
  type AuthProfileStore,
  listProfilesForProvider,
  resolveAuthProfileDisplayLabel,
  resolveAuthStorePathForDisplay,
  resolveProfileUnusableUntilForDisplay,
} from "../../agents/auth-profiles.js";
import { getCustomProviderApiKey, resolveEnvApiKey } from "../../agents/model-auth.js";
import type { MoltbotConfig } from "../../config/config.js";
import { shortenHomePath } from "../../utils.js";
import { maskApiKey } from "./list.format.js";
import type { ProviderAuthOverview } from "./list.types.js";

export function resolveProviderAuthOverview(params: {
  provider: string;
  cfg: MoltbotConfig;
  store: AuthProfileStore;
  modelsPath: string;
}): ProviderAuthOverview {
  const { provider, cfg, store } = params;
  const now = Date.now();
  const profiles = listProfilesForProvider(store, provider);
  const withUnusableSuffix = (base: string, profileId: string) => {
    const unusableUntil = resolveProfileUnusableUntilForDisplay(store, profileId);
    if (!unusableUntil || now >= unusableUntil) return base;
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
    if (!profile) return `${profileId}=missing`;
    if (profile.type === "api_key") {
      return withUnusableSuffix(`${profileId}=${maskApiKey(profile.key)}`, profileId);
    }
    if (profile.type === "token") {
      return withUnusableSuffix(`${profileId}=token:${maskApiKey(profile.token)}`, profileId);
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

  const effective: ProviderAuthOverview["effective"] = (() => {
    if (profiles.length > 0) {
      return {
        kind: "profiles",
        detail: shortenHomePath(resolveAuthStorePathForDisplay()),
      };
    }
    if (envKey) {
      const isOAuthEnv =
        envKey.source.includes("OAUTH_TOKEN") || envKey.source.toLowerCase().includes("oauth");
      return {
        kind: "env",
        detail: isOAuthEnv ? "OAuth (env)" : maskApiKey(envKey.apiKey),
      };
    }
    if (customKey) {
      return { kind: "models.json", detail: maskApiKey(customKey) };
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
            value:
              envKey.source.includes("OAUTH_TOKEN") || envKey.source.toLowerCase().includes("oauth")
                ? "OAuth (env)"
                : maskApiKey(envKey.apiKey),
            source: envKey.source,
          },
        }
      : {}),
    ...(customKey
      ? {
          modelsJson: {
            value: maskApiKey(customKey),
            source: `models.json: ${shortenHomePath(params.modelsPath)}`,
          },
        }
      : {}),
  };
}
