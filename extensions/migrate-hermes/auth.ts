import { createHash } from "node:crypto";
import {
  loadAuthProfileStoreWithoutExternalProfiles,
  resolveAuthStorePathForDisplay,
} from "openclaw/plugin-sdk/agent-runtime";
import {
  createMigrationItem,
  createMigrationManualItem,
  markMigrationItemConflict,
  markMigrationItemError,
  markMigrationItemSkipped,
} from "openclaw/plugin-sdk/migration";
import type { MigrationItem, MigrationProviderContext } from "openclaw/plugin-sdk/plugin-entry";
import {
  buildOpenAICodexCredentialExtra,
  buildOauthProviderAuthResult,
  resolveOpenAICodexAccessTokenExpiry,
  resolveOpenAICodexAuthIdentity,
  resolveOpenAICodexImportProfileName,
  updateAuthProfileStoreWithLock,
  type AuthProfileStore,
  type OAuthCredential,
  type OpenClawConfig,
  type ProviderAuthResult,
} from "openclaw/plugin-sdk/provider-auth";
import {
  applyAuthProfileConfigWithConflictCheck,
  hasAuthProfileConfigConflict,
  hasCurrentAuthProfileConfigConflict,
  type HermesAuthProfileConfig,
} from "./auth-config.js";
import { isRecord, readString, readText } from "./helpers.js";
import {
  HERMES_REASON_AUTH_PROFILE_EXISTS,
  HERMES_REASON_AUTH_PROFILE_WRITE_FAILED,
  HERMES_REASON_CONFIG_RUNTIME_UNAVAILABLE,
  HERMES_REASON_INCLUDE_SECRETS,
  HERMES_REASON_MISSING_SECRET_METADATA,
  HERMES_REASON_SECRET_NO_LONGER_PRESENT,
} from "./items.js";
import type { HermesSource } from "./source.js";
import type { PlannedTargets } from "./targets.js";

const OPENAI_PROVIDER_ID = "openai";
const OPENAI_DEFAULT_MODEL = "openai/gpt-5.5";
const HERMES_AUTH_DISPLAY_NAME = "Hermes import";

type AgentDefaultModelConfigs = NonNullable<
  NonNullable<NonNullable<OpenClawConfig["agents"]>["defaults"]>["models"]
>;
type AgentDefaultModelConfigEntry = AgentDefaultModelConfigs[string];

type HermesCodexAuthCandidate = {
  access: string;
  accountId?: string;
  refresh: string;
  sourceKind: "opencode-auth-json";
  sourceCredentialIndex?: number;
  sourceLabel: string;
  sourcePath: string;
  updatedAt?: number;
};

type HermesCodexAuthProfile = {
  candidate: HermesCodexAuthCandidate;
  credential: OAuthCredential;
  result: ProviderAuthResult;
  sourceProfileId: string;
};

function authProfileTarget(agentDir: string, profileId: string): string {
  return `${resolveAuthStorePathForDisplay(agentDir)}#${profileId}`;
}

function sourceCredentialFingerprint(candidate: HermesCodexAuthCandidate): string {
  const hash = createHash("sha256");
  for (const part of [
    candidate.sourceKind,
    candidate.accountId ?? "",
    candidate.access,
    candidate.refresh,
  ]) {
    hash.update(part);
    hash.update("\0");
  }
  return hash.digest("hex");
}

async function readOpenCodeOpenAICandidates(
  authPath: string | undefined,
): Promise<HermesCodexAuthCandidate[]> {
  const raw = await readText(authPath);
  if (!raw || !authPath) {
    return [];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!isRecord(parsed)) {
    return [];
  }
  const openai = isRecord(parsed.openai) ? parsed.openai : undefined;
  const access = readString(openai?.access);
  const accountId = readString(openai?.accountId);
  const refresh = readString(openai?.refresh);
  if (!access || !refresh) {
    return [];
  }
  return [
    {
      access,
      ...(accountId ? { accountId } : {}),
      refresh,
      sourceKind: "opencode-auth-json",
      sourceCredentialIndex: 0,
      sourceLabel: "OpenCode OpenAI OAuth credential",
      sourcePath: authPath,
    },
  ];
}

async function hasLegacyHermesAuthJson(authPath: string | undefined): Promise<boolean> {
  const raw = await readText(authPath);
  if (!raw) {
    return false;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    return (
      isRecord(parsed) &&
      (hasLegacyOpenAIOAuthTokenFields(parsed.providers, "providers") ||
        hasLegacyOpenAIOAuthTokenFields(parsed.credential_pool, "credential_pool") ||
        hasLegacyOpenAIOAuthTokenFields(parsed.tokens, "tokens"))
    );
  } catch {
    return false;
  }
}

