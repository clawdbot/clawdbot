import { listAgentToolResultMiddlewares } from "../../plugins/agent-tool-result-middleware.js";
import { hasGlobalHooks } from "../../plugins/hook-runner-global.js";
import {
  cancelDeferredPluginToolApproval,
  hasBeforeToolCallPolicy,
  runBeforeToolCallHook,
} from "../agent-tools.before-tool-call.js";
import { stableStringify } from "../stable-stringify.js";
import { resolveToolLoopDetectionConfig } from "../tool-loop-detection-config.js";
import { payloadTextResult } from "../tools/common.js";
import { runAgentHarnessAfterToolCallHook } from "./hook-helpers.js";
import { runAgentHarnessBeforeAgentFinalizeHook } from "./lifecycle-hook-helpers.js";
import {
  nativeHookRelayParamsWereRewritten,
  normalizeNativeHookToolName,
  readNativeHookRelayApprovalMode,
} from "./native-hook-relay-codec.js";
import {
  runNativeHookRelayPermissionRequest,
  setNativeHookRelayPreToolUseApproval,
} from "./native-hook-relay-permissions.js";
import type {
  ActiveNativeHookRelayRegistration,
  NativeHookRelayEvent,
  NativeHookRelayInvocation,
  NativeHookRelayProcessResponse,
  NativeHookRelayProviderAdapter,
  NativeHookRelayRegistration,
} from "./native-hook-relay-types.js";
import { createAgentToolResultMiddlewareRunner } from "./tool-result-middleware.js";

function nativePreToolUseMayRunLoopDetection(
  registration: ActiveNativeHookRelayRegistration,
): boolean {
  if (!registration.preToolUseLoopDetection || !registration.sessionKey) {
    return false;
  }
  const loopDetection = resolveToolLoopDetectionConfig({
    cfg: registration.config,
    agentId: registration.agentId,
  });
  return loopDetection?.enabled !== false;
}

export function nativeHookRelayEventHasLocalWork(
  registration: ActiveNativeHookRelayRegistration,
  event: NativeHookRelayEvent,
): boolean {
  if (event === "pre_tool_use") {
    // Avoid spawning a native hook relay for every Codex tool call when there
    // is no before_tool_call hook, trusted-tool policy, or loop detector work.
    return hasBeforeToolCallPolicy() || nativePreToolUseMayRunLoopDetection(registration);
  }
  if (event === "post_tool_use") {
    return hasGlobalHooks("after_tool_call") || listAgentToolResultMiddlewares("codex").length > 0;
  }
  if (event === "before_agent_finalize") {
    return hasGlobalHooks("before_agent_finalize");
  }
  return true;
}

export async function processNativeHookRelayInvocation(params: {
  registration: NativeHookRelayRegistration;
  invocation: NativeHookRelayInvocation;
  adapter: NativeHookRelayProviderAdapter;
}): Promise<NativeHookRelayProcessResponse> {
  if (params.invocation.event === "pre_tool_use") {
    return runNativeHookRelayPreToolUse(params);
  }
  if (params.invocation.event === "post_tool_use") {
    return runNativeHookRelayPostToolUse(params);
  }
  if (params.invocation.event === "before_agent_finalize") {
    return runNativeHookRelayBeforeAgentFinalize(params);
  }
  return runNativeHookRelayPermissionRequest(params);
}

async function runNativeHookRelayPreToolUse(params: {
  registration: NativeHookRelayRegistration;
  invocation: NativeHookRelayInvocation;
  adapter: NativeHookRelayProviderAdapter;
}): Promise<NativeHookRelayProcessResponse> {
  const toolName = normalizeNativeHookToolName(params.invocation.toolName);
  const toolInput = params.adapter.readToolInput(params.invocation.rawPayload);
  const originalToolInputFingerprint = stableStringify(toolInput);
  const approvalMode = readNativeHookRelayApprovalMode(params.invocation.rawPayload);
  const outcome = await runBeforeToolCallHook({
    toolName,
    params: toolInput,
    ...(params.invocation.toolUseId ? { toolCallId: params.invocation.toolUseId } : {}),
    ...(approvalMode === "report" ? { approvalMode: "defer" } : {}),
    signal: params.registration.signal,
    ctx: {
      ...(params.registration.agentId ? { agentId: params.registration.agentId } : {}),
      sessionId: params.registration.sessionId,
      ...(params.registration.sessionKey ? { sessionKey: params.registration.sessionKey } : {}),
      ...(params.registration.config ? { config: params.registration.config } : {}),
      runId: params.registration.runId,
      ...(params.registration.channelId ? { channelId: params.registration.channelId } : {}),
      ...(params.registration.requester ? { requester: params.registration.requester } : {}),
      ...(params.invocation.cwd
        ? { cwd: params.invocation.cwd, workspaceDir: params.invocation.cwd }
        : {}),
    },
  });
  if (outcome.blocked) {
    return params.adapter.renderPreToolUseBlockResponse(
      outcome.reason,
      outcome.kind === "failure" && outcome.disposition !== "blocked"
        ? outcome.disposition
        : undefined,
    );
  }
  if (outcome.deferredApproval) {
    if (
      !setNativeHookRelayPreToolUseApproval({
        relayId: params.registration.relayId,
        toolUseId: params.invocation.toolUseId,
        deferredApproval: outcome.deferredApproval,
        originalParamsFingerprint: originalToolInputFingerprint,
      })
    ) {
      cancelDeferredPluginToolApproval(outcome.deferredApproval);
      return params.adapter.renderPreToolUseBlockResponse(
        "Plugin approval required but Codex tool id unavailable.",
      );
    }
    return params.adapter.renderNoopResponse(params.invocation.event);
  }
  if (nativeHookRelayParamsWereRewritten(originalToolInputFingerprint, outcome.params)) {
    // Codex app-server may continue with the original params when updatedInput
    // is unsupported, so rewrites must fail closed here.
    return params.adapter.renderPreToolUseBlockResponse(
      "OpenClaw tool policy rewrote Codex app-server approval params; refusing original request.",
    );
  }
  return params.adapter.renderNoopResponse(params.invocation.event);
}

