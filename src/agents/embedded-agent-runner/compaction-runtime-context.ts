/**
 * Builds runtime context for context-engine backed embedded compaction.
 */
import type { ThinkLevel } from "../../auto-reply/thinking.js";
import type { ChatType } from "../../channels/chat-type.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { ProviderRuntimeModel } from "../../plugins/provider-runtime-model.types.js";
import { isDefaultAgentRuntimeId, normalizeOptionalAgentRuntimeId } from "../agent-runtime-id.js";
import {
  listActiveProcessSessionReferences,
  type ActiveProcessSessionReference,
} from "../bash-process-references.js";
import { resolveContextWindowInfo } from "../context-window-guard.js";
import { DEFAULT_CONTEXT_TOKENS, DEFAULT_PROVIDER } from "../defaults.js";
import {
  buildModelAliasIndex,
  inferUniqueProviderFromConfiguredModels,
  resolveModelRefFromString,
} from "../model-selection-shared.js";
import { resolveSelectedOpenAIRuntimeProvider } from "../openai-routing.js";
import { agentRuntimeAuthPlanMatchesTarget } from "../runtime-plan/prepare-auth.js";
import type { AgentRuntimePlan } from "../runtime-plan/types.js";
import { resolveCandidateThinkingLevel } from "../thinking-runtime.js";
import type { CompactEmbeddedAgentSessionParams } from "./compact.types.js";
import { readAgentModelContextTokens } from "./model-context-tokens.js";
import { normalizeContextTokenBudget } from "./utils.js";

type EmbeddedCompactionRuntimeContextParams = Omit<
  Partial<CompactEmbeddedAgentSessionParams>,
  | "workspaceDir"
  | "sessionKey"
  | "messageChannel"
  | "messageProvider"
  | "chatType"
  | "agentAccountId"
  | "currentChannelId"
  | "currentThreadTs"
  | "currentMessageId"
  | "authProfileId"
  | "cwd"
  | "senderId"
  | "provider"
  | "model"
> & {
  workspaceDir: string;
  sessionKey?: string | null;
  messageChannel?: string | null;
  messageProvider?: string | null;
  chatType?: ChatType | null;
  agentAccountId?: string | null;
  currentChannelId?: string | null;
  currentThreadTs?: string | null;
  currentMessageId?: string | number | null;
  authProfileId?: string | null;
  cwd?: string | null;
  senderId?: string | null;
  provider?: string | null;
  modelId?: string | null;
  harnessRuntime?: string | null;
  activeProcessSessions?: ActiveProcessSessionReference[];
};

/** Resolve the configured compaction override against the actual model/runtime candidate. */
export function resolveEmbeddedCompactionThinkingLevel(params: {
  config?: OpenClawConfig;
  provider: string;
  modelId: string;
  inheritedLevel?: ThinkLevel;
  agentId?: string;
  sessionKey?: string;
  agentRuntime?: string | null;
}): ThinkLevel {
  const requestedLevel =
    params.config?.agents?.defaults?.compaction?.thinkingLevel ?? params.inheritedLevel;
  if (!requestedLevel) {
    return "off";
  }
  // A compaction model override or fallback can change the supported level set.
  // Revalidate the immutable request for every concrete candidate instead of
  // carrying a level clamped for an earlier model into a later attempt.
  return (
    resolveCandidateThinkingLevel({
      cfg: params.config,
      provider: params.provider,
      modelId: params.modelId,
      level: requestedLevel,
      agentId: params.agentId,
      sessionKey: params.sessionKey,
      agentRuntime: params.agentRuntime,
    }) ?? "off"
  );
}

/**
 * Resolve the effective compaction target from config, falling back to the
 * caller-supplied provider/model and optionally applying runtime defaults.
 */
