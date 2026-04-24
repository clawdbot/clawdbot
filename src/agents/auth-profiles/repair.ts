import type { AuthProfileConfig } from "../../config/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { findNormalizedProviderKey, normalizeProviderId } from "../provider-id.js";
import { resolveAuthProfileMetadata } from "./identity.js";
import { dedupeProfileIds, listProfilesForProvider } from "./profile-list.js";
import type { AuthProfileIdRepairResult, AuthProfileStore } from "./types.js";

function getProfileSuffix(profileId: string): string {
  const idx = profileId.indexOf(":");
  if (idx < 0) {
    return "";
  }
  return profileId.slice(idx + 1);
}

function isEmailLike(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed) {
    return false;
  }
  return trimmed.includes("@") && trimmed.includes(".");
}

export function suggestOAuthProfileIdForLegacyDefault(params: {
  cfg?: OpenClawConfig;
  store: AuthProfileStore;
  provider: string;
  legacyProfileId: string;
}): string | null {
  const providerKey = normalizeProviderId(params.provider);
  const legacySuffix = getProfileSuffix(params.legacyProfileId);
  if (legacySuffix !== "default") {
    return null;
  }

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
  if (oauthProfiles.length === 0) {
    return null;
  }

  const configuredEmail = legacyCfg?.email?.trim();
  if (configuredEmail) {
    const byEmail = oauthProfiles.find((id) => {
      const email = resolveAuthProfileMetadata({
        cfg: params.cfg,
        store: params.store,
        profileId: id,
      }).email;
      return email === configuredEmail || id === `${providerKey}:${configuredEmail}`;
    });
    if (byEmail) {
      return byEmail;
    }
  }

  const lastGood = params.store.lastGood?.[providerKey] ?? params.store.lastGood?.[params.provider];
  if (lastGood && oauthProfiles.includes(lastGood)) {
    return lastGood;
  }

  const nonLegacy = oauthProfiles.filter((id) => id !== params.legacyProfileId);
  if (nonLegacy.length === 1) {
    return nonLegacy[0] ?? null;
  }

  const emailLike = nonLegacy.filter((id) => isEmailLike(getProfileSuffix(id)));
  if (emailLike.length === 1) {
    return emailLike[0] ?? null;
  }

  return null;
}

export function repairOAuthProfileIdMismatch(params: {
  cfg: OpenClawConfig;
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

  const { email: toEmail, displayName: toDisplayName } = resolveAuthProfileMetadata({
    store: params.store,
    profileId: toProfileId,
  });
  const { email: _legacyEmail, displayName: _legacyDisplayName, ...legacyCfgRest } = legacyCfg;

  const nextProfiles = {
    ...params.cfg.auth?.profiles,
  } as Record<string, AuthProfileConfig>;
  delete nextProfiles[legacyProfileId];
  nextProfiles[toProfileId] = {
    ...legacyCfgRest,
    ...(toDisplayName ? { displayName: toDisplayName } : {}),
    ...(toEmail ? { email: toEmail } : {}),
  };

  const providerKey = normalizeProviderId(params.provider);
  const nextOrder = (() => {
    const order = params.cfg.auth?.order;
    if (!order) {
      return undefined;
    }
    const resolvedKey = findNormalizedProviderKey(order, providerKey);
    if (!resolvedKey) {
      return order;
    }
    const existing = order[resolvedKey];
    if (!Array.isArray(existing)) {
      return order;
    }
    const replaced = existing
      .map((id) => (id === legacyProfileId ? toProfileId : id))
      .filter((id): id is string => typeof id === "string" && id.trim().length > 0);
    const deduped = dedupeProfileIds(replaced);
    return { ...order, [resolvedKey]: deduped };
  })();

  const nextCfg: OpenClawConfig = {
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
