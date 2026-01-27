import type { MoltbotConfig } from "../../config/config.js";
import type { AuthProfileConfig } from "../../config/types.js";
import { normalizeProviderId } from "../model-selection.js";
import { listProfilesForProvider } from "./profiles.js";
import type { AuthProfileIdRepairResult, AuthProfileStore } from "./types.js";

function getProfileSuffix(profileId: string): string {
  const idx = profileId.indexOf(":");
  if (idx < 0) return "";
  return profileId.slice(idx + 1);
}

function isEmailLike(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed) return false;
  return trimmed.includes("@") && trimmed.includes(".");
}

export function suggestOAuthProfileIdForLegacyDefault(params: {
  cfg?: MoltbotConfig;
  store: AuthProfileStore;
  provider: string;
  legacyProfileId: string;
}): string | null {
  const providerKey = normalizeProviderId(params.provider);
  const legacySuffix = getProfileSuffix(params.legacyProfileId);
  if (legacySuffix !== "default") return null;

  const legacyCfg = params.cfg?.auth?.profiles?.[params.legacyProfileId];
  if (
    legacyCfg &&
    normalizeProviderId(legacyCfg.provider) === providerKey &&
    legacyCfg.mode !== "oauth"
  ) {
    return null;
  }

  const oauthProfiles = listProfilesForProvider(params.store, providerKey).filter(
    (id) => params.store.profiles[id]?.type === "oauth",
  );
  if (oauthProfiles.length === 0) return null;

  const configuredEmail = legacyCfg?.email?.trim();
  if (configuredEmail) {
    const byEmail = oauthProfiles.find((id) => {
      const cred = params.store.profiles[id];
      if (!cred || cred.type !== "oauth") return false;
      const email = (cred.email as string | undefined)?.trim();
      return email === configuredEmail || id === `${providerKey}:${configuredEmail}`;
    });
    if (byEmail) return byEmail;
  }

  const lastGood = params.store.lastGood?.[providerKey] ?? params.store.lastGood?.[params.provider];
  if (lastGood && oauthProfiles.includes(lastGood)) return lastGood;

  const nonLegacy = oauthProfiles.filter((id) => id !== params.legacyProfileId);
  if (nonLegacy.length === 1) return nonLegacy[0] ?? null;

  const emailLike = nonLegacy.filter((id) => isEmailLike(getProfileSuffix(id)));
  if (emailLike.length === 1) return emailLike[0] ?? null;

  return null;
}

export function repairOAuthProfileIdMismatch(params: {
  cfg: MoltbotConfig;
  store: AuthProfileStore;
  provider: string;
  legacyProfileId?: string;
}): AuthProfileIdRepairResult {
  const legacyProfileId =
    params.legacyProfileId ?? `${normalizeProviderId(params.provider)}:default`;
  const legacyCfg = params.cfg.auth?.profiles?.[legacyProfileId];
  if (!legacyCfg) {
    return { config: params.cfg, changes: [], migrated: false };
  }
  if (legacyCfg.mode !== "oauth") {
    return { config: params.cfg, changes: [], migrated: false };
  }
  if (normalizeProviderId(legacyCfg.provider) !== normalizeProviderId(params.provider)) {
    return { config: params.cfg, changes: [], migrated: false };
  }

  const toProfileId = suggestOAuthProfileIdForLegacyDefault({
    cfg: params.cfg,
    store: params.store,
    provider: params.provider,
    legacyProfileId,
  });
  if (!toProfileId || toProfileId === legacyProfileId) {
    return { config: params.cfg, changes: [], migrated: false };
  }

  const toCred = params.store.profiles[toProfileId];
  const toEmail =
    toCred?.type === "oauth" ? (toCred.email as string | undefined)?.trim() : undefined;

  const nextProfiles = {
    ...(params.cfg.auth?.profiles as Record<string, AuthProfileConfig> | undefined),
  } as Record<string, AuthProfileConfig>;
  delete nextProfiles[legacyProfileId];
  nextProfiles[toProfileId] = {
    ...legacyCfg,
    ...(toEmail ? { email: toEmail } : {}),
  };

  const providerKey = normalizeProviderId(params.provider);
  const nextOrder = (() => {
    const order = params.cfg.auth?.order;
    if (!order) return undefined;
    const resolvedKey = Object.keys(order).find((key) => normalizeProviderId(key) === providerKey);
    if (!resolvedKey) return order;
    const existing = order[resolvedKey];
    if (!Array.isArray(existing)) return order;
    const replaced = existing
      .map((id) => (id === legacyProfileId ? toProfileId : id))
      .filter((id): id is string => typeof id === "string" && id.trim().length > 0);
    const deduped: string[] = [];
    for (const entry of replaced) {
      if (!deduped.includes(entry)) deduped.push(entry);
    }
    return { ...order, [resolvedKey]: deduped };
  })();

  const nextCfg: MoltbotConfig = {
    ...params.cfg,
    auth: {
      ...params.cfg.auth,
      profiles: nextProfiles,
      ...(nextOrder ? { order: nextOrder } : {}),
    },
  };

  const changes = [`Auth: migrate ${legacyProfileId} → ${toProfileId} (OAuth profile id)`];

  return {
    config: nextCfg,
    changes,
    migrated: true,
    fromProfileId: legacyProfileId,
    toProfileId,
  };
}
