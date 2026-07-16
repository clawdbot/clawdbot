/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
// Codex plugin module implements auth bridge behavior.
import { createHash } from "node:crypto";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
  ensureAuthProfileStore,
  findPersistedAuthProfileCredential,
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
import { hasUsableOAuthCredential } from "openclaw/plugin-sdk/provider-auth";
import { resolveCodexAppServerHomeDir, withEphemeralCodexAuthStore } from "./auth-start-options.js";
import type { CodexAppServerClient } from "./client.js";
import { ensureCodexComputerUseSharedPluginCache } from "./computer-use-cache.js";
import {
  resolveCodexAppServerUserHomeDir,
  resolveCodexComputerUseConfig,
  type CodexAppServerStartOptions,
} from "./config.js";
import {
  isJsonObject,
  type CodexChatgptAuthTokensRefreshResponse,
  type CodexGetAccountResponse,
  type CodexLoginAccountParams,
} from "./protocol.js";
import { isCodexAppServerNativeAuthProfile } from "./session-binding.js";
import { resolveCodexAppServerSpawnEnv } from "./transport-stdio.js";

const CODEX_APP_SERVER_AUTH_PROVIDER = "openai";
const OPENAI_CODEX_APP_SERVER_AUTH_PROVIDER = "openai-codex";
const LEGACY_CODEX_APP_SERVER_AUTH_PROVIDER = "codex-cli";
const CODEX_APP_SERVER_EXTERNAL_CLI_PROVIDER_IDS = [
  CODEX_APP_SERVER_AUTH_PROVIDER,
  LEGACY_CODEX_APP_SERVER_AUTH_PROVIDER,
];
const OPENAI_PROVIDER = "openai";
const OPENAI_CODEX_DEFAULT_PROFILE_ID = "openai:default";
const CODEX_HOME_ENV_VAR = "CODEX_HOME";
const HOME_ENV_VAR = "HOME";
const CODEX_API_KEY_ENV_VAR = "CODEX_API_KEY";
const OPENAI_API_KEY_ENV_VAR = "OPENAI_API_KEY";
const CODEX_ACCESS_TOKEN_ENV_VAR = "CODEX_ACCESS_TOKEN";
const CODEX_APP_SERVER_API_KEY_ENV_VARS = [CODEX_API_KEY_ENV_VAR, OPENAI_API_KEY_ENV_VAR];
const CODEX_APP_SERVER_PREPARED_AUTH_ENV_VARS = [
  CODEX_API_KEY_ENV_VAR,
  OPENAI_API_KEY_ENV_VAR,
  CODEX_ACCESS_TOKEN_ENV_VAR,
];
const CODEX_APP_SERVER_HOME_ENV_VARS = [CODEX_HOME_ENV_VAR, HOME_ENV_VAR];
const CODEX_AUTH_JSON_FILENAME = "auth.json";
const CODEX_HOME_DIRNAME = ".codex";
type AuthProfileOrderConfig = Parameters<typeof resolveAuthProfileOrder>[0]["cfg"];
export type CodexAppServerAuthRequirement = "api-key" | "subscription";
const scopedOAuthRefreshQueues = new WeakMap<
  AuthProfileStore,
  Map<string, Promise<OAuthCredential>>
>();

