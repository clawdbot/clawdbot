import { AsyncLocalStorage } from "node:async_hooks";
import type { AssistantMessage } from "@openclaw/llm-core";
import type { AgentToolCall } from "./types.js";

/** Internal assistant-turn context for one concrete tool invocation. */
export interface AgentToolExecutionContext {
  assistantMessage: AssistantMessage;
  toolCall: AgentToolCall;
}

const activeToolExecution = new AsyncLocalStorage<AgentToolExecutionContext>();

export function getAgentToolExecutionContext(): AgentToolExecutionContext | undefined {
  return activeToolExecution.getStore();
}

export function runWithAgentToolExecutionContext<T>(
  context: AgentToolExecutionContext,
  run: () => T,
): T {
  return activeToolExecution.run(context, run);
}
