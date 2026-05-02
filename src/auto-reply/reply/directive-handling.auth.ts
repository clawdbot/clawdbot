import { formatRemainingShort } from "../../agents/auth-health.js";
import {
  isProfileInCooldown,
  resolveAuthProfileDisplayLabel,
  resolveAuthStorePathForDisplay,
} from "../../agents/auth-profiles.js";
import {
  ensureAuthProfileStore,
  resolveAuthProfileOrder,
  resolveEnvApiKey,
  resolveUsableCustomProviderApiKey,
} from "../../agents/model-auth.js";
import { findNormalizedProviderValue, normalizeProviderId } from "../../agents/model-selection.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { coerceSecretRef } from "../../config/types.secrets.js";
import { normalizeLowercaseStringOrEmpty } from "../../shared/string-coerce.js";
import { shortenHomePath } from "../../utils.js";
import { maskApiKey } from "../../utils/mask-api-key.js";

export type ModelAuthDetailMode = "compact" | "verbose";

function resolveStoredCredentialLabel(params: {
  value: unknown;
  refValue: unknown;
  mode: ModelAuthDetailMode;
}): string {
  const masked = maskApiKey(typeof params.value === "string" ? params.value : "");
  if (masked !== "missing") {
    return masked;
  }
  if (coerceSecretRef(params.refValue)) {
    return params.mode === "compact" ? "(ref)" : "ref";
  }
  return "missing";
}

function formatExpirationLabel(
  expires: unknown,
  now: number,
  formatUntil: (timestampMs: number) => string,
  compactExpiredPrefix = " expired",
) {
  if (typeof expires !== "number" || !Number.isFinite(expires) || expires <= 0) {
    return "";
  }
  return expires <= now ? compactExpiredPrefix : ` exp ${formatUntil(expires)}`;
}

function formatFlagsSuffix(flags: string[]) {
  return flags.length > 0 ? ` (${flags.join(", ")})` : "";
}

export const resolveAuthLabel = async (
  provider: string,
  cfg: OpenClawConfig,
  modelsPath: string,
  agentDir?: string,
  mode: ModelAuthDetailMode = "compact",
  workspaceDir?: string,
): Promise<{ label: string; source: string }> => {
  const formatPath = (value: string) => shortenHomePath(value);
  const store = ensureAuthProfileStore(agentDir, {
    allowKeychainPrompt: false,
  });
  const order = resolveAuthProfileOrder({ cfg, store, provider });
  const providerKey = normalizeProviderId(provider);
  const lastGood = findNormalizedProviderValue(store.lastGood, providerKey);
  const nextProfileId = order[0];
  const now = Date.now();
  const formatUntil = (timestampMs: number) =>
    formatRemainingShort(timestampMs - now, { underMinuteLabel: "soon" });

  if (order.length > 0) {
    if (mode === "compact") {
      const profileId = nextProfileId;
      if (!profileId) {
        return { label: "missing", source: "missing" };
      }
      const profile = store.profiles[profileId];
      const configProfile = cfg.auth?.profiles?.[profileId];
      const missing =
        !profile ||
        (configProfile?.provider && configProfile.provider !== profile.provider) ||
        (configProfile?.mode &&
          configProfile.mode !== profile.type &&
          !(configProfile.mode === "oauth" && profile.type === "token"));

      const more = order.length > 1 ? ` (+${order.length - 1})` : "";
      if (missing) {
        return { label: `${profileId} missing${more}`, source: "" };
      }

      if (profile.type === "api_key") {
        const keyLabel = resolveStoredCredentialLabel({
          value: profile.key,
          refValue: profile.keyRef,
          mode,
        });
        return {
          label: `${profileId} api-key ${keyLabel}${more}`,
          source: "",
        };
      }
      if (profile.type === "token") {
        const tokenLabel = resolveStoredCredentialLabel({
          value: profile.token,
          refValue: profile.tokenRef,
          mode,
        });
        const exp = formatExpirationLabel(profile.expires, now, formatUntil);
        return {
          label: `${profileId} token ${tokenLabel}${exp}${more}`,
          source: "",
        };
      }
      const display = resolveAuthProfileDisplayLabel({ cfg, store, profileId });
      const label = display === profileId ? profileId : display;
      const exp = formatExpirationLabel(profile.expires, now, formatUntil);
      return { label: `${label} oauth${exp}${more}`, source: "" };
    }

    const labels = order.map((profileId) => {
      const profile = store.profiles[profileId];
      const configProfile = cfg.auth?.profiles?.[profileId];
      const flags: string[] = [];
      if (profileId === nextProfileId) {
        flags.push("next");
      }
      if (lastGood && profileId === lastGood) {
        flags.push("lastGood");
      }
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
        const suffix = formatFlagsSuffix(flags);
        return `${profileId}=missing${suffix}`;
      }
      if (profile.type === "api_key") {
        const keyLabel = resolveStoredCredentialLabel({
          value: profile.key,
          refValue: profile.keyRef,
          mode,
        });
        const suffix = formatFlagsSuffix(flags);
        return `${profileId}=${keyLabel}${suffix}`;
      }
      if (profile.type === "token") {
        const tokenLabel = resolveStoredCredentialLabel({
          value: profile.token,
          refValue: profile.tokenRef,
          mode,
        });
        const expirationFlag = formatExpirationLabel(profile.expires, now, formatUntil, "expired");
        if (expirationFlag) {
          flags.push(expirationFlag);
        }
        const suffix = formatFlagsSuffix(flags);
        return `${profileId}=token:${tokenLabel}${suffix}`;
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
      const expirationFlag = formatExpirationLabel(profile.expires, now, formatUntil, "expired");
      if (expirationFlag) {
        flags.push(expirationFlag);
      }
      const suffixLabel = suffix ? ` ${suffix}` : "";
      const suffixFlags = formatFlagsSuffix(flags);
      return `${profileId}=OAuth${suffixLabel}${suffixFlags}`;
    });
    return {
      label: labels.join(", "),
      source: `auth-profiles.json: ${formatPath(resolveAuthStorePathForDisplay(agentDir))}`,
    };
  }

  const envKey = resolveEnvApiKey(provider, process.env, { config: cfg, workspaceDir });
  if (envKey) {
    const isOAuthEnv =
      envKey.source.includes("ANTHROPIC_OAUTH_TOKEN") ||
      normalizeLowercaseStringOrEmpty(envKey.source).includes("oauth");
    const label = isOAuthEnv ? "OAuth (env)" : maskApiKey(envKey.apiKey);
    return { label, source: mode === "verbose" ? envKey.source : "" };
  }
  const customKey = resolveUsableCustomProviderApiKey({ cfg, provider })?.apiKey;
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
