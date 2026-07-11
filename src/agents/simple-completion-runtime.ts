import { supportsOpenAIReasoningEffort } from "@openclaw/ai/internal/openai";
import { resolveClaudeSonnet5ModelIdentity } from "@openclaw/llm-core";
/**
 * Simple completion runtime preparation.
 *
 * Resolves agent model selection, auth, runtime policy, and missing-auth errors before simple completions run.
 */
import type { ThinkLevel } from "../auto-reply/thinking.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { formatErrorMessage } from "../infra/errors.js";
import { completeSimple } from "../llm/stream.js";
import type {
  AssistantMessage,
  Model,
  ModelThinkingLevel,
  ThinkingLevel as SimpleCompletionThinkingLevel,
} from "../llm/types.js";
import { prepareProviderRuntimeAuth } from "../plugins/provider-runtime.runtime.js";
import { resolveAgentDir, resolveAgentEffectiveModelPrimary } from "./agent-scope.js";
import { ensureAuthProfileStore } from "./auth-profiles/store.js";
import { DEFAULT_PROVIDER } from "./defaults.js";
import { resolveModel, resolveModelAsync } from "./embedded-agent-runner/model.js";
import {
  fingerprintAuthProfileCredential,
  fingerprintResolvedProviderAuth,
} from "./execution-auth-binding.js";
import { resolveAgentHarnessPolicy } from "./harness/policy.js";
import {
  applySecretRefHeaderSentinels,
  applyLocalNoAuthHeaderOverride,
  formatMissingAuthError,
  getApiKeyForModel,
  type ResolvedProviderAuth,
} from "./model-auth.js";
import { splitTrailingAuthProfile } from "./model-ref-profile.js";
import {
  buildModelAliasIndex,
  resolveDefaultModelForAgent,
  resolveModelRefFromString,
} from "./model-selection.js";
import { OPENAI_PROVIDER_ID, isOpenAIProvider } from "./openai-routing.js";
import { applyPreparedRuntimeAuthToModel } from "./provider-request-config.js";
import {
  protectPreparedProviderRuntimeAuth,
  unwrapSecretSentinelsForProviderEgress,
} from "./provider-secret-egress.js";
import { prepareModelForSimpleCompletion } from "./simple-completion-transport.js";
import { resolveUtilityModelRefForAgent } from "./utility-model.js";

type SimpleCompletionAuthStorage = {
  setRuntimeApiKey: (provider: string, apiKey: string) => void;
};

type CompletionRuntimeCredential = {
  apiKey: string;
  model: Model;
};

type AllowedMissingApiKeyMode = ResolvedProviderAuth["mode"];

export type SimpleCompletionModelOptions = {
  maxTokens?: number;
  temperature?: number;
  reasoning?: ThinkLevel | SimpleCompletionThinkingLevel;
  signal?: AbortSignal;
};

export type PreparedSimpleCompletionModel =
  | {
      model: Model;
      auth: ResolvedProviderAuth;
      /** Non-reversible owner proof captured from the same auth snapshot. */
      sourceAuthFingerprint?: string;
    }
  | {
      error: string;
      auth?: ResolvedProviderAuth;
    };

export type AgentSimpleCompletionSelection = {
  provider: string;
  modelId: string;
  /** Provider used for auth/transport when runtime policy redirects the logical model ref. */
  runtimeProvider?: string;
  profileId?: string;
  agentDir: string;
};

export type PreparedSimpleCompletionModelForAgent =
  | {
      selection: AgentSimpleCompletionSelection;
      model: Model;
      auth: ResolvedProviderAuth;
      sourceAuthFingerprint?: string;
    }
  | {
      error: string;
      selection?: AgentSimpleCompletionSelection;
      auth?: ResolvedProviderAuth;
    };

