/** Commands for adding, pasting, and logging into provider model auth profiles. */
import {
  cancel,
  confirm as clackConfirm,
  isCancel,
  password as clackPassword,
  select as clackSelect,
  text as clackText,
} from "@clack/prompts";
import { readByteStreamWithLimit } from "@openclaw/media-core/read-byte-stream-with-limit";
import { expectDefined } from "@openclaw/normalization-core";
import { resolveExpiresAtMsFromDurationMs } from "@openclaw/normalization-core/number-coercion";
import {
  normalizeOptionalString,
  normalizeStringifiedOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import { styleSelectParams } from "../../../packages/terminal-core/src/prompt-select-styled-params.js";
import { stylePromptMessage } from "../../../packages/terminal-core/src/prompt-style.js";
import { resolveMutableAgentEntry } from "../../agents/agent-scope-config.js";
import { resolveAgentWorkspaceDir } from "../../agents/agent-scope.js";
import { removeProviderAuthProfilesWithLock } from "../../agents/auth-profiles.js";
import {
  promoteAuthProfileInOrder,
  upsertAuthProfileAfterLoginWithLockOrThrow,
  upsertAuthProfileWithLockOrThrow,
} from "../../agents/auth-profiles/profiles.js";
import type { AuthProfileCredential } from "../../agents/auth-profiles/types.js";
import { normalizeProviderId } from "../../agents/model-ref-shared.js";
import { isCliProvider } from "../../agents/model-selection-cli.js";
import {
  AGENT_MODEL_POLICY_ALLOW_CONFIG_PATH,
  resolveConfiguredModelPolicyAllow,
} from "../../agents/model-selection-shared.js";
import { resolveProviderIdForAuth } from "../../agents/provider-auth-aliases.js";
import { resolveDefaultAgentWorkspaceDir } from "../../agents/workspace.js";
import { formatCliCommand } from "../../cli/command-format.js";
import { parseDurationMs } from "../../cli/parse-duration.js";
import { logConfigUpdated } from "../../config/logging.js";
import { normalizeAgentModelRefForConfig } from "../../config/model-input.js";
import { parseModelPolicyWildcardRef } from "../../config/model-policy-ref.js";
import {
  attachRuntimeConfigWriteApplication,
  createRuntimeConfigWriteApplication,
} from "../../config/runtime-write-application.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { isRemoteEnvironment } from "../../infra/remote-env.js";
import {
  applyProviderAuthConfigPatch,
  applyDefaultModel,
  pickAuthMethod,
  restorePriorAgentsDefaultsModelUnlessOptIn,
  resolveProviderMatch,
} from "../../plugins/provider-auth-choice-helpers.js";
import { applyAuthProfileConfig } from "../../plugins/provider-auth-helpers.js";
import { prepareProviderAuthProfilesForPersistence } from "../../plugins/provider-auth-persistence.js";
import { createVpsAwareOAuthHandlers } from "../../plugins/provider-oauth-flow.js";
import { resolvePluginProvidersCore } from "../../plugins/providers.runtime.js";
import {
  resolvePluginSetupProviderCore,
  resolvePluginSetupRegistry,
} from "../../plugins/setup-registry.js";
import type {
  ProviderAuthMethod,
  ProviderAuthResult,
  ProviderPlugin,
} from "../../plugins/types.js";
import { captureGatewayRootWorkAdmissionContinuationScope } from "../../process/gateway-work-admission.js";
import type { RuntimeEnv } from "../../runtime.js";
import { normalizeSecretInput } from "../../utils/normalize-secret-input.js";
import { createClackPrompter } from "../../wizard/clack-prompter.js";
import type { WizardPrompter } from "../../wizard/prompts.js";
import { validateAnthropicSetupToken } from "../auth-token.js";
import { repairCodexRuntimePluginInstallForModelSelection } from "../codex-runtime-plugin-install.js";
import { repairCopilotRuntimePluginInstallForModelSelection } from "../copilot-runtime-plugin-install.js";
import { tryImportProviderCredential } from "./auth-credential-import.js";
import { type ModelAuthRefreshOutcome, refreshRunningGatewayAuthState } from "./auth-refresh.js";
import { loadValidConfigOrThrow, resolveModelsTargetAgent, updateConfig } from "./shared.js";

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

const MODELS_AUTH_STDIN_MAX_BYTES = 1024 * 1024;

type ProviderModelAccessResult = "enabled" | "already-visible" | "failed";

function providerModelPolicyNeedsUpdate(
  policy: ReturnType<typeof resolveConfiguredModelPolicyAllow>,
  provider: string,
): boolean {
  // Missing or empty policy already permits every model.
  return Boolean(
    provider &&
    policy.refs.length > 0 &&
    !policy.refs.some((entry) => parseModelPolicyWildcardRef(entry)?.key === `${provider}/*`),
  );
}

function appendProviderModelPolicy(params: {
  config: OpenClawConfig;
  agentId: string;
  provider: string;
}): boolean {
  const provider = normalizeProviderId(params.provider);
  const policy = resolveConfiguredModelPolicyAllow({
    cfg: params.config,
    agentId: params.agentId,
  });
  if (!providerModelPolicyNeedsUpdate(policy, provider)) {
    return false;
  }
  const allow = [...policy.refs, `${provider}/*`];
  if (policy.configPath === AGENT_MODEL_POLICY_ALLOW_CONFIG_PATH) {
    const entry = resolveMutableAgentEntry(params.config, params.agentId);
    if (!entry) {
      throw new Error(`Agent "${params.agentId}" no longer exists in the current config.`);
    }
    entry.modelPolicy = { ...entry.modelPolicy, allow };
    return true;
  }

  params.config.agents ??= {};
  params.config.agents.defaults ??= {};
  params.config.agents.defaults.modelPolicy = {
    ...params.config.agents.defaults.modelPolicy,
    allow,
  };
  return true;
}

async function adoptProviderModelPolicy(params: {
  provider: string;
  agentId: string;
  runtime: RuntimeEnv;
  prompter: WizardPrompter;
}): Promise<ProviderModelAccessResult> {
  try {
    const current = await loadValidConfigOrThrow();
    const provider = normalizeProviderId(params.provider);
    const policy = resolveConfiguredModelPolicyAllow({
      cfg: current,
      agentId: params.agentId,
    });
    if (!providerModelPolicyNeedsUpdate(policy, provider)) {
      return "already-visible";
    }
    let changed = false;
    const application = createRuntimeConfigWriteApplication(
      captureGatewayRootWorkAdmissionContinuationScope()?.run,
    );
    await updateConfig(
      (config) => {
        changed = appendProviderModelPolicy({ ...params, config });
        return config;
      },
      {
        writeOptions: attachRuntimeConfigWriteApplication({}, application),
      },
    );
    if (changed) {
      if (application.claimed && (await application.result) !== "applied") {
        throw new Error("the running Gateway did not apply the saved model policy");
      }
      logConfigUpdated(params.runtime);
      return "enabled";
    }
    return "already-visible";
  } catch (error) {
    params.runtime.error(
      `Provider sign-in succeeded, but model access could not be updated: ${error instanceof Error ? error.message : String(error)}`,
    );
    await params.prompter.note(
      `Signed in to ${params.provider}, but OpenClaw could not enable its models. Retry this sign-in after the current config change finishes.`,
      "Model access",
    );
    return "failed";
  }
}

async function readPipedStdin(): Promise<string> {
  const bytes = await readByteStreamWithLimit(process.stdin, {
    maxBytes: MODELS_AUTH_STDIN_MAX_BYTES,
    onOverflow: ({ maxBytes }) => new Error(`Piped auth input exceeds ${maxBytes} bytes.`),
  });
  return bytes.toString("utf8");
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
  if (normalized === "openai-codex" || normalized === "codex-cli") {
    throw new Error(`"${normalized}" is a legacy provider ID; use --provider openai.`);
  }
  return normalized === "openai" || normalized === "codex" ? "openai" : normalized;
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
  agentId: string;
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
  ownerPluginId?: string;
}): ProviderPlugin[] {
  const requestedProvider = params.requestedProvider
    ? normalizeManualAuthProvider(params.requestedProvider)
    : undefined;
  if (requestedProvider) {
    const setupProvider = resolvePluginSetupProviderCore({
      provider: requestedProvider,
      config: params.config,
      workspaceDir: params.workspaceDir,
      ...(params.ownerPluginId ? { pluginIds: [params.ownerPluginId] } : {}),
    });
    return setupProvider
      ? [
          params.ownerPluginId
            ? { ...setupProvider, pluginId: params.ownerPluginId }
            : setupProvider,
        ]
      : [...params.providers];
  }

  const setupProviders = resolvePluginSetupRegistry({
    config: params.config,
    workspaceDir: params.workspaceDir,
  }).providers.map((entry) => entry.provider);
  return mergeSetupProviders(params.providers, setupProviders);
}

