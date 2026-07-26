/** Builds embedded-agent run parameters from queued follow-up run state. */
import { resolveEffectiveModelFallbacks } from "../../agents/agent-scope.js";
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

/** Builds the shared embedded-agent run params from a queued follow-up run. */
export function buildEmbeddedRunBaseParams(params: {
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
  return {
    sessionFile: params.run.sessionFile,
    workspaceDir: params.run.workspaceDir,
    cwd: params.run.cwd,
    agentDir: params.run.agentDir,
    config,
    skillsSnapshot: params.run.skillsSnapshot,
    ownerNumbers: params.run.ownerNumbers,
    inputProvenance: params.run.inputProvenance,
    senderIsOwner: params.run.senderIsOwner,
    channelContext: params.run.channelContext,
    approvalReviewerDeviceId: params.run.approvalReviewerDeviceId,
    enforceFinalTag,
    silentExpected: params.run.silentExpected,
    allowEmptyAssistantReplyAsSilent: params.run.allowEmptyAssistantReplyAsSilent,
    silentReplyPromptMode: params.run.silentReplyPromptMode,
    sourceReplyDeliveryMode: params.run.sourceReplyDeliveryMode,
    clientCaps: params.run.clientCaps,
    toolBindings: params.run.toolBindings,
    taskSuggestionDeliveryMode: params.run.taskSuggestionDeliveryMode,
    provider: params.provider,
    model: params.model,
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
}
