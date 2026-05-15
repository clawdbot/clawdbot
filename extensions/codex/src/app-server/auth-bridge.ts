import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import {
  ensureAuthProfileStore,
  ensureAuthProfileStoreWithoutExternalProfiles,
  loadAuthProfileStoreForSecretsRuntime,
  refreshOAuthCredentialForRuntime,
  resolveAuthProfileOrder,
  resolveProviderIdForAuth,
  resolveApiKeyForProfile,
  resolveDefaultAgentDir,
  resolvePersistedAuthProfileOwnerAgentDir,
  type AuthProfileCredential,
  type AuthProfileStore,
  type OAuthCredential,
} from "openclaw/plugin-sdk/agent-runtime";
import type { CodexAppServerClient } from "./client.js";
import type { CodexAppServerStartOptions } from "./config.js";
import type {
  CodexChatgptAuthTokensRefreshResponse,
  CodexGetAccountResponse,
  CodexLoginAccountParams,
} from "./protocol.js";
import { resolveCodexAppServerSpawnEnv } from "./transport-stdio.js";

const CODEX_APP_SERVER_AUTH_PROVIDER = "openai-codex";
const OPENAI_PROVIDER = "openai";
const OPENAI_CODEX_DEFAULT_PROFILE_ID = "openai-codex:default";
const CODEX_HOME_ENV_VAR = "CODEX_HOME";
const HOME_ENV_VAR = "HOME";
const CODEX_APP_SERVER_HOME_DIRNAME = "codex-home";
const CODEX_APP_SERVER_NATIVE_HOME_DIRNAME = "home";
const CODEX_API_KEY_ENV_VAR = "CODEX_API_KEY";
const OPENAI_API_KEY_ENV_VAR = "OPENAI_API_KEY";
const CODEX_APP_SERVER_API_KEY_ENV_VARS = [CODEX_API_KEY_ENV_VAR, OPENAI_API_KEY_ENV_VAR];
const CODEX_APP_SERVER_HOME_ENV_VARS = [CODEX_HOME_ENV_VAR, HOME_ENV_VAR];

type AuthProfileOrderConfig = Parameters<typeof resolveAuthProfileOrder>[0]["cfg"];

export async function bridgeCodexAppServerStartOptions(params: {
  startOptions: CodexAppServerStartOptions;
  agentDir: string;
  authProfileId?: string | null;
  config?: AuthProfileOrderConfig;
}): Promise<CodexAppServerStartOptions> {
  if (params.startOptions.transport !== "stdio") {
    return params.startOptions;
  }
  const isolatedStartOptions = await withAgentCodexHomeEnvironment(
    params.startOptions,
    params.agentDir,
  );
  if (params.authProfileId === null) {
    return isolatedStartOptions;
  }
  const store = ensureCodexAppServerAuthProfileStore({
    agentDir: params.agentDir,
    authProfileId: params.authProfileId,
    config: params.config,
  });
  const authProfileId = resolveCodexAppServerAuthProfileId({
    authProfileId: params.authProfileId,
    store,
    config: params.config,
  });
  const shouldClearInheritedOpenAiApiKey = shouldClearOpenAiApiKeyForCodexAuthProfile({
    store,
    authProfileId,
    config: params.config,
  });
  return shouldClearInheritedOpenAiApiKey
    ? withClearedEnvironmentVariables(isolatedStartOptions, CODEX_APP_SERVER_API_KEY_ENV_VARS)
    : isolatedStartOptions;
}

export function resolveCodexAppServerAuthProfileId(params: {
  authProfileId?: string;
  store: ReturnType<typeof ensureAuthProfileStore>;
  config?: AuthProfileOrderConfig;
}): string | undefined {
  const requested = params.authProfileId?.trim();
  if (requested) {
    return requested;
  }
  return resolveAuthProfileOrder({
    cfg: params.config,
    store: params.store,
    provider: CODEX_APP_SERVER_AUTH_PROVIDER,
  })[0]?.trim();
}