export function resolveEmbeddedCompactionTarget(params: {
  config?: OpenClawConfig;
  provider?: string | null;
  modelId?: string | null;
  authProfileId?: string | null;
  harnessRuntime?: string | null;
  modelSelectionLocked?: boolean;
  defaultProvider?: string;
  defaultModel?: string;
}): {
  provider: string | undefined;
  runtimeProvider?: string;
  contextProvider?: string;
  nativeHarnessCompaction?: boolean;
  model: string | undefined;
  authProfileId: string | undefined;
} {
  const provider = params.provider?.trim() || params.defaultProvider;
  const model = params.modelId?.trim() || params.defaultModel;
  // A locked session's creating model owns every transcript read, including
  // summaries. Compaction-specific model overrides would cross that boundary.
  const override = params.modelSelectionLocked
    ? undefined
    : params.config?.agents?.defaults?.compaction?.model?.trim();
  const resolveTargetProviders = (
    targetProvider: string | undefined,
    authProfileId: string | undefined,
  ) => {
    if (!targetProvider) {
      return {};
    }
    const selectedHarnessRuntime = normalizeOptionalAgentRuntimeId(params.harnessRuntime);
    // Compaction follows the concrete session or prepared-plan owner. Provider
    // defaults choose new runs; they cannot move an existing transcript.
    const useNativeHarnessRuntime =
      selectedHarnessRuntime !== undefined &&
      selectedHarnessRuntime !== "openclaw" &&
      !isDefaultAgentRuntimeId(selectedHarnessRuntime);
    const harnessRuntime = useNativeHarnessRuntime ? selectedHarnessRuntime : "openclaw";
    const runtimeProvider = resolveSelectedOpenAIRuntimeProvider({
      provider: targetProvider,
      harnessRuntime: harnessRuntime ?? undefined,
      authProfileId,
      config: params.config,
    });
    const routedRuntimeProvider = runtimeProvider === targetProvider ? undefined : runtimeProvider;
    return {
      runtimeProvider: routedRuntimeProvider,
      contextProvider: useNativeHarnessRuntime ? routedRuntimeProvider : undefined,
      ...(useNativeHarnessRuntime ? { nativeHarnessCompaction: true } : {}),
    };
  };
  if (!override) {
    const authProfileId = params.authProfileId ?? undefined;
    return {
      provider,
      ...resolveTargetProviders(provider, authProfileId),
      model,
      authProfileId,
    };
  }
  const slashIdx = override.indexOf("/");
  if (slashIdx > 0) {
    const overrideProvider = override.slice(0, slashIdx).trim();
    const overrideModel = override.slice(slashIdx + 1).trim() || params.defaultModel;
    // When switching provider via override, drop the primary auth profile to
    // avoid sending the wrong credentials.
    const authProfileId =
      overrideProvider !== provider ? undefined : (params.authProfileId ?? undefined);
    return {
      provider: overrideProvider,
      ...resolveTargetProviders(overrideProvider, authProfileId),
      model: overrideModel,
      authProfileId,
    };
  }
  const config = params.config ?? {};
  const currentProvider = provider?.trim();
  if (
    currentProvider &&
    hasBareConfiguredModelForProvider({
      cfg: config,
      provider: currentProvider,
      model: override,
    })
  ) {
    const authProfileId = params.authProfileId ?? undefined;
    return {
      provider: currentProvider,
      ...resolveTargetProviders(currentProvider, authProfileId),
      model: override,
      authProfileId,
    };
  }
  const inferredLiteralProvider = inferUniqueProviderFromConfiguredModels({
    cfg: config,
    model: override,
  });
  if (inferredLiteralProvider) {
    const authProfileId =
      inferredLiteralProvider !== provider ? undefined : (params.authProfileId ?? undefined);
    return {
      provider: inferredLiteralProvider,
      ...resolveTargetProviders(inferredLiteralProvider, authProfileId),
      model: override,
      authProfileId,
    };
  }
  const defaultProvider = provider || DEFAULT_PROVIDER;
  const aliasResolution = resolveModelRefFromString({
    cfg: config,
    raw: override,
    defaultProvider,
    aliasIndex: buildModelAliasIndex({
      cfg: config,
      defaultProvider,
    }),
  });
  if (aliasResolution?.alias) {
    const resolvedProvider = aliasResolution.ref.provider;
    const authProfileId =
      resolvedProvider !== provider ? undefined : (params.authProfileId ?? undefined);
    return {
      provider: resolvedProvider,
      ...resolveTargetProviders(resolvedProvider, authProfileId),
      model: aliasResolution.ref.model,
      authProfileId,
    };
  }
  const authProfileId = params.authProfileId ?? undefined;
  return {
    provider,
    ...resolveTargetProviders(provider, authProfileId),
    model: override,
    authProfileId,
  };
}

function normalizeCompactionConfigKey(value: string): string {
  return value.trim().toLowerCase();
}

function hasBareConfiguredModelForProvider(params: {
  cfg: OpenClawConfig;
  provider: string;
  model: string;
}): boolean {
  const providerKey = normalizeCompactionConfigKey(params.provider);
  const modelKey = normalizeCompactionConfigKey(params.model);
  if (!providerKey || !modelKey || params.model.includes("/")) {
    return false;
  }
  for (const rawRef of Object.keys(params.cfg.agents?.defaults?.models ?? {})) {
    const slashIdx = rawRef.indexOf("/");
    if (slashIdx <= 0 || rawRef.endsWith("/*")) {
      continue;
    }
    const rawProvider = rawRef.slice(0, slashIdx);
    const rawModel = rawRef.slice(slashIdx + 1);
    if (
      normalizeCompactionConfigKey(rawProvider) === providerKey &&
      normalizeCompactionConfigKey(rawModel) === modelKey
    ) {
      return true;
    }
  }
  const configuredProvider = Object.entries(params.cfg.models?.providers ?? {}).find(([key]) => {
    return normalizeCompactionConfigKey(key) === providerKey;
  })?.[1];
  return (configuredProvider?.models ?? []).some((entry) => {
    return normalizeCompactionConfigKey(entry?.id ?? "") === modelKey;
  });
}

