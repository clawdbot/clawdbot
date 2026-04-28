import {
  ensureAuthProfileStore,
  loadAuthProfileStoreForSecretsRuntime,
  resolveProviderIdForAuth,
  resolveApiKeyForProfile,
  saveAuthProfileStore,
  type AuthProfileCredential,
  type OAuthCredential,
} from "openclaw/plugin-sdk/agent-runtime";
import type { CodexAppServerClient } from "./client.js";
import type { CodexAppServerStartOptions } from "./config.js";
import type { ChatgptAuthTokensRefreshResponse } from "./protocol-generated/typescript/v2/ChatgptAuthTokensRefreshResponse.js";
import type { GetAccountResponse } from "./protocol-generated/typescript/v2/GetAccountResponse.js";
import type { LoginAccountParams } from "./protocol-generated/typescript/v2/LoginAccountParams.js";
import { resolveCodexAppServerSpawnEnv } from "./transport-stdio.js";

const CODEX_APP_SERVER_AUTH_PROVIDER = "openai-codex";
const OPENAI_CODEX_DEFAULT_PROFILE_ID = "openai-codex:default";
const CODEX_API_KEY_ENV_VAR = "CODEX_API_KEY";
const OPENAI_API_KEY_ENV_VAR = "OPENAI_API_KEY";
const CODEX_APP_SERVER_API_KEY_ENV_VARS = [CODEX_API_KEY_ENV_VAR, OPENAI_API_KEY_ENV_VAR];

export async function bridgeCodexAppServerStartOptions(params: {
  startOptions: CodexAppServerStartOptions;
  agentDir: string;
  authProfileId?: string;
}): Promise<CodexAppServerStartOptions> {
  if (params.startOptions.transport !== "stdio") {
    return params.startOptions;
  }
  const store = ensureAuthProfileStore(params.agentDir, { allowKeychainPrompt: false });
  const shouldClearInheritedOpenAiApiKey = shouldClearOpenAiApiKeyForCodexAuthProfile({
    store,
    authProfileId: params.authProfileId,
  });
  return shouldClearInheritedOpenAiApiKey
    ? withClearedEnvironmentVariables(params.startOptions, CODEX_APP_SERVER_API_KEY_ENV_VARS)
    : params.startOptions;
}

export async function applyCodexAppServerAuthProfile(params: {
  client: CodexAppServerClient;
  agentDir: string;
  authProfileId?: string;
  startOptions?: CodexAppServerStartOptions;
}): Promise<void> {
  const loginParams = await resolveCodexAppServerAuthProfileLoginParams({
    agentDir: params.agentDir,
    authProfileId: params.authProfileId,
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

export function resolveCodexAppServerAuthProfileLoginParams(params: {
  agentDir: string;
  authProfileId?: string;
}): Promise<LoginAccountParams | undefined> {
  return resolveCodexAppServerAuthProfileLoginParamsInternal(params);
}

export async function refreshCodexAppServerAuthTokens(params: {
  agentDir: string;
  authProfileId?: string;
}): Promise<ChatgptAuthTokensRefreshResponse> {
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
}): Promise<LoginAccountParams | undefined> {
  const profileId = params.authProfileId?.trim();
  if (!profileId) {
    return undefined;
  }
  const store = ensureAuthProfileStore(params.agentDir, { allowKeychainPrompt: false });
  const credential = store.profiles[profileId];
  if (!credential) {
    throw new Error(`Codex app-server auth profile "${profileId}" was not found.`);
  }
  if (!isCodexAppServerAuthProvider(credential.provider)) {
    throw new Error(
      `Codex app-server auth profile "${profileId}" must belong to provider "openai-codex" or a supported alias.`,
    );
  }
  const loginParams = await resolveLoginParamsForCredential(profileId, credential, {
    agentDir: params.agentDir,
    forceOAuthRefresh: params.forceOAuthRefresh === true,
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
}): Promise<LoginAccountParams | undefined> {
  const apiKey = readFirstNonEmptyEnv(params.env, CODEX_APP_SERVER_API_KEY_ENV_VARS);
  if (!apiKey) {
    return undefined;
  }
  const response = await params.client.request<GetAccountResponse>("account/read", {
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
  params: { agentDir: string; forceOAuthRefresh: boolean },
): Promise<LoginAccountParams | undefined> {
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
  const resolvedCredential = await resolveOAuthCredentialForCodexAppServer(profileId, credential, {
    agentDir: params.agentDir,
    forceRefresh: params.forceOAuthRefresh,
  });
  const accessToken = resolvedCredential.access?.trim();
  return accessToken
    ? buildChatgptAuthTokensParams(profileId, resolvedCredential, accessToken)
    : undefined;
}

async function resolveOAuthCredentialForCodexAppServer(
  profileId: string,
  credential: OAuthCredential,
  params: { agentDir: string; forceRefresh: boolean },
): Promise<OAuthCredential> {
  const store = ensureAuthProfileStore(params.agentDir, { allowKeychainPrompt: false });
  if (params.forceRefresh) {
    store.profiles[profileId] = { ...credential, expires: 0 };
    saveAuthProfileStore(store, params.agentDir);
  }
  const resolved = await resolveApiKeyForProfile({
    store,
    profileId,
    agentDir: params.agentDir,
  });
  const refreshed = loadAuthProfileStoreForSecretsRuntime(params.agentDir).profiles[profileId];
  const storedCredential = store.profiles[profileId];
  const candidate =
    refreshed?.type === "oauth" && isCodexAppServerAuthProvider(refreshed.provider)
      ? refreshed
      : storedCredential?.type === "oauth" &&
          isCodexAppServerAuthProvider(storedCredential.provider)
        ? storedCredential
        : credential;
  return resolved?.apiKey ? { ...candidate, access: resolved.apiKey } : candidate;
}

function isCodexAppServerAuthProvider(provider: string): boolean {
  return resolveProviderIdForAuth(provider) === CODEX_APP_SERVER_AUTH_PROVIDER;
}

function shouldClearOpenAiApiKeyForCodexAuthProfile(params: {
  store: ReturnType<typeof ensureAuthProfileStore>;
  authProfileId?: string;
}): boolean {
  const profileId = params.authProfileId?.trim();
  const credential = profileId
    ? params.store.profiles[profileId]
    : params.store.profiles[OPENAI_CODEX_DEFAULT_PROFILE_ID];
  return isCodexSubscriptionCredential(credential);
}

function isCodexSubscriptionCredential(credential: AuthProfileCredential | undefined): boolean {
  if (!credential || !isCodexAppServerAuthProvider(credential.provider)) {
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
  for (const key of keys) {
    const value = env[key]?.trim();
    if (value) {
      return value;
    }
  }
  return undefined;
}

function buildChatgptAuthTokensParams(
  profileId: string,
  credential: AuthProfileCredential,
  accessToken: string,
): LoginAccountParams {
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