function hasLegacyOpenAIOAuthTokenFields(value: unknown, keyHint = ""): boolean {
  if (Array.isArray(value)) {
    return value.some((entry) => hasLegacyOpenAIOAuthTokenFields(entry, keyHint));
  }
  if (!isRecord(value)) {
    return false;
  }
  const provider = readString(value.provider)?.toLowerCase();
  const normalizedKeyHint = keyHint.toLowerCase();
  const isOpenAIRecord = normalizedKeyHint.includes("openai") || provider === OPENAI_PROVIDER_ID;
  const hasTokenPair =
    (readString(value.access) && readString(value.refresh)) ||
    (readString(value.access_token) && readString(value.refresh_token));
  if (isOpenAIRecord && hasTokenPair) {
    return true;
  }
  return Object.entries(value).some(([key, entry]) =>
    hasLegacyOpenAIOAuthTokenFields(entry, keyHint ? `${keyHint}.${key}` : key),
  );
}

function buildAuthResult(
  candidate: HermesCodexAuthCandidate,
  fallbackProfileName = "hermes-import",
): ProviderAuthResult {
  const identity = resolveOpenAICodexAuthIdentity({
    access: candidate.access,
    accountId: candidate.accountId,
  });
  return buildOauthProviderAuthResult({
    providerId: OPENAI_PROVIDER_ID,
    defaultModel: OPENAI_DEFAULT_MODEL,
    access: candidate.access,
    refresh: candidate.refresh,
    expires: resolveOpenAICodexAccessTokenExpiry(candidate.access),
    email: identity.email,
    profileName: resolveOpenAICodexImportProfileName(identity, fallbackProfileName),
    displayName: HERMES_AUTH_DISPLAY_NAME,
    credentialExtra: buildOpenAICodexCredentialExtra(identity),
  });
}

function readProviderAuthModelConfigs(result: ProviderAuthResult): AgentDefaultModelConfigs {
  const models = result.configPatch?.agents?.defaults?.models;
  if (isRecord(models)) {
    return { ...models };
  }
  const defaultModel = readString(result.defaultModel) ?? OPENAI_DEFAULT_MODEL;
  return { [defaultModel]: {} };
}

function mergeModelConfigEntry(
  existing: AgentDefaultModelConfigEntry | undefined,
  patch: AgentDefaultModelConfigEntry,
): AgentDefaultModelConfigEntry {
  if (existing && isRecord(existing) && isRecord(patch)) {
    return { ...existing, ...patch } as AgentDefaultModelConfigEntry;
  }
  return existing ?? patch;
}

function applyOAuthModelConfigsToConfig(
  cfg: OpenClawConfig,
  result: ProviderAuthResult,
): OpenClawConfig {
  const patchModels = readProviderAuthModelConfigs(result);
  const existingModels = cfg.agents?.defaults?.models ?? {};
  const models: AgentDefaultModelConfigs = result.replaceDefaultModels
    ? { ...patchModels }
    : { ...existingModels };
  if (!result.replaceDefaultModels) {
    for (const [modelRef, modelConfig] of Object.entries(patchModels)) {
      models[modelRef] = mergeModelConfigEntry(models[modelRef], modelConfig);
    }
  }
  return {
    ...cfg,
    agents: {
      ...cfg.agents,
      defaults: {
        ...cfg.agents?.defaults,
        models,
      },
    },
  };
}

function authProfileDedupeKey(profile: HermesCodexAuthProfile): string {
  if (profile.credential.accountId) {
    return `${profile.credential.provider}:account:${profile.credential.accountId}`;
  }
  if (profile.credential.email) {
    return `${profile.credential.provider}:email:${profile.credential.email}`;
  }
  return `${profile.credential.provider}:profile:${profile.sourceProfileId}`;
}

async function readCodexAuthProfilesFromSource(
  source: HermesSource,
): Promise<HermesCodexAuthProfile[]> {
  const candidates = (await readOpenCodeOpenAICandidates(source.opencodeAuthPath)).toSorted(
    (left, right) => (right.updatedAt ?? 0) - (left.updatedAt ?? 0),
  );
  const profiles: HermesCodexAuthProfile[] = [];
  const seen = new Set<string>();
  for (const [index, candidate] of candidates.entries()) {
    const fallbackProfileName =
      candidates.length === 1 ? "hermes-import" : `hermes-import-${index + 1}`;
    const result = buildAuthResult(candidate, fallbackProfileName);
    const profile = result.profiles[0];
    if (!profile || profile.credential.type !== "oauth") {
      continue;
    }
    const entry = {
      candidate,
      credential: profile.credential,
      result,
      sourceProfileId: profile.profileId,
    };
    const dedupeKey = authProfileDedupeKey(entry);
    if (seen.has(dedupeKey)) {
      continue;
    }
    seen.add(dedupeKey);
    profiles.push(entry);
  }
  return profiles;
}

