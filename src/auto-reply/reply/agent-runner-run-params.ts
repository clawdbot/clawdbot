/** Builds embedded-agent run parameters from queued follow-up run state. */
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import { resolveEffectiveModelFallbacks } from "../../agents/agent-scope.js";
import { findModelInCatalog, modelSupportsInput } from "../../agents/model-catalog-lookup.js";
import { modelTransportRoutesMatch } from "../../agents/model-compat-catalog.js";
import {
  resolveMergedModelProviderConfig,
  resolveMergedModelProviderModels,
} from "../../config/model-provider-config.js";
import type { resolveProviderScopedAuthProfile } from "./agent-runner-auth-profile.js";
import type { FollowupRun } from "./queue.js";

/** Callback used to detect providers that require final-answer tags. */
type ReasoningTagProviderResolver = (
  provider: string,
  options: {
    config: FollowupRun["run"]["config"];
    workspaceDir: string;
    modelId: string;
  },
) => boolean;

/** Builds model fallback options for an embedded follow-up run. */
export function resolveModelFallbackOptions(
  run: FollowupRun["run"],
  configOverride: FollowupRun["run"]["config"] = run.config,
) {
  const config = configOverride;
  const fallbacksOverride = run.modelSelectionLocked
    ? []
    : resolveEffectiveModelFallbacks({
        cfg: config,
        agentId: run.agentId,
        sessionKey: run.sessionKey,
        hasSessionModelOverride: run.hasSessionModelOverride === true,
        modelOverrideSource: run.modelOverrideSource,
        hasAutoFallbackProvenance: run.hasAutoFallbackProvenance === true,
      });
  return {
    cfg: config,
    provider: run.provider,
    model: run.model,
    requestedRouteResolution: run.requestedRouteResolution,
    agentDir: run.agentDir,
    agentId: run.agentId,
    sessionKey: run.runtimePolicySessionKey ?? run.sessionKey,
    fallbacksOverride,
  };
}

/** Resolves whether final-answer tags should be enforced for an embedded follow-up run. */
function resolveEnforceFinalTagWithResolver(
  run: FollowupRun["run"],
  provider: string,
  model: string,
  isReasoningTagProvider?: ReasoningTagProviderResolver,
): boolean {
  return (
    (run.skipProviderRuntimeHints ? false : undefined) ??
    (run.enforceFinalTag ||
      isReasoningTagProvider?.(provider, {
        config: run.config,
        workspaceDir: run.workspaceDir,
        modelId: model,
      }) ||
      false)
  );
}

/** Prepare the selected candidate's input before placement can bypass local model resolution. */
export async function resolveRunModelHasVision(params: {
  run: FollowupRun["run"];
  provider: string;
  model: string;
}): Promise<boolean> {
  const { run, provider, model } = params;
  const providerConfig = resolveMergedModelProviderConfig(run.config, provider);
  const configured = resolveMergedModelProviderModels({
    models: providerConfig?.models,
    normalizeModelId: normalizeLowercaseStringOrEmpty,
  }).get(normalizeLowercaseStringOrEmpty(model));
  if (configured?.input !== undefined) {
    return modelSupportsInput(configured, "image");
  }
  const route = {
    api: configured?.api ?? providerConfig?.api,
    baseUrl: configured?.baseUrl ?? providerConfig?.baseUrl,
  };
  const prepared = findModelInCatalog(run.thinkingCatalog ?? [], provider, model);
  if (prepared?.input !== undefined && modelTransportRoutesMatch(prepared, route)) {
    return modelSupportsInput(prepared, "image");
  }
  const { loadProviderScopedThinkingCatalog } =
    await import("../../agents/model-catalog.runtime.js");
  const catalog = await loadProviderScopedThinkingCatalog({
    config: run.config,
    provider,
    model,
    agentId: run.agentId,
    agentDir: run.agentDir,
    workspaceDir: run.workspaceDir,
    requiredInputRoute: route,
  });
  return modelSupportsInput(findModelInCatalog(catalog, provider, model), "image");
}

/** Builds the shared embedded-agent run params from a queued follow-up run. */
export async function buildEmbeddedRunBaseParams(params: {
  run: FollowupRun["run"];
  provider: string;
  model: string;
  runId: string;
  promptCacheKey?: string;
  authProfile: ReturnType<typeof resolveProviderScopedAuthProfile>;
  allowTransientCooldownProbe?: boolean;
  isReasoningTagProvider?: ReasoningTagProviderResolver;
}) {
  const config = params.run.config;
  const modelFallbacksOverride = params.run.modelSelectionLocked
    ? []
    : resolveEffectiveModelFallbacks({
        cfg: config,
        agentId: params.run.agentId,
        sessionKey: params.run.sessionKey,
        hasSessionModelOverride: params.run.hasSessionModelOverride === true,
        modelOverrideSource: params.run.modelOverrideSource,
        hasAutoFallbackProvenance: params.run.hasAutoFallbackProvenance === true,
      });
  const enforceFinalTag = resolveEnforceFinalTagWithResolver(
    params.run,
    params.provider,
    params.model,
    params.isReasoningTagProvider,
  );
  // Runtime policy keys may differ from session keys for direct-message scoped policy.
  const runParams = {
    sessionFile: params.run.sessionFile,
    workspaceDir: params.run.workspaceDir,
    cwd: params.run.cwd,
    permissionMode: params.run.permissionMode,
    sessionRoot: params.run.sessionRoot,
    agentDir: params.run.agentDir,
    config,
    toolOverrides: params.run.toolOverrides,
    skillsSnapshot: params.run.skillsSnapshot,
    ownerNumbers: params.run.ownerNumbers,
    inputProvenance: params.run.inputProvenance,
    trustedInternalHandoff: params.run.trustedInternalHandoff,
    scheduledToolPolicy: params.run.scheduledToolPolicy,
    runtimePluginToolGrant: params.run.runtimePluginToolGrant,
    senderIsOwner: params.run.senderIsOwner,
    conversationToolPolicy: params.run.conversationToolPolicy,
    channelContext: params.run.channelContext,
    approvalReviewerDeviceId: params.run.approvalReviewerDeviceId,
    enforceFinalTag,
    silentExpected: params.run.silentExpected,
    allowEmptyAssistantReplyAsSilent: params.run.allowEmptyAssistantReplyAsSilent,
    terminalReplyExpectation: params.run.terminalReplyExpectation,
    silentReplyPromptMode: params.run.silentReplyPromptMode,
    sourceReplyDeliveryMode: params.run.sourceReplyDeliveryMode,
    clientCaps: params.run.clientCaps,
    toolBindings: params.run.toolBindings,
    taskSuggestionDeliveryMode: params.run.taskSuggestionDeliveryMode,
    skillWorkshopProposalRevision: params.run.skillWorkshopProposalRevision,
    provider: params.provider,
    model: params.model,
    modelHasVision: await resolveRunModelHasVision(params),
    modelSelectionLocked: params.run.modelSelectionLocked,
    modelFallbacksOverride,
    ...params.authProfile,
    thinkLevel: params.run.thinkLevel,
    fastMode: params.run.fastMode,
    fastModeAutoOnSeconds: params.run.fastModeAutoOnSeconds,
    verboseLevel: params.run.verboseLevel,
    reasoningLevel: params.run.reasoningLevel,
    execOverrides: params.run.execOverrides,
    bashElevated: params.run.bashElevated,
    timeoutMs: params.run.timeoutMs,
    runId: params.runId,
    promptCacheKey: params.promptCacheKey,
    allowTransientCooldownProbe: params.allowTransientCooldownProbe,
  };
  return runParams;
}
