import fsp from "node:fs/promises";
import type { SandboxContext } from "openclaw/plugin-sdk/agent-harness-runtime";
import {
  buildAgentHookContextChannelFields,
  isHostScopedAgentToolActive,
  resolveSandboxContext as defaultResolveSandboxContext,
  resolveSessionAgentIds,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import { readNonEmptyString, readResolvedAttemptPath, resolveModelRef } from "./attempt-config.js";
import type {
  AttemptParamsLike,
  CopilotAttemptDeps,
  CopilotAttemptParams,
} from "./attempt-types.js";
import { assertCopilotAttemptHostCapabilities } from "./attempt-types.js";
import { createCopilotToolBridge } from "./tool-bridge.js";
export function prepareCopilotAttemptContext(
  params: CopilotAttemptParams,
  deps: CopilotAttemptDeps,
) {
  const settledToolFinalization = deps.operation === "settled-tool-finalization";
  if (!settledToolFinalization) {
    assertCopilotAttemptHostCapabilities(params);
  }
  const { hostCapabilities: _hostCapabilities, ...capabilityFreeParams } = params;
  const input = (
    settledToolFinalization
      ? {
          ...capabilityFreeParams,
          disableTools: true,
          images: [],
          imageOrder: [],
          extraSystemPrompt: undefined,
          onAgentEvent: undefined,
          onAgentToolResult: undefined,
          onAssistantDelta: undefined,
          onAssistantMessageStart: undefined,
          onBlockReply: undefined,
          onBlockReplyFlush: undefined,
          onPartialReply: undefined,
          onReasoningEnd: undefined,
          onReasoningStream: undefined,
          onToolResult: undefined,
          onToolStreamBoundary: undefined,
          operation: "settled-tool-finalization",
        }
      : params
  ) as AttemptParamsLike;
  const createToolBridge = deps.createToolBridge ?? createCopilotToolBridge;
  const hostSystemAgentActive =
    deps.isHostScopedToolActive?.("openclaw") ?? isHostScopedAgentToolActive("openclaw");
  const ringZeroSystemAgentRun =
    hostSystemAgentActive &&
    input.toolsAllow?.length === 1 &&
    input.toolsAllow[0]?.trim().toLowerCase() === "openclaw";
  const messages = Array.isArray(input.messages) ? [...input.messages] : [];
  const modelRef = resolveModelRef(input);
  const resolvedWorkspaceForSandbox =
    readResolvedAttemptPath(input.workspaceDir) ?? readResolvedAttemptPath(input.cwd);
  const sandboxSessionKey =
    readNonEmptyString((input as { sandboxSessionKey?: unknown }).sandboxSessionKey) ??
    readNonEmptyString((input as { sessionKey?: unknown }).sessionKey) ??
    readNonEmptyString(input.sessionId);
  const { sessionAgentId } = resolveSessionAgentIds({
    sessionKey: readNonEmptyString((input as { sessionKey?: unknown }).sessionKey),
    config: input.config,
    agentId: readNonEmptyString(params.agentId),
  });
  const hookContextWindowFields = {
    ...(input.contextWindowInfo?.tokens
      ? { contextTokenBudget: input.contextWindowInfo.tokens }
      : input.contextTokenBudget
        ? { contextTokenBudget: input.contextTokenBudget }
        : {}),
    ...(input.contextWindowInfo?.source
      ? { contextWindowSource: input.contextWindowInfo.source }
      : {}),
    ...(input.contextWindowInfo?.referenceTokens
      ? { contextWindowReferenceTokens: input.contextWindowInfo.referenceTokens }
      : {}),
  };
  const hookContext = {
    runId: input.runId,
    jobId: input.jobId,
    agentId: sessionAgentId,
    sessionKey: sandboxSessionKey,
    sessionId: input.sessionId,
    workspaceDir: resolvedWorkspaceForSandbox,
    modelProviderId: modelRef.provider,
    modelId: modelRef.id,
    trigger: input.trigger,
    ...(input.config ? { config: input.config } : {}),
    ...hookContextWindowFields,
    ...buildAgentHookContextChannelFields(input),
  };
  return {
    settledToolFinalization,
    input,
    createToolBridge,
    ringZeroSystemAgentRun,
    messages,
    modelRef,
    resolvedWorkspaceForSandbox,
    sandboxSessionKey,
    sessionAgentId,
    hookContextWindowFields,
    hookContext,
  };
}
export async function resolveCopilotAttemptSandbox(params: {
  deps: CopilotAttemptDeps;
  input: AttemptParamsLike;
  resolvedWorkspaceForSandbox: string;
  sandboxSessionKey: string | undefined;
}): Promise<{ sandbox: SandboxContext | null; effectiveWorkspaceDir: string }> {
  const resolveSandbox = params.deps.resolveSandboxContextOverride ?? defaultResolveSandboxContext;
  const sandbox =
    params.input.sandbox !== undefined
      ? params.input.sandbox
      : await resolveSandbox({
          config: params.input.config,
          sessionKey: params.sandboxSessionKey,
          workspaceDir: params.resolvedWorkspaceForSandbox,
        });
  const effectiveWorkspaceDir = sandbox?.enabled
    ? sandbox.workspaceAccess === "rw"
      ? params.resolvedWorkspaceForSandbox
      : sandbox.workspaceDir
    : params.resolvedWorkspaceForSandbox;
  if (sandbox?.enabled && effectiveWorkspaceDir !== params.resolvedWorkspaceForSandbox) {
    await fsp.mkdir(effectiveWorkspaceDir, { recursive: true });
  }
  return { sandbox, effectiveWorkspaceDir };
}
