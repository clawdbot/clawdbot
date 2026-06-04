/**
 * Agent harness tool/message hook helpers.
 *
 * Harnesses use this to dispatch after-tool-call and before-message-write hooks
 * while isolating hook failures from the runtime path.
 */
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { getGlobalHookRunner } from "../../plugins/hook-runner-global.js";
import { consumeAdjustedParamsForToolCall } from "../agent-tools.before-tool-call.js";
import type { AgentMessage } from "../runtime/index.js";

const log = createSubsystemLogger("agents/harness");

/** Runs best-effort after-tool-call hooks for a completed tool invocation. */
export async function runAgentHarnessAfterToolCallHook(params: {
  toolName: string;
  toolCallId: string;
  runId?: string;
  agentId?: string;
  sessionId?: string;
  sessionKey?: string;
  channelId?: string;
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
  // Hooks should see adjusted tool params when before_tool_call rewrote them.
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
        ...(params.channelId ? { channelId: params.channelId } : {}),
        toolCallId: params.toolCallId,
      },
    );
  } catch (error) {
    log.warn(`after_tool_call hook failed: tool=${params.toolName} error=${String(error)}`);
  }
}

/** Runs before-message-write hooks and returns the possibly rewritten message. */
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
