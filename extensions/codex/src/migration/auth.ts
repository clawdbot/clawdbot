import { loadAuthProfileStoreWithoutExternalProfiles } from "openclaw/plugin-sdk/agent-runtime";
import {
  createMigrationItem,
  markMigrationItemConflict,
  markMigrationItemError,
  markMigrationItemSkipped,
} from "openclaw/plugin-sdk/migration";
import type { MigrationItem, MigrationProviderContext } from "openclaw/plugin-sdk/plugin-entry";
import {
  applyAuthProfileConfig,
  buildApiKeyCredential,
  buildOpenAICodexCredentialExtra,
  buildOauthProviderAuthResult,
  readCodexCliCredentialsCached,
  resolveOpenAICodexAuthIdentity,
  resolveOpenAICodexImportProfileName,
  updateAuthProfileStoreWithLock,
  type AuthProfileStore,
  type OAuthCredential,
  type OpenClawConfig,
  type ProviderAuthResult,
} from "openclaw/plugin-sdk/provider-auth";
import {
  isRecord,
  normalizeOptionalString as readString,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import { readJsonObject } from "./helpers.js";
import type { CodexSource } from "./source.js";
import type { resolveCodexMigrationTargets } from "./targets.js";

const OPENAI_PROVIDER_ID = "openai";
const OPENAI_CODEX_DEFAULT_MODEL = "openai/gpt-5.5";
const CODEX_IMPORT_DISPLAY_NAME = "Codex import";
const CODEX_REASON_AUTH_NOT_SELECTED = "auth credential migration not selected";
const CODEX_REASON_AUTH_PROFILE_EXISTS = "auth profile exists";
const CODEX_REASON_AUTH_PROFILE_WRITE_FAILED = "failed to write auth profile";
const CODEX_REASON_AUTH_NO_LONGER_PRESENT = "auth credential no longer present";
const CODEX_REASON_MISSING_AUTH_METADATA = "missing auth metadata";
const CODEX_CONFIG_PATCH_MODE_RETURN = "return";

type CodexMigrationTargets = ReturnType<typeof resolveCodexMigrationTargets>;
type AgentDefaultModelConfigs = NonNullable<
  NonNullable<NonNullable<OpenClawConfig["agents"]>["defaults"]>["models"]
>;
type AgentDefaultModelConfigEntry = AgentDefaultModelConfigs[string];

type CodexAuthCredential =
  | {
      kind: "oauth";
      provider: typeof OPENAI_PROVIDER_ID;
      profileId: string;
      result: ProviderAuthResult;
      modelConfigs: AgentDefaultModelConfigs;
    }
  | {
      kind: "api_key";
      provider: typeof OPENAI_PROVIDER_ID;
      profileId: string;
      key: string;
    };

type CodexAuthProfileConfig = {
  profileId: string;
  provider: string;
  mode: "api_key" | "oauth";
  email?: string;
  displayName?: string;
};

type CodexAuthConfigApplyResult = "configured" | "conflict" | "unavailable";

class CodexAuthConfigConflict extends Error {}

async function readModelRefs(source: CodexSource): Promise<string[]> {
  const cache = await readJsonObject(source.modelsCachePath);
  const models = Array.isArray(cache.models) ? cache.models : [];
  const refs = new Set<string>();
  for (const model of models) {
    const slug =
      typeof model === "string"
        ? model.trim()
        : isRecord(model)
          ? (readString(model.slug) ?? readString(model.id) ?? readString(model.name))
          : undefined;
    if (!slug) {
      continue;
    }
    refs.add(`${OPENAI_PROVIDER_ID}/${slug}`);
  }
  refs.add(OPENAI_CODEX_DEFAULT_MODEL);
  return [...refs].toSorted();
}

function readProviderAuthModelConfigs(result: ProviderAuthResult): AgentDefaultModelConfigs {
  const models = result.configPatch?.agents?.defaults?.models;
  if (isRecord(models)) {
    return { ...models };
  }
  const defaultModel = readString(result.defaultModel) ?? OPENAI_CODEX_DEFAULT_MODEL;
  return { [defaultModel]: {} };
}

async function buildCodexOAuthCredential(source: CodexSource): Promise<CodexAuthCredential | null> {
  const credential = readCodexCliCredentialsCached({
    codexHome: source.codexHome,
    allowKeychainPrompt: false,
    ttlMs: 0,
  });
  if (!credential) {
    return null;
  }
  const identity = resolveOpenAICodexAuthIdentity({
    access: credential.access,
    accountId: credential.accountId,
  });
  const modelRefs = await readModelRefs(source);
  const configPatch = {
    agents: {
      defaults: {
        models: Object.fromEntries(modelRefs.map((modelRef) => [modelRef, {}])),
      },
    },
  } satisfies Partial<OpenClawConfig>;
  const result = buildOauthProviderAuthResult({
    providerId: OPENAI_PROVIDER_ID,
    defaultModel: OPENAI_CODEX_DEFAULT_MODEL,
    access: credential.access,
    refresh: credential.refresh,
    expires: credential.expires,
    email: identity.email,
    profileName: resolveOpenAICodexImportProfileName(identity, "codex-import"),
    displayName: CODEX_IMPORT_DISPLAY_NAME,
    credentialExtra: buildOpenAICodexCredentialExtra({
      accountId: identity.accountId,
      chatgptPlanType: identity.chatgptPlanType,
      idToken: credential.idToken,
    }),
    configPatch,
  });
  const profile = result.profiles[0];
  return profile
    ? {
        kind: "oauth",
        provider: OPENAI_PROVIDER_ID,
        profileId: profile.profileId,
        result,
        modelConfigs: readProviderAuthModelConfigs(result),
      }
    : null;
}

async function buildCodexApiKeyCredential(
  source: CodexSource,
): Promise<CodexAuthCredential | null> {
  const raw = await readJsonObject(source.authPath);
  const key = readString(raw.OPENAI_API_KEY);
  if (!key) {
    return null;
  }
  return {
    kind: "api_key",
    provider: OPENAI_PROVIDER_ID,
    profileId: "openai:codex-import",
    key,
  };
}

async function readCodexAuthCredentials(source: CodexSource): Promise<CodexAuthCredential[]> {
  const oauth = await buildCodexOAuthCredential(source);
  const apiKey = await buildCodexApiKeyCredential(source);
  return [oauth, apiKey].filter((entry): entry is CodexAuthCredential => entry !== null);
}

function findMatchingOAuthProfile(
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

function findMatchingApiKeyProfile(
  store: AuthProfileStore,
  provider: string,
  key: string,
): string | undefined {
  for (const [profileId, existing] of Object.entries(store.profiles)) {
    if (existing.type === "api_key" && existing.provider === provider && existing.key === key) {
      return profileId;
    }
  }
  return undefined;
}

function itemProfileTarget(
  credential: CodexAuthCredential,
  store: AuthProfileStore,
): { profileId: string; matchedExisting: boolean } {
  if (credential.kind === "oauth") {
    const profile = credential.result.profiles[0];
    const matched =
      profile?.credential.type === "oauth"
        ? findMatchingOAuthProfile(store, profile.credential)
        : undefined;
    return { profileId: matched ?? credential.profileId, matchedExisting: Boolean(matched) };
  }
  const matched = findMatchingApiKeyProfile(store, credential.provider, credential.key);
  return { profileId: matched ?? credential.profileId, matchedExisting: Boolean(matched) };
}

function replaceConfigDraft(draft: OpenClawConfig, next: OpenClawConfig): void {
  for (const key of Object.keys(draft) as Array<keyof OpenClawConfig>) {
    delete draft[key];
  }
  Object.assign(draft, next);
}

function existingAuthProfileConfigIsCompatible(
  existing: NonNullable<NonNullable<OpenClawConfig["auth"]>["profiles"]>[string],
  profile: CodexAuthProfileConfig,
): boolean {
  if (existing.provider !== profile.provider || existing.mode !== profile.mode) {
    return false;
  }
  if (existing.email && profile.email && existing.email !== profile.email) {
    return false;
  }
  return true;
}

function hasAuthProfileConfigConflict(
  config: OpenClawConfig,
  profile: CodexAuthProfileConfig,
  overwrite: boolean,
): boolean {
  if (overwrite) {
    return false;
  }
  const existing = config.auth?.profiles?.[profile.profileId];
  return Boolean(existing && !existingAuthProfileConfigIsCompatible(existing, profile));
}

function hasCurrentAuthProfileConfigConflict(
  ctx: MigrationProviderContext,
  profile: CodexAuthProfileConfig,
): boolean {
  let config = ctx.config;
  try {
    config = (ctx.runtime?.config?.current?.() as OpenClawConfig | undefined) ?? config;
  } catch {
    // Fall back to the planning snapshot; direct config writes recheck inside mutate.
  }
  return hasAuthProfileConfigConflict(config, profile, Boolean(ctx.overwrite));
}

function applyDefaultModelIfMissing(cfg: OpenClawConfig): OpenClawConfig {
  const currentModel = cfg.agents?.defaults?.model;
  const primary =
    typeof currentModel === "string"
      ? currentModel
      : isRecord(currentModel)
        ? readString(currentModel.primary)
        : undefined;
  if (primary) {
    return cfg;
  }
  return {
    ...cfg,
    agents: {
      ...cfg.agents,
      defaults: {
        ...cfg.agents?.defaults,
        model: {
          ...(isRecord(currentModel) ? currentModel : {}),
          primary: OPENAI_CODEX_DEFAULT_MODEL,
        },
      },
    },
  };
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
  credential: Extract<CodexAuthCredential, { kind: "oauth" }>,
): OpenClawConfig {
  const existingModels = cfg.agents?.defaults?.models ?? {};
  const models: AgentDefaultModelConfigs = credential.result.replaceDefaultModels
    ? { ...credential.modelConfigs }
    : { ...existingModels };
  if (!credential.result.replaceDefaultModels) {
    for (const [modelRef, modelConfig] of Object.entries(credential.modelConfigs)) {
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

function applyOAuthConfigToConfig(
  cfg: OpenClawConfig,
  credential: Extract<CodexAuthCredential, { kind: "oauth" }>,
  profileId: string,
): OpenClawConfig {
  let next = applyOAuthModelConfigsToConfig(cfg, credential);
  const profile = credential.result.profiles[0];
  if (profile) {
    next = applyAuthProfileConfig(next, {
      profileId,
      provider: profile.credential.provider,
      mode: "oauth",
      ...("email" in profile.credential && profile.credential.email
        ? { email: profile.credential.email }
        : {}),
      ...("displayName" in profile.credential && profile.credential.displayName
        ? { displayName: profile.credential.displayName }
        : {}),
      preferProfileFirst: false,
    });
  }
  return applyDefaultModelIfMissing(next);
}

function applyApiKeyConfigToConfig(
  cfg: OpenClawConfig,
  credential: Extract<CodexAuthCredential, { kind: "api_key" }>,
  profileId: string,
): OpenClawConfig {
  return applyAuthProfileConfig(cfg, {
    profileId,
    provider: credential.provider,
    mode: "api_key",
    displayName: CODEX_IMPORT_DISPLAY_NAME,
    preferProfileFirst: false,
  });
}

function shouldReturnAuthConfigPatch(ctx: MigrationProviderContext): boolean {
  return ctx.providerOptions?.configPatchMode === CODEX_CONFIG_PATCH_MODE_RETURN;
}

function oauthAuthProfileConfig(
  credential: Extract<CodexAuthCredential, { kind: "oauth" }>,
  profileId: string,
): CodexAuthProfileConfig | null {
  const profile = credential.result.profiles[0];
  if (!profile || profile.credential.type !== "oauth") {
    return null;
  }
  return {
    profileId,
    provider: profile.credential.provider,
    mode: "oauth",
    ...("email" in profile.credential && profile.credential.email
      ? { email: profile.credential.email }
      : {}),
    ...("displayName" in profile.credential && profile.credential.displayName
      ? { displayName: profile.credential.displayName }
      : {}),
  };
}

function apiKeyAuthProfileConfig(
  credential: Extract<CodexAuthCredential, { kind: "api_key" }>,
  profileId: string,
): CodexAuthProfileConfig {
  return {
    profileId,
    provider: credential.provider,
    mode: "api_key",
    displayName: CODEX_IMPORT_DISPLAY_NAME,
  };
}

function authProfileConfigForCredential(
  credential: CodexAuthCredential,
  profileId: string,
): CodexAuthProfileConfig | null {
  return credential.kind === "oauth"
    ? oauthAuthProfileConfig(credential, profileId)
    : apiKeyAuthProfileConfig(credential, profileId);
}

async function applyCodexAuthProfileConfig(
  ctx: MigrationProviderContext,
  profile: CodexAuthProfileConfig,
  applyConfig: (config: OpenClawConfig) => OpenClawConfig,
): Promise<CodexAuthConfigApplyResult> {
  const configApi = ctx.runtime?.config;
  if (!configApi?.current || !configApi.mutateConfigFile) {
    return "unavailable";
  }
  try {
    await configApi.mutateConfigFile({
      base: "runtime",
      afterWrite: { mode: "auto" },
      mutate(draft) {
        const current = draft;
        if (hasAuthProfileConfigConflict(current, profile, Boolean(ctx.overwrite))) {
          throw new CodexAuthConfigConflict();
        }
        const next = applyConfig(current);
        replaceConfigDraft(draft, next);
      },
    });
    return "configured";
  } catch (error) {
    return error instanceof CodexAuthConfigConflict ? "conflict" : "unavailable";
  }
}

async function applyOAuthConfig(
  ctx: MigrationProviderContext,
  credential: Extract<CodexAuthCredential, { kind: "oauth" }>,
  profileId: string,
): Promise<CodexAuthConfigApplyResult> {
  const profile = oauthAuthProfileConfig(credential, profileId);
  if (!profile) {
    return "unavailable";
  }
  return applyCodexAuthProfileConfig(ctx, profile, (config) =>
    applyOAuthConfigToConfig(config, credential, profileId),
  );
}

async function applyApiKeyConfig(
  ctx: MigrationProviderContext,
  credential: Extract<CodexAuthCredential, { kind: "api_key" }>,
  profileId: string,
): Promise<CodexAuthConfigApplyResult> {
  return applyCodexAuthProfileConfig(
    ctx,
    apiKeyAuthProfileConfig(credential, profileId),
    (config) => applyApiKeyConfigToConfig(config, credential, profileId),
  );
}

export async function buildCodexAuthItems(params: {
  ctx: MigrationProviderContext;
  source: CodexSource;
  targets: CodexMigrationTargets;
}): Promise<MigrationItem[]> {
  const credentials = await readCodexAuthCredentials(params.source);
  if (credentials.length === 0) {
    return [];
  }
  const store = loadAuthProfileStoreWithoutExternalProfiles(params.targets.agentDir);
  const skipped = !params.ctx.includeSecrets;
  return credentials.map((credential) => {
    const { profileId, matchedExisting } = itemProfileTarget(credential, store);
    const targetExists = Boolean(store.profiles[profileId]);
    const configProfile = authProfileConfigForCredential(credential, profileId);
    const configConflict = configProfile
      ? hasAuthProfileConfigConflict(
          params.ctx.config,
          configProfile,
          Boolean(params.ctx.overwrite),
        )
      : false;
    const conflict =
      ((targetExists && !matchedExisting && !params.ctx.overwrite) || configConflict) && !skipped;
    return createMigrationItem({
      id: `auth:${credential.provider}`,
      kind: "auth",
      action: skipped ? "skip" : "create",
      source: params.source.authPath,
      target: `${params.targets.agentDir}/auth-profiles.json#${profileId}`,
      status: skipped ? "skipped" : conflict ? "conflict" : "planned",
      sensitive: true,
      reason: skipped
        ? CODEX_REASON_AUTH_NOT_SELECTED
        : conflict
          ? CODEX_REASON_AUTH_PROFILE_EXISTS
          : undefined,
      message:
        credential.kind === "oauth"
          ? "Import Codex OAuth credentials and configure OpenAI Codex models."
          : "Import Codex OpenAI API key.",
      details: {
        provider: credential.provider,
        profileId,
        sourceProfileId: credential.profileId,
        sourceKind: "codex-auth-json",
        credentialKind: credential.kind,
      },
    });
  });
}

export async function applyCodexAuthItem(params: {
  ctx: MigrationProviderContext;
  item: MigrationItem;
  source: CodexSource;
  targets: CodexMigrationTargets;
}): Promise<MigrationItem> {
  const { ctx, item, source, targets } = params;
  if (item.status !== "planned") {
    return item;
  }
  const profileId = typeof item.details?.profileId === "string" ? item.details.profileId : "";
  const provider = typeof item.details?.provider === "string" ? item.details.provider : "";
  const sourceProfileId =
    typeof item.details?.sourceProfileId === "string" ? item.details.sourceProfileId : undefined;
  if (!profileId || !provider) {
    return markMigrationItemError(item, CODEX_REASON_MISSING_AUTH_METADATA);
  }
  const credential = (await readCodexAuthCredentials(source)).find(
    (candidate) => candidate.provider === provider,
  );
  if (!credential) {
    return markMigrationItemSkipped(item, CODEX_REASON_AUTH_NO_LONGER_PRESENT);
  }
  if (credential.kind === "oauth" && sourceProfileId && credential.profileId !== sourceProfileId) {
    return markMigrationItemSkipped(item, CODEX_REASON_AUTH_NO_LONGER_PRESENT);
  }
  const oauthProfile = credential.kind === "oauth" ? credential.result.profiles[0] : undefined;
  const oauthCredential =
    oauthProfile?.credential.type === "oauth" ? oauthProfile.credential : undefined;
  if (credential.kind === "oauth" && !oauthCredential) {
    return markMigrationItemError(item, CODEX_REASON_MISSING_AUTH_METADATA);
  }
  const configProfile = authProfileConfigForCredential(credential, profileId);
  if (!configProfile) {
    return markMigrationItemError(item, CODEX_REASON_MISSING_AUTH_METADATA);
  }
  if (hasCurrentAuthProfileConfigConflict(ctx, configProfile)) {
    return markMigrationItemConflict(item, CODEX_REASON_AUTH_PROFILE_EXISTS);
  }
  let conflicted = false;
  let wrote = false;
  const store = await updateAuthProfileStoreWithLock({
    agentDir: targets.agentDir,
    updater: (freshStore) => {
      const existing = freshStore.profiles[profileId];
      if (!ctx.overwrite && existing) {
        const matchedProfileId =
          credential.kind === "oauth"
            ? findMatchingOAuthProfile(freshStore, oauthCredential!)
            : findMatchingApiKeyProfile(freshStore, credential.provider, credential.key);
        if (matchedProfileId === profileId) {
          return false;
        }
        conflicted = true;
        return false;
      }
      freshStore.profiles[profileId] =
        credential.kind === "oauth"
          ? {
              ...oauthCredential!,
              displayName: CODEX_IMPORT_DISPLAY_NAME,
            }
          : {
              ...buildApiKeyCredential(credential.provider, credential.key),
              displayName: CODEX_IMPORT_DISPLAY_NAME,
            };
      wrote = true;
      return true;
    },
  });
  if (conflicted) {
    return markMigrationItemConflict(item, CODEX_REASON_AUTH_PROFILE_EXISTS);
  }
  if (!store?.profiles[profileId]) {
    return markMigrationItemError(item, CODEX_REASON_AUTH_PROFILE_WRITE_FAILED);
  }
  const configResult = shouldReturnAuthConfigPatch(ctx)
    ? "unavailable"
    : credential.kind === "oauth"
      ? await applyOAuthConfig(ctx, credential, profileId)
      : await applyApiKeyConfig(ctx, credential, profileId);
  if (configResult === "conflict") {
    return markMigrationItemConflict(item, CODEX_REASON_AUTH_PROFILE_EXISTS);
  }
  return {
    ...item,
    status: "migrated",
    details: {
      ...item.details,
      wroteAuthProfile: wrote,
      configUpdated: configResult === "configured",
      ...(shouldReturnAuthConfigPatch(ctx) ? { configPatchReturned: true } : {}),
    },
  };
}

export async function buildCodexAuthConfigPatchItems(params: {
  ctx: MigrationProviderContext;
  item: MigrationItem;
  source: CodexSource;
}): Promise<MigrationItem[]> {
  const { ctx, item, source } = params;
  if (item.status !== "migrated" || !shouldReturnAuthConfigPatch(ctx)) {
    return [];
  }
  const profileId = typeof item.details?.profileId === "string" ? item.details.profileId : "";
  const provider = typeof item.details?.provider === "string" ? item.details.provider : "";
  const sourceProfileId =
    typeof item.details?.sourceProfileId === "string" ? item.details.sourceProfileId : undefined;
  if (!profileId || !provider) {
    return [];
  }
  const credential = (await readCodexAuthCredentials(source)).find(
    (candidate) => candidate.provider === provider,
  );
  if (!credential) {
    return [];
  }
  if (credential.kind === "oauth" && sourceProfileId && credential.profileId !== sourceProfileId) {
    return [];
  }
  const next =
    credential.kind === "oauth"
      ? applyOAuthConfigToConfig(ctx.config, credential, profileId)
      : applyApiKeyConfigToConfig(ctx.config, credential, profileId);
  const items: MigrationItem[] = [];
  if (next.auth) {
    items.push(
      createMigrationItem({
        id: `${item.id}:config:auth`,
        kind: "config",
        action: "merge",
        status: "migrated",
        target: "auth",
        message: "Configure imported Codex auth profile.",
        details: {
          path: ["auth"],
          value: next.auth,
        },
      }),
    );
  }
  if (next.agents?.defaults) {
    items.push(
      createMigrationItem({
        id: `${item.id}:config:agents-defaults`,
        kind: "config",
        action: "merge",
        status: "migrated",
        target: "agents.defaults",
        message: "Configure imported Codex models.",
        details: {
          path: ["agents", "defaults"],
          value: next.agents.defaults,
        },
      }),
    );
  }
  return items;
}
