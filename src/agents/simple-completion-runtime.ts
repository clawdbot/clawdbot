import {
  reasoningTagTextPolicy,
  supportsOpenAIReasoningEffort,
} from "@openclaw/ai/internal/openai";
import { defaultApiRegistry } from "@openclaw/ai/internal/runtime";
import { prepareModelForSimpleCompletion } from "@openclaw/ai/transports";
import {
  resolveClaudeOpus5ModelIdentity,
  resolveClaudeSonnet5ModelIdentity,
} from "@openclaw/llm-core";
/**
 * Simple completion runtime preparation.
 *
 * Resolves agent model selection, auth, runtime policy, and missing-auth errors before simple completions run.
 */
import type { ThinkLevel } from "../auto-reply/thinking.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { formatErrorMessage } from "../infra/errors.js";
import { bindModelLlmRuntime, getModelLlmRuntime } from "../llm/model-runtime-binding.js";
import { completeSimple } from "../llm/stream.js";
import type {
  AssistantMessage,
  Model,
  ModelThinkingLevel,
  ThinkingLevel as SimpleCompletionThinkingLevel,
} from "../llm/types.js";
import { resolvePluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.js";
import type { PluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.types.js";
import { prepareProviderRuntimeAuth } from "../plugins/provider-runtime.runtime.js";
import { withPluginRuntimeGenerationScope } from "../plugins/runtime/generation-scope.js";
import {
  resolveAgentDir,
  resolveAgentEffectiveModelPrimary,
  resolveAgentWorkspaceDir,
  resolveDefaultAgentId,
} from "./agent-scope.js";
import { ensureAuthProfileStore } from "./auth-profiles/store.js";
import { DEFAULT_PROVIDER } from "./defaults.js";
import { resolveModelAsync } from "./embedded-agent-runner/model.js";
import {
  fingerprintAuthProfileCredential,
  fingerprintResolvedProviderAuth,
} from "./execution-auth-binding.js";
import { resolveAgentHarnessPolicy } from "./harness/policy.js";
import {
  createAgentRuntimeMetadataPluginIdScope,
  type AgentHarnessPluginSelection,
} from "./harness/runtime-plugin-load-plan.js";
import {
  applySecretRefHeaderSentinels,
  applyLocalNoAuthHeaderOverride,
  formatMissingAuthError,
  getApiKeyForModelCore,
  resolveApiKeyForProviderCore,
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
  acquireAgentRunPreparedModelRuntime,
  type PreparedModelRuntimeSnapshot,
} from "./prepared-model-runtime.js";
import {
  buildProviderModelAuthDirectSource,
  buildProviderModelAuthSourcePlan,
} from "./provider-model-auth-source-plan.js";
import { applyPreparedRuntimeAuthToModel } from "./provider-request-config.js";
import { protectPreparedProviderRuntimeAuth } from "./provider-secret-egress.js";
import { buildAgentRuntimeAuthPlan } from "./runtime-plan/auth.js";
import { materializePreparedRuntimeModel } from "./runtime-plan/materialize-model.js";
import { getModelRegistryRuntime } from "./sessions/model-registry-runtime.js";
import {
  createPreparedSimpleCompletionResolverContext,
  type PreparedSimpleCompletionResolverContext,
} from "./simple-completion-scope.js";
import { resolveUtilityModelRefForAgent } from "./utility-model.js";

type AllowedMissingApiKeyMode = ResolvedProviderAuth["mode"];

type SimpleCompletionModelOptions = {
  maxTokens?: number;
  temperature?: number;
  reasoning?: ThinkLevel | SimpleCompletionThinkingLevel;
  strictReasoningTags?: boolean;
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
  | (Extract<PreparedSimpleCompletionModel, { model: Model }> & {
      selection: AgentSimpleCompletionSelection;
    })
  | (Extract<PreparedSimpleCompletionModel, { error: string }> & {
      selection?: AgentSimpleCompletionSelection;
    });

type SimpleCompletionSelectionParams = {
  cfg: OpenClawConfig;
  agentId: string;
  agentDir?: string;
  modelRef?: string;
  useUtilityModel?: boolean;
  manifestPlugins?: PluginMetadataSnapshot["plugins"];
};

type SimpleCompletionSelectionRequest = {
  selection: AgentSimpleCompletionSelection;
  shorthandModelId?: string;
};

function resolveSimpleCompletionSelectionRequest(
  params: SimpleCompletionSelectionParams,
): SimpleCompletionSelectionRequest | null {
  const fallbackRef = resolveDefaultModelForAgent({
    cfg: params.cfg,
    agentId: params.agentId,
    manifestPlugins: params.manifestPlugins,
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
          ...(params.manifestPlugins
            ? { metadataSnapshot: { plugins: params.manifestPlugins } }
            : {}),
        })
      : undefined) ||
    resolveAgentEffectiveModelPrimary(params.cfg, params.agentId);
  const split = modelRef ? splitTrailingAuthProfile(modelRef) : null;
  const aliasIndex = buildModelAliasIndex({
    cfg: params.cfg,
    agentId: params.agentId,
    defaultProvider: fallbackRef.provider || DEFAULT_PROVIDER,
    manifestPlugins: params.manifestPlugins,
  });
  const resolved = split
    ? resolveModelRefFromString({
        cfg: params.cfg,
        agentId: params.agentId,
        raw: split.model,
        defaultProvider: fallbackRef.provider || DEFAULT_PROVIDER,
        aliasIndex,
        manifestPlugins: params.manifestPlugins,
      })
    : null;
  const provider = resolved?.ref.provider ?? fallbackRef.provider;
  const modelId = resolved?.ref.model ?? fallbackRef.model;
  if (!provider || !modelId) {
    return null;
  }
  const runtimeProvider =
    isOpenAIProvider(provider) &&
    resolveAgentHarnessPolicy({ provider, modelId, config: params.cfg, agentId: params.agentId })
      .runtime === "codex"
      ? OPENAI_PROVIDER_ID
      : undefined;
  return {
    selection: {
      provider,
      modelId,
      ...(runtimeProvider ? { runtimeProvider } : {}),
      profileId: split?.profile || undefined,
      agentDir: params.agentDir?.trim() || resolveAgentDir(params.cfg, params.agentId),
    },
    ...(split && !split.model.includes("/") ? { shorthandModelId: split.model } : {}),
  };
}

export function resolveSimpleCompletionSelectionForAgent(
  params: SimpleCompletionSelectionParams,
): AgentSimpleCompletionSelection | null {
  return resolveSimpleCompletionSelectionRequest(params)?.selection ?? null;
}

export async function prepareSimpleCompletionModel(params: {
  cfg: OpenClawConfig | undefined;
  agentId?: string;
  provider: string;
  modelId: string;
  agentDir?: string;
  profileId?: string;
  preferredProfile?: string;
  allowMissingApiKeyModes?: ReadonlyArray<AllowedMissingApiKeyMode>;
  allowBundledStaticCatalogFallback?: boolean;
  skipAgentDiscovery?: boolean;
  bindAuthOwner?: boolean;
  modelResolver?: typeof resolveModelAsync;
  /** Internal caller-owned generation. Public plugin callers use the agent helper below. */
  preparedModelRuntime?: PreparedModelRuntimeSnapshot;
  workspaceDir?: string;
  agentRuntimeId?: string;
}): Promise<PreparedSimpleCompletionModel> {
  return await withPreparedSimpleCompletionRuntime(
    params,
    [
      {
        provider: params.provider,
        modelId: params.modelId,
        ...(params.agentRuntimeId ? { runtime: params.agentRuntimeId } : {}),
      },
    ],
    async (context) =>
      await prepareSimpleCompletionModelCore(
        { ...params, agentDir: context.preparedModelRuntime.agentDir },
        context,
      ),
  );
}

async function prepareSimpleCompletionModelCore(
  params: Parameters<typeof prepareSimpleCompletionModel>[0],
  context: PreparedSimpleCompletionResolverContext,
): Promise<PreparedSimpleCompletionModel> {
  const { modelResolver, workspaceDir } = context;
  const resolved = await modelResolver(
    params.provider,
    params.modelId,
    params.agentDir,
    params.cfg,
    {
      ...(params.agentId ? { agentId: params.agentId } : {}),
      ...(params.allowBundledStaticCatalogFallback !== undefined
        ? { allowBundledStaticCatalogFallback: params.allowBundledStaticCatalogFallback }
        : {}),
      ...(params.skipAgentDiscovery ? { skipAgentDiscovery: true } : {}),
      authProfileId: params.profileId,
      preferredProfile: params.preferredProfile,
    },
  );
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
      ? await resolveApiKeyForProviderCore({
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
      : await getApiKeyForModelCore({
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
            // The credential is already resolved by the caller and wrapped as
            // required provider-binding ownership below, so it is not an
            // ambient discovery competing with declared profiles.
            authorization: "declared",
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
            modelResolver(initialModel.provider, initialModel.id, params.agentDir, config, {
              ...(params.agentId ? { agentId: params.agentId } : {}),
              skipAgentDiscovery: true,
              allowBundledStaticCatalogFallback: true,
              preferBundledStaticCatalogTransport: true,
              authProfileId,
              authProfileMode,
            }),
        })) ?? initialModel;
      if (resolvesAuthBeforePhysicalRoute) {
        auth = await getApiKeyForModelCore({
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
  if (!rawApiKey && !params.allowMissingApiKeyModes?.includes(auth.mode)) {
    return {
      error: formatMissingAuthError(auth, resolvedModel.provider),
      auth,
    };
  }

  let authValue = rawApiKey;
  if (rawApiKey) {
    const preparedAuth = protectPreparedProviderRuntimeAuth({
      provider: resolvedModel.provider,
      preparedAuth: await prepareProviderRuntimeAuth({
        provider: resolvedModel.provider,
        config: params.cfg,
        workspaceDir,
        env: process.env,
        context: {
          config: params.cfg,
          workspaceDir,
          env: process.env,
          provider: resolvedModel.provider,
          modelId: resolvedModel.id,
          model: resolvedModel,
          apiKey: rawApiKey,
          authMode: auth.mode,
          profileId: auth.profileId,
        },
      }),
    });
    authValue = preparedAuth?.apiKey?.trim() || rawApiKey;
    resolved.authStorage.setRuntimeApiKey(resolvedModel.provider, authValue);
    resolvedModel = applyPreparedRuntimeAuthToModel(resolvedModel, preparedAuth);
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
  const modelRuntime = getModelRegistryRuntime(resolved.modelRegistry);

  return {
    model: bindModelLlmRuntime(
      applySecretRefHeaderSentinels(
        applyLocalNoAuthHeaderOverride(resolvedModel, resolvedAuth),
        params.cfg,
      ),
      modelRuntime.llmRuntime,
    ),
    auth: resolvedAuth,
    ...(sourceAuthFingerprint ? { sourceAuthFingerprint } : {}),
  };
}

async function withPreparedSimpleCompletionRuntime<T>(
  params: {
    cfg: OpenClawConfig | undefined;
    agentId?: string;
    agentDir?: string;
    modelResolver?: typeof resolveModelAsync;
    preparedModelRuntime?: PreparedModelRuntimeSnapshot;
    workspaceDir?: string;
    agentRuntimeId?: string;
    pluginMetadataSnapshot?: PluginMetadataSnapshot;
  },
  runtimePluginSelections: readonly AgentHarnessPluginSelection[],
  run: (context: PreparedSimpleCompletionResolverContext) => Promise<T>,
): Promise<T> {
  const config = params.cfg ?? {};
  const agentId = params.agentId ?? resolveDefaultAgentId(config);
  const agentDir = params.agentDir?.trim() || resolveAgentDir(config, agentId);
  const requestedWorkspaceDir =
    params.workspaceDir ??
    params.preparedModelRuntime?.workspaceDir ??
    resolveAgentWorkspaceDir(config, agentId);
  const lease = params.preparedModelRuntime
    ? undefined
    : await acquireAgentRunPreparedModelRuntime(
        {
          config,
          agentId,
          agentDir,
          workspaceDir: requestedWorkspaceDir,
          loadRuntimePlugins: true,
          runtimePluginSelections: runtimePluginSelections.map((selection) => ({
            ...selection,
            agentId,
          })),
        },
        {
          catalogMode: "static",
          ...(params.pluginMetadataSnapshot
            ? { pluginMetadataSnapshot: params.pluginMetadataSnapshot }
            : {}),
        },
      );
  const preparedModelRuntime = params.preparedModelRuntime ?? lease!.snapshot;
  const workspaceDir =
    params.workspaceDir ?? preparedModelRuntime.workspaceDir ?? requestedWorkspaceDir;
  const context = createPreparedSimpleCompletionResolverContext({
    preparedModelRuntime,
    workspaceDir,
    modelResolver: params.modelResolver,
    agentRuntimeId: params.agentRuntimeId,
  });
  try {
    return await withPluginRuntimeGenerationScope(preparedModelRuntime, () => run(context));
  } finally {
    lease?.release();
  }
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
  /** @deprecated no-op; kept for plugin-SDK source compatibility, remove at next SDK-breaking window. */
  useAsyncModelResolution?: boolean;
  skipAgentDiscovery?: boolean;
  bindAuthOwner?: boolean;
  modelResolver?: typeof resolveModelAsync;
}): Promise<PreparedSimpleCompletionModelForAgent> {
  const selectionParams = {
    cfg: params.cfg,
    agentId: params.agentId,
    agentDir: params.agentDir,
    modelRef: params.modelRef,
    useUtilityModel: params.useUtilityModel,
  };
  const tentativeRequest = resolveSimpleCompletionSelectionRequest(selectionParams);
  if (!tentativeRequest) {
    return { error: `No model configured for agent ${params.agentId}.` };
  }
  const tentativeSelection = tentativeRequest.selection;
  const workspaceDir = resolveAgentWorkspaceDir(params.cfg, params.agentId);
  const pluginIdScope = createAgentRuntimeMetadataPluginIdScope({
    config: params.cfg,
    workspaceDir,
    selections: [
      {
        provider: tentativeSelection.runtimeProvider ?? tentativeSelection.provider,
        modelId: tentativeSelection.modelId,
        agentId: params.agentId,
      },
    ],
    ...(tentativeRequest.shorthandModelId
      ? { shorthandModelIds: [tentativeRequest.shorthandModelId] }
      : {}),
  });
  let metadataSnapshot = resolvePluginMetadataSnapshot({
    config: params.cfg,
    env: process.env,
    workspaceDir,
    pluginIdScope,
    allowWorkspaceScopedCurrent: true,
  });
  const resolveSelection = () =>
    resolveSimpleCompletionSelectionForAgent({
      ...selectionParams,
      manifestPlugins: metadataSnapshot.plugins,
    });
  let selection = resolveSelection();
  if (!selection) {
    return { error: `No model configured for agent ${params.agentId}.` };
  }
  const canonicalPluginIdScope = createAgentRuntimeMetadataPluginIdScope({
    config: params.cfg,
    workspaceDir,
    selections: [
      {
        provider: selection.runtimeProvider ?? selection.provider,
        modelId: selection.modelId,
        agentId: params.agentId,
      },
    ],
    ...(tentativeRequest.shorthandModelId &&
    selection.provider === tentativeSelection.provider &&
    selection.modelId === tentativeSelection.modelId
      ? { shorthandModelIds: [tentativeRequest.shorthandModelId] }
      : {}),
  });
  if (canonicalPluginIdScope.key !== pluginIdScope.key) {
    metadataSnapshot = resolvePluginMetadataSnapshot({
      config: params.cfg,
      env: process.env,
      workspaceDir,
      pluginIdScope: canonicalPluginIdScope,
      allowWorkspaceScopedCurrent: true,
    });
    selection = resolveSelection();
    if (!selection) {
      return { error: `No model configured for agent ${params.agentId}.` };
    }
  }
  const selectedProvider = selection.runtimeProvider ?? selection.provider;
  return await withPreparedSimpleCompletionRuntime(
    {
      ...params,
      agentDir: selection.agentDir,
      pluginMetadataSnapshot: metadataSnapshot,
    },
    [{ provider: selectedProvider, modelId: selection.modelId }],
    async (context) => {
      const prepared = await prepareSimpleCompletionModelCore(
        {
          cfg: params.cfg,
          agentId: params.agentId,
          provider: selectedProvider,
          modelId: selection.modelId,
          agentDir: selection.agentDir,
          profileId: selection.profileId,
          preferredProfile: params.preferredProfile,
          allowMissingApiKeyModes: params.allowMissingApiKeyModes,
          ...(params.allowBundledStaticCatalogFallback !== undefined
            ? { allowBundledStaticCatalogFallback: params.allowBundledStaticCatalogFallback }
            : {}),
          skipAgentDiscovery: params.skipAgentDiscovery,
          bindAuthOwner: params.bindAuthOwner,
        },
        context,
      );
      return { ...prepared, selection };
    },
  );
}

export async function completeWithPreparedSimpleCompletionModel(params: {
  model: Model;
  auth: ResolvedProviderAuth;
  context: Parameters<typeof completeSimple>[1];
  cfg?: OpenClawConfig;
  options?: SimpleCompletionModelOptions;
}): Promise<AssistantMessage> {
  const runtime = getModelLlmRuntime(params.model);
  let completionModel = prepareModelForSimpleCompletion({
    // Direct SDK callers that did not use the preparation helper keep the shipped
    // process-default behavior; all prepared host paths carry their lifecycle owner.
    apiRegistry: runtime?.registry ?? defaultApiRegistry,
    model: params.model,
    cfg: params.cfg,
  });
  if (runtime) {
    completionModel = bindModelLlmRuntime(completionModel, runtime);
  }
  const { reasoning: rawReasoning, strictReasoningTags, ...options } = params.options ?? {};
  const reasoning = normalizeSimpleCompletionReasoning(rawReasoning, completionModel);
  const completionOptions = {
    ...options,
    ...(reasoning ? { reasoning } : {}),
    apiKey: params.auth.apiKey,
  };
  if (strictReasoningTags) {
    reasoningTagTextPolicy.markStrict(completionOptions);
  }
  return await completeSimple(completionModel, params.context, completionOptions);
}

function normalizeSimpleCompletionReasoning(
  reasoning: SimpleCompletionModelOptions["reasoning"],
  model: Model,
): ModelThinkingLevel | undefined {
  switch (reasoning) {
    case undefined:
      return undefined;
    case "off":
      return resolveClaudeSonnet5ModelIdentity(model) || resolveClaudeOpus5ModelIdentity(model)
        ? "off"
        : undefined;
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
