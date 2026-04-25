import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { getGlobalHookRunner } from "../../plugins/hook-runner-global.js";
import { consumeAdjustedParamsForToolCall } from "../pi-tools.before-tool-call.js";

const log = createSubsystemLogger("agents/harness");

export async function runAgentHarnessAfterToolCallHook(params: {
  toolName: string;
  toolCallId: string;
  runId?: string;
  agentId?: string;
  sessionId?: string;
  sessionKey?: string;
  startArgs: Record<string, unknown>;
  result?: unknown;
  error?: string;
  startedAt?: number;
}): Promise<void> {
  const hookRunner = getGlobalHookRunner();
  if (!hookRunner?.hasHooks("after_tool_call")) {
    return;
  }
  const adjustedArgs = consumeAdjustedParamsForToolCall(params.toolCallId, params.runId);
  const eventArgs =
    adjustedArgs && typeof adjustedArgs === "object"
      ? (adjustedArgs as Record<string, unknown>)
      : params.startArgs;
  try {
    await hookRunner.runAfterToolCall(
      {
        toolName: params.toolName,
        params: eventArgs,
        ...(params.runId ? { runId: params.runId } : {}),
        toolCallId: params.toolCallId,
        ...(params.result ? { result: params.result } : {}),
        ...(params.error ? { error: params.error } : {}),
        ...(params.startedAt != null ? { durationMs: Date.now() - params.startedAt } : {}),
      },
      {
        toolName: params.toolName,
        ...(params.agentId ? { agentId: params.agentId } : {}),
        ...(params.sessionId ? { sessionId: params.sessionId } : {}),
        ...(params.sessionKey ? { sessionKey: params.sessionKey } : {}),
        ...(params.runId ? { runId: params.runId } : {}),
        toolCallId: params.toolCallId,
      },
    );
  } catch (error) {
    log.warn(`after_tool_call hook failed: tool=${params.toolName} error=${String(error)}`);
  }
}

export function runAgentHarnessBeforeMessageWriteHook(params: {
  message: AgentMessage;
  agentId?: string;
  sessionKey?: string;
}): AgentMessage | null {
  const hookRunner = getGlobalHookRunner();
  if (!hookRunner?.hasHooks("before_message_write")) {
    return params.message;
  }
  const result = hookRunner.runBeforeMessageWrite(
    { message: params.message },
    {
      ...(params.agentId ? { agentId: params.agentId } : {}),
      ...(params.sessionKey ? { sessionKey: params.sessionKey } : {}),
    },
  );
  if (result?.block) {
    return null;
  }
  return result?.message ?? params.message;
}
