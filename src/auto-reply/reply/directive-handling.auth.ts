import {
  isProfileInCooldown,
  resolveAuthProfileDisplayLabel,
  resolveAuthStorePathForDisplay,
} from "../../agents/auth-profiles.js";
import {
  ensureAuthProfileStore,
  getCustomProviderApiKey,
  resolveAuthProfileOrder,
  resolveEnvApiKey,
} from "../../agents/model-auth.js";
import { normalizeProviderId } from "../../agents/model-selection.js";
import type { MoltbotConfig } from "../../config/config.js";
import { shortenHomePath } from "../../utils.js";

export type ModelAuthDetailMode = "compact" | "verbose";

const maskApiKey = (value: string): string => {
  const trimmed = value.trim();
  if (!trimmed) return "missing";
  if (trimmed.length <= 16) return trimmed;
  return `${trimmed.slice(0, 8)}...${trimmed.slice(-8)}`;
};

export const resolveAuthLabel = async (
  provider: string,
  cfg: MoltbotConfig,
  modelsPath: string,
  agentDir?: string,
  mode: ModelAuthDetailMode = "compact",
): Promise<{ label: string; source: string }> => {
  const formatPath = (value: string) => shortenHomePath(value);
  const store = ensureAuthProfileStore(agentDir, {
    allowKeychainPrompt: false,
  });
  const order = resolveAuthProfileOrder({ cfg, store, provider });
  const providerKey = normalizeProviderId(provider);
  const lastGood = (() => {
    const map = store.lastGood;
    if (!map) return undefined;
    for (const [key, value] of Object.entries(map)) {
      if (normalizeProviderId(key) === providerKey) return value;
    }
    return undefined;
  })();
  const nextProfileId = order[0];
  const now = Date.now();

  const formatUntil = (timestampMs: number) => {
    const remainingMs = Math.max(0, timestampMs - now);
    const minutes = Math.round(remainingMs / 60_000);
    if (minutes < 1) return "soon";
    if (minutes < 60) return `${minutes}m`;
    const hours = Math.round(minutes / 60);
    if (hours < 48) return `${hours}h`;
    const days = Math.round(hours / 24);
    return `${days}d`;
  };

  if (order.length > 0) {
    if (mode === "compact") {
      const profileId = nextProfileId;
      if (!profileId) return { label: "missing", source: "missing" };
      const profile = store.profiles[profileId];
      const configProfile = cfg.auth?.profiles?.[profileId];
      const missing =
        !profile ||
        (configProfile?.provider && configProfile.provider !== profile.provider) ||
        (configProfile?.mode &&
          configProfile.mode !== profile.type &&
          !(configProfile.mode === "oauth" && profile.type === "token"));

      const more = order.length > 1 ? ` (+${order.length - 1})` : "";
      if (missing) return { label: `${profileId} missing${more}`, source: "" };

      if (profile.type === "api_key") {
        return {
          label: `${profileId} api-key ${maskApiKey(profile.key)}${more}`,
          source: "",
        };
      }
      if (profile.type === "token") {
        const exp =
          typeof profile.expires === "number" &&
          Number.isFinite(profile.expires) &&
          profile.expires > 0
            ? profile.expires <= now
              ? " expired"
              : ` exp ${formatUntil(profile.expires)}`
            : "";
        return {
          label: `${profileId} token ${maskApiKey(profile.token)}${exp}${more}`,
          source: "",
        };
      }
      const display = resolveAuthProfileDisplayLabel({ cfg, store, profileId });
      const label = display === profileId ? profileId : display;
      const exp =
        typeof profile.expires === "number" &&
        Number.isFinite(profile.expires) &&
        profile.expires > 0
          ? profile.expires <= now
            ? " expired"
            : ` exp ${formatUntil(profile.expires)}`
          : "";
      return { label: `${label} oauth${exp}${more}`, source: "" };
    }

    const labels = order.map((profileId) => {
      const profile = store.profiles[profileId];
      const configProfile = cfg.auth?.profiles?.[profileId];
      const flags: string[] = [];
      if (profileId === nextProfileId) flags.push("next");
      if (lastGood && profileId === lastGood) flags.push("lastGood");
      if (isProfileInCooldown(store, profileId)) {
        const until = store.usageStats?.[profileId]?.cooldownUntil;
        if (typeof until === "number" && Number.isFinite(until) && until > now) {
          flags.push(`cooldown ${formatUntil(until)}`);
        } else {
          flags.push("cooldown");
        }
      }
      if (
        !profile ||
        (configProfile?.provider && configProfile.provider !== profile.provider) ||
        (configProfile?.mode &&
          configProfile.mode !== profile.type &&
          !(configProfile.mode === "oauth" && profile.type === "token"))
      ) {
        const suffix = flags.length > 0 ? ` (${flags.join(", ")})` : "";
        return `${profileId}=missing${suffix}`;
      }
      if (profile.type === "api_key") {
        const suffix = flags.length > 0 ? ` (${flags.join(", ")})` : "";
        return `${profileId}=${maskApiKey(profile.key)}${suffix}`;
      }
      if (profile.type === "token") {
        if (
          typeof profile.expires === "number" &&
          Number.isFinite(profile.expires) &&
          profile.expires > 0
        ) {
          flags.push(profile.expires <= now ? "expired" : `exp ${formatUntil(profile.expires)}`);
        }
        const suffix = flags.length > 0 ? ` (${flags.join(", ")})` : "";
        return `${profileId}=token:${maskApiKey(profile.token)}${suffix}`;
      }
      const display = resolveAuthProfileDisplayLabel({
        cfg,
        store,
        profileId,
      });
      const suffix =
        display === profileId
          ? ""
          : display.startsWith(profileId)
            ? display.slice(profileId.length).trim()
            : `(${display})`;
      if (
        typeof profile.expires === "number" &&
        Number.isFinite(profile.expires) &&
        profile.expires > 0
      ) {
        flags.push(profile.expires <= now ? "expired" : `exp ${formatUntil(profile.expires)}`);
      }
      const suffixLabel = suffix ? ` ${suffix}` : "";
      const suffixFlags = flags.length > 0 ? ` (${flags.join(", ")})` : "";
      return `${profileId}=OAuth${suffixLabel}${suffixFlags}`;
    });
    return {
      label: labels.join(", "),
      source: `auth-profiles.json: ${formatPath(resolveAuthStorePathForDisplay(agentDir))}`,
    };
  }

  const envKey = resolveEnvApiKey(provider);
  if (envKey) {
    const isOAuthEnv =
      envKey.source.includes("ANTHROPIC_OAUTH_TOKEN") ||
      envKey.source.toLowerCase().includes("oauth");
    const label = isOAuthEnv ? "OAuth (env)" : maskApiKey(envKey.apiKey);
    return { label, source: mode === "verbose" ? envKey.source : "" };
  }
  const customKey = getCustomProviderApiKey(cfg, provider);
  if (customKey) {
    return {
      label: maskApiKey(customKey),
      source: mode === "verbose" ? `models.json: ${formatPath(modelsPath)}` : "",
    };
  }
  return { label: "missing", source: "missing" };
};

export const formatAuthLabel = (auth: { label: string; source: string }) => {
  if (!auth.source || auth.source === auth.label || auth.source === "missing") {
    return auth.label;
  }
  return `${auth.label} (${auth.source})`;
};

export const resolveProfileOverride = (params: {
  rawProfile?: string;
  provider: string;
  cfg: MoltbotConfig;
  agentDir?: string;
}): { profileId?: string; error?: string } => {
  const raw = params.rawProfile?.trim();
  if (!raw) return {};
  const store = ensureAuthProfileStore(params.agentDir, {
    allowKeychainPrompt: false,
  });
  const profile = store.profiles[raw];
  if (!profile) {
    return { error: `Auth profile "${raw}" not found.` };
  }
  if (profile.provider !== params.provider) {
    return {
      error: `Auth profile "${raw}" is for ${profile.provider}, not ${params.provider}.`,
    };
  }
  return { profileId: raw };
};
