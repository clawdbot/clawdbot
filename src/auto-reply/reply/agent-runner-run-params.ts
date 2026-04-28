import { resolveEffectiveModelFallbacks } from "../../agents/agent-scope.js";
import type { resolveProviderScopedAuthProfile } from "./agent-runner-auth-profile.js";
import type { FollowupRun } from "./queue.js";

export type ReasoningTagProviderResolver = (
  provider: string,
  options: {
    config: FollowupRun["run"]["config"];
    workspaceDir: string;
    modelId: string;
  },
) => boolean;

export const resolveEnforceFinalTagWithResolver = (
  run: FollowupRun["run"],
  provider: string,
  model = run.model,
  isReasoningTagProvider?: ReasoningTagProviderResolver,
) =>
  (run.skipProviderRuntimeHints ? false : undefined) ??
  (run.enforceFinalTag ||
    isReasoningTagProvider?.(provider, {
      config: run.config,
      workspaceDir: run.workspaceDir,
      modelId: model,
    }) ||
    false);

export function resolveModelFallbackOptions(
  run: FollowupRun["run"],
  configOverride: FollowupRun["run"]["config"] = run.config,
) {
  const config = configOverride;
  return {
    cfg: config,
    provider: run.provider,
    model: run.model,
    agentDir: run.agentDir,
    fallbacksOverride: resolveEffectiveModelFallbacks({
      cfg: config,
      agentId: run.agentId,
      hasSessionModelOverride: run.hasSessionModelOverride === true,
      modelOverrideSource: run.modelOverrideSource,
    }),
  };
}

export function buildEmbeddedRunBaseParams(params: {
  run: FollowupRun["run"];
  provider: string;
  model: string;
  runId: string;
  authProfile: ReturnType<typeof resolveProviderScopedAuthProfile>;
  allowTransientCooldownProbe?: boolean;
  isReasoningTagProvider?: ReasoningTagProviderResolver;
}) {
  const config = params.run.config;
  return {
    sessionFile: params.run.sessionFile,
    workspaceDir: params.run.workspaceDir,
    agentDir: params.run.agentDir,
    config,
    skillsSnapshot: params.run.skillsSnapshot,
    ownerNumbers: params.run.ownerNumbers,
    inputProvenance: params.run.inputProvenance,
    senderIsOwner: params.run.senderIsOwner,
    enforceFinalTag: resolveEnforceFinalTagWithResolver(
      params.run,
      params.provider,
      params.model,
      params.isReasoningTagProvider,
    ),
    silentExpected: params.run.silentExpected,
    allowEmptyAssistantReplyAsSilent: params.run.allowEmptyAssistantReplyAsSilent,
    silentReplyPromptMode: params.run.silentReplyPromptMode,
    sourceReplyDeliveryMode: params.run.sourceReplyDeliveryMode,
    provider: params.provider,
    model: params.model,
    ...params.authProfile,
    thinkLevel: params.run.thinkLevel,
    verboseLevel: params.run.verboseLevel,
    reasoningLevel: params.run.reasoningLevel,
    execOverrides: params.run.execOverrides,
    bashElevated: params.run.bashElevated,
    timeoutMs: params.run.timeoutMs,
    runId: params.runId,
    allowTransientCooldownProbe: params.allowTransientCooldownProbe,
  };
}