export function resolveSimpleCompletionSelectionForAgent(params: {
  cfg: OpenClawConfig;
  agentId: string;
  agentDir?: string;
  modelRef?: string;
  useUtilityModel?: boolean;
}): AgentSimpleCompletionSelection | null {
  const fallbackRef = resolveDefaultModelForAgent({
    cfg: params.cfg,
    agentId: params.agentId,
  });
  // Utility routing derives a provider-declared small model when unset and
  // treats an explicit empty utilityModel as "use the primary" (disabled).
  const modelRef =
    params.modelRef?.trim() ||
    (params.useUtilityModel
      ? resolveUtilityModelRefForAgent({
          cfg: params.cfg,
          agentId: params.agentId,
          primaryProvider: fallbackRef.provider,
        })
      : undefined) ||
    resolveAgentEffectiveModelPrimary(params.cfg, params.agentId);
  const split = modelRef ? splitTrailingAuthProfile(modelRef) : null;
  const aliasIndex = buildModelAliasIndex({
    cfg: params.cfg,
    defaultProvider: fallbackRef.provider || DEFAULT_PROVIDER,
  });
  const resolved = split
    ? resolveModelRefFromString({
        raw: split.model,
        defaultProvider: fallbackRef.provider || DEFAULT_PROVIDER,
        aliasIndex,
      })
    : null;
  const provider = resolved?.ref.provider ?? fallbackRef.provider;
  const modelId = resolved?.ref.model ?? fallbackRef.model;
  if (!provider || !modelId) {
    return null;
  }
  return {
    provider,
    modelId,
    ...resolveSimpleCompletionRuntimeProvider({
      cfg: params.cfg,
      agentId: params.agentId,
      provider,
      modelId,
    }),
    profileId: split?.profile || undefined,
    agentDir: params.agentDir?.trim() || resolveAgentDir(params.cfg, params.agentId),
  };
}

function resolveSimpleCompletionRuntimeProvider(params: {
  cfg: OpenClawConfig;
  agentId: string;
  provider: string;
  modelId: string;
}): Pick<AgentSimpleCompletionSelection, "runtimeProvider"> {
  if (!isOpenAIProvider(params.provider)) {
    return {};
  }
  const policy = resolveAgentHarnessPolicy({
    provider: params.provider,
    modelId: params.modelId,
    config: params.cfg,
    agentId: params.agentId,
  });
  return policy.runtime === "codex" ? { runtimeProvider: OPENAI_PROVIDER_ID } : {};
}

async function setRuntimeApiKeyForCompletion(params: {
  authStorage: SimpleCompletionAuthStorage;
  model: Model;
  apiKey: string;
  authMode: ResolvedProviderAuth["mode"];
  cfg?: OpenClawConfig;
  workspaceDir?: string;
  profileId?: string;
}): Promise<CompletionRuntimeCredential> {
  if (params.model.provider === "github-copilot") {
    const { resolveCopilotApiToken } = await import("../plugin-sdk/provider-auth.js");
    const copilotToken = await resolveCopilotApiToken({
      githubToken: unwrapSecretSentinelsForProviderEgress(
        params.apiKey,
        "GitHub Copilot runtime auth exchange",
      ),
      config: params.cfg,
    });
    const protectedAuth = protectPreparedProviderRuntimeAuth({
      provider: params.model.provider,
      preparedAuth: {
        apiKey: copilotToken.token,
        baseUrl: copilotToken.baseUrl,
      },
    });
    const runtimeApiKey = protectedAuth?.apiKey ?? copilotToken.token;
    params.authStorage.setRuntimeApiKey(params.model.provider, runtimeApiKey);
    return {
      apiKey: runtimeApiKey,
      model: { ...params.model, baseUrl: copilotToken.baseUrl },
    };
  }
  const preparedAuth = protectPreparedProviderRuntimeAuth({
    provider: params.model.provider,
    preparedAuth: await prepareProviderRuntimeAuth({
      provider: params.model.provider,
      config: params.cfg,
      workspaceDir: params.workspaceDir,
      env: process.env,
      context: {
        config: params.cfg,
        workspaceDir: params.workspaceDir,
        env: process.env,
        provider: params.model.provider,
        modelId: params.model.id,
        model: params.model,
        apiKey: unwrapSecretSentinelsForProviderEgress(
          params.apiKey,
          "provider runtime auth exchange",
        ),
        authMode: params.authMode,
        profileId: params.profileId,
      },
    }),
  });
  const runtimeApiKey = preparedAuth?.apiKey?.trim() || params.apiKey;
  params.authStorage.setRuntimeApiKey(params.model.provider, runtimeApiKey);
  return {
    apiKey: runtimeApiKey,
    model: applyPreparedRuntimeAuthToModel(params.model, preparedAuth),
  };
}