export function resolveCodexAppServerAuthProfileIdForAgent(params: {
  authProfileId?: string;
  agentDir?: string;
  config?: AuthProfileOrderConfig;
}): string | undefined {
  const agentDir = params.agentDir?.trim() || resolveDefaultAgentDir(params.config ?? {});
  const store = ensureCodexAppServerAuthProfileStore({
    agentDir,
    authProfileId: params.authProfileId,
    config: params.config,
  });
  return resolveCodexAppServerAuthProfileId({
    authProfileId: params.authProfileId,
    store,
    config: params.config,
  });
}

function ensureCodexAppServerAuthProfileStore(params: {
  agentDir?: string;
  authProfileId?: string;
  config?: AuthProfileOrderConfig;
}): ReturnType<typeof ensureAuthProfileStore> {
  return ensureAuthProfileStore(params.agentDir, {
    allowKeychainPrompt: false,
    config: params.config,
    externalCliProviderIds: [CODEX_APP_SERVER_AUTH_PROVIDER],
    ...(params.authProfileId ? { externalCliProfileIds: [params.authProfileId] } : {}),
  });
}

function resolveCodexAppServerAuthProfileStore(params: {
  agentDir?: string;
  authProfileId?: string;
  authProfileStore?: AuthProfileStore;
  config?: AuthProfileOrderConfig;
}): AuthProfileStore {
  const overlaidStore = ensureCodexAppServerAuthProfileStore({
    agentDir: params.agentDir,
    authProfileId: params.authProfileId,
    config: params.config,
  });
  if (!params.authProfileStore) {
    return overlaidStore;
  }
  const order =
    params.authProfileStore.order || overlaidStore.order
      ? {
          ...overlaidStore.order,
          ...params.authProfileStore.order,
        }
      : undefined;
  return {
    ...params.authProfileStore,
    ...(order ? { order } : {}),
    profiles: {
      ...overlaidStore.profiles,
      ...params.authProfileStore.profiles,
    },
  };
}

export async function resolveCodexAppServerAuthAccountCacheKey(params: {
  authProfileId?: string;
  authProfileStore?: AuthProfileStore;
  agentDir?: string;
  config?: AuthProfileOrderConfig;
}): Promise<string | undefined> {
  const agentDir = params.agentDir?.trim() || resolveDefaultAgentDir(params.config ?? {});
  const store = resolveCodexAppServerAuthProfileStore({
    agentDir,
    authProfileId: params.authProfileId,
    authProfileStore: params.authProfileStore,
    config: params.config,
  });
  const profileId = resolveCodexAppServerAuthProfileId({
    authProfileId: params.authProfileId,
    store,
    config: params.config,
  });
  if (!profileId) {
    return undefined;
  }
  const credential = store.profiles[profileId];
  if (!credential || !isCodexAppServerAuthProfileCredential(credential, params.config)) {
    return undefined;
  }
  if (credential.type === "api_key") {
    const resolved = await resolveApiKeyForProfile({
      store,
      profileId,
      agentDir,
    });
    const apiKey = resolved?.apiKey?.trim();
    return apiKey
      ? `${resolveChatgptAccountId(profileId, credential)}:${fingerprintApiKeyAuthProfileCacheKey(apiKey)}`
      : resolveChatgptAccountId(profileId, credential);
  }
  if (credential.type === "token") {
    const resolved = await resolveApiKeyForProfile({
      store,
      profileId,
      agentDir,
    });
    const accessToken = resolved?.apiKey?.trim();
    return accessToken
      ? `${resolveChatgptAccountId(profileId, credential)}:${fingerprintTokenAuthProfileCacheKey(accessToken)}`
      : resolveChatgptAccountId(profileId, credential);
  }
  return resolveChatgptAccountId(profileId, credential);
}