async function resolveModelsAuthContext(params?: {
  requestedProvider?: string;
  ownerPluginId?: string;
  rawAgentId?: string | null;
  config?: OpenClawConfig;
}): Promise<ResolvedModelsAuthContext> {
  const config = params?.config ?? (await loadValidConfigOrThrow());
  const { agentId, agentDir } = await resolveModelsAuthAgent(params?.rawAgentId, config);
  const workspaceDir =
    resolveAgentWorkspaceDir(config, agentId) ?? resolveDefaultAgentWorkspaceDir();
  const requestedProvider = params?.requestedProvider?.trim();
  const providerRef = requestedProvider
    ? normalizeManualAuthProvider(requestedProvider)
    : undefined;
  const ownerPluginId = params?.ownerPluginId;
  const providers = resolvePluginProvidersCore({
    config,
    workspaceDir,
    mode: "setup",
    includeUntrustedWorkspacePlugins: false,
    ...(ownerPluginId
      ? {
          onlyPluginIds: [ownerPluginId],
          activate: true,
        }
      : providerRef
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
    ownerPluginId,
  });
  return {
    config,
    agentId,
    agentDir,
    workspaceDir,
    providers: authProviders,
  };
}

async function resolveModelsAuthAgent(rawAgentId?: string | null, config?: OpenClawConfig) {
  const cfg = config ?? (await loadValidConfigOrThrow());
  return resolveModelsTargetAgent(cfg, rawAgentId ?? undefined, { kind: "mutation" });
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
  agentId: string;
  agentDir: string;
  runtime: RuntimeEnv;
  prompter: WizardPrompter;
  setDefault?: boolean;
  credentialOnly?: boolean;
  env?: NodeJS.ProcessEnv;
  beforePersistentEffect?: () => void | Promise<void>;
}): Promise<ProviderAuthResult["profiles"]> {
  const defaultModel = params.result.defaultModel
    ? normalizeAgentModelRefForConfig(params.result.defaultModel)
    : undefined;
  const profiles = params.profiles ?? params.result.profiles;
  const persistedProfiles: ProviderAuthResult["profiles"] = [];
  const shouldUpdateConfig =
    Boolean(!params.credentialOnly && params.result.configPatch) ||
    Boolean(params.setDefault && defaultModel);
  let persistentEffectStarted = false;
  const beginPersistentEffect = async () => {
    if (persistentEffectStarted) {
      return;
    }
    await params.beforePersistentEffect?.();
    persistentEffectStarted = true;
  };

  for (const candidate of profiles) {
    await beginPersistentEffect();
    const prepared = prepareProviderAuthProfilesForPersistence({
      profiles: [candidate],
      config: params.config,
      env: params.env,
    });
    const profile = expectDefined(prepared.profiles[0], "prepared auth profile");
    try {
      await upsertAuthProfileAfterLoginWithLockOrThrow({
        profileId: profile.profileId,
        credential: profile.credential,
        agentDir: params.agentDir,
      });
    } catch (error) {
      try {
        prepared.rollback();
      } catch (rollbackError) {
        // Both errors are retained; persistence remains the primary cause, not rollback.
        // oxlint-disable-next-line preserve-caught-error -- AggregateError.errors preserves the rollback error.
        throw new AggregateError(
          [error, rollbackError],
          "Provider auth persistence failed and protected-store rollback could not be confirmed.",
          { cause: error },
        );
      }
      throw error;
    }
    persistedProfiles.push(profile);
    await promotePersistedAuthProfile({
      config: params.config,
      agentDir: params.agentDir,
      provider: profile.credential.provider,
      profileId: profile.profileId,
    });
  }

  // Auth login owns the credential store. Keep openclaw.json untouched unless
  // the provider explicitly returns a config patch or the user opts into a
  // default-model write.
  if (shouldUpdateConfig) {
    await beginPersistentEffect();
    const updated = await updateConfig((cfg) => {
      const priorAgentsDefaultsModel = cfg.agents?.defaults?.model;
      let next = cfg;
      if (!params.credentialOnly && params.result.configPatch) {
        next = applyProviderAuthConfigPatch(next, params.result.configPatch, {
          replaceDefaultModels: params.result.replaceDefaultModels,
        });
      }
      if (!params.credentialOnly) {
        next = restorePriorAgentsDefaultsModelUnlessOptIn({
          cfg: next,
          priorAgentsDefaultsModel,
          setDefault: params.setDefault,
        });
      }
      if (
        params.setDefault &&
        defaultModel &&
        (!params.credentialOnly || priorAgentsDefaultsModel === undefined)
      ) {
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

  for (const profile of persistedProfiles) {
    params.runtime.log(
      `Auth profile: ${profile.profileId} (${profile.credential.provider}/${credentialMode(profile.credential)})`,
    );
  }
  if (defaultModel) {
    params.runtime.log(
      params.setDefault
        ? `Default model set to ${defaultModel}`
        : `Default model available: ${defaultModel} (current default unchanged; run ${formatCliCommand(`openclaw models set ${defaultModel}`)} to apply)`,
    );
  }
  return persistedProfiles;
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

async function promotePersistedAuthProfile(params: {
  config: OpenClawConfig;
  agentDir: string;
  provider: string;
  profileId: string;
}): Promise<void> {
  const configuredSelection = resolveConfiguredAuthSelectionForProvider(
    params.config,
    params.provider,
  );
  const promoted = await promoteAuthProfileInOrder({
    agentDir: params.agentDir,
    provider: params.provider,
    profileId: params.profileId,
    createIfMissing: configuredSelection.createIfMissing,
    ...(configuredSelection.order ? { createFromOrder: configuredSelection.order } : {}),
  });
  if (!promoted.ok) {
    throw new Error(
      "The auth profile was saved, but its order could not be updated because the auth store is busy. Wait a moment, then retry the login.",
    );
  }
}

async function runProviderAuthMethod(params: {
  config: OpenClawConfig;
  agentId: string;
  agentDir: string;
  workspaceDir: string;
  provider: ProviderPlugin;
  method: ProviderAuthMethod;
  runtime: RuntimeEnv;
  prompter: WizardPrompter;
  profileId?: string;
  setDefault?: boolean;
  credentialOnly?: boolean;
  env?: NodeJS.ProcessEnv;
  isRemote?: boolean;
  signal?: AbortSignal;
  openUrl?: (url: string) => Promise<void>;
  beforePersistentEffect?: () => void | Promise<void>;
}): Promise<PendingModelsAuthLoginFlowResult> {
  params.signal?.throwIfAborted();
  const result = await params.method.run({
    config: params.config,
    env: params.env ?? process.env,
    agentDir: params.agentDir,
    workspaceDir: params.workspaceDir,
    prompter: params.prompter,
    runtime: params.runtime,
    allowSecretRefPrompt: false,
    isRemote: params.isRemote ?? isRemoteEnvironment(),
    signal: params.signal,
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
  params.signal?.throwIfAborted();
  // Provider caveats print as plain lines; sign-in never blocks on a notes step.
  for (const note of result.notes ?? []) {
    params.runtime.log(note);
  }
  const profiles = resolveLoginProfiles({
    result,
    requestedProfileId: params.profileId,
  });

  const persistedProfiles = await persistProviderAuthResult({
    result,
    profiles,
    config: params.config,
    agentId: params.agentId,
    agentDir: params.agentDir,
    runtime: params.runtime,
    prompter: params.prompter,
    setDefault: params.setDefault,
    credentialOnly: params.credentialOnly,
    env: params.env ?? process.env,
    ...(params.beforePersistentEffect
      ? { beforePersistentEffect: params.beforePersistentEffect }
      : {}),
  });
  return {
    providerId: params.provider.id,
    methodId: params.method.id,
    ...(result.defaultModel ? { defaultModel: result.defaultModel } : {}),
    profiles: persistedProfiles.map((profile) => ({
      profileId: profile.profileId,
      provider: profile.credential.provider,
      mode: credentialMode(profile.credential),
    })),
  };
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

  const { config, agentId, agentDir, workspaceDir, providers } = await resolveModelsAuthContext({
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

  const pendingLogin = await runProviderAuthMethod({
    config,
    agentId,
    agentDir,
    workspaceDir,
    provider,
    method,
    runtime,
    prompter,
  });
  await finalizeProviderLogin({ agentId, runtime, prompter }, pendingLogin);
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
  const { agentId, agentDir } = await resolveModelsAuthAgent(opts.agent);
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

  await refreshRunningGatewayAuthState(agentId, "login");

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
  const { agentId, agentDir } = await resolveModelsAuthAgent(opts.agent);
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

  await refreshRunningGatewayAuthState(agentId, "login");

  logConfigUpdated(runtime);
  runtime.log(`Auth profile: ${profileId} (${provider}/api_key)`);
}

/** Interactive helper for adding token auth profiles, with provider/method prompts. */
export async function modelsAuthAddCommand(opts: { agent?: string }, runtime: RuntimeEnv) {
  const { config, agentId, agentDir, workspaceDir, providers } = await resolveModelsAuthContext({
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
      const pendingLogin = await runProviderAuthMethod({
        config,
        agentId,
        agentDir,
        workspaceDir,
        provider: providerPlugin,
        method,
        runtime,
        prompter,
      });
      await finalizeProviderLogin({ agentId, runtime, prompter }, pendingLogin);
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
  imported?: true;
  defaultModel?: string;
  modelAccess: ProviderModelAccessResult;
  authRefresh: ModelAuthRefreshOutcome;
  profiles: Array<{
    profileId: string;
    provider: string;
    mode: "api_key" | "oauth" | "token";
  }>;
};

type PendingModelsAuthLoginFlowResult = Omit<
  ModelsAuthLoginFlowResult,
  "modelAccess" | "authRefresh"
>;

export type ModelsAuthLoginFlowOptions = LoginOptions & {
  /** Manifest owner selected by a remote provider-login choice. */
  ownerPluginId?: string;
  /** Persist credentials without applying provider setup config. */
  credentialOnly?: boolean;
  config?: OpenClawConfig;
  runtime: RuntimeEnv;
  prompter: WizardPrompter;
  env?: NodeJS.ProcessEnv;
  isRemote?: boolean;
  signal?: AbortSignal;
  openUrl?: (url: string) => Promise<void>;
  beforePersistentEffect?: () => void | Promise<void>;
  refreshAuthState?: (agentId: string) => Promise<ModelAuthRefreshOutcome>;
};

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
function resolveLoginProfiles(params: {
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
    `Tip: Codex-capable models can use native Codex web search. Configure the \`web_search\` tool with \`${formatCliCommand("openclaw configure --section web")}\`. Docs: https://docs.openclaw.ai/tools/web`,
  );
}

async function finalizeProviderLogin(
  params: {
    agentId: string;
    runtime: RuntimeEnv;
    prompter: WizardPrompter;
    refreshAuthState?: (agentId: string) => Promise<ModelAuthRefreshOutcome>;
    logCompletion?: () => void;
    showOpenAiTip?: boolean;
  },
  result: PendingModelsAuthLoginFlowResult,
): Promise<ModelsAuthLoginFlowResult> {
  const modelAccess =
    result.profiles.length > 0
      ? await adoptProviderModelPolicy({
          provider: result.providerId,
          agentId: params.agentId,
          runtime: params.runtime,
          prompter: params.prompter,
        })
      : "failed";
  const authRefresh = params.refreshAuthState
    ? await params.refreshAuthState(params.agentId)
    : await refreshRunningGatewayAuthState(params.agentId, "login");
  params.logCompletion?.();
  if (params.showOpenAiTip) {
    maybeLogOpenAICodexNativeSearchTip(params.runtime, result.providerId);
  }
  return { ...result, modelAccess, authRefresh };
}

export async function runModelsAuthLoginFlowCore(
  opts: ModelsAuthLoginFlowOptions,
): Promise<ModelsAuthLoginFlowResult> {
  const ownerPluginId = opts.ownerPluginId?.trim() || undefined;
  const requestedProviderId = opts.provider
    ? normalizeManualAuthProvider(opts.provider)
    : undefined;
  let context = await resolveModelsAuthContext({
    requestedProvider: requestedProviderId,
    ownerPluginId,
    rawAgentId: opts.agent,
    config: opts.config,
  });
  const prompter = opts.prompter;
  let authProviders = listProvidersWithAuthMethods(context.providers);
  let requestedProvider = requestedProviderId
    ? resolveProviderMatch(authProviders, requestedProviderId)
    : null;
  const useProviderPicker =
    ownerPluginId === undefined &&
    requestedProviderId !== undefined &&
    requestedProvider === null &&
    isCliProvider(requestedProviderId, context.config);
  if (useProviderPicker) {
    context = await resolveModelsAuthContext({
      rawAgentId: opts.agent,
      config: context.config,
    });
    authProviders = listProvidersWithAuthMethods(context.providers);
  }
  if (authProviders.length === 0) {
    if (ownerPluginId) {
      throw new Error(
        `Provider login plugin "${ownerPluginId}" is unavailable. Refresh the available provider logins and try again.`,
      );
    }
    throw new Error(
      `No provider plugins found. Install one via \`${formatCliCommand("openclaw plugins install")}\`.`,
    );
  }
  if (useProviderPicker) {
    await prompter.note(
      `Provider "${requestedProviderId}" uses its own CLI login. Select a provider with an OpenClaw auth flow.`,
      "Provider auth",
    );
  } else if (requestedProviderId && !requestedProvider) {
    if (ownerPluginId) {
      throw new Error(
        `Provider "${requestedProviderId}" is not available from plugin "${ownerPluginId}". Refresh the available provider logins and try again.`,
      );
    }
    requestedProvider = resolveRequestedProviderOrThrow(authProviders, requestedProviderId);
  }
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

  const importedCredential =
    !opts.force && !opts.profileId
      ? await tryImportProviderCredential({
          method: chosenMethod,
          config: context.config,
          agentId: context.agentId,
          runtime: opts.runtime,
          ...(opts.credentialOnly !== undefined ? { credentialOnly: opts.credentialOnly } : {}),
          ...(opts.signal ? { signal: opts.signal } : {}),
          ...(opts.beforePersistentEffect
            ? { beforePersistentEffect: opts.beforePersistentEffect }
            : {}),
        })
      : undefined;
  if (importedCredential && "unavailableReason" in importedCredential) {
    await prompter.note(importedCredential.unavailableReason, "Existing CLI sign-in");
  }
  if (importedCredential && !("unavailableReason" in importedCredential)) {
    if (
      normalizeProviderId(importedCredential.provider) !== normalizeProviderId(selectedProvider.id)
    ) {
      throw new Error(
        `Credential import for provider "${selectedProvider.id}" returned provider "${importedCredential.provider}".`,
      );
    }
    await promotePersistedAuthProfile({
      config: context.config,
      agentDir: context.agentDir,
      provider: importedCredential.provider,
      profileId: importedCredential.profileId,
    });
    return await finalizeProviderLogin(
      {
        agentId: context.agentId,
        runtime: opts.runtime,
        prompter,
        ...(opts.refreshAuthState ? { refreshAuthState: opts.refreshAuthState } : {}),
        showOpenAiTip: true,
        logCompletion: () => {
          if (importedCredential.configUpdated) {
            logConfigUpdated(opts.runtime);
          }
          opts.runtime.log(
            `Auth profile: ${importedCredential.profileId} (${importedCredential.provider}/${importedCredential.mode}, imported)`,
          );
        },
      },
      {
        providerId: selectedProvider.id,
        methodId: chosenMethod.id,
        imported: true,
        profiles: [
          {
            profileId: importedCredential.profileId,
            provider: importedCredential.provider,
            mode: importedCredential.mode,
          },
        ],
      },
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
        agentDir: context.agentDir,
      });
      if (!clearedStore) {
        throw new Error(
          "auth store is busy; close other OpenClaw commands using this state directory and retry",
        );
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

  const pendingLogin = await runProviderAuthMethod({
    config: context.config,
    agentId: context.agentId,
    agentDir: context.agentDir,
    workspaceDir: context.workspaceDir,
    provider: selectedProvider,
    method: chosenMethod,
    runtime: opts.runtime,
    prompter,
    ...(opts.profileId ? { profileId: opts.profileId } : {}),
    ...(opts.setDefault !== undefined ? { setDefault: opts.setDefault } : {}),
    ...(opts.credentialOnly !== undefined ? { credentialOnly: opts.credentialOnly } : {}),
    ...(opts.env ? { env: opts.env } : {}),
    ...(opts.isRemote !== undefined ? { isRemote: opts.isRemote } : {}),
    ...(opts.signal ? { signal: opts.signal } : {}),
    ...(opts.openUrl ? { openUrl: opts.openUrl } : {}),
    ...(opts.beforePersistentEffect ? { beforePersistentEffect: opts.beforePersistentEffect } : {}),
  });
  return await finalizeProviderLogin(
    {
      agentId: context.agentId,
      runtime: opts.runtime,
      prompter,
      ...(opts.refreshAuthState ? { refreshAuthState: opts.refreshAuthState } : {}),
      showOpenAiTip: true,
    },
    pendingLogin,
  );
}

export async function modelsAuthLoginCommand(opts: LoginOptions, runtime: RuntimeEnv) {
  if (!process.stdin.isTTY) {
    throw new Error(
      `models auth login requires an interactive TTY. In automation, use ${formatCliCommand("openclaw models auth paste-token --provider <provider>")} when token auth is available.`,
    );
  }

  const result = await runModelsAuthLoginFlowCore({
    ...opts,
    runtime,
    prompter: createClackPrompter(),
  });
  if (result.authRefresh === "gateway-rejected") {
    runtime.error(
      "Provider login succeeded, but the Gateway rejected its auth refresh. Check the Gateway logs, then run /models.",
    );
  } else if (result.authRefresh === "gateway-unreachable") {
    runtime.error(
      "Provider login succeeded, but the running Gateway could not refresh its models. Restart the Gateway, then run /models.",
    );
  }
}
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
