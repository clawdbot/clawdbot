/** Commands for adding, pasting, and logging into provider model auth profiles. */
import {
  cancel,
  confirm as clackConfirm,
  isCancel,
  password as clackPassword,
  select as clackSelect,
  text as clackText,
} from "@clack/prompts";
import { expectDefined } from "@openclaw/normalization-core";
import { resolveExpiresAtMsFromDurationMs } from "@openclaw/normalization-core/number-coercion";
import {
  normalizeOptionalString,
  normalizeStringifiedOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import { styleSelectParams } from "../../../packages/terminal-core/src/prompt-select-styled-params.js";
import { stylePromptMessage } from "../../../packages/terminal-core/src/prompt-style.js";
import {
  resolveAgentDir,
  resolveAgentWorkspaceDir,
  resolveDefaultAgentId,
} from "../../agents/agent-scope.js";
import {
  externalCliDiscoveryForProviderAuth,
  removeProviderAuthProfilesWithLock,
} from "../../agents/auth-profiles.js";
import {
  listProfilesForProvider,
  promoteAuthProfileInOrder,
  upsertAuthProfileWithLock,
} from "../../agents/auth-profiles/profiles.js";
import { loadAuthProfileStoreForRuntime } from "../../agents/auth-profiles/store.js";
import type { AuthProfileCredential } from "../../agents/auth-profiles/types.js";
import { clearAuthProfileCooldown } from "../../agents/auth-profiles/usage.js";
import { normalizeProviderId } from "../../agents/model-selection-normalize.js";
import { resolveProviderIdForAuth } from "../../agents/provider-auth-aliases.js";
import { resolveDefaultAgentWorkspaceDir } from "../../agents/workspace.js";
import { formatCliCommand } from "../../cli/command-format.js";
import { parseDurationMs } from "../../cli/parse-duration.js";
import { logConfigUpdated } from "../../config/logging.js";
import { normalizeAgentModelRefForConfig } from "../../config/model-input.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { callGateway } from "../../gateway/call.js";
import { isRemoteEnvironment } from "../../infra/remote-env.js";
import {
  applyProviderAuthConfigPatch,
  applyDefaultModel,
  pickAuthMethod,
  restorePriorAgentsDefaultsModelUnlessOptIn,
  resolveProviderMatch,
} from "../../plugins/provider-auth-choice-helpers.js";
import { applyAuthProfileConfig } from "../../plugins/provider-auth-helpers.js";
import { createVpsAwareOAuthHandlers } from "../../plugins/provider-oauth-flow.js";
import { resolvePluginProviders } from "../../plugins/providers.runtime.js";
import {
  resolvePluginSetupProvider,
  resolvePluginSetupRegistry,
} from "../../plugins/setup-registry.js";
import type {
  ProviderAuthMethod,
  ProviderAuthResult,
  ProviderPlugin,
} from "../../plugins/types.js";
import type { RuntimeEnv } from "../../runtime.js";
import { normalizeSecretInput } from "../../utils/normalize-secret-input.js";
import { createClackPrompter } from "../../wizard/clack-prompter.js";
import type { WizardPrompter } from "../../wizard/prompts.js";
import { validateAnthropicSetupToken } from "../auth-token.js";
import { repairCodexRuntimePluginInstallForModelSelection } from "../codex-runtime-plugin-install.js";
import { repairCopilotRuntimePluginInstallForModelSelection } from "../copilot-runtime-plugin-install.js";
import { loadValidConfigOrThrow, resolveKnownAgentId, updateConfig } from "./shared.js";

type UpsertAuthProfileParams = Parameters<typeof upsertAuthProfileWithLock>[0];

// CLI auth writes occur outside the gateway process, which may retain an older runtime snapshot.
async function refreshRunningGatewayAuthState(): Promise<void> {
  try {
    await callGateway({
      method: "models.authStatus",
      params: { refresh: true },
      timeoutMs: 3000,
    });
  } catch {
    // Auth writes must still succeed when no local gateway is running.
  }
}

function resolveManualTokenExpiryMs(expiresIn: string | undefined): number | undefined {
  const normalizedExpiresIn = normalizeStringifiedOptionalString(expiresIn);
  if (!normalizedExpiresIn) {
    return undefined;
  }
  const durationMs = parseDurationMs(normalizedExpiresIn, { defaultUnit: "d" });
  const expires = resolveExpiresAtMsFromDurationMs(durationMs);
  if (expires === undefined) {
    throw new Error("Invalid expiry duration: resulting token expiry is outside Date range.");
  }
  return expires;
}

function guardCancel<T>(value: T | symbol): T {
  if (typeof value === "symbol" || isCancel(value)) {
    cancel("Cancelled.");
    process.exit(0);
  }
  return value;
}

const confirm = async (params: Parameters<typeof clackConfirm>[0]) =>
  guardCancel(
    await clackConfirm({
      ...params,
      message: stylePromptMessage(params.message),
    }),
  );
const text = async (params: Parameters<typeof clackText>[0]) =>
  guardCancel(
    await clackText({
      ...params,
      message: stylePromptMessage(params.message),
    }),
  );
const password = async (params: Parameters<typeof clackPassword>[0]) =>
  guardCancel(
    await clackPassword({
      ...params,
      message: stylePromptMessage(params.message),
    }),
  );
const select = async <T>(params: Parameters<typeof clackSelect<T>>[0]) =>
  guardCancel(await clackSelect(styleSelectParams(params)));

async function readPipedStdin(): Promise<string> {
  process.stdin.setEncoding("utf8");
  let input = "";
  for await (const chunk of process.stdin) {
    input += String(chunk);
  }
  return input;
}

async function readPastedSecret(params: {
  message: string;
  masked: boolean;
  validate?: (value: string | undefined) => string | undefined;
}): Promise<string> {
  const promptParams = { message: params.message, validate: params.validate };
  const input = process.stdin.isTTY
    ? await (params.masked ? password(promptParams) : text(promptParams))
    : await readPipedStdin();
  const normalized = normalizeSecretInput(input);
  const validationMessage = params.validate?.(normalized);
  if (validationMessage) {
    throw new Error(validationMessage);
  }
  return normalized;
}

function resolveDefaultTokenProfileId(provider: string): string {
  return `${normalizeProviderId(provider)}:manual`;
}

function normalizeManualAuthProvider(provider: string): string {
  const normalized = normalizeProviderId(provider);
  return normalized === "openai" || normalized === "codex" || normalized === "openai-codex"
    ? "openai"
    : normalized;
}

function isOpenAIProvider(provider: string): boolean {
  return normalizeManualAuthProvider(provider) === "openai";
}

function stripBearerPrefix(value: string): string {
  return value
    .trim()
    .replace(/^Bearer\s+/i, "")
    .trim();
}

function looksLikeOpenAIApiKey(value: string): boolean {
  return /^sk-[A-Za-z0-9_-]{8,}$/.test(value.trim());
}

function looksLikeJwtToken(value: string): boolean {
  const token = stripBearerPrefix(value);
  const parts = token.split(".");
  return parts.length === 3 && parts.every((part) => /^[A-Za-z0-9_-]{8,}$/.test(part));
}

function looksLikeStructuredCredential(value: string): boolean {
  const trimmed = value.trim();
  return trimmed.startsWith("{") || trimmed.startsWith("[");
}

function validateOpenAICodexApiKeyInput(value: string): string | undefined {
  const trimmed = value.trim();
  if (!trimmed) {
    return "Required";
  }
  if (looksLikeOpenAIApiKey(trimmed)) {
    return undefined;
  }
  if (looksLikeJwtToken(trimmed) || looksLikeStructuredCredential(trimmed)) {
    // OAuth/token material belongs in token profiles; storing it as an API key
    // would make provider auth fail later with misleading model errors.
    return `That looks like token or OAuth material, not an OpenAI API key. Use ${formatCliCommand("openclaw models auth paste-token --provider openai")} for token auth material.`;
  }
  return "That does not look like an OpenAI API key.";
}

type ResolvedModelsAuthContext = {
  config: OpenClawConfig;
  agentDir: string;
  workspaceDir: string;
  providers: ProviderPlugin[];
};

function listProvidersWithAuthMethods(providers: ProviderPlugin[]): ProviderPlugin[] {
  return providers.filter((provider) => provider.auth.length > 0);
}

function listTokenAuthMethods(provider: ProviderPlugin): ProviderAuthMethod[] {
  return provider.auth.filter((method) => method.kind === "token");
}

function listProvidersWithTokenMethods(providers: ProviderPlugin[]): ProviderPlugin[] {
  return providers.filter((provider) => listTokenAuthMethods(provider).length > 0);
}

function mergeSetupProviders(
  providers: readonly ProviderPlugin[],
  setupProviders: readonly ProviderPlugin[],
): ProviderPlugin[] {
  if (setupProviders.length === 0) {
    return [...providers];
  }
  const setupById = new Map(
    setupProviders.map((provider) => [normalizeProviderId(provider.id), provider] as const),
  );
  const merged = providers.map(
    (provider) => setupById.get(normalizeProviderId(provider.id)) ?? provider,
  );
  const existing = new Set(merged.map((provider) => normalizeProviderId(provider.id)));
  for (const provider of setupProviders) {
    if (!existing.has(normalizeProviderId(provider.id))) {
      merged.push(provider);
    }
  }
  return merged;
}

function preferSetupAuthProviders(params: {
  providers: readonly ProviderPlugin[];
  config: OpenClawConfig;
  workspaceDir: string;
  requestedProvider?: string;
}): ProviderPlugin[] {
  const requestedProvider = params.requestedProvider
    ? normalizeManualAuthProvider(params.requestedProvider)
    : undefined;
  if (requestedProvider) {
    const setupProvider = resolvePluginSetupProvider({
      provider: requestedProvider,
      config: params.config,
      workspaceDir: params.workspaceDir,
    });
    return setupProvider ? [setupProvider] : [...params.providers];
  }

  const setupProviders = resolvePluginSetupRegistry({
    config: params.config,
    workspaceDir: params.workspaceDir,
  }).providers.map((entry) => entry.provider);
  return mergeSetupProviders(params.providers, setupProviders);
}

async function resolveModelsAuthContext(params?: {
  requestedProvider?: string;
  rawAgentId?: string | null;
  config?: OpenClawConfig;
}): Promise<ResolvedModelsAuthContext> {
  const config = params?.config ?? (await loadValidConfigOrThrow());
  const agentId =
    resolveKnownAgentId({ cfg: config, rawAgentId: params?.rawAgentId }) ??
    resolveDefaultAgentId(config);
  const agentDir = resolveAgentDir(config, agentId);
  const workspaceDir =
    resolveAgentWorkspaceDir(config, agentId) ?? resolveDefaultAgentWorkspaceDir();
  const requestedProvider = params?.requestedProvider?.trim();
  const providerRef = requestedProvider
    ? normalizeManualAuthProvider(requestedProvider)
    : undefined;
  const providers = resolvePluginProviders({
    config,
    workspaceDir,
    mode: "setup",
    includeUntrustedWorkspacePlugins: false,
    bundledProviderVitestCompat: true,
    ...(providerRef
      ? {
          providerRefs: [providerRef],
          activate: true,
        }
      : {}),
  });
  const authProviders = preferSetupAuthProviders({
    providers,
    config,
    workspaceDir,
    requestedProvider: providerRef,
  });
  return {
    config,
    agentDir,
    workspaceDir,
    providers: authProviders,
  };
}

async function resolveModelsAuthAgentDir(rawAgentId?: string | null): Promise<string> {
  const config = await loadValidConfigOrThrow();
  const agentId = resolveKnownAgentId({ cfg: config, rawAgentId }) ?? resolveDefaultAgentId(config);
  return resolveAgentDir(config, agentId);
}

function resolveRequestedProviderOrThrow(
  providers: ProviderPlugin[],
  rawProvider?: string,
): ProviderPlugin | null {
  const requested = rawProvider?.trim();
  if (!requested) {
    return null;
  }
  const matched = resolveProviderMatch(providers, requested);
  if (matched) {
    return matched;
  }
  const available = providers
    .map((provider) => provider.id)
    .filter(Boolean)
    .toSorted((a, b) => a.localeCompare(b));
  const availableText = available.length > 0 ? available.join(", ") : "(none)";
  throw new Error(
    `Unknown provider "${requested}". Loaded providers: ${availableText}. Verify plugins via \`${formatCliCommand("openclaw plugins list --json")}\`.`,
  );
}

function resolveTokenMethodOrThrow(
  provider: ProviderPlugin,
  rawMethod?: string,
): ProviderAuthMethod | null {
  const tokenMethods = listTokenAuthMethods(provider);
  if (rawMethod?.trim()) {
    const matched = pickAuthMethod(provider, rawMethod);
    if (matched && matched.kind === "token") {
      return matched;
    }
    const available = tokenMethods.map((method) => method.id).join(", ") || "(none)";
    throw new Error(
      `Unknown token auth method "${rawMethod}" for provider "${provider.id}". Available token methods: ${available}.`,
    );
  }
  return null;
}

async function pickProviderAuthMethod(params: {
  provider: ProviderPlugin;
  requestedMethod?: string;
  prompter: WizardPrompter;
}) {
  const rawRequestedMethod = params.requestedMethod?.trim();
  if (rawRequestedMethod) {
    return pickAuthMethod(params.provider, rawRequestedMethod);
  }
  const oauthMethod = params.provider.auth.find((method) => method.kind === "oauth");
  if (oauthMethod) {
    return oauthMethod;
  }
  if (params.provider.auth.length === 1) {
    return params.provider.auth[0] ?? null;
  }
  return await params.prompter
    .select({
      message: `Auth method for ${params.provider.label}`,
      options: params.provider.auth.map((method) => ({
        value: method.id,
        label: method.label,
        hint: method.hint,
      })),
    })
    .then((id) => params.provider.auth.find((method) => method.id === id) ?? null);
}

async function pickProviderTokenMethod(params: {
  provider: ProviderPlugin;
  requestedMethod?: string;
  prompter: WizardPrompter;
}) {
  const explicitTokenMethod = resolveTokenMethodOrThrow(params.provider, params.requestedMethod);
  if (explicitTokenMethod) {
    return explicitTokenMethod;
  }
  const tokenMethods = listTokenAuthMethods(params.provider);
  if (tokenMethods.length === 0) {
    return null;
  }
  const setupTokenMethod = tokenMethods.find((method) => method.id === "setup-token");
  if (setupTokenMethod) {
    return setupTokenMethod;
  }
  if (tokenMethods.length === 1) {
    return tokenMethods[0] ?? null;
  }
  return await params.prompter
    .select({
      message: `Token method for ${params.provider.label}`,
      options: tokenMethods.map((method) => ({
        value: method.id,
        label: method.label,
        hint: method.hint,
      })),
    })
    .then((id) => tokenMethods.find((method) => method.id === id) ?? null);
}

async function persistProviderAuthResult(params: {
  result: ProviderAuthResult;
  profiles?: ProviderAuthResult["profiles"];
  config: OpenClawConfig;
  agentDir: string;
  runtime: RuntimeEnv;
  prompter: WizardPrompter;
  setDefault?: boolean;
}) {
  const defaultModel = params.result.defaultModel
    ? normalizeAgentModelRefForConfig(params.result.defaultModel)
    : undefined;
  const profiles = params.profiles ?? params.result.profiles;
  const shouldUpdateConfig = Boolean(
    params.result.configPatch || (params.setDefault && defaultModel),
  );

  for (const profile of profiles) {
    const configuredSelection = resolveConfiguredAuthSelectionForProvider(
      params.config,
      profile.credential.provider,
    );
    await upsertAuthProfileWithLockOrThrow({
      profileId: profile.profileId,
      credential: profile.credential,
      agentDir: params.agentDir,
    });
    await promoteAuthProfileInOrder({
      agentDir: params.agentDir,
      provider: profile.credential.provider,
      profileId: profile.profileId,
      createIfMissing: configuredSelection.createIfMissing,
      ...(configuredSelection.order ? { createFromOrder: configuredSelection.order } : {}),
    });
  }

  // Auth login owns the credential store. Keep openclaw.json untouched unless
  // the provider explicitly returns a config patch or the user opts into a
  // default-model write.
  if (shouldUpdateConfig) {
    const updated = await updateConfig((cfg) => {
      const priorAgentsDefaultsModel = cfg.agents?.defaults?.model;
      let next = cfg;
      if (params.result.configPatch) {
        next = applyProviderAuthConfigPatch(next, params.result.configPatch, {
          replaceDefaultModels: params.result.replaceDefaultModels,
        });
      }
      next = restorePriorAgentsDefaultsModelUnlessOptIn({
        cfg: next,
        priorAgentsDefaultsModel,
        setDefault: params.setDefault,
      });
      if (params.setDefault && defaultModel) {
        next = applyDefaultModel(next, defaultModel);
      }
      return next;
    });
    if (defaultModel) {
      const repaired = await repairCodexRuntimePluginInstallForModelSelection({
        cfg: updated,
        model: defaultModel,
      });
      const copilotRepaired = await repairCopilotRuntimePluginInstallForModelSelection({
        cfg: updated,
        model: defaultModel,
      });
      for (const warning of [...repaired.warnings, ...copilotRepaired.warnings]) {
        params.runtime.error?.(warning);
      }
    }
    logConfigUpdated(params.runtime);
  }

  await refreshRunningGatewayAuthState();

  for (const profile of profiles) {
    params.runtime.log(
      `Auth profile: ${profile.profileId} (${profile.credential.provider}/${credentialMode(profile.credential)})`,
    );
  }
  if (defaultModel) {
    params.runtime.log(
      params.setDefault
        ? `Default model set to ${defaultModel}`
        : `Default model available: ${defaultModel} (use --set-default to apply)`,
    );
  }
  if (params.result.notes && params.result.notes.length > 0) {
    await params.prompter.note(params.result.notes.join("\n"), "Provider notes");
  }
}

function resolveConfiguredAuthSelectionForProvider(
  cfg: OpenClawConfig,
  provider: string,
): { createIfMissing: boolean; order?: string[] } {
  const providerAuthKey = resolveProviderIdForAuth(provider, { config: cfg });
  for (const [orderProvider, profileIds] of Object.entries(cfg.auth?.order ?? {})) {
    if (
      profileIds.length > 0 &&
      resolveProviderIdForAuth(orderProvider, { config: cfg }) === providerAuthKey
    ) {
      return { createIfMissing: true, order: profileIds };
    }
  }
  const profileIds = Object.entries(cfg.auth?.profiles ?? {})
    .filter(
      ([, profile]) =>
        resolveProviderIdForAuth(profile.provider, { config: cfg }) === providerAuthKey,
    )
    .map(([profileId]) => profileId);
  return profileIds.length > 0
    ? { createIfMissing: true, order: profileIds }
    : { createIfMissing: false };
}

async function runProviderAuthMethod(params: {
  config: OpenClawConfig;
  agentDir: string;
  workspaceDir: string;
  provider: ProviderPlugin;
  method: ProviderAuthMethod;
  runtime: RuntimeEnv;
  prompter: WizardPrompter;
  profileId?: string;
  setDefault?: boolean;
  env?: NodeJS.ProcessEnv;
  isRemote?: boolean;
  openUrl?: (url: string) => Promise<void>;
}): Promise<{ result: ProviderAuthResult; profiles: ProviderAuthResult["profiles"] }> {
  const selectedProviderId = normalizeProviderId(params.provider.id);
  await clearStaleProfileLockouts(selectedProviderId, params.agentDir);

  const result = await params.method.run({
    config: params.config,
    env: params.env ?? process.env,
    agentDir: params.agentDir,
    workspaceDir: params.workspaceDir,
    prompter: params.prompter,
    runtime: params.runtime,
    allowSecretRefPrompt: false,
    isRemote: params.isRemote ?? isRemoteEnvironment(),
    openUrl:
      params.openUrl ??
      (async (url) => {
        const { openUrl } = await import("../onboard-helpers.js");
        await openUrl(url);
      }),
    oauth: {
      createVpsAwareHandlers: (runtimeParams) => createVpsAwareOAuthHandlers(runtimeParams),
    },
  });
  const resultProviderIds = new Set(
    result.profiles.map((profile) => normalizeProviderId(profile.credential.provider)),
  );
  for (const providerId of resultProviderIds) {
    if (providerId && providerId !== selectedProviderId) {
      await clearStaleProfileLockouts(providerId, params.agentDir);
    }
  }

  const profiles = resolveLoginProfiles({
    result,
    requestedProfileId: params.profileId,
  });

  await persistProviderAuthResult({
    result,
    profiles,
    config: params.config,
    agentDir: params.agentDir,
    runtime: params.runtime,
    prompter: params.prompter,
    setDefault: params.setDefault,
  });

  return { result, profiles };
}

/** Runs an interactive provider setup-token auth flow. */
export async function modelsAuthSetupTokenCommand(
  opts: { provider?: string; yes?: boolean; agent?: string },
  runtime: RuntimeEnv,
) {
  if (!process.stdin.isTTY) {
    throw new Error(
      `setup-token requires an interactive TTY. In automation, use ${formatCliCommand("openclaw models auth paste-token --provider <provider>")} instead.`,
    );
  }

  const { config, agentDir, workspaceDir, providers } = await resolveModelsAuthContext({
    requestedProvider: opts.provider,
    rawAgentId: opts.agent,
  });
  const tokenProviders = listProvidersWithTokenMethods(providers);
  if (tokenProviders.length === 0) {
    throw new Error(
      `No provider token-auth plugins found. Install one via \`${formatCliCommand("openclaw plugins install")}\`.`,
    );
  }

  const provider =
    resolveRequestedProviderOrThrow(tokenProviders, opts.provider) ?? tokenProviders[0] ?? null;
  if (!provider) {
    throw new Error(
      `No token-capable provider is available. Run ${formatCliCommand("openclaw plugins list")} to verify provider plugins are installed.`,
    );
  }

  if (!opts.yes) {
    const proceed = await confirm({
      message: `Continue with ${provider.label} token auth?`,
      initialValue: true,
    });
    if (!proceed) {
      return;
    }
  }

  const prompter = createClackPrompter();
  const method = await pickProviderTokenMethod({ provider, prompter });
  if (!method) {
    throw new Error(`Provider "${provider.id}" does not expose a token auth method.`);
  }

  await runProviderAuthMethod({
    config,
    agentDir,
    workspaceDir,
    provider,
    method,
    runtime,
    prompter,
  });
}

/** Reads a pasted bearer/setup token and stores it as an auth profile. */
export async function modelsAuthPasteTokenCommand(
  opts: {
    provider?: string;
    profileId?: string;
    expiresIn?: string;
    agent?: string;
  },
  runtime: RuntimeEnv,
) {
  const agentDir = await resolveModelsAuthAgentDir(opts.agent);
  const rawProvider = normalizeOptionalString(opts.provider);
  if (!rawProvider) {
    throw new Error(
      `Missing --provider. Run ${formatCliCommand("openclaw models status")} or ${formatCliCommand("openclaw plugins list")} to choose a provider.`,
    );
  }
  const provider = normalizeManualAuthProvider(rawProvider);
  const profileId =
    normalizeOptionalString(opts.profileId) || resolveDefaultTokenProfileId(provider);

  const validateTokenInput = (value: string | undefined): string | undefined => {
    const trimmed = value?.trim();
    if (!trimmed) {
      return "Required";
    }
    if (provider === "anthropic") {
      return validateAnthropicSetupToken(trimmed.replaceAll(/\s+/g, ""));
    }
    if (isOpenAIProvider(provider) && looksLikeOpenAIApiKey(trimmed)) {
      return `That looks like an OpenAI API key. Use ${formatCliCommand("openclaw models auth paste-api-key --provider openai")} for API-key auth.`;
    }
    return undefined;
  };
  const tokenInput = await readPastedSecret({
    message: `Paste token for ${provider}`,
    masked: true,
    validate: validateTokenInput,
  });
  const token =
    provider === "anthropic"
      ? tokenInput.replaceAll(/\s+/g, "").trim()
      : (normalizeOptionalString(tokenInput) ?? "");

  const expires = resolveManualTokenExpiryMs(opts.expiresIn);

  await upsertAuthProfileWithLockOrThrow({
    profileId,
    credential: {
      type: "token",
      provider,
      token,
      ...(expires ? { expires } : {}),
    },
    agentDir,
  });

  await updateConfig((cfg) => applyAuthProfileConfig(cfg, { profileId, provider, mode: "token" }));

  await refreshRunningGatewayAuthState();

  logConfigUpdated(runtime);
  runtime.log(`Auth profile: ${profileId} (${provider}/token)`);
  if (provider === "anthropic") {
    runtime.log("Anthropic setup-token auth is supported in OpenClaw.");
    runtime.log("OpenClaw prefers Claude CLI reuse when it is available on the host.");
    runtime.log("Anthropic staff told us this OpenClaw path is allowed again.");
  }
}

/** Reads a pasted API key and stores it as an auth profile. */
export async function modelsAuthPasteApiKeyCommand(
  opts: {
    provider?: string;
    profileId?: string;
    agent?: string;
  },
  runtime: RuntimeEnv,
) {
  const agentDir = await resolveModelsAuthAgentDir(opts.agent);
  const rawProvider = normalizeOptionalString(opts.provider);
  if (!rawProvider) {
    throw new Error(
      `Missing --provider. Run ${formatCliCommand("openclaw models status")} or ${formatCliCommand("openclaw plugins list")} to choose a provider.`,
    );
  }
  const provider = normalizeManualAuthProvider(rawProvider);
  const profileId =
    normalizeOptionalString(opts.profileId) || resolveDefaultTokenProfileId(provider);

  const key = await readPastedSecret({
    message: `Paste API key for ${provider}`,
    masked: true,
    validate: (value) => {
      const trimmed = value?.trim();
      if (!trimmed) {
        return "Required";
      }
      if (isOpenAIProvider(provider)) {
        return validateOpenAICodexApiKeyInput(trimmed);
      }
      return undefined;
    },
  });

  await upsertAuthProfileWithLockOrThrow({
    profileId,
    credential: {
      type: "api_key",
      provider,
      key,
    },
    agentDir,
  });

  await updateConfig((cfg) =>
    applyAuthProfileConfig(cfg, { profileId, provider, mode: "api_key" }),
  );

  await refreshRunningGatewayAuthState();

  logConfigUpdated(runtime);
  runtime.log(`Auth profile: ${profileId} (${provider}/api_key)`);
}

async function upsertAuthProfileWithLockOrThrow(params: UpsertAuthProfileParams): Promise<void> {
  const updated = await upsertAuthProfileWithLock(params);
  if (!updated) {
    throw new Error(
      "Failed to update auth profile store; the auth store lock may be busy. Wait a moment and retry.",
    );
  }
}

/** Interactive helper for adding token auth profiles, with provider/method prompts. */
export async function modelsAuthAddCommand(opts: { agent?: string }, runtime: RuntimeEnv) {
  const { config, agentDir, workspaceDir, providers } = await resolveModelsAuthContext({
    rawAgentId: opts.agent,
  });
  const tokenProviders = listProvidersWithTokenMethods(providers);

  const provider = await select({
    message: "Token provider",
    options: [
      ...tokenProviders.map((providerPlugin) => ({
        value: providerPlugin.id,
        label: providerPlugin.id,
        hint: providerPlugin.docsPath ? `Docs: ${providerPlugin.docsPath}` : undefined,
      })),
      { value: "custom", label: "custom (type provider id)" },
    ],
  });

  const providerId =
    provider === "custom"
      ? normalizeProviderId(
          await text({
            message: "Provider id",
            validate: (value) => (value?.trim() ? undefined : "Required"),
          }),
        )
      : provider;

  const providerPlugin =
    provider === "custom" ? null : resolveRequestedProviderOrThrow(tokenProviders, providerId);
  if (providerPlugin) {
    const tokenMethods = listTokenAuthMethods(providerPlugin);
    const methodId =
      tokenMethods.length > 0
        ? await select({
            message: "Token method",
            options: [
              ...tokenMethods.map((method) => ({
                value: method.id,
                label: method.label,
                hint: method.hint,
              })),
              { value: "paste", label: "paste token" },
            ],
          })
        : "paste";
    if (methodId !== "paste") {
      const prompter = createClackPrompter();
      const method = tokenMethods.find((candidate) => candidate.id === methodId);
      if (!method) {
        throw new Error(
          `Unknown token auth method "${methodId}". Run ${formatCliCommand("openclaw models auth login --provider " + providerPlugin.id)} to choose interactively.`,
        );
      }
      await runProviderAuthMethod({
        config,
        agentDir,
        workspaceDir,
        provider: providerPlugin,
        method,
        runtime,
        prompter,
      });
      return;
    }
  }

  const profileIdDefault = resolveDefaultTokenProfileId(providerId);
  const profileId = (
    await text({
      message: "Profile id",
      initialValue: profileIdDefault,
      validate: (value) => (value?.trim() ? undefined : "Required"),
    })
  ).trim();

  const wantsExpiry = await confirm({
    message: "Does this token expire?",
    initialValue: false,
  });
  const expiresIn = wantsExpiry
    ? (
        await text({
          message: "Expires in (duration)",
          initialValue: "365d",
          validate: (value) => {
            try {
              parseDurationMs(value ?? "", { defaultUnit: "d" });
              return undefined;
            } catch {
              return "Invalid duration (e.g. 365d, 12h, 30m)";
            }
          },
        })
      ).trim()
    : undefined;

  await modelsAuthPasteTokenCommand(
    { provider: providerId, profileId, expiresIn, agent: opts.agent },
    runtime,
  );
}

type LoginOptions = {
  provider?: string;
  method?: string;
  profileId?: string;
  setDefault?: boolean;
  yes?: boolean;
  agent?: string;
  /**
   * When true, remove any existing auth profiles for the resolved provider
   * before invoking the auth flow. This is the escape hatch for stuck
   * cached OAuth profiles where the standard `auth login` short-circuits
   * because credentials already exist on disk.
   */
  force?: boolean;
};

export type ModelsAuthLoginFlowResult = {
  providerId: string;
  methodId: string;
  defaultModel?: string;
  profiles: Array<{
    profileId: string;
    provider: string;
    mode: "api_key" | "oauth" | "token";
  }>;
};

export type ModelsAuthLoginFlowOptions = LoginOptions & {
  config?: OpenClawConfig;
  runtime: RuntimeEnv;
  prompter: WizardPrompter;
  env?: NodeJS.ProcessEnv;
  isRemote?: boolean;
  openUrl?: (url: string) => Promise<void>;
};

/**
 * Clear stale cooldown/disabled state for all profiles matching a provider.
 * When a user explicitly runs `models auth login`, they intend to fix auth —
 * stale `auth_permanent` / `billing` lockouts should not persist across
 * a deliberate re-authentication attempt.
 */
async function clearStaleProfileLockouts(provider: string, agentDir: string): Promise<void> {
  try {
    const store = loadAuthProfileStoreForRuntime(agentDir, {
      externalCli: externalCliDiscoveryForProviderAuth({ provider }),
    });
    const profileIds = listProfilesForProvider(store, provider);
    for (const profileId of profileIds) {
      await clearAuthProfileCooldown({ store, profileId, agentDir });
    }
  } catch {
    // Best-effort housekeeping — never block re-authentication.
  }
}

/** Resolves a requested login provider or throws with available provider details. */
export function resolveRequestedLoginProviderOrThrow(
  providers: ProviderPlugin[],
  rawProvider?: string,
): ProviderPlugin | null {
  return resolveRequestedProviderOrThrow(providers, rawProvider);
}

function credentialMode(credential: AuthProfileCredential): "api_key" | "oauth" | "token" {
  if (credential.type === "api_key") {
    return "api_key";
  }
  if (credential.type === "token") {
    return "token";
  }
  return "oauth";
}

/** Applies an optional profile-id override to a single returned login profile. */
export function resolveLoginProfiles(params: {
  result: ProviderAuthResult;
  requestedProfileId?: string;
}): ProviderAuthResult["profiles"] {
  const requestedProfileId = params.requestedProfileId?.trim();
  if (!requestedProfileId) {
    return params.result.profiles;
  }

  if (params.result.profiles.length !== 1) {
    throw new Error(
      "--profile-id requires exactly one returned auth profile from the selected auth method.",
    );
  }

  const [profile] = params.result.profiles;
  return [{ ...expectDefined(profile, "auth profile"), profileId: requestedProfileId }];
}

function maybeLogOpenAICodexNativeSearchTip(runtime: RuntimeEnv, providerId: string) {
  if (providerId !== "openai") {
    return;
  }
  runtime.log(
    "Tip: Codex-capable models can use native Codex web search. Enable it with openclaw configure --section web (recommended mode: cached). Docs: https://docs.openclaw.ai/tools/web",
  );
}

export async function runModelsAuthLoginFlow(
  opts: ModelsAuthLoginFlowOptions,
): Promise<ModelsAuthLoginFlowResult> {
  const { config, agentDir, workspaceDir, providers } = await resolveModelsAuthContext({
    requestedProvider: opts.provider,
    rawAgentId: opts.agent,
    config: opts.config,
  });
  const prompter = opts.prompter;
  const authProviders = listProvidersWithAuthMethods(providers);
  if (authProviders.length === 0) {
    throw new Error(
      `No provider plugins found. Install one via \`${formatCliCommand("openclaw plugins install")}\`.`,
    );
  }

  const requestedProvider = resolveRequestedLoginProviderOrThrow(
    authProviders,
    opts.provider ? normalizeManualAuthProvider(opts.provider) : undefined,
  );
  const selectedProvider =
    requestedProvider ??
    (await prompter
      .select({
        message: "Select a provider",
        options: authProviders.map((provider) => ({
          value: provider.id,
          label: provider.label,
          hint: provider.docsPath ? `Docs: ${provider.docsPath}` : undefined,
        })),
      })
      .then((id) => resolveProviderMatch(authProviders, id)));

  if (!selectedProvider) {
    throw new Error(
      `Unknown provider. Run ${formatCliCommand("openclaw models status")} or ${formatCliCommand("openclaw plugins list")} to see available provider plugins.`,
    );
  }

  const chosenMethod = await pickProviderAuthMethod({
    provider: selectedProvider,
    requestedMethod: opts.method,
    prompter,
  });

  if (!chosenMethod) {
    throw new Error(
      `Unknown auth method. Run ${formatCliCommand("openclaw models auth login --provider " + selectedProvider.id)} without --method to choose interactively.`,
    );
  }

  if (opts.force) {
    // Purge existing profiles for this provider only after we have a valid
    // auth method to invoke. Running the purge earlier (before method
    // resolution) would delete the user's working credentials and then
    // throw on an unresolvable `--method`, leaving them without a usable
    // profile and no auth flow started. This is the documented escape
    // hatch for stuck OAuth credentials (expired token, swapped account,
    // etc.) where `auth login` would otherwise short-circuit on the cached
    // profile.
    try {
      const clearedStore = await removeProviderAuthProfilesWithLock({
        provider: selectedProvider.id,
        agentDir,
      });
      if (!clearedStore) {
        throw new Error("profile store update failed");
      }
      opts.runtime.log(
        `Removed cached auth profiles for provider "${selectedProvider.id}" (--force). Running fresh auth flow.`,
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(
        `Could not clear cached profiles for "${selectedProvider.id}" before re-login: ${message}. Re-login was not started because --force must remove cached profiles first.`,
        { cause: err },
      );
    }
  }

  const { result, profiles } = await runProviderAuthMethod({
    config,
    agentDir,
    workspaceDir,
    provider: selectedProvider,
    method: chosenMethod,
    runtime: opts.runtime,
    prompter,
    profileId: opts.profileId,
    setDefault: opts.setDefault,
    env: opts.env,
    isRemote: opts.isRemote,
    openUrl: opts.openUrl,
  });
  maybeLogOpenAICodexNativeSearchTip(opts.runtime, selectedProvider.id);
  return {
    providerId: selectedProvider.id,
    methodId: chosenMethod.id,
    ...(result.defaultModel ? { defaultModel: result.defaultModel } : {}),
    profiles: profiles.map((profile) => ({
      profileId: profile.profileId,
      provider: profile.credential.provider,
      mode: credentialMode(profile.credential),
    })),
  };
}

export async function modelsAuthLoginCommand(opts: LoginOptions, runtime: RuntimeEnv) {
  if (!process.stdin.isTTY) {
    throw new Error(
      `models auth login requires an interactive TTY. In automation, use ${formatCliCommand("openclaw models auth paste-token --provider <provider>")} when token auth is available.`,
    );
  }

  await runModelsAuthLoginFlow({
    ...opts,
    runtime,
    prompter: createClackPrompter(),
  });
}