export function resolveCodexAppServerEnvApiKeyCacheKey(params: {
  startOptions: Pick<CodexAppServerStartOptions, "transport" | "env" | "clearEnv">;
  baseEnv?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
}): string | undefined {
  if (params.startOptions.transport !== "stdio") {
    return undefined;
  }
  const env = resolveCodexAppServerSpawnEnv(
    params.startOptions,
    params.baseEnv ?? process.env,
    params.platform ?? process.platform,
  );
  const apiKey = readFirstNonEmptyEnvEntry(env, CODEX_APP_SERVER_API_KEY_ENV_VARS);
  if (!apiKey) {
    return undefined;
  }
  const hash = createHash("sha256");
  hash.update("openclaw:codex:app-server-env-api-key:v1");
  hash.update("\0");
  hash.update(apiKey.key);
  hash.update("\0");
  hash.update(apiKey.value);
  return `${apiKey.key}:sha256:${hash.digest("hex")}`;
}

function fingerprintApiKeyAuthProfileCacheKey(apiKey: string): string {
  const hash = createHash("sha256");
  hash.update("openclaw:codex:app-server-auth-profile-api-key:v1");
  hash.update("\0");
  hash.update(apiKey);
  return `api_key:sha256:${hash.digest("hex")}`;
}

function fingerprintTokenAuthProfileCacheKey(accessToken: string): string {
  const hash = createHash("sha256");
  hash.update("openclaw:codex:app-server-auth-profile-token:v1");
  hash.update("\0");
  hash.update(accessToken);
  return `token:sha256:${hash.digest("hex")}`;
}

export function resolveCodexAppServerHomeDir(agentDir: string): string {
  return path.join(path.resolve(agentDir), CODEX_APP_SERVER_HOME_DIRNAME);
}

export function resolveCodexAppServerNativeHomeDir(agentDir: string): string {
  return path.join(resolveCodexAppServerHomeDir(agentDir), CODEX_APP_SERVER_NATIVE_HOME_DIRNAME);
}

async function withAgentCodexHomeEnvironment(
  startOptions: CodexAppServerStartOptions,
  agentDir: string,
): Promise<CodexAppServerStartOptions> {
  const codexHome = startOptions.env?.[CODEX_HOME_ENV_VAR]?.trim()
    ? startOptions.env[CODEX_HOME_ENV_VAR]
    : resolveCodexAppServerHomeDir(agentDir);
  const nativeHome = startOptions.env?.[HOME_ENV_VAR]?.trim()
    ? startOptions.env[HOME_ENV_VAR]
    : undefined;
  await fs.mkdir(codexHome, { recursive: true });
  if (nativeHome) {
    await fs.mkdir(nativeHome, { recursive: true });
  }
  const nextStartOptions: CodexAppServerStartOptions = {
    ...startOptions,
    env: {
      ...startOptions.env,
      [CODEX_HOME_ENV_VAR]: codexHome,
      ...(nativeHome ? { [HOME_ENV_VAR]: nativeHome } : {}),
    },
  };
  const clearEnv = withoutClearedCodexHomeEnv(startOptions.clearEnv);
  if (clearEnv) {
    nextStartOptions.clearEnv = clearEnv;
  } else {
    delete nextStartOptions.clearEnv;
  }
  return nextStartOptions;
}

function withoutClearedCodexHomeEnv(clearEnv: string[] | undefined): string[] | undefined {
  if (!clearEnv) {
    return undefined;
  }
  const reserved = new Set(CODEX_APP_SERVER_HOME_ENV_VARS);
  const filtered = clearEnv.filter((envVar) => !reserved.has(envVar.trim().toUpperCase()));
  return filtered.length === clearEnv.length ? clearEnv : filtered;
}