async function readCodexAuthProfilesFromPath(params: {
  sourcePath: string | undefined;
  sourceKind: unknown;
}): Promise<HermesCodexAuthProfile[]> {
  if (params.sourceKind === "opencode-auth-json") {
    return await readCodexAuthProfilesFromSource({
      root: "",
      archivePaths: [],
      ...(params.sourcePath ? { opencodeAuthPath: params.sourcePath } : {}),
    });
  }
  return [];
}

function findMatchingProfile(
  store: AuthProfileStore,
  credential: OAuthCredential,
): string | undefined {
  for (const [profileId, existing] of Object.entries(store.profiles)) {
    if (existing.type !== "oauth" || existing.provider !== credential.provider) {
      continue;
    }
    if (credential.accountId && existing.accountId === credential.accountId) {
      return profileId;
    }
    const canMatchByEmail = !credential.accountId || !existing.accountId;
    if (canMatchByEmail && credential.email && existing.email === credential.email) {
      return profileId;
    }
  }
  return undefined;
}

function oauthAuthProfileConfig(
  profileId: string,
  credential: OAuthCredential,
): HermesAuthProfileConfig {
  return {
    profileId,
    provider: credential.provider,
    mode: "oauth",
    ...(credential.email ? { email: credential.email } : {}),
    ...(credential.displayName ? { displayName: credential.displayName } : {}),
  };
}

function matchesSourceCredentialFingerprint(
  profile: HermesCodexAuthProfile,
  fingerprint: string,
): boolean {
  return sourceCredentialFingerprint(profile.candidate) === fingerprint;
}

function findPlannedAuthProfile(params: {
  profiles: HermesCodexAuthProfile[];
  sourceProfileId: string;
  sourceCredentialIndex?: number;
  sourceCredentialFingerprint?: string;
}): HermesCodexAuthProfile | undefined {
  const bySourceProfileId = params.profiles.find(
    (entry) => entry.sourceProfileId === params.sourceProfileId,
  );
  const fingerprint = params.sourceCredentialFingerprint;
  if (!fingerprint) {
    return bySourceProfileId;
  }
  if (bySourceProfileId && matchesSourceCredentialFingerprint(bySourceProfileId, fingerprint)) {
    return bySourceProfileId;
  }
  const byIndex =
    params.sourceCredentialIndex === undefined
      ? undefined
      : params.profiles.find(
          (entry) => entry.candidate.sourceCredentialIndex === params.sourceCredentialIndex,
        );
  if (byIndex && matchesSourceCredentialFingerprint(byIndex, fingerprint)) {
    return byIndex;
  }
  return params.profiles.find((entry) => matchesSourceCredentialFingerprint(entry, fingerprint));
}

export async function buildAuthItems(params: {
  ctx: MigrationProviderContext;
  source: HermesSource;
  targets: PlannedTargets;
}): Promise<MigrationItem[]> {
  const items: MigrationItem[] = [];
  if (await hasLegacyHermesAuthJson(params.source.authPath)) {
    items.push(
      createMigrationManualItem({
        id: "manual:legacy-hermes-auth-json",
        source: params.source.authPath ?? "auth.json",
        message:
          "Hermes auth.json contains legacy OAuth credentials. OpenClaw no longer imports those into live auth during Hermes migration.",
        recommendation:
          "Run openclaw models auth login --provider openai after migration, or run openclaw doctor --fix for existing OpenClaw legacy auth state.",
      }),
    );
  }
  const profiles = await readCodexAuthProfilesFromSource(params.source);
  if (profiles.length === 0) {
    return items;
  }
  const store = loadAuthProfileStoreWithoutExternalProfiles(params.targets.agentDir);
  items.push(
    ...profiles.map((profile) => {
      const matchedProfileId = findMatchingProfile(store, profile.credential);
      const profileId = matchedProfileId ?? profile.sourceProfileId;
      const targetExists = Boolean(store.profiles[profileId]);
      const skipped = !params.ctx.includeSecrets;
      const configConflict = hasAuthProfileConfigConflict(
        params.ctx.config,
        oauthAuthProfileConfig(profileId, profile.credential),
        Boolean(params.ctx.overwrite),
      );
      const conflict =
        ((targetExists && !matchedProfileId && !params.ctx.overwrite) || configConflict) &&
        !skipped;
      const itemId =
        profiles.length === 1
          ? `auth:${OPENAI_PROVIDER_ID}`
          : `auth:${OPENAI_PROVIDER_ID}:${profile.sourceProfileId}`;
      return createMigrationItem({
        id: itemId,
        kind: "auth",
        action: skipped ? "skip" : "create",
        source: profile.candidate.sourcePath,
        target: authProfileTarget(params.targets.agentDir, profileId),
        status: skipped ? "skipped" : conflict ? "conflict" : "planned",
        sensitive: true,
        reason: skipped
          ? HERMES_REASON_INCLUDE_SECRETS
          : conflict
            ? HERMES_REASON_AUTH_PROFILE_EXISTS
            : undefined,
        message: skipped
          ? "OpenAI OAuth credentials detected in OpenCode."
          : "Import OpenAI OAuth credentials and configure OpenAI models.",
        details: {
          provider: OPENAI_PROVIDER_ID,
          profileId,
          ...(typeof profile.candidate.sourceCredentialIndex === "number"
            ? { sourceCredentialIndex: profile.candidate.sourceCredentialIndex }
            : {}),
          sourceCredentialFingerprint: sourceCredentialFingerprint(profile.candidate),
          sourceProfileId: profile.sourceProfileId,
          sourceKind: profile.candidate.sourceKind,
          sourceLabel: profile.candidate.sourceLabel,
        },
      });
    }),
  );
  return items;
}