async function runNativeHookRelayPostToolUse(params: {
  registration: NativeHookRelayRegistration;
  invocation: NativeHookRelayInvocation;
  adapter: NativeHookRelayProviderAdapter;
}): Promise<NativeHookRelayProcessResponse> {
  const toolName = normalizeNativeHookToolName(params.invocation.toolName);
  const toolCallId =
    params.invocation.toolUseId ?? `${params.invocation.event}:${params.invocation.receivedAt}`;
  const startArgs = params.adapter.readToolInput(params.invocation.rawPayload);
  const rawResult = params.adapter.readToolResponse(params.invocation.rawPayload);
  // Native results are observe-only for middleware: codex-rs PostToolUse hooks
  // cannot replace tool_response (PostToolUseOutcome has no result field), so a
  // transformed result reaches only after_tool_call observers, never the model.
  const hasToolResultMiddleware = listAgentToolResultMiddlewares("codex").length > 0;
  const result = !hasToolResultMiddleware
    ? rawResult
    : await createAgentToolResultMiddlewareRunner({
        runtime: "codex",
        ...(params.registration.agentId ? { agentId: params.registration.agentId } : {}),
        sessionId: params.registration.sessionId,
        ...(params.registration.sessionKey ? { sessionKey: params.registration.sessionKey } : {}),
        runId: params.registration.runId,
      }).applyToolResultMiddleware({
        turnId: params.invocation.turnId,
        toolCallId,
        toolName,
        args: startArgs,
        ...(params.invocation.cwd ? { cwd: params.invocation.cwd } : {}),
        result: payloadTextResult(rawResult),
      });
  await runAgentHarnessAfterToolCallHook({
    toolName,
    toolCallId,
    runId: params.registration.runId,
    ...(params.registration.agentId ? { agentId: params.registration.agentId } : {}),
    sessionId: params.registration.sessionId,
    ...(params.registration.sessionKey ? { sessionKey: params.registration.sessionKey } : {}),
    ...(params.registration.channelId ? { channelId: params.registration.channelId } : {}),
    startArgs,
    result,
  });
  return params.adapter.renderNoopResponse(params.invocation.event);
}

async function runNativeHookRelayBeforeAgentFinalize(params: {
  registration: NativeHookRelayRegistration;
  invocation: NativeHookRelayInvocation;
  adapter: NativeHookRelayProviderAdapter;
}): Promise<NativeHookRelayProcessResponse> {
  const outcome = await runAgentHarnessBeforeAgentFinalizeHook({
    event: {
      runId: params.registration.runId,
      sessionId: params.registration.sessionId,
      ...(params.registration.sessionKey ? { sessionKey: params.registration.sessionKey } : {}),
      ...(params.invocation.turnId ? { turnId: params.invocation.turnId } : {}),
      provider: params.registration.provider,
      ...(params.invocation.model ? { model: params.invocation.model } : {}),
      ...(params.invocation.cwd ? { cwd: params.invocation.cwd } : {}),
      ...(params.invocation.transcriptPath
        ? { transcriptPath: params.invocation.transcriptPath }
        : {}),
      stopHookActive: params.invocation.stopHookActive === true,
      ...(params.invocation.lastAssistantMessage
        ? { lastAssistantMessage: params.invocation.lastAssistantMessage }
        : {}),
    },
    ctx: {
      ...(params.registration.agentId ? { agentId: params.registration.agentId } : {}),
      sessionId: params.registration.sessionId,
      ...(params.registration.sessionKey ? { sessionKey: params.registration.sessionKey } : {}),
      runId: params.registration.runId,
      ...(params.registration.channelId ? { channelId: params.registration.channelId } : {}),
      ...(params.invocation.cwd ? { workspaceDir: params.invocation.cwd } : {}),
      ...(params.invocation.model ? { modelId: params.invocation.model } : {}),
    },
  });
  if (outcome.action === "revise") {
    return params.adapter.renderBeforeAgentFinalizeReviseResponse(outcome.reason);
  }
  if (outcome.action === "finalize") {
    return params.adapter.renderBeforeAgentFinalizeStopResponse(outcome.reason);
  }
  return params.adapter.renderNoopResponse(params.invocation.event);
}