export async function applyCodexAppServerAuthProfile(params: {
  client: CodexAppServerClient;
  agentDir: string;
  authProfileId?: string | null;
  startOptions?: CodexAppServerStartOptions;
  config?: AuthProfileOrderConfig;
}): Promise<void> {
  if (params.authProfileId === null) {
    return;
  }
  const loginParams = await resolveCodexAppServerAuthProfileLoginParams({
    agentDir: params.agentDir,
    authProfileId: params.authProfileId,
    config: params.config,
  });
  if (!loginParams) {
    if (params.startOptions?.transport !== "stdio") {
      return;
    }
    const env = resolveCodexAppServerSpawnEnv(params.startOptions, process.env);
    const fallbackLoginParams = await resolveCodexAppServerEnvApiKeyLoginParams({
      client: params.client,
      env,
    });
    if (fallbackLoginParams) {
      await params.client.request("account/login/start", fallbackLoginParams);
    }
    return;
  }
  await params.client.request("account/login/start", loginParams);
}

function resolveCodexAppServerAuthProfileLoginParams(params: {
  agentDir: string;
  authProfileId?: string;
  config?: AuthProfileOrderConfig;
}): Promise<CodexLoginAccountParams | undefined> {
  return resolveCodexAppServerAuthProfileLoginParamsInternal(params);
}

export async function refreshCodexAppServerAuthTokens(params: {
  agentDir: string;
  authProfileId?: string;
  config?: AuthProfileOrderConfig;
}): Promise<CodexChatgptAuthTokensRefreshResponse> {
  const loginParams = await resolveCodexAppServerAuthProfileLoginParamsInternal({
    ...params,
    forceOAuthRefresh: true,
  });
  if (!loginParams || loginParams.type !== "chatgptAuthTokens") {
    throw new Error("Codex app-server ChatGPT token refresh requires an OAuth auth profile.");
  }
  return {
    accessToken: loginParams.accessToken,
    chatgptAccountId: loginParams.chatgptAccountId,
    chatgptPlanType: loginParams.chatgptPlanType ?? null,
  };
}

async function resolveCodexAppServerAuthProfileLoginParamsInternal(params: {
  agentDir: string;
  authProfileId?: string;
  forceOAuthRefresh?: boolean;
  config?: AuthProfileOrderConfig;
}): Promise<CodexLoginAccountParams | undefined> {
  const store = ensureCodexAppServerAuthProfileStore({
    agentDir: params.agentDir,
    authProfileId: params.authProfileId,
    config: params.config,
  });
  const profileId = resolveCodexAppServerAuthProfileId({
    authProfileId: params.authProfileId,
    store,
    config: params.config,
  });
  if (!profileId) {
    return undefined;
  }
  const credential = store.profiles[profileId];
  if (!credential) {
    throw new Error(`Codex app-server auth profile "${profileId}" was not found.`);
  }
  if (!isCodexAppServerAuthProfileCredential(credential, params.config)) {
    throw new Error(
      `Codex app-server auth profile "${profileId}" must be OpenAI Codex auth or an OpenAI API-key backup.`,
    );
  }
  const loginParams = await resolveLoginParamsForCredential(profileId, credential, {
    agentDir: params.agentDir,
    forceOAuthRefresh: params.forceOAuthRefresh === true,
    config: params.config,
  });
  if (!loginParams) {
    throw new Error(
      `Codex app-server auth profile "${profileId}" does not contain usable credentials.`,
    );
  }
  return loginParams;
}

async function resolveCodexAppServerEnvApiKeyLoginParams(params: {
  client: CodexAppServerClient;
  env: NodeJS.ProcessEnv;
}): Promise<CodexLoginAccountParams | undefined> {
  const apiKey = readFirstNonEmptyEnv(params.env, CODEX_APP_SERVER_API_KEY_ENV_VARS);
  if (!apiKey) {
    return undefined;
  }
  const response = await params.client.request<CodexGetAccountResponse>("account/read", {
    refreshToken: false,
  });
  if (response.account || !response.requiresOpenaiAuth) {
    return undefined;
  }
  return { type: "apiKey", apiKey };
}