export async function applyAuthItem(
  ctx: MigrationProviderContext,
  item: MigrationItem,
  targets: PlannedTargets,
): Promise<MigrationItem> {
  if (item.status !== "planned") {
    return item;
  }
  const source = item.source;
  const profileId = typeof item.details?.profileId === "string" ? item.details.profileId : "";
  const sourceProfileId =
    typeof item.details?.sourceProfileId === "string" ? item.details.sourceProfileId : profileId;
  const sourceCredentialIndex =
    typeof item.details?.sourceCredentialIndex === "number"
      ? item.details.sourceCredentialIndex
      : undefined;
  const sourceCredentialFingerprintLocal =
    typeof item.details?.sourceCredentialFingerprint === "string"
      ? item.details.sourceCredentialFingerprint
      : undefined;
  if (!source || !profileId) {
    return markMigrationItemError(item, HERMES_REASON_MISSING_SECRET_METADATA);
  }
  const profiles = await readCodexAuthProfilesFromPath({
    sourcePath: source,
    sourceKind: item.details?.sourceKind,
  });
  const profile = findPlannedAuthProfile({
    profiles,
    sourceProfileId,
    ...(sourceCredentialIndex === undefined ? {} : { sourceCredentialIndex }),
    ...(sourceCredentialFingerprintLocal
      ? { sourceCredentialFingerprint: sourceCredentialFingerprintLocal }
      : {}),
  });
  if (!profile) {
    return markMigrationItemSkipped(item, HERMES_REASON_SECRET_NO_LONGER_PRESENT);
  }
  let conflicted = false;
  let wrote = false;
  const credential = {
    ...profile.credential,
    displayName:
      "displayName" in profile.credential && profile.credential.displayName
        ? profile.credential.displayName
        : HERMES_AUTH_DISPLAY_NAME,
  };
  const configProfile = oauthAuthProfileConfig(profileId, credential);
  if (hasCurrentAuthProfileConfigConflict(ctx, configProfile)) {
    return markMigrationItemConflict(item, HERMES_REASON_AUTH_PROFILE_EXISTS);
  }
  const store = await updateAuthProfileStoreWithLock({
    agentDir: targets.agentDir,
    updater: (freshStore) => {
      const existing = freshStore.profiles[profileId];
      if (!ctx.overwrite && existing) {
        const matchedProfileId = findMatchingProfile(freshStore, credential);
        if (matchedProfileId !== profileId) {
          conflicted = true;
          return false;
        }
        return false;
      }
      freshStore.profiles[profileId] = credential;
      wrote = true;
      return true;
    },
  });
  if (conflicted) {
    return markMigrationItemConflict(item, HERMES_REASON_AUTH_PROFILE_EXISTS);
  }
  if (!store?.profiles[profileId]) {
    return markMigrationItemError(item, HERMES_REASON_AUTH_PROFILE_WRITE_FAILED);
  }
  const configResult = await applyAuthProfileConfigWithConflictCheck({
    ctx,
    profile: configProfile,
    applyConfigPatch(config) {
      return applyOAuthModelConfigsToConfig(config, profile.result);
    },
  });
  if (configResult === "conflict") {
    return markMigrationItemConflict(item, HERMES_REASON_AUTH_PROFILE_EXISTS);
  }
  return {
    ...item,
    status: "migrated",
    message:
      configResult === "configured"
        ? item.message
        : `${item.message ?? "Imported auth profile."} ${HERMES_REASON_CONFIG_RUNTIME_UNAVAILABLE}.`,
    details: {
      ...item.details,
      wroteAuthProfile: wrote,
      configUpdated: configResult === "configured",
    },
  };
}