function hasMissingApiKeyAllowance(params: {
  mode: ResolvedProviderAuth["mode"];
  allowMissingApiKeyModes?: ReadonlyArray<AllowedMissingApiKeyMode>;
}): boolean {
  return Boolean(params.allowMissingApiKeyModes?.includes(params.mode));
}

export async function prepareSimpleCompletionModel(params: {
  cfg: OpenClawConfig | undefined;
  provider: string;
  modelId: string;
  agentDir?: string;
  profileId?: string;
  preferredProfile?: string;
  allowMissingApiKeyModes?: ReadonlyArray<AllowedMissingApiKeyMode>;
  allowBundledStaticCatalogFallback?: boolean;
  useAsyncModelResolution?: boolean;
  skipAgentDiscovery?: boolean;
  bindAuthOwner?: boolean;
  modelResolver?: typeof resolveModelAsync;
}): Promise<PreparedSimpleCompletionModel> {
  const resolved =
    params.useAsyncModelResolution || params.skipAgentDiscovery
      ? await (params.modelResolver ?? resolveModelAsync)(
          params.provider,
          params.modelId,
          params.agentDir,
          params.cfg,
          {
            ...(params.allowBundledStaticCatalogFallback !== undefined
              ? { allowBundledStaticCatalogFallback: params.allowBundledStaticCatalogFallback }
              : {}),
            ...(params.skipAgentDiscovery ? { skipAgentDiscovery: true } : {}),
            authProfileId: params.profileId,
            preferredProfile: params.preferredProfile,
          },
        )
      : resolveModel(params.provider, params.modelId, params.agentDir, params.cfg, {
          authProfileId: params.profileId,
          preferredProfile: params.preferredProfile,
        });
  if (!resolved.model) {
    return {
      error: resolved.error ?? `Unknown model: ${params.provider}/${params.modelId}`,
    };
  }

  let auth: ResolvedProviderAuth;
  const authStore = params.bindAuthOwner
    ? ensureAuthProfileStore(params.agentDir, {
        readOnly: true,
        allowKeychainPrompt: false,
        config: params.cfg,
      })
    : undefined;
  try {
    auth = await getApiKeyForModel({
      model: resolved.model,
      cfg: params.cfg,
      agentDir: params.agentDir,
      profileId: params.profileId,
      preferredProfile: params.preferredProfile,
      ...(authStore ? { store: authStore } : {}),
      ...(params.bindAuthOwner && params.profileId ? { lockedProfile: true } : {}),
      secretSentinels: true,
    });
  } catch (err) {
    return {
      error: `Auth lookup failed for provider "${resolved.model.provider}": ${formatErrorMessage(err)}`,
    };
  }
  const rawApiKey = auth.apiKey?.trim();
  if (
    !rawApiKey &&
    !hasMissingApiKeyAllowance({
      mode: auth.mode,
      allowMissingApiKeyModes: params.allowMissingApiKeyModes,
    })
  ) {
    return {
      error: formatMissingAuthError(auth, resolved.model.provider),
      auth,
    };
  }

  let resolvedApiKey = rawApiKey;
  let resolvedModel = resolved.model;
  if (rawApiKey) {
    const runtimeCredential = await setRuntimeApiKeyForCompletion({
      authStorage: resolved.authStorage,
      model: resolved.model,
      apiKey: rawApiKey,
      authMode: auth.mode,
      cfg: params.cfg,
      workspaceDir: params.agentDir,
      profileId: auth.profileId,
    });
    resolvedApiKey = runtimeCredential.apiKey;
    resolvedModel = runtimeCredential.model;
  }

  const resolvedAuth: ResolvedProviderAuth = {
    ...auth,
    apiKey: resolvedApiKey,
  };
  const profileCredential = params.profileId ? authStore?.profiles[params.profileId] : undefined;
  const sourceAuthFingerprint = params.bindAuthOwner
    ? profileCredential?.type === "oauth" && params.profileId
      ? fingerprintAuthProfileCredential({
          profileId: params.profileId,
          credential: profileCredential,
        })
      : fingerprintResolvedProviderAuth(auth)
    : undefined;

  return {
    model: applySecretRefHeaderSentinels(
      applyLocalNoAuthHeaderOverride(resolvedModel, resolvedAuth),
      params.cfg,
    ),
    auth: resolvedAuth,
    ...(sourceAuthFingerprint ? { sourceAuthFingerprint } : {}),
  };
}