/** Resolves the concrete harness already bound to this exact compaction target. */
export function resolveCompactionHarnessRuntime(params: {
  boundHarnessRuntime?: string | null;
  preparedRuntimePlan?: AgentRuntimePlan;
  configuredHarnessRuntime?: string | null;
  provider: string;
  modelId: string;
}): string | undefined {
  const boundHarnessRuntime = normalizeOptionalAgentRuntimeId(params.boundHarnessRuntime);
  if (boundHarnessRuntime) {
    return boundHarnessRuntime;
  }
  const preparedRuntimePlan = params.preparedRuntimePlan;
  if (
    preparedRuntimePlan &&
    agentRuntimeAuthPlanMatchesTarget(preparedRuntimePlan.auth, {
      provider: params.provider,
      modelId: params.modelId,
    })
  ) {
    const preparedHarnessRuntime = normalizeOptionalAgentRuntimeId(
      preparedRuntimePlan.resolvedRef.harnessId,
    );
    if (preparedHarnessRuntime) {
      return preparedHarnessRuntime;
    }
  }
  return normalizeOptionalAgentRuntimeId(params.configuredHarnessRuntime);
}

/** Resolves the shared policy, target, and harness ownership for either compaction entry point. */
export function resolveCompactionContextTokenBudget(params: {
  config?: OpenClawConfig;
  provider: string;
  modelId: string;
  model?: ProviderRuntimeModel;
  requestedTokenBudget?: number;
  fallbackTokenBudget?: number;
}) {
  const resolvedBudget =
    normalizeContextTokenBudget(
      resolveContextWindowInfo({
        cfg: params.config,
        provider: params.provider,
        modelId: params.modelId,
        modelContextTokens: readAgentModelContextTokens(params.model),
        modelContextWindow: params.model?.contextWindow,
        defaultTokens: DEFAULT_CONTEXT_TOKENS,
      }).tokens,
    ) ?? DEFAULT_CONTEXT_TOKENS;
  return Math.min(
    normalizeContextTokenBudget(params.requestedTokenBudget) ??
      normalizeContextTokenBudget(params.fallbackTokenBudget) ??
      resolvedBudget,
    resolvedBudget,
  );
}

export function buildEmbeddedCompactionRuntimeContext(
  params: EmbeddedCompactionRuntimeContextParams,
) {
  const resolved = resolveEmbeddedCompactionTarget({
    config: params.config,
    provider: params.provider,
    modelId: params.modelId,
    authProfileId: params.authProfileId,
    harnessRuntime: params.harnessRuntime,
    modelSelectionLocked: params.modelSelectionLocked,
  });
  const agentHarnessId = params.harnessRuntime?.trim() || undefined;
  const runtimeAuthPlan =
    params.runtimeAuthPlan &&
    resolved.provider &&
    resolved.model &&
    agentRuntimeAuthPlanMatchesTarget(params.runtimeAuthPlan, {
      provider: resolved.provider,
      modelId: resolved.model,
    })
      ? params.runtimeAuthPlan
      : undefined;
  const processScopeKey = params.sessionKey?.trim();
  const activeProcessSessions =
    params.activeProcessSessions ??
    listActiveProcessSessionReferences({
      scopeKey: processScopeKey,
    });
  return {
    sessionKey: params.sessionKey ?? undefined,
    messageChannel: params.messageChannel ?? undefined,
    messageProvider: params.messageProvider ?? undefined,
    clientCaps: params.clientCaps,
    chatType: params.chatType ?? undefined,
    agentAccountId: params.agentAccountId ?? undefined,
    currentChannelId: params.currentChannelId ?? undefined,
    currentThreadTs: params.currentThreadTs ?? undefined,
    currentMessageId: params.currentMessageId ?? undefined,
    authProfileId: resolved.authProfileId,
    authProfileIdSource: params.authProfileIdSource,
    runtimeAuthPlan,
    agentHarnessId,
    modelSelectionLocked: params.modelSelectionLocked,
    workspaceDir: params.workspaceDir,
    cwd: params.cwd ?? undefined,
    agentDir: params.agentDir,
    config: params.config,
    skillsSnapshot: params.skillsSnapshot,
    senderIsOwner: params.senderIsOwner,
    senderId: params.senderId ?? undefined,
    provider: resolved.provider,
    runtimeProvider: resolved.runtimeProvider,
    model: resolved.model,
    modelFallbacksOverride: params.modelFallbacksOverride,
    thinkLevel: params.thinkLevel,
    reasoningLevel: params.reasoningLevel,
    bashElevated: params.bashElevated,
    extraSystemPrompt: params.extraSystemPrompt,
    sourceReplyDeliveryMode: params.sourceReplyDeliveryMode,
    ownerNumbers: params.ownerNumbers,
    ...(activeProcessSessions.length > 0 ? { activeProcessSessions } : {}),
  };
}