async function resolveLoginParamsForCredential(
  profileId: string,
  credential: AuthProfileCredential,
  params: { agentDir: string; forceOAuthRefresh: boolean; config?: AuthProfileOrderConfig },
): Promise<CodexLoginAccountParams | undefined> {
  if (credential.type === "api_key") {
    const resolved = await resolveApiKeyForProfile({
      store: ensureAuthProfileStore(params.agentDir, { allowKeychainPrompt: false }),
      profileId,
      agentDir: params.agentDir,
    });
    const apiKey = resolved?.apiKey?.trim();
    return apiKey ? { type: "apiKey", apiKey } : undefined;
  }
  if (credential.type === "token") {
    const resolved = await resolveApiKeyForProfile({
      store: ensureAuthProfileStore(params.agentDir, { allowKeychainPrompt: false }),
      profileId,
      agentDir: params.agentDir,
    });
    const accessToken = resolved?.apiKey?.trim();
    return accessToken
      ? buildChatgptAuthTokensParams(profileId, credential, accessToken)
      : undefined;
  }
  if (credential.type !== "oauth") {
    return undefined;
  }
  const resolvedCredential = await resolveOAuthCredentialForCodexAppServer(profileId, credential, {
    agentDir: params.agentDir,
    forceRefresh: params.forceOAuthRefresh,
    config: params.config,
  });
  const accessToken = resolvedCredential.access?.trim();
  return accessToken
    ? buildChatgptAuthTokensParams(profileId, resolvedCredential, accessToken)
    : undefined;
}

async function resolveOAuthCredentialForCodexAppServer(
  profileId: string,
  credential: OAuthCredential,
  params: { agentDir: string; forceRefresh: boolean; config?: AuthProfileOrderConfig },
): Promise<OAuthCredential> {
  const ownerAgentDir = resolvePersistedAuthProfileOwnerAgentDir({
    agentDir: params.agentDir,
    profileId,
  });
  const store = ensureCodexAppServerAuthProfileStore({
    agentDir: ownerAgentDir,
    authProfileId: profileId,
    config: params.config,
  });
  const persistedStore = ensureAuthProfileStoreWithoutExternalProfiles(ownerAgentDir, {
    allowKeychainPrompt: false,
  });
  const persistedCredential = persistedStore.profiles[profileId];
  const persistedOAuthCredential =
    persistedCredential?.type === "oauth" &&
    isCodexAppServerAuthProvider(persistedCredential.provider, params.config)
      ? persistedCredential
      : undefined;
  const ownerCredential = store.profiles[profileId];
  const overlaidOAuthCredential =
    ownerCredential?.type === "oauth" &&
    isCodexAppServerAuthProvider(ownerCredential.provider, params.config)
      ? ownerCredential
      : undefined;
  if (params.forceRefresh && !persistedOAuthCredential && overlaidOAuthCredential) {
    const refreshedRuntimeCredential = await refreshOAuthCredentialForRuntime({
      credential: overlaidOAuthCredential,
    });
    if (!refreshedRuntimeCredential?.access?.trim()) {
      throw new Error(`Codex app-server auth profile "${profileId}" could not refresh.`);
    }
    store.profiles[profileId] = refreshedRuntimeCredential;
    return refreshedRuntimeCredential;
  }
  const resolved = await resolveApiKeyForProfile({
    store,
    profileId,
    agentDir: ownerAgentDir,
    forceRefresh: params.forceRefresh && Boolean(persistedOAuthCredential),
  });
  const refreshed = loadAuthProfileStoreForSecretsRuntime(ownerAgentDir).profiles[profileId];
  const storedCredential = store.profiles[profileId];
  const candidate =
    refreshed?.type === "oauth" && isCodexAppServerAuthProvider(refreshed.provider, params.config)
      ? refreshed
      : storedCredential?.type === "oauth" &&
          isCodexAppServerAuthProvider(storedCredential.provider, params.config)
        ? storedCredential
        : credential;
  return resolved?.apiKey ? { ...candidate, access: resolved.apiKey } : candidate;
}

