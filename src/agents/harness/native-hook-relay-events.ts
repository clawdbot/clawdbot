import type { createSubsystemLogger } from "../../logging/subsystem.js";
import { listAgentToolResultMiddlewares } from "../../plugins/agent-tool-result-middleware.js";
import {
  cancelDeferredPluginToolApproval,
  runBeforeToolCallHook,
} from "../agent-tools.before-tool-call.js";
import { stableStringify } from "../stable-stringify.js";
import { payloadTextResult } from "../tools/common.js";
import { runAgentHarnessAfterToolCallHook } from "./hook-helpers.js";
import { runAgentHarnessBeforeAgentFinalizeHook } from "./lifecycle-hook-helpers.js";
import type {
  NativeHookRelayInvocation,
  NativeHookRelayPermissionApprovalRequest,
  NativeHookRelayPermissionApprovalResult,
  NativeHookRelayProcessResponse,
  NativeHookRelayProviderAdapter,
  NativeHookRelayRegistration,
} from "./native-hook-relay-contracts.js";
import {
  nativeHookRelayParamsWereRewritten,
  normalizeNativeHookToolName,
  readNativeHookRelayApprovalMode,
} from "./native-hook-relay-provider.js";
import { createAgentToolResultMiddlewareRunner } from "./tool-result-middleware.js";

export function createNativeHookRelayEventRuntime(context: {
  pendingPermissionApprovals: Map<string, Promise<NativeHookRelayPermissionApprovalResult>>;
  setNativeHookRelayPreToolUseApproval: (params: {
    relayId: string;
    toolUseId?: string;
    deferredApproval: Parameters<typeof cancelDeferredPluginToolApproval>[0];
    originalParamsFingerprint: string;
  }) => boolean;
  startNativeHookRelayPermissionApprovalWithBudget: (params: {
    registration: NativeHookRelayRegistration;
    approvalKey: string;
    request: NativeHookRelayPermissionApprovalRequest;
  }) => Promise<NativeHookRelayPermissionApprovalResult>;
  nativeHookRelayPermissionApprovalKey: (params: {
    registration: NativeHookRelayRegistration;
    request: NativeHookRelayPermissionApprovalRequest;
  }) => string;
  nativeHookRelayPermissionAllowAlwaysKey: (params: {
    registration: NativeHookRelayRegistration;
    request: NativeHookRelayPermissionApprovalRequest;
  }) => string;
  hasNativeHookRelayPermissionAllowAlways: (key: string, now?: number) => boolean;
  rememberNativeHookRelayPermissionAllowAlways: (key: string, now?: number) => void;
  log: Pick<ReturnType<typeof createSubsystemLogger>, "warn">;
}) {
  const {
    pendingPermissionApprovals,
    setNativeHookRelayPreToolUseApproval,
    startNativeHookRelayPermissionApprovalWithBudget,
    nativeHookRelayPermissionApprovalKey,
    nativeHookRelayPermissionAllowAlwaysKey,
    hasNativeHookRelayPermissionAllowAlways,
    rememberNativeHookRelayPermissionAllowAlways,
    log,
  } = context;
  async function processNativeHookRelayInvocation(params: {
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

  async function runNativeHookRelayPermissionRequest(params: {
    registration: NativeHookRelayRegistration;
    invocation: NativeHookRelayInvocation;
    adapter: NativeHookRelayProviderAdapter;
  }): Promise<NativeHookRelayProcessResponse> {
    const request: NativeHookRelayPermissionApprovalRequest = {
      provider: params.registration.provider,
      ...(params.registration.agentId ? { agentId: params.registration.agentId } : {}),
      sessionId: params.registration.sessionId,
      ...(params.registration.sessionKey ? { sessionKey: params.registration.sessionKey } : {}),
      runId: params.registration.runId,
      toolName: normalizeNativeHookToolName(params.invocation.toolName),
      ...(params.invocation.toolUseId ? { toolCallId: params.invocation.toolUseId } : {}),
      ...(params.invocation.cwd ? { cwd: params.invocation.cwd } : {}),
      ...(params.invocation.model ? { model: params.invocation.model } : {}),
      toolInput: params.adapter.readToolInput(params.invocation.rawPayload),
      ...(params.registration.signal ? { signal: params.registration.signal } : {}),
    };
    const approvalKey = nativeHookRelayPermissionApprovalKey({
      registration: params.registration,
      request,
    });
    const allowAlwaysKey = nativeHookRelayPermissionAllowAlwaysKey({
      registration: params.registration,
      request,
    });
    if (hasNativeHookRelayPermissionAllowAlways(allowAlwaysKey)) {
      return params.adapter.renderPermissionDecisionResponse("allow");
    }
    const pendingApproval = pendingPermissionApprovals.get(approvalKey);
    try {
      const decision = await (pendingApproval ??
        startNativeHookRelayPermissionApprovalWithBudget({
          registration: params.registration,
          approvalKey,
          request,
        }));
      if (decision === "allow") {
        return params.adapter.renderPermissionDecisionResponse("allow");
      }
      if (decision === "allow-always") {
        rememberNativeHookRelayPermissionAllowAlways(allowAlwaysKey);
        return params.adapter.renderPermissionDecisionResponse("allow");
      }
      if (decision === "deny") {
        return params.adapter.renderPermissionDecisionResponse("deny", "Denied by user");
      }
    } catch (error) {
      log.warn(
        `native hook permission approval failed; deferring to provider approval path: ${String(error)}`,
      );
    }
    // A PermissionRequest no-op is not an allow decision. Codex interprets it as
    // "no hook decision" and falls through to its normal guardian/user approval path.
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

  return { processNativeHookRelayInvocation };
}
