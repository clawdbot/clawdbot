/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
// Codex plugin module implements auth bridge behavior.

import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
  AgentHarnessPreflightError,
  resolveDefaultAgentDir,
} from "openclaw/plugin-sdk/agent-harness-registration";
import {
  ensureAuthProfileStore,
  findPersistedAuthProfileCredential,
  loadAuthProfileStoreForSecretsRuntime,
  refreshOAuthCredentialForRuntime,
  resolveApiKeyForProfile,
  resolvePersistedAuthProfileOwnerAgentDir,
  type AuthProfileCredential,
  type AuthProfileStore,
  type OAuthCredential,
} from "openclaw/plugin-sdk/agent-runtime";
import {
  hasUsableOAuthCredential,
  resolveOpenAICodexAuthIdentity,
} from "openclaw/plugin-sdk/provider-auth";
import { resolveProviderIdForAuth } from "openclaw/plugin-sdk/provider-auth-aliases";
import {
  CODEX_AUTH_JSON_FILENAME,
  CODEX_APP_SERVER_API_KEY_ENV_VARS,
  resolveCodexAppServerFallbackApiKeyCacheKey,
  fingerprintApiKeyAuthProfileCacheKey,
  fingerprintTokenAuthProfileCacheKey,
  readCodexCliAuthFileApiKey,
  readFirstNonEmptyEnv,
} from "./auth-cache-key.js";
import {
  resolveCodexAppServerAuthProfileId,
  resolveCodexAppServerAuthProfileStore,
  isCodexAppServerNativeAuthProfile,
  CODEX_APP_SERVER_AUTH_PROVIDER,
} from "./auth-profile.js";
import {
  resolveCodexAppServerHomeDir,
  resolveCodexAppServerLocalHomeDir,
  withEphemeralCodexAuthStore,
} from "./auth-start-options.js";
import type { CodexAppServerClient } from "./client.js";
import { ensureCodexComputerUseSharedPluginCache } from "./computer-use-cache.js";
import {
  ensureCodexManagedBundledMarketplace,
  resolveCodexManagedBundledMarketplaceSource,
} from "./computer-use-marketplace.js";
import { ensureOwnedCodexHome } from "./computer-use-service-path.js";
import {
  ensureCodexComputerUseServiceApp,
  resolveCodexComputerUseServiceAppSourcePath,
} from "./computer-use-service.js";
import type { CodexAppServerHomeScope, CodexAppServerStartOptions } from "./config-contracts.js";
import { resolveCodexComputerUseConfig } from "./config-runtime.js";
import {
  resolveMacOSDesktopCodexAppPathCandidates,
  type MacOSDesktopCodexAppPathCandidate,
} from "./desktop-app-paths.js";
import type { CodexDesktopGeneration } from "./desktop-generation-owner.js";
import {
  isJsonObject,
  type CodexChatgptAuthTokensRefreshResponse,
  type CodexGetAccountResponse,
  type CodexLoginAccountParams,
} from "./protocol.js";
import { resolveCodexAppServerSpawnEnv } from "./transport-stdio.js";

const OPENAI_CODEX_DEFAULT_PROFILE_ID = "openai:default";
const CODEX_HOME_ENV_VAR = "CODEX_HOME";
const HOME_ENV_VAR = "HOME";
const CODEX_API_KEY_ENV_VAR = "CODEX_API_KEY";
const OPENAI_API_KEY_ENV_VAR = "OPENAI_API_KEY";
const CODEX_ACCESS_TOKEN_ENV_VAR = "CODEX_ACCESS_TOKEN";
const CODEX_APP_SERVER_PREPARED_AUTH_ENV_VARS = [
  CODEX_API_KEY_ENV_VAR,
  OPENAI_API_KEY_ENV_VAR,
  CODEX_ACCESS_TOKEN_ENV_VAR,
];
const CODEX_APP_SERVER_HOME_ENV_VARS = [CODEX_HOME_ENV_VAR, HOME_ENV_VAR];
const MAX_COMPUTER_USE_ARTIFACT_OWNERS = 128;
const activeComputerUseArtifactReconciliations = new Map<
  string,
  { latestEpoch?: number; appliedCacheBinding?: string; active: number; tail: Promise<void> }
