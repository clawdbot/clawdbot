import { splitTrailingAuthProfile } from "../agents/model-ref-profile.js";
import { collectConfiguredModelRefs } from "../config/model-refs.js";
import type { AuthProfileConfig } from "../config/types.auth.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "../shared/string-coerce.js";
import { isRecord } from "../utils.js";

const AUTH_PROFILE_MODES = new Set<AuthProfileConfig["mode"]>([
  "api_key",
  "aws-sdk",
  "oauth",
  "token",
]);

export type AuthProfileConfigProtectionResult = {
  config: OpenClawConfig;
  repairs: string[];
  warnings: string[];
};

function normalizeProviderId(value: unknown): string {
  return normalizeLowercaseStringOrEmpty(value);
}

function normalizeProfileId(value: unknown): string | null {
  return normalizeOptionalString(value) ?? null;
}

function normalizeMode(value: unknown): AuthProfileConfig["mode"] | null {
  return typeof value === "string" && AUTH_PROFILE_MODES.has(value as AuthProfileConfig["mode"])
    ? (value as AuthProfileConfig["mode"])
    : null;
}

function extractProviderFromModelRef(value: string): string | null {
  const { model } = splitTrailingAuthProfile(value);
  const slash = model.indexOf("/");
  if (slash <= 0) {
    return null;
  }
  return normalizeProviderId(model.slice(0, slash)) || null;
}

function extractProviderFromProfileId(profileId: string): string | null {
  const colon = profileId.indexOf(":");
  if (colon <= 0) {
    return null;
  }
  return normalizeProviderId(profileId.slice(0, colon)) || null;
}

function collectActiveAuthHints(config: OpenClawConfig): {
  activeProviders: Set<string>;
  explicitProfileIds: Set<string>;
  explicitProfileProviders: Map<string, Set<string>>;
} {
  const activeProviders = new Set<string>();
  const explicitProfileIds = new Set<string>();
  const explicitProfileProviders = new Map<string, Set<string>>();

  const models = isRecord(config.models) ? config.models : {};
  const providers = isRecord(models.providers) ? models.providers : {};
  for (const providerId of Object.keys(providers)) {
    const normalized = normalizeProviderId(providerId);
    if (normalized) {
      activeProviders.add(normalized);
    }
  }

  for (const { value } of collectConfiguredModelRefs(config)) {
    const { profile } = splitTrailingAuthProfile(value);
    const provider = extractProviderFromModelRef(value);
    if (profile) {
      explicitProfileIds.add(profile);
      if (provider) {
        const providers = explicitProfileProviders.get(profile) ?? new Set<string>();
        providers.add(provider);
        explicitProfileProviders.set(profile, providers);
      }
    }
    if (provider) {
      activeProviders.add(provider);
    }
  }

  const auth = isRecord(config.auth) ? config.auth : {};
  const order = isRecord(auth.order) ? auth.order : {};
  for (const [providerId, profileIds] of Object.entries(order)) {
    const provider = normalizeProviderId(providerId);
    if (!provider || !activeProviders.has(provider) || !Array.isArray(profileIds)) {
      continue;
    }
    for (const profileId of profileIds) {
      const normalized = normalizeProfileId(profileId);
      if (normalized) {
        explicitProfileIds.add(normalized);
      }
    }
  }

  return { activeProviders, explicitProfileIds, explicitProfileProviders };
}

function isValidProfileMetadata(value: unknown): value is AuthProfileConfig {
  if (!isRecord(value)) {
    return false;
  }
  return normalizeProviderId(value.provider) !== "" && normalizeMode(value.mode) !== null;
}

function buildProfileMetadata(params: {
  profileId: string;
  before: unknown;
  after: unknown;
  providerHint?: string;
}): AuthProfileConfig | null {
  const before = isRecord(params.before) ? params.before : {};
  const after = isRecord(params.after) ? params.after : {};
  const provider =
    normalizeProviderId(after.provider) ||
    normalizeProviderId(before.provider) ||
    extractProviderFromProfileId(params.profileId) ||
    normalizeProviderId(params.providerHint);
  if (!provider) {
    return null;
  }
  const mode = normalizeMode(after.mode) ?? normalizeMode(before.mode) ?? "api_key";
  const repaired: AuthProfileConfig = { provider, mode };
  const email = normalizeOptionalString(after.email) ?? normalizeOptionalString(before.email);
  const displayName =
    normalizeOptionalString(after.displayName) ?? normalizeOptionalString(before.displayName);
  if (email) {
    repaired.email = email;
  }
  if (displayName) {
    repaired.displayName = displayName;
  }
  return repaired;
}

function ensureAuthProfiles(config: OpenClawConfig): Record<string, AuthProfileConfig> {
  const root = config as Record<string, unknown>;
  const auth: Record<string, unknown> = isRecord(root.auth) ? root.auth : {};
  if (root.auth !== auth) {
    root.auth = auth;
  }
  if (!isRecord(auth.profiles)) {
    auth.profiles = {};
  }
  return auth.profiles as Record<string, AuthProfileConfig>;
}

export function protectActiveAuthProfileConfig(params: {
  before: OpenClawConfig;
  after: OpenClawConfig;
}): AuthProfileConfigProtectionResult {
  const { activeProviders, explicitProfileIds, explicitProfileProviders } = collectActiveAuthHints(
    params.before,
  );
  const beforeAuth = isRecord(params.before.auth) ? params.before.auth : {};
  const beforeProfiles = isRecord(beforeAuth.profiles) ? beforeAuth.profiles : {};
  if (Object.keys(beforeProfiles).length === 0) {
    return { config: params.after, repairs: [], warnings: [] };
  }

  const config = structuredClone(params.after);
  const afterAuth = isRecord(config.auth) ? config.auth : {};
  const afterProfiles = isRecord(afterAuth.profiles) ? afterAuth.profiles : {};
  const repairs: string[] = [];
  const warnings: string[] = [];

  for (const [profileId, beforeProfile] of Object.entries(beforeProfiles)) {
    const afterProfile = afterProfiles[profileId];
    const afterProfileRecord = isRecord(afterProfile) ? afterProfile : null;
    const beforeProfileRecord = isRecord(beforeProfile) ? beforeProfile : null;
    if (isValidProfileMetadata(afterProfile)) {
      continue;
    }
    const provider =
      normalizeProviderId(afterProfileRecord?.provider) ||
      normalizeProviderId(beforeProfileRecord?.provider) ||
      extractProviderFromProfileId(profileId);
    const protectsActiveProvider = !!provider && activeProviders.has(provider);
    const protectsExplicitProfile = explicitProfileIds.has(profileId);
    if (!protectsActiveProvider && !protectsExplicitProfile) {
      continue;
    }

    const repaired = buildProfileMetadata({
      profileId,
      before: beforeProfile,
      after: afterProfile,
      providerHint:
        explicitProfileProviders.get(profileId)?.size === 1
          ? [...(explicitProfileProviders.get(profileId) ?? [])][0]
          : undefined,
    });
    if (!repaired) {
      warnings.push(
        `auth.profiles.${profileId}: active auth profile metadata could not be inferred; repair manually before running doctor --fix.`,
      );
      continue;
    }
    const profiles = ensureAuthProfiles(config);
    profiles[profileId] = repaired;
    repairs.push(
      `Repaired auth.profiles.${profileId} metadata for active ${repaired.provider} auth.`,
    );
  }

  return { config, repairs, warnings };
}
