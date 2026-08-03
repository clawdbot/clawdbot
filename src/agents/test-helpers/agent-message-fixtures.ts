/**
 * Agent message fixtures and casts for tests.
 *
 * These helpers keep fixture construction terse while still returning the
 * runtime message shapes expected by agent test harnesses.
 */
import type { AssistantMessage, UserMessage } from "openclaw/plugin-sdk/llm";
import type { AgentMessage } from "../runtime/index.js";
import { ZERO_USAGE_FIXTURE } from "./usage-fixtures.js";

/** Casts an unknown fixture value to an agent message for tests. */
export function castAgentMessage(message: unknown): AgentMessage {
  return message as AgentMessage;
}

/** Casts unknown fixture values to agent messages for tests. */
export function castAgentMessages(messages: unknown[]): AgentMessage[] {
  return messages as AgentMessage[];
}

/** Builds a user message fixture with a stable timestamp. */
export function makeAgentUserMessage(
  overrides: Partial<UserMessage> & Pick<UserMessage, "content">,
): UserMessage {
  return {
    role: "user",
    timestamp: 0,
    ...overrides,
  };
}

/** Builds an assistant message fixture with stable model/provider defaults. */
export function makeAgentAssistantMessage(
  overrides: Partial<AssistantMessage> & Pick<AssistantMessage, "content">,
): AssistantMessage {
  return {
    role: "assistant",
    api: "openai-responses",
    provider: "openai",
    model: "test-model",
    usage: ZERO_USAGE_FIXTURE,
    stopReason: "stop",
    timestamp: 0,
    ...overrides,
  };
}