export async function bridgeCodexAppServerStartOptions(params: {
  startOptions: CodexAppServerStartOptions;
  agentDir: string;
  authProfileId?: string | null;
  authProfileStore?: AuthProfileStore;
  preparedAuth?: CodexAppServerPreparedAuth;
  config?: AuthProfileOrderConfig;
  pluginConfig?: unknown;
}): Promise<CodexAppServerStartOptions> {
  if (params.startOptions.transport !== "stdio") {
    return params.startOptions;
  }
  const scopedStartOptions = await withCodexHomeEnvironment(
    withEphemeralCodexAuthStore(params),
    params.agentDir,
    params.pluginConfig,
  );
  if (params.preparedAuth) {
    return withClearedEnvironmentVariables(
      scopedStartOptions,
      CODEX_APP_SERVER_PREPARED_AUTH_ENV_VARS,
    );
  }
  if (params.authProfileId === null) {
    return scopedStartOptions;
  }
  const store = resolveCodexAppServerAuthProfileStore({
    agentDir: params.agentDir,
    authProfileId: params.authProfileId,
    authProfileStore: params.authProfileStore,
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
    ? withClearedEnvironmentVariables(scopedStartOptions, CODEX_APP_SERVER_API_KEY_ENV_VARS)
    : scopedStartOptions;
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
  authProfileStore?: AuthProfileStore;
  agentDir?: string;
  config?: AuthProfileOrderConfig;
}): string | undefined {
  const agentDir = params.agentDir?.trim() || resolveDefaultAgentDir(params.config ?? {});
  const store = resolveCodexAppServerAuthProfileStore({
    agentDir,
    authProfileId: params.authProfileId,
    authProfileStore: params.authProfileStore,
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
    externalCliProviderIds: CODEX_APP_SERVER_EXTERNAL_CLI_PROVIDER_IDS,
    ...(params.authProfileId ? { externalCliProfileIds: [params.authProfileId] } : {}),
  });
}

export function resolveCodexAppServerAuthProfileStore(params: {
  agentDir?: string;
  authProfileId?: string;
  authProfileStore?: AuthProfileStore;
  config?: AuthProfileOrderConfig;
}): AuthProfileStore {
  if (params.authProfileStore) {
    return params.authProfileStore;
  }
  return ensureCodexAppServerAuthProfileStore({
    agentDir: params.agentDir,
    authProfileId: params.authProfileId,
    config: params.config,
  });
}

type CodexAppServerPreparedAuthProfileSnapshot = {
  loginParams: CodexLoginAccountParams;
  secretFreeCacheKey: string;
};

export type CodexAppServerPreparedAuth =
  | { kind: "api-key"; apiKey: string }
  | {
      kind: "profile";
      profileId: string;
      store: AuthProfileStore;
      snapshot?: CodexAppServerPreparedAuthProfileSnapshot;
    };

export type CodexAppServerResolvedPreparedAuth =
  | Extract<CodexAppServerPreparedAuth, { kind: "api-key" }>
  | (Extract<CodexAppServerPreparedAuth, { kind: "profile" }> & {
      snapshot: CodexAppServerPreparedAuthProfileSnapshot;
    });

/** Resolves prepared profile login material once so cache identity and RPC login cannot drift. */
export async function resolveCodexAppServerPreparedAuthProfileSnapshot(params: {
  authProfileId?: string;
  authProfileStore?: AuthProfileStore;
  agentDir?: string;
  config?: AuthProfileOrderConfig;
}): Promise<CodexAppServerPreparedAuthProfileSnapshot | undefined> {
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
  const loginParams = await resolveCodexAppServerAuthProfileLoginParamsInternal({
    agentDir,
    authProfileId: profileId,
    authProfileStore: store,
    config: params.config,
  });
  if (!loginParams) {
    return undefined;
  }
  const accountId =
    loginParams.type === "chatgptAuthTokens"
      ? loginParams.chatgptAccountId
      : resolveChatgptAccountId(profileId, credential);
  const stableChatgptAccountId = resolveStableChatgptAccountId(credential);
  const secretFreeCacheKey =
    credential.type === "api_key" && loginParams.type === "apiKey"
      ? `${accountId}:${fingerprintApiKeyAuthProfileCacheKey(loginParams.apiKey)}`
      : loginParams.type === "chatgptAuthTokens" &&
          (credential.type === "token" || !stableChatgptAccountId)
        ? `${accountId}:${fingerprintTokenAuthProfileCacheKey(loginParams.accessToken)}`
        : accountId;
  return { loginParams, secretFreeCacheKey };
}

/** Maps one prepared route to one mutually exclusive app-server auth handoff. */
export async function resolveCodexAppServerPreparedAuthHandoff(params: {
  authRequirement?: CodexAppServerAuthRequirement;
  resolvedApiKey?: string;
  authProfileId?: string;
  authProfileStore: AuthProfileStore;
  agentDir?: string;
  config?: AuthProfileOrderConfig;
  subscriptionProfileRequiredError: string;
  subscriptionProfileUnusableError: string;
}) {
  if (params.authRequirement === "api-key") {
    const apiKey = params.resolvedApiKey?.trim();
    if (!apiKey) {
      throw new Error("Prepared Codex API-key route is missing its resolved API key.");
    }
    return {
      nativeAuthProfile: false,
      preparedAuth: { kind: "api-key" as const, apiKey },
    };
  }

  const authProfileId = params.authProfileId?.trim() || undefined;
  const nativeAuthProfile = isCodexAppServerNativeAuthProfile({
    authProfileId,
    authProfileStore: params.authProfileStore,
    agentDir: params.agentDir,
    config: params.config,
  });
  if (params.authRequirement !== "subscription") {
    return { authProfileId, nativeAuthProfile };
  }
  if (!authProfileId || !nativeAuthProfile) {
    throw createCodexAppServerAuthError(params.subscriptionProfileRequiredError);
  }

  const snapshot = await resolveCodexAppServerPreparedAuthProfileSnapshot({
    authProfileId,
    authProfileStore: params.authProfileStore,
    agentDir: params.agentDir,
    config: params.config,
  });
  if (!snapshot) {
    throw createCodexAppServerAuthError(params.subscriptionProfileUnusableError);
  }
  return {
    authProfileId,
    nativeAuthProfile,
    preparedAuth: {
      kind: "profile" as const,
      profileId: authProfileId,
      store: params.authProfileStore,
      snapshot,
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
    const resolved = await resolveApiKeyForProfile({ store, profileId, agentDir });
    const apiKey = resolved?.apiKey?.trim();
    return apiKey
      ? `${resolveChatgptAccountId(profileId, credential)}:${fingerprintApiKeyAuthProfileCacheKey(apiKey)}`
      : resolveChatgptAccountId(profileId, credential);
  }
  if (credential.type === "token") {
    const resolved = await resolveApiKeyForProfile({ store, profileId, agentDir });
    const accessToken = resolved?.apiKey?.trim();
    return accessToken
      ? `${resolveChatgptAccountId(profileId, credential)}:${fingerprintTokenAuthProfileCacheKey(accessToken)}`
      : resolveChatgptAccountId(profileId, credential);
  }
  return resolveChatgptAccountId(profileId, credential);
}

function resolveCodexAppServerEnvApiKeyCacheKey(params: {
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

export function resolveCodexAppServerFallbackApiKeyCacheKey(params: {
  startOptions: Pick<CodexAppServerStartOptions, "transport" | "env" | "clearEnv">;
  baseEnv?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
}): string | undefined {
  if (params.startOptions.transport !== "stdio") {
    return undefined;
  }
  return (
    resolveCodexAppServerEnvApiKeyCacheKey(params) ??
    resolveCodexCliAuthFileApiKeyCacheKey(params.baseEnv ?? process.env)
  );
}

/** Secret-free cache identity for an API key already resolved by the runtime plan. */
export function resolveCodexAppServerPreparedApiKeyCacheKey(
  apiKey: string | undefined,
): string | undefined {
  const resolved = apiKey?.trim();
  return resolved ? fingerprintApiKeyAuthProfileCacheKey(resolved) : undefined;
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

function fingerprintCodexCliAuthFileApiKeyCacheKey(apiKey: string): string {
  const hash = createHash("sha256");
  hash.update("openclaw:codex:app-server-cli-auth-json-api-key:v1");
  hash.update("\0");
  hash.update(apiKey);
  return `CODEX_AUTH_JSON:sha256:${hash.digest("hex")}`;
}

export { resolveCodexAppServerHomeDir } from "./auth-start-options.js";

async function withCodexHomeEnvironment(
  startOptions: CodexAppServerStartOptions,
  agentDir: string,
  pluginConfig?: unknown,
): Promise<CodexAppServerStartOptions> {
  const codexHome = startOptions.env?.[CODEX_HOME_ENV_VAR]?.trim()
    ? startOptions.env[CODEX_HOME_ENV_VAR]
    : startOptions.homeScope === "user"
      ? resolveCodexAppServerUserHomeDir(process.env)
      : resolveCodexAppServerHomeDir(agentDir);
  const nativeHome = startOptions.env?.[HOME_ENV_VAR]?.trim()
    ? startOptions.env[HOME_ENV_VAR]
    : undefined;
  await fs.mkdir(codexHome, { recursive: true });
  await ensureCodexComputerUseSharedPluginCache({
    codexHome,
    config: resolveCodexComputerUseConfig({ pluginConfig }),
  });
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
  authProfileStore?: AuthProfileStore;
  preparedAuth?: CodexAppServerResolvedPreparedAuth;
  authRequirement?: CodexAppServerAuthRequirement;
  startOptions?: CodexAppServerStartOptions;
  config?: AuthProfileOrderConfig;
}): Promise<void> {
  if (params.preparedAuth?.kind === "profile") {
    await params.client.request("account/login/start", params.preparedAuth.snapshot.loginParams);
    return;
  }
  if (params.preparedAuth?.kind === "api-key") {
    await params.client.request("account/login/start", {
      type: "apiKey",
      apiKey: params.preparedAuth.apiKey,
    });
    return;
  }
  if (params.authProfileId === null) {
    if (params.authRequirement === "subscription") {
      const response = await params.client.request<CodexGetAccountResponse>("account/read", {
        refreshToken: false,
      });
      if (!isJsonObject(response.account) || response.account.type !== "chatgpt") {
        throw createCodexAppServerAuthError(
          "Codex subscription auth profile could not produce login credentials.",
        );
      }
    }
    return;
  }
  let loginParams: CodexLoginAccountParams | undefined;
  try {
    loginParams = await resolveCodexAppServerAuthProfileLoginParams({
      agentDir: params.agentDir,
      authProfileId: params.authProfileId,
      authProfileStore: params.authProfileStore,
      config: params.config,
    });
  } catch (error) {
    if (
      params.authRequirement === "subscription" &&
      error instanceof CodexAppServerAuthProfileUnavailableError
    ) {
      throw createCodexAppServerAuthError(
        "Codex subscription auth profile could not produce login credentials.",
        error,
      );
    }
    throw error;
  }
  if (params.authRequirement === "subscription" && loginParams?.type !== "chatgptAuthTokens") {
    throw createCodexAppServerAuthError(
      "Codex subscription auth profile could not produce login credentials.",
    );
  }
  if (!loginParams) {
    // Observe native state only for explicit API-key routes. A subscription
    // route must fail here so profile rotation can run before billing changes.
    if (params.authRequirement === "subscription") {
      throw createCodexAppServerAuthError(
        "Codex subscription auth profile could not produce login credentials.",
      );
    }
    if (params.authRequirement !== "api-key" || params.startOptions?.transport !== "stdio") {
      return;
    }
    const env = resolveCodexAppServerSpawnEnv(params.startOptions, process.env);
    const fallbackLoginParams = await resolveCodexAppServerFallbackApiKeyLoginParams({
      client: params.client,
      env,
      codexCliAuthEnv: process.env,
    });
    if (fallbackLoginParams) {
      await params.client.request("account/login/start", fallbackLoginParams);
    }
    return;
  }
  await params.client.request("account/login/start", loginParams);
}

function createCodexAppServerAuthError(message: string, cause?: unknown): Error & { status: 401 } {
  const error = cause === undefined ? new Error(message) : new Error(message, { cause });
  return Object.assign(error, { status: 401 as const });
}

class CodexAppServerAuthProfileUnavailableError extends Error {}

async function resolveCodexAppServerAuthProfileLoginParams(params: {
  agentDir: string;
  authProfileId?: string;
  authProfileStore?: AuthProfileStore;
  config?: AuthProfileOrderConfig;
}): Promise<CodexLoginAccountParams | undefined> {
  const store = resolveCodexAppServerAuthProfileStore(params);
  const profileId = resolveCodexAppServerAuthProfileId({
    authProfileId: params.authProfileId,
    store,
    config: params.config,
  });
  const profile = profileId ? store.profiles[profileId] : undefined;
  if (profileId && !profile) {
    throw new CodexAppServerAuthProfileUnavailableError(
      `Codex app-server auth profile "${profileId}" was not found.`,
    );
  }
  if (profileId && profile && !isCodexAppServerAuthProfileCredential(profile, params.config)) {
    throw new CodexAppServerAuthProfileUnavailableError(
      `Codex app-server auth profile "${profileId}" must be OpenAI Codex auth or an OpenAI API-key backup.`,
    );
  }
  return await resolveCodexAppServerAuthProfileLoginParamsInternal({
    ...params,
    authProfileStore: store,
  });
}

export async function refreshCodexAppServerAuthTokens(params: {
  agentDir: string;
  authProfileId?: string;
  authProfileStore?: AuthProfileStore;
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
  authProfileStore?: AuthProfileStore;
  forceOAuthRefresh?: boolean;
  config?: AuthProfileOrderConfig;
}): Promise<CodexLoginAccountParams | undefined> {
  const store = resolveCodexAppServerAuthProfileStore({
    agentDir: params.agentDir,
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
    store,
    preferStoreCredential: Boolean(params.authProfileStore?.profiles[profileId]),
    forceOAuthRefresh: params.forceOAuthRefresh === true,
    config: params.config,
  });
  if (!loginParams) {
    throw new CodexAppServerAuthProfileUnavailableError(
      `Codex app-server auth profile "${profileId}" does not contain usable credentials.`,
    );
  }
  return loginParams;
}

async function resolveCodexAppServerFallbackApiKeyLoginParams(params: {
  client: CodexAppServerClient;
  env: NodeJS.ProcessEnv;
  codexCliAuthEnv: NodeJS.ProcessEnv;
}): Promise<CodexLoginAccountParams | undefined> {
  const apiKey =
    readFirstNonEmptyEnv(params.env, CODEX_APP_SERVER_API_KEY_ENV_VARS) ??
    (await readCodexCliAuthFileApiKey(params.codexCliAuthEnv));
  if (!apiKey) {
    return undefined;
  }
  const response = await params.client.request<CodexGetAccountResponse>("account/read", {
    refreshToken: false,
  });
  if (response.account) {
    return undefined;
  }
  return { type: "apiKey", apiKey };
}

function resolveCodexCliAuthFilePath(env: NodeJS.ProcessEnv): string {
  const configuredCodexHome = env[CODEX_HOME_ENV_VAR]?.trim();
  if (configuredCodexHome) {
    return path.join(resolveHomeRelativePath(configuredCodexHome, env), CODEX_AUTH_JSON_FILENAME);
  }
  const home = env[HOME_ENV_VAR]?.trim() || env.USERPROFILE?.trim() || os.homedir();
  return path.join(home, CODEX_HOME_DIRNAME, CODEX_AUTH_JSON_FILENAME);
}

function resolveHomeRelativePath(value: string, env: NodeJS.ProcessEnv): string {
  if (value === "~" || value.startsWith("~/") || value.startsWith("~\\")) {
    const home = env[HOME_ENV_VAR]?.trim() || env.USERPROFILE?.trim() || os.homedir();
    return path.join(home, value.slice(value === "~" ? 1 : 2));
  }
  return value;
}

function parseCodexCliAuthFileApiKey(raw: string): string | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== "object") {
    return undefined;
  }
  const apiKey = (parsed as Record<string, unknown>).OPENAI_API_KEY;
  return typeof apiKey === "string" && apiKey.trim() ? apiKey.trim() : undefined;
}

async function readCodexCliAuthFileApiKey(env: NodeJS.ProcessEnv): Promise<string | undefined> {
  try {
    return parseCodexCliAuthFileApiKey(await fs.readFile(resolveCodexCliAuthFilePath(env), "utf8"));
  } catch {
    return undefined;
  }
}

function resolveCodexCliAuthFileApiKeyCacheKey(env: NodeJS.ProcessEnv): string | undefined {
  try {
    const apiKey = parseCodexCliAuthFileApiKey(
      fsSync.readFileSync(resolveCodexCliAuthFilePath(env), "utf8"),
    );
    return apiKey ? fingerprintCodexCliAuthFileApiKeyCacheKey(apiKey) : undefined;
  } catch {
    return undefined;
  }
}

async function resolveLoginParamsForCredential(
  profileId: string,
  credential: AuthProfileCredential,
  params: {
    agentDir: string;
    store: AuthProfileStore;
    preferStoreCredential: boolean;
    forceOAuthRefresh: boolean;
    config?: AuthProfileOrderConfig;
  },
): Promise<CodexLoginAccountParams | undefined> {
  // Runtime honors the persisted auth profile type. Shape-based remediation
  // belongs at credential entry time so request handling does not preemptively
  // reject opaque provider credentials.
  if (credential.type === "api_key") {
    const resolved = await resolveApiKeyForProfile({
      store: params.preferStoreCredential
        ? params.store
        : ensureAuthProfileStore(params.agentDir, { allowKeychainPrompt: false }),
      profileId,
      agentDir: params.agentDir,
    });
    const apiKey = resolved?.apiKey?.trim();
    return apiKey ? { type: "apiKey", apiKey } : undefined;
  }
  if (credential.type === "token") {
    const resolved = await resolveApiKeyForProfile({
      store: params.preferStoreCredential
        ? params.store
        : ensureAuthProfileStore(params.agentDir, { allowKeychainPrompt: false }),
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
    store: params.store,
    preferStoreCredential: params.preferStoreCredential,
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
  params: {
    agentDir: string;
    store: AuthProfileStore;
    preferStoreCredential: boolean;
    forceRefresh: boolean;
    config?: AuthProfileOrderConfig;
  },
): Promise<OAuthCredential> {
  const ownerAgentDir = resolvePersistedAuthProfileOwnerAgentDir({
    agentDir: params.agentDir,
    profileId,
  });
  const persistedCredential = findPersistedAuthProfileCredential({
    agentDir: ownerAgentDir,
    profileId,
  });
  const useScopedCredential =
    params.preferStoreCredential &&
    shouldUseScopedOAuthCredential({
      store: params.store,
      profileId,
      persistedCredential,
      suppliedCredential: credential,
      config: params.config,
    });
  const store = useScopedCredential
    ? params.store
    : ensureCodexAppServerAuthProfileStore({
        agentDir: ownerAgentDir,
        authProfileId: profileId,
        config: params.config,
      });
  const persistedOAuthCredential =
    !useScopedCredential &&
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
  if (useScopedCredential && overlaidOAuthCredential) {
    return await resolveScopedOAuthCredential({
      store,
      profileId,
      credential: overlaidOAuthCredential,
      forceRefresh: params.forceRefresh,
    });
  }
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
  const refreshed = useScopedCredential
    ? undefined
    : loadAuthProfileStoreForSecretsRuntime(ownerAgentDir).profiles[profileId];
  const refreshedOAuthCredential =
    refreshed?.type === "oauth" && isCodexAppServerAuthProvider(refreshed.provider, params.config)
      ? refreshed
      : undefined;
  if (refreshedOAuthCredential && isDeepStrictEqual(params.store.profiles[profileId], credential)) {
    // Persisted refreshes rotate refresh tokens. Keep an isolated prepared
    // store aligned without reverting a concurrent caller-owned replacement.
    params.store.profiles[profileId] = refreshedOAuthCredential;
  }
  const storedCredential = store.profiles[profileId];
  const candidate = refreshedOAuthCredential
    ? refreshedOAuthCredential
    : storedCredential?.type === "oauth" &&
        isCodexAppServerAuthProvider(storedCredential.provider, params.config)
      ? storedCredential
      : credential;
  return resolved?.apiKey ? { ...candidate, access: resolved.apiKey } : candidate;
}

function shouldUseScopedOAuthCredential(params: {
  store: AuthProfileStore;
  profileId: string;
  persistedCredential: AuthProfileCredential | undefined;
  suppliedCredential: OAuthCredential;
  config?: AuthProfileOrderConfig;
}): boolean {
  if (!params.store.runtimePersistedProfileIds?.includes(params.profileId)) {
    return true;
  }
  const persisted = params.persistedCredential;
  if (persisted?.type !== "oauth") {
    return true;
  }
  if (
    resolveProviderIdForAuth(persisted.provider, { config: params.config }) !==
    resolveProviderIdForAuth(params.suppliedCredential.provider, { config: params.config })
  ) {
    return true;
  }
  return (
    !isDeepStrictEqual(persisted, params.suppliedCredential) &&
    !hasMatchingOAuthIdentity(persisted, params.suppliedCredential)
  );
}

function hasMatchingOAuthIdentity(persisted: OAuthCredential, supplied: OAuthCredential): boolean {
  const persistedAccountId = persisted.accountId?.trim();
  const suppliedAccountId = supplied.accountId?.trim();
  if (persistedAccountId && suppliedAccountId) {
    return persistedAccountId === suppliedAccountId;
  }
  const persistedEmail = persisted.email?.trim().toLowerCase();
  const suppliedEmail = supplied.email?.trim().toLowerCase();
  return Boolean(persistedEmail && suppliedEmail && persistedEmail === suppliedEmail);
}

async function resolveScopedOAuthCredential(params: {
  store: AuthProfileStore;
  profileId: string;
  credential: OAuthCredential;
  forceRefresh: boolean;
}): Promise<OAuthCredential> {
  const existingRefresh = scopedOAuthRefreshQueues.get(params.store)?.get(params.profileId);
  if (existingRefresh) {
    return await existingRefresh;
  }
  if (!params.forceRefresh && hasUsableOAuthCredential(params.credential)) {
    return params.credential;
  }

  const storeRefreshes = scopedOAuthRefreshQueues.get(params.store) ?? new Map();
  scopedOAuthRefreshQueues.set(params.store, storeRefreshes);
  const refresh = (async () => {
    const current = params.store.profiles[params.profileId];
    const credential = current?.type === "oauth" ? current : params.credential;
    if (!params.forceRefresh && hasUsableOAuthCredential(credential)) {
      return credential;
    }
    const refreshed = await refreshOAuthCredentialForRuntime({ credential });
    if (!refreshed?.access?.trim()) {
      throw new Error(`Codex app-server auth profile "${params.profileId}" could not refresh.`);
    }
    if (!isDeepStrictEqual(params.store.profiles[params.profileId], credential)) {
      throw new Error(
        `Codex app-server auth profile "${params.profileId}" changed while refreshing.`,
      );
    }
    params.store.profiles[params.profileId] = refreshed;
    return refreshed;
  })();
  storeRefreshes.set(params.profileId, refresh);
  try {
    return await refresh;
  } finally {
    // Scoped stores are process-local; serialize their rotating refresh token
    // and release the queue entry with the refresh that owns it.
    if (storeRefreshes.get(params.profileId) === refresh) {
      storeRefreshes.delete(params.profileId);
    }
  }
}

function isCodexAppServerAuthProvider(provider: string, config?: AuthProfileOrderConfig): boolean {
  const resolvedProvider = resolveProviderIdForAuth(provider, { config });
  return (
    resolvedProvider === CODEX_APP_SERVER_AUTH_PROVIDER ||
    resolvedProvider === OPENAI_CODEX_APP_SERVER_AUTH_PROVIDER ||
    // Older Codex auth profiles stored the CLI runtime id here. The app-server
    // login protocol still receives the same externally managed ChatGPT token.
    resolvedProvider === LEGACY_CODEX_APP_SERVER_AUTH_PROVIDER
  );
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
  return resolveStableChatgptAccountId(credential) ?? profileId;
}

function resolveStableChatgptAccountId(credential: AuthProfileCredential): string | undefined {
  if ("accountId" in credential && typeof credential.accountId === "string") {
    const accountId = credential.accountId.trim();
    if (accountId) {
      return accountId;
    }
  }
  const email = credential.email?.trim();
  return email || undefined;
}
