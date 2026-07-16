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
  resolveApiKeyForProvider,
  type ResolvedProviderAuth,
} from "./model-auth.js";
import { splitTrailingAuthProfile } from "./model-ref-profile.js";
import {
  buildModelAliasIndex,
  resolveDefaultModelForAgent,
  resolveModelRefFromString,
} from "./model-selection.js";
import { resolveOpenAIModelRoutes, selectOpenAIModelRouteAuth } from "./openai-model-routes.js";
import { OPENAI_PROVIDER_ID, isOpenAIProvider } from "./openai-routing.js";
import {
  buildProviderModelAuthDirectSource,
  buildProviderModelAuthSourcePlan,
} from "./provider-model-auth-source-plan.js";
import { applyPreparedRuntimeAuthToModel } from "./provider-request-config.js";
import { protectPreparedProviderRuntimeAuth } from "./provider-secret-egress.js";
import { buildAgentRuntimeAuthPlan } from "./runtime-plan/auth.js";
import { materializePreparedRuntimeModel } from "./runtime-plan/materialize-model.js";
import { resolveSimpleCompletionModelResolverWorkspace } from "./simple-completion-scope.js";
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

type SimpleCompletionModelOptions = {
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

type AgentSimpleCompletionSelection = {
  provider: string;
  modelId: string;
  /** Provider used for auth/transport when runtime policy redirects the logical model ref. */
  runtimeProvider?: string;
  profileId?: string;
  agentDir: string;
};

type PreparedSimpleCompletionModelForAgent =
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
        apiKey: params.apiKey,
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
  const workspaceDir = resolveSimpleCompletionModelResolverWorkspace(params.modelResolver);
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
            workspaceDir,
            authProfileId: params.profileId,
            preferredProfile: params.preferredProfile,
          },
        )
      : resolveModel(params.provider, params.modelId, params.agentDir, params.cfg, {
          workspaceDir,
          authProfileId: params.profileId,
          preferredProfile: params.preferredProfile,
        });
  if (!resolved.model) {
    return {
      error: resolved.error ?? `Unknown model: ${params.provider}/${params.modelId}`,
    };
  }
  const initialModel = resolved.model;
  let resolvedModel = initialModel;

  const routeResolution = resolveOpenAIModelRoutes({
    provider: initialModel.provider,
    modelId: initialModel.id,
    api: initialModel.api,
    baseUrl: initialModel.baseUrl,
    config: params.cfg,
    env: process.env,
  });
  const resolvesAuthBeforePhysicalRoute =
    routeResolution?.kind === "routes" && routeResolution.routes.length > 1;

  let auth: ResolvedProviderAuth;
  const authStore = params.bindAuthOwner
    ? ensureAuthProfileStore(params.agentDir, {
        readOnly: true,
        allowKeychainPrompt: false,
        config: params.cfg,
      })
    : undefined;
  try {
    auth = resolvesAuthBeforePhysicalRoute
      ? await resolveApiKeyForProvider({
          provider: initialModel.provider,
          cfg: params.cfg,
          agentDir: params.agentDir,
          workspaceDir,
          profileId: params.profileId,
          preferredProfile: params.preferredProfile,
          ...(authStore ? { store: authStore } : {}),
          ...(params.bindAuthOwner && params.profileId ? { lockedProfile: true } : {}),
          modelId: initialModel.id,
          secretSentinels: true,
        })
      : await getApiKeyForModel({
          model: initialModel,
          cfg: params.cfg,
          agentDir: params.agentDir,
          workspaceDir,
          profileId: params.profileId,
          preferredProfile: params.preferredProfile,
          ...(authStore ? { store: authStore } : {}),
          ...(params.bindAuthOwner && params.profileId ? { lockedProfile: true } : {}),
          secretSentinels: true,
        });
    if (routeResolution?.kind === "routes") {
      const source = auth.profileId
        ? {
            kind: "profile" as const,
            profileId: auth.profileId,
            provider: initialModel.provider,
            mode: auth.mode,
            readiness: "ready" as const,
            cooldown: "clear" as const,
          }
        : buildProviderModelAuthDirectSource({
            mode: auth.mode,
            availability: true,
            evidence: "runtime",
          });
      const routeAuthDecision = selectOpenAIModelRouteAuth({
        resolution: routeResolution,
        sourcePlan: buildProviderModelAuthSourcePlan({
          ownership: { reason: "provider-binding", source },
          profiles: [],
        }),
      });
      if (routeAuthDecision.kind !== "selected") {
        throw new Error(
          routeAuthDecision.kind === "rejected"
            ? routeAuthDecision.message
            : "OpenAI route selection unexpectedly deferred after auth was resolved.",
        );
      }
      const route = routeAuthDecision.selection.route;
      const plan = buildAgentRuntimeAuthPlan({
        provider: initialModel.provider,
        modelId: initialModel.id,
        authProfileProvider: initialModel.provider,
        authProfileMode: auth.mode,
        sessionAuthProfileId: auth.profileId,
        sessionAuthProfileSource: params.profileId ? "user" : "auto",
        modelRoute: {
          provider: initialModel.provider,
          modelId: initialModel.id,
          api: route.api,
          baseUrl: route.baseUrl,
          authRequirement: route.authRequirement,
          requestTransportOverrides: route.requestTransportOverrides,
          runtimePolicy: route.runtimePolicy,
        },
        config: params.cfg,
        workspaceDir,
      });
      resolvedModel =
        (await materializePreparedRuntimeModel({
          plan,
          provider: initialModel.provider,
          modelId: initialModel.id,
          config: params.cfg,
          model: initialModel,
          resolveModel: ({ config, authProfileId, authProfileMode }) =>
            (params.modelResolver ?? resolveModelAsync)(
              initialModel.provider,
              initialModel.id,
              params.agentDir,
              config,
              {
                authStorage: resolved.authStorage,
                modelRegistry: resolved.modelRegistry,
                skipAgentDiscovery: true,
                allowBundledStaticCatalogFallback: true,
                preferBundledStaticCatalogTransport: true,
                workspaceDir,
                authProfileId,
                authProfileMode,
              },
            ),
        })) ?? initialModel;
      if (resolvesAuthBeforePhysicalRoute) {
        auth = await getApiKeyForModel({
          model: resolvedModel,
          cfg: params.cfg,
          agentDir: params.agentDir,
          workspaceDir,
          profileId: auth.profileId,
          preferredProfile: params.preferredProfile,
          ...(authStore ? { store: authStore } : {}),
          ...(params.bindAuthOwner && params.profileId ? { lockedProfile: true } : {}),
          secretSentinels: true,
        });
      }
    }
  } catch (err) {
    return {
      error: `Auth lookup failed for provider "${initialModel.provider}": ${formatErrorMessage(err)}`,
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
      error: formatMissingAuthError(auth, resolvedModel.provider),
      auth,
    };
  }

  let authValue = rawApiKey;
  if (rawApiKey) {
    const runtimeCredential = await setRuntimeApiKeyForCompletion({
      authStorage: resolved.authStorage,
      model: resolvedModel,
      apiKey: rawApiKey,
      authMode: auth.mode,
      cfg: params.cfg,
      workspaceDir: workspaceDir ?? params.agentDir,
      profileId: auth.profileId,
    });
    authValue = runtimeCredential.apiKey;
    resolvedModel = runtimeCredential.model;
  }

  const resolvedAuth: ResolvedProviderAuth = {
    ...auth,
    apiKey: authValue,
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