function isCodexAppServerAuthProvider(provider: string, config?: AuthProfileOrderConfig): boolean {
  return resolveProviderIdForAuth(provider, { config }) === CODEX_APP_SERVER_AUTH_PROVIDER;
}

function isOpenAIApiKeyBackupCredential(
  credential: AuthProfileCredential,
  config?: AuthProfileOrderConfig,
): boolean {
  return (
    credential.type === "api_key" &&
    resolveProviderIdForAuth(credential.provider, { config }) === OPENAI_PROVIDER
  );
}

function isCodexAppServerAuthProfileCredential(
  credential: AuthProfileCredential,
  config?: AuthProfileOrderConfig,
): boolean {
  return (
    isCodexAppServerAuthProvider(credential.provider, config) ||
    isOpenAIApiKeyBackupCredential(credential, config)
  );
}

function shouldClearOpenAiApiKeyForCodexAuthProfile(params: {
  store: ReturnType<typeof ensureAuthProfileStore>;
  authProfileId?: string;
  config?: AuthProfileOrderConfig;
}): boolean {
  const profileId = params.authProfileId?.trim();
  const credential = profileId
    ? params.store.profiles[profileId]
    : params.store.profiles[OPENAI_CODEX_DEFAULT_PROFILE_ID];
  return isCodexSubscriptionCredential(credential, params.config);
}

function isCodexSubscriptionCredential(
  credential: AuthProfileCredential | undefined,
  config?: AuthProfileOrderConfig,
): boolean {
  if (!credential || !isCodexAppServerAuthProvider(credential.provider, config)) {
    return false;
  }
  return credential.type === "oauth" || credential.type === "token";
}

function withClearedEnvironmentVariables(
  startOptions: CodexAppServerStartOptions,
  envVars: readonly string[],
): CodexAppServerStartOptions {
  const clearEnv = startOptions.clearEnv ?? [];
  const missingEnvVars = envVars.filter((envVar) => !clearEnv.includes(envVar));
  if (missingEnvVars.length === 0) {
    return startOptions;
  }
  return {
    ...startOptions,
    clearEnv: [...clearEnv, ...missingEnvVars],
  };
}

function readFirstNonEmptyEnv(env: NodeJS.ProcessEnv, keys: readonly string[]): string | undefined {
  return readFirstNonEmptyEnvEntry(env, keys)?.value;
}

function readFirstNonEmptyEnvEntry(
  env: NodeJS.ProcessEnv,
  keys: readonly string[],
): { key: string; value: string } | undefined {
  for (const key of keys) {
    const value = env[key]?.trim();
    if (value) {
      return { key, value };
    }
  }
  return undefined;
}

function buildChatgptAuthTokensParams(
  profileId: string,
  credential: AuthProfileCredential,
  accessToken: string,
): CodexLoginAccountParams {
  return {
    type: "chatgptAuthTokens",
    accessToken,
    chatgptAccountId: resolveChatgptAccountId(profileId, credential),
    chatgptPlanType: resolveChatgptPlanType(credential),
  };
}

function resolveChatgptPlanType(credential: AuthProfileCredential): string | null {
  const record = credential as Record<string, unknown>;
  const planType = record.chatgptPlanType ?? record.planType;
  return typeof planType === "string" && planType.trim() ? planType.trim() : null;
}

function resolveChatgptAccountId(profileId: string, credential: AuthProfileCredential): string {
  if ("accountId" in credential && typeof credential.accountId === "string") {
    const accountId = credential.accountId.trim();
    if (accountId) {
      return accountId;
    }
  }
  const email = credential.email?.trim();
  return email || profileId;
}