export async function prepareSimpleCompletionModelForAgent(params: {
  cfg: OpenClawConfig;
  agentId: string;
  agentDir?: string;
  modelRef?: string;
  useUtilityModel?: boolean;
  preferredProfile?: string;
  allowMissingApiKeyModes?: ReadonlyArray<AllowedMissingApiKeyMode>;
  allowBundledStaticCatalogFallback?: boolean;
  useAsyncModelResolution?: boolean;
  skipAgentDiscovery?: boolean;
  bindAuthOwner?: boolean;
  modelResolver?: typeof resolveModelAsync;
}): Promise<PreparedSimpleCompletionModelForAgent> {
  const selection = resolveSimpleCompletionSelectionForAgent({
    cfg: params.cfg,
    agentId: params.agentId,
    agentDir: params.agentDir,
    modelRef: params.modelRef,
    useUtilityModel: params.useUtilityModel,
  });
  if (!selection) {
    return {
      error: `No model configured for agent ${params.agentId}.`,
    };
  }
  const prepared = await prepareSimpleCompletionModel({
    cfg: params.cfg,
    provider: selection.runtimeProvider ?? selection.provider,
    modelId: selection.modelId,
    agentDir: selection.agentDir,
    profileId: selection.profileId,
    preferredProfile: params.preferredProfile,
    allowMissingApiKeyModes: params.allowMissingApiKeyModes,
    ...(params.allowBundledStaticCatalogFallback !== undefined
      ? { allowBundledStaticCatalogFallback: params.allowBundledStaticCatalogFallback }
      : {}),
    useAsyncModelResolution: params.useAsyncModelResolution,
    skipAgentDiscovery: params.skipAgentDiscovery,
    bindAuthOwner: params.bindAuthOwner,
    modelResolver: params.modelResolver,
  });
  if ("error" in prepared) {
    return {
      ...prepared,
      selection,
    };
  }
  return {
    selection,
    model: prepared.model,
    auth: prepared.auth,
    ...(prepared.sourceAuthFingerprint
      ? { sourceAuthFingerprint: prepared.sourceAuthFingerprint }
      : {}),
  };
}

export async function completeWithPreparedSimpleCompletionModel(params: {
  model: Model;
  auth: ResolvedProviderAuth;
  context: Parameters<typeof completeSimple>[1];
  cfg?: OpenClawConfig;
  options?: SimpleCompletionModelOptions;
}): Promise<AssistantMessage> {
  const completionModel = prepareModelForSimpleCompletion({ model: params.model, cfg: params.cfg });
  const { reasoning: rawReasoning, ...options } = params.options ?? {};
  const reasoning = normalizeSimpleCompletionReasoning(rawReasoning, completionModel);
  return await completeSimple(completionModel, params.context, {
    ...options,
    ...(reasoning ? { reasoning } : {}),
    apiKey: params.auth.apiKey,
  });
}

function normalizeSimpleCompletionReasoning(
  reasoning: SimpleCompletionModelOptions["reasoning"],
  model: Model,
): ModelThinkingLevel | undefined {
  switch (reasoning) {
    case undefined:
      return undefined;
    case "off":
      return resolveClaudeSonnet5ModelIdentity(model) ? "off" : undefined;
    case "adaptive":
      return "medium";
    case "ultra":
    case "max":
      return isOpenAIProvider(model.provider) && supportsOpenAIReasoningEffort(model, "max")
        ? "max"
        : "xhigh";
    default:
      return reasoning;
  }
}