>();
type AuthProfileOrderConfig = Parameters<typeof resolveCodexAppServerAuthProfileId>[0]["config"];
export type CodexAppServerAuthRequirement = "api-key" | "subscription";
const scopedOAuthRefreshQueues = new WeakMap<
  AuthProfileStore,
  Map<string, Promise<OAuthCredential>>
>();

export async function bridgeCodexAppServerStartOptions(params: {
  startOptions: CodexAppServerStartOptions;
  agentId?: string;
  agentDir: string;
  authProfileId?: string | null;
  authProfileStore?: AuthProfileStore;
  preparedAuth?: CodexAppServerPreparedAuth;
  authRequirement?: CodexAppServerAuthRequirement;
  config?: AuthProfileOrderConfig;
  pluginConfig?: unknown;
}): Promise<CodexAppServerStartOptions> {
  if (params.startOptions.transport !== "stdio") {
    return params.startOptions;
  }
  const scopeStartOptions = () =>
    withCodexHomeEnvironment(withEphemeralCodexAuthStore(params), params.agentDir);

  if (params.preparedAuth) {
    const scopedStartOptions = await scopeStartOptions();
    return withClearedEnvironmentVariables(
      scopedStartOptions,
      CODEX_APP_SERVER_PREPARED_AUTH_ENV_VARS,
    );
  }
  if (params.authProfileId === null) {
    return scopeStartOptions();
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
  if (!authProfileId) {
    assertNoUnimportedAgentCodexAuthFile(params);
  }

  const scopedStartOptions = await scopeStartOptions();
  const shouldClearInheritedOpenAiApiKey = shouldClearOpenAiApiKeyForCodexAuthProfile({
    store,
    authProfileId,
  });
  return shouldClearInheritedOpenAiApiKey
    ? withClearedEnvironmentVariables(scopedStartOptions, CODEX_APP_SERVER_API_KEY_ENV_VARS)
    : scopedStartOptions;
}

function assertNoUnimportedAgentCodexAuthFile(params: {
  startOptions: CodexAppServerStartOptions;
  agentId?: string;
  agentDir: string;
  authRequirement?: CodexAppServerAuthRequirement;
}): void {
  // Ephemeral stdio starts cannot load this stale file, and the shared-client key
  // separates auth requirements plus fallback identities. Preserve the supported
  // stdio API-key login instead of turning a leftover file into a hard failure.
  if (
    params.authRequirement === "api-key" &&
    resolveCodexAppServerFallbackApiKeyCacheKey({ startOptions: params.startOptions })
  ) {
    return;
  }
  const message = resolveUnimportedAgentCodexAuthMessage(params);
  if (message) {
    throw new AgentHarnessPreflightError(message);
  }
}

function resolveUnimportedAgentCodexAuthMessage(params: {
  startOptions: CodexAppServerStartOptions;
  agentId?: string;
  agentDir: string;
}): string | undefined {
  if (params.startOptions.transport !== "stdio" || params.startOptions.homeScope === "user") {
    return undefined;
  }
  const codexHome = resolveCodexAppServerHomeDir(params.agentDir);
  const authPath = path.join(codexHome, CODEX_AUTH_JSON_FILENAME);
  // OpenClaw-owned starts force ephemeral Codex auth, so this file would otherwise be
  // ignored and the operator would receive only the downstream authentication error.
  if (!fsSync.existsSync(authPath)) {
    return undefined;
  }
  const targetAgentId = params.agentId?.trim() || "<agent-id>";
  return `A Codex auth file exists at ${authPath}, but agent-scoped Codex runs use OpenClaw's auth store and do not read that file. Preview only that credential import with \`openclaw migrate plan codex --from <codex-home> --agent ${targetAgentId} --include-secrets --item auth:openai\`, then run \`openclaw migrate apply codex --from <codex-home> --agent ${targetAgentId} --include-secrets --item auth:openai --yes\`. If the plan finds no credentials, remove the stale auth file.`;
}

type CodexAppServerPreparedAuthProfileSnapshot = {
  loginParams: CodexLoginAccountParams;
  secretFreeCacheKey: string;
  /** Genuine ChatGPT principal id; email/profile fallbacks are not authorization identity. */
  chatgptAccountId?: string;
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
  if (!credential || !isCodexAppServerAuthProfileCredential(credential)) {
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
  const chatgptAccountId =
    loginParams.type === "chatgptAuthTokens" ? loginParams.chatgptAccountId : undefined;
  return {
    loginParams,
    secretFreeCacheKey,
    ...(chatgptAccountId ? { chatgptAccountId } : {}),
  };
}

/** Maps one prepared route to one mutually exclusive app-server auth handoff. */
export async function resolveCodexAppServerPreparedAuthHandoff(params: {
  authRequirement?: CodexAppServerAuthRequirement;
  resolvedApiKey?: string;
  authProfileId?: string;
  authProfileStore: AuthProfileStore;
  agentDir?: string;
  /** Required: an omitted scope would silently reintroduce prepared logins on native homes. */
  homeScope: CodexAppServerHomeScope;
  /** Remote execution must never rely on ambient or native-home credentials. */
  requirePreparedAuth?: boolean;
  config?: AuthProfileOrderConfig;
  subscriptionProfileRequiredError: string;
  subscriptionProfileUnusableError: string;
}) {
  // A user-home app-server owns the operator's native Codex account. Codex persists
  // api-key logins into CODEX_HOME/auth.json and swaps the live account for external
  // token logins, so a prepared OpenClaw handoff here would rewrite the account that
  // Codex CLI and Desktop share. Native homes are verified, never logged into.
  const usesNativeHome = params.homeScope === "user";
  if (params.requirePreparedAuth && usesNativeHome) {
    throw createCodexAppServerAuthError(
      'Codex remote-exec cloud placement requires prepared OpenAI auth. Configure an OpenAI API-key, OAuth, or token profile and use appServer.homeScope="agent"; ambient credentials and native Codex auth are not allowed.',
    );
  }
  if (usesNativeHome) {
    return { nativeAuthProfile: true };
  }
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
  if (params.authRequirement !== "subscription" && !params.requirePreparedAuth) {
    return { authProfileId, nativeAuthProfile };
  }
  if (!authProfileId || (params.authRequirement === "subscription" && !nativeAuthProfile)) {
    throw createCodexAppServerAuthError(
      params.requirePreparedAuth
        ? "Codex remote-exec cloud placement requires prepared OpenAI auth. Configure an OpenAI API-key, OAuth, or token profile; ambient CODEX_API_KEY, OPENAI_API_KEY, and native Codex auth are not allowed."
        : params.subscriptionProfileRequiredError,
    );
  }

  const snapshot = await resolveCodexAppServerPreparedAuthProfileSnapshot({
    authProfileId,
    authProfileStore: params.authProfileStore,
    agentDir: params.agentDir,
    config: params.config,
  });
  if (!snapshot) {
    throw createCodexAppServerAuthError(
      params.requirePreparedAuth
        ? "Codex remote-exec cloud placement could not prepare the selected OpenAI auth profile. Repair or replace the profile, then retry."
        : params.subscriptionProfileUnusableError,
    );
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
  if (!credential || !isCodexAppServerAuthProfileCredential(credential)) {
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

export { resolveCodexAppServerHomeDir } from "./auth-start-options.js";

async function withCodexHomeEnvironment(
  startOptions: CodexAppServerStartOptions,
  agentDir: string,
): Promise<CodexAppServerStartOptions> {
  const codexHome = resolveCodexAppServerLocalHomeDir(startOptions, agentDir);
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

/** Reconciles Computer Use artifacts for the exact managed command about to start. */
export async function reconcileCodexComputerUseStartArtifacts(params: {
  startOptions: CodexAppServerStartOptions;
  agentDir: string;
  pluginConfig?: unknown;
  ownsIsolatedCodexHome?: boolean;
  desktopGeneration?: CodexDesktopGeneration;
  assertCurrent?: () => void;
  forceCacheRefresh?: boolean;
}): Promise<void> {
  if (params.startOptions.transport !== "stdio") {
    return;
  }
  const codexHome = resolveCodexAppServerLocalHomeDir(params.startOptions, params.agentDir);
  const key = path.resolve(codexHome);
  let owner = activeComputerUseArtifactReconciliations.get(key);
  if (!owner) {
    owner = { active: 0, tail: Promise.resolve() };
    activeComputerUseArtifactReconciliations.set(key, owner);
  } else {
    activeComputerUseArtifactReconciliations.delete(key);
    activeComputerUseArtifactReconciliations.set(key, owner);
  }
  owner.active += 1;
  const epoch = params.desktopGeneration?.epoch;
  if (epoch !== undefined && (owner.latestEpoch === undefined || epoch > owner.latestEpoch)) {
    owner.latestEpoch = epoch;
  }
  const assertCurrent = () => {
    params.assertCurrent?.();
    if (epoch !== undefined && owner.latestEpoch !== epoch) {
      throw new Error("Codex Computer Use artifact reconciliation was superseded.");
    }
  };
  const operation = owner.tail
    .catch(() => undefined)
    .then(async () => {
      assertCurrent();
      const appliedCacheBinding = await reconcileCodexComputerUseStartArtifactsOnce({
        ...params,
        codexHome,
        assertCurrent,
        previousCacheBinding: owner.appliedCacheBinding,
      });
      assertCurrent();
      owner.appliedCacheBinding = appliedCacheBinding;
    });
  const settled = operation.then(
    () => undefined,
    () => undefined,
  );
  owner.tail = settled;
  try {
    await operation;
  } finally {
    owner.active = Math.max(0, owner.active - 1);
    if (
      owner.active === 0 &&
      owner.latestEpoch === undefined &&
      activeComputerUseArtifactReconciliations.get(key) === owner &&
      owner.tail === settled
    ) {
      activeComputerUseArtifactReconciliations.delete(key);
    }
    pruneComputerUseArtifactOwners();
  }
}

async function reconcileCodexComputerUseStartArtifactsOnce(params: {
  startOptions: CodexAppServerStartOptions;
  agentDir: string;
  pluginConfig?: unknown;
  ownsIsolatedCodexHome?: boolean;
  codexHome: string;
  assertCurrent: () => void;
  desktopGeneration?: CodexDesktopGeneration;
  forceCacheRefresh?: boolean;
  previousCacheBinding?: string;
}): Promise<string | undefined> {
  const codexHome = params.codexHome;
  const computerUseConfig = resolveCodexComputerUseConfig({ pluginConfig: params.pluginConfig });
  const ownsIsolatedCodexHome =
    params.ownsIsolatedCodexHome ??
    (params.startOptions.homeScope !== "user" &&
      !params.startOptions.env?.[CODEX_HOME_ENV_VAR]?.trim());
  const shouldProvisionComputerUse =
    computerUseConfig.enabled && computerUseConfig.autoInstall && ownsIsolatedCodexHome;
  if (shouldProvisionComputerUse) {
    await ensureOwnedCodexHome(codexHome, params.agentDir);
  } else {
    await fs.mkdir(codexHome, { recursive: true });
  }
  const desktopCandidates = resolveMacOSDesktopCodexAppPathCandidates();
  const exactDesktopCandidate = desktopCandidates.find(
    (candidate) =>
      path.resolve(candidate.appServerCommandPath) === path.resolve(params.startOptions.command),
  );
  const usesManagedBundledMarketplace =
    !computerUseConfig.marketplaceSource &&
    !computerUseConfig.marketplacePath &&
    !computerUseConfig.marketplaceName;
  const needsBundledMarketplace =
    usesManagedBundledMarketplace ||
    (computerUseConfig.pluginCacheMode === "shared" &&
      !computerUseConfig.marketplaceName &&
      !computerUseConfig.marketplacePath);
  const artifactCandidate = shouldProvisionComputerUse
    ? await resolveCompleteComputerUseArtifactCandidate({
        candidates: exactDesktopCandidate ? [exactDesktopCandidate] : desktopCandidates,
        needsBundledMarketplace,
      })
    : exactDesktopCandidate;
  params.assertCurrent();
  if (shouldProvisionComputerUse) {
    if (desktopCandidates.length > 0 && !artifactCandidate) {
      throw new CodexComputerUseCandidateArtifactsUnavailableError();
    }
    try {
      const marketplacePath = usesManagedBundledMarketplace
        ? await ensureCodexManagedBundledMarketplace({
            codexHome,
            ownershipRoot: params.agentDir,
            ...(artifactCandidate
              ? {
                  appServerCommand: artifactCandidate.appServerCommandPath,
                  candidates: [artifactCandidate],
                  ownershipCandidates: desktopCandidates,
                }
              : {}),
            assertCurrent: params.assertCurrent,
          })
        : undefined;
      params.assertCurrent();
      if (usesManagedBundledMarketplace && desktopCandidates.length > 0 && !marketplacePath) {
        throw new CodexComputerUseCandidateArtifactsUnavailableError();
      }
      const service = await ensureCodexComputerUseServiceApp({
        codexHome,
        ownershipRoot: params.agentDir,
        ...(artifactCandidate
          ? {
              appServerCommand: artifactCandidate.appServerCommandPath,
              sourceAppCandidates: artifactCandidate.computerUseServiceAppPaths,
            }
          : {}),
        assertCurrent: params.assertCurrent,
      });
      params.assertCurrent();
      if (desktopCandidates.length > 0 && service.status === "source_missing") {
        throw new CodexComputerUseCandidateArtifactsUnavailableError();
      }
    } catch (error) {
      params.assertCurrent();
      if (error instanceof CodexComputerUseCandidateArtifactsUnavailableError) {
        throw error;
      }
      throw new AgentHarnessPreflightError("Codex Computer Use client provisioning failed.", {
        cause: error,
        scope: "harness",
      });
    }
  }
  params.assertCurrent();
  const cacheBinding = [
    params.desktopGeneration?.epoch ?? "manual",
    artifactCandidate?.bundledMarketplacePath ?? "default",
    computerUseConfig.pluginName,
  ].join("\0");
  const cache = await ensureCodexComputerUseSharedPluginCache({
    codexHome,
    config: computerUseConfig,
    ...(ownsIsolatedCodexHome ? { ownershipRoot: params.agentDir } : {}),
    ...(artifactCandidate
      ? { bundledMarketplacePath: artifactCandidate.bundledMarketplacePath }
      : {}),
    assertCurrent: params.assertCurrent,
    forceRefresh: params.forceCacheRefresh === true || params.previousCacheBinding !== cacheBinding,
  });
  params.assertCurrent();
  return cache.status === "shared" ? cacheBinding : undefined;
}

async function resolveCompleteComputerUseArtifactCandidate(params: {
  candidates: readonly MacOSDesktopCodexAppPathCandidate[];
  needsBundledMarketplace: boolean;
}): Promise<MacOSDesktopCodexAppPathCandidate | undefined> {
  for (const candidate of params.candidates) {
    if (
      params.needsBundledMarketplace &&
      !(await resolveCodexManagedBundledMarketplaceSource({ candidates: [candidate] }))
    ) {
      continue;
    }
    if (
      await resolveCodexComputerUseServiceAppSourcePath({
        sourceAppCandidates: candidate.computerUseServiceAppPaths,
      })
    ) {
      return candidate;
    }
  }
  return undefined;
}

function pruneComputerUseArtifactOwners(): void {
  while (activeComputerUseArtifactReconciliations.size > MAX_COMPUTER_USE_ARTIFACT_OWNERS) {
    const inactive = [...activeComputerUseArtifactReconciliations].find(
      ([, owner]) => owner.active === 0,
    );
    if (!inactive) {
      return;
    }
    activeComputerUseArtifactReconciliations.delete(inactive[0]);
  }
}

class CodexComputerUseCandidateArtifactsUnavailableError extends Error {
  readonly code = "CODEX_COMPUTER_USE_CANDIDATE_ARTIFACTS_UNAVAILABLE";

  constructor() {
    super("The selected Codex desktop app does not contain complete Computer Use artifacts.");
    this.name = "CodexComputerUseCandidateArtifactsUnavailableError";
  }
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
  assertCurrent?: () => void;
}): Promise<void> {
  params.assertCurrent?.();
  if (!params.preparedAuth && params.authProfileId === null) {
    await assertNativeCodexAccountMatchesRoute(
      params.client,
      params.authRequirement,
      params.assertCurrent,
    );
    return;
  }
  let loginParams =
    params.preparedAuth?.kind === "profile"
      ? params.preparedAuth.snapshot.loginParams
      : params.preparedAuth?.kind === "api-key"
        ? { type: "apiKey", apiKey: params.preparedAuth.apiKey }
        : await resolveCodexAppServerAuthProfileLoginParams({
            agentDir: params.agentDir,
            authProfileId: params.authProfileId ?? undefined,
            authProfileStore: params.authProfileStore,
            config: params.config,
          });
  if (params.authRequirement === "subscription" && loginParams?.type !== "chatgptAuthTokens") {
    throw createCodexAppServerAuthError(
      "Codex subscription auth profile could not produce login credentials. Sign in with `openclaw models auth login --provider openai`, select that profile, then retry.",
    );
  }
  if (
    !loginParams &&
    params.authRequirement === "api-key" &&
    params.startOptions?.transport === "stdio"
  ) {
    const env = resolveCodexAppServerSpawnEnv(params.startOptions, process.env);
    loginParams = await resolveCodexAppServerFallbackApiKeyLoginParams({
      client: params.client,
      env,
      codexCliAuthEnv: process.env,
      assertCurrent: params.assertCurrent,
    });
  }
  if (loginParams) {
    // Refresh and overload backoff can outlive the caller; check at the physical write.
    await params.client.request("account/login/start", loginParams, {
      assertCurrent: params.assertCurrent,
    });
  }
}

/**
 * Native-home connections are verified, never logged into. Both directions of the
 * check protect the same billing boundary: a subscription route cannot run without
 * ChatGPT tokens, and a Platform route must not silently spend the operator's
 * ChatGPT plan. An absent account is left alone because the native home may serve a
 * custom model provider that reports no OpenAI account at all.
 */
async function assertNativeCodexAccountMatchesRoute(
  client: CodexAppServerClient,
  authRequirement: CodexAppServerAuthRequirement | undefined,
  assertCurrent?: () => void,
): Promise<void> {
  if (!authRequirement) {
    return;
  }
  const response = await client.request<CodexGetAccountResponse>(
    "account/read",
    { refreshToken: false },
    { assertCurrent },
  );
  const accountType = isJsonObject(response.account) ? response.account.type : undefined;
  if (authRequirement === "subscription") {
    if (accountType !== "chatgpt") {
      throw createCodexAppServerAuthError(
        'Codex subscription route requires ChatGPT auth in the native Codex home. Run `codex login` for that home, or use appServer.homeScope="agent" with an OpenClaw OAuth profile, then retry.',
      );
    }
    return;
  }
  if (accountType === "chatgpt") {
    throw createCodexAppServerAuthError(
      'Codex Platform route requires an API-key account, but the native Codex home is signed in with a ChatGPT subscription. Sign that home in with `codex login --with-api-key`, or set appServer.homeScope="agent" so OpenClaw can inject its own key.',
    );
  }
}

function createCodexAppServerAuthError(message: string, cause?: unknown): Error & { status: 401 } {
  const error = cause === undefined ? new Error(message) : new Error(message, { cause });
  return Object.assign(error, { status: 401 as const });
}

class CodexAppServerAuthProfileUnavailableError extends Error {
  readonly status = 401;
  readonly code = "selected_auth_profile_unavailable";
}

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
      `Codex app-server auth profile "${profileId}" was not found. Select an existing OpenAI profile or sign in again with OpenClaw, then retry.`,
    );
  }
  if (profileId && profile && !isCodexAppServerAuthProfileCredential(profile)) {
    throw new CodexAppServerAuthProfileUnavailableError(
      `Codex app-server auth profile "${profileId}" must use the canonical OpenAI auth provider; run "openclaw doctor --fix" to migrate legacy provider IDs.`,
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
  previousAccountId?: string | null;
  config?: AuthProfileOrderConfig;
}): Promise<CodexChatgptAuthTokensRefreshResponse> {
  const previousAccountId = params.previousAccountId?.trim();
  if (previousAccountId) {
    const store = resolveCodexAppServerAuthProfileStore(params);
    const profileId = resolveCodexAppServerAuthProfileId({
      authProfileId: params.authProfileId,
      store,
      config: params.config,
    });
    const credential = profileId ? store.profiles[profileId] : undefined;
    const selectedAccountId = credential
      ? (resolveExplicitChatgptAccountId(credential) ??
        (credential.type === "oauth"
          ? resolveOpenAICodexAuthIdentity({ access: credential.access }).accountId
          : undefined))
      : undefined;
    if (selectedAccountId && selectedAccountId !== previousAccountId) {
      throw new Error(
        "ChatGPT workspace changed before Codex token refresh. Retry to start a client for the selected workspace.",
      );
    }
  }
  const loginParams = await resolveCodexAppServerAuthProfileLoginParamsInternal({
    ...params,
    forceOAuthRefresh: true,
  });
  if (!loginParams || loginParams.type !== "chatgptAuthTokens") {
    throw new Error(
      "Codex app-server ChatGPT token refresh requires an OAuth auth profile. Sign in with `openclaw models auth login --provider openai`, select that profile, then retry.",
    );
  }
  if (previousAccountId && loginParams.chatgptAccountId !== previousAccountId) {
    throw new Error(
      "ChatGPT workspace changed during Codex token refresh. Retry to start a client for the selected workspace.",
    );
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
    throw new CodexAppServerAuthProfileUnavailableError(
      `Codex app-server auth profile "${profileId}" was not found. Select an existing OpenAI profile or sign in again with OpenClaw, then retry.`,
    );
  }
  if (!isCodexAppServerAuthProfileCredential(credential)) {
    throw new CodexAppServerAuthProfileUnavailableError(
      `Codex app-server auth profile "${profileId}" must use the canonical OpenAI auth provider; run "openclaw doctor --fix" to migrate legacy provider IDs.`,
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
      `Codex app-server auth profile "${profileId}" does not contain usable credentials. Repair or replace the selected OpenAI credential, then retry.`,
    );
  }
  return loginParams;
}

async function resolveCodexAppServerFallbackApiKeyLoginParams(params: {
  client: CodexAppServerClient;
  env: NodeJS.ProcessEnv;
  codexCliAuthEnv: NodeJS.ProcessEnv;
  assertCurrent?: () => void;
}): Promise<CodexLoginAccountParams | undefined> {
  const apiKey =
    readFirstNonEmptyEnv(params.env, CODEX_APP_SERVER_API_KEY_ENV_VARS) ??
    (await readCodexCliAuthFileApiKey(params.codexCliAuthEnv));
  if (!apiKey) {
    return undefined;
  }
  const response = await params.client.request<CodexGetAccountResponse>(
    "account/read",
    { refreshToken: false },
    { assertCurrent: params.assertCurrent },
  );
  if (response.account) {
    return undefined;
  }
  return { type: "apiKey", apiKey };
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
        : ensureAuthProfileStore(params.agentDir, { allowKeychainPrompt: false, profileId }),
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
        : ensureAuthProfileStore(params.agentDir, { allowKeychainPrompt: false, profileId }),
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
    : resolveCodexAppServerAuthProfileStore({
        agentDir: ownerAgentDir,
        authProfileId: profileId,
        config: params.config,
      });
  const persistedOAuthCredential =
    !useScopedCredential &&
    persistedCredential?.type === "oauth" &&
    isCodexAppServerAuthProvider(persistedCredential.provider)
      ? persistedCredential
      : undefined;
  const ownerCredential = store.profiles[profileId];
  const overlaidOAuthCredential =
    ownerCredential?.type === "oauth" && isCodexAppServerAuthProvider(ownerCredential.provider)
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
      throw new Error(
        `Codex app-server auth profile "${profileId}" could not refresh. Sign in again with OpenClaw, then retry.`,
      );
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
    : loadAuthProfileStoreForSecretsRuntime(ownerAgentDir, { profileId }).profiles[profileId];
  const refreshedOAuthCredential =
    refreshed?.type === "oauth" && isCodexAppServerAuthProvider(refreshed.provider)
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
    : storedCredential?.type === "oauth" && isCodexAppServerAuthProvider(storedCredential.provider)
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
  // Claim-only workspaces must stay distinct even when their emails match,
  // or a scoped refresh can overwrite a replacement persisted account.
  const persistedAccountId = resolveOpenAICodexAuthIdentity(persisted).accountId?.trim();
  const suppliedAccountId = resolveOpenAICodexAuthIdentity(supplied).accountId?.trim();
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
      throw new Error(
        `Codex app-server auth profile "${params.profileId}" could not refresh. Sign in again with OpenClaw, then retry.`,
      );
    }
    if (!isDeepStrictEqual(params.store.profiles[params.profileId], credential)) {
      throw new Error(
        `Codex app-server auth profile "${params.profileId}" changed while refreshing. Retry with the newly selected OpenAI profile.`,
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

// Runtime consumes canonical auth state; doctor owns retired profile-id migration.
function isCodexAppServerAuthProvider(provider: string): boolean {
  return provider.trim().toLowerCase() === CODEX_APP_SERVER_AUTH_PROVIDER;
}

function isCodexAppServerAuthProfileCredential(credential: AuthProfileCredential): boolean {
  return isCodexAppServerAuthProvider(credential.provider);
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

function buildChatgptAuthTokensParams(
  profileId: string,
  credential: AuthProfileCredential,
  accessToken: string,
): CodexLoginAccountParams {
  const storedAccountId = resolveExplicitChatgptAccountId(credential);
  const tokenAccountId = resolveOpenAICodexAuthIdentity({ access: accessToken }).accountId;
  if (storedAccountId && tokenAccountId && storedAccountId !== tokenAccountId) {
    throw new CodexAppServerAuthProfileUnavailableError(
      `Codex app-server auth profile "${profileId}" has a different ChatGPT account ID than its access token. Sign in again before retrying.`,
    );
  }
  const chatgptAccountId = storedAccountId ?? tokenAccountId;
  if (!chatgptAccountId) {
    throw new CodexAppServerAuthProfileUnavailableError(
      `Codex app-server auth profile "${profileId}" is missing its ChatGPT account ID. Sign in again before retrying.`,
    );
  }
  return {
    type: "chatgptAuthTokens",
    accessToken,
    chatgptAccountId,
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
  return resolveExplicitChatgptAccountId(credential) ?? (credential.email?.trim() || undefined);
}

function resolveExplicitChatgptAccountId(credential: AuthProfileCredential): string | undefined {
  if ("accountId" in credential && typeof credential.accountId === "string") {
    const accountId = credential.accountId.trim();
    if (accountId) {
      return accountId;
    }
  }
  return undefined;
}
