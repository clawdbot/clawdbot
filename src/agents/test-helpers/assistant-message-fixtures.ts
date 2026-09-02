/**
 * Assistant message fixtures for agent tests.
 *
 * Tests use this helper to construct complete assistant messages with stable
 * defaults while overriding only the fields relevant to a scenario.
 */
import type { AssistantMessage } from "openclaw/plugin-sdk/llm";
import { ZERO_USAGE_FIXTURE } from "./usage-fixtures.js";

/** Builds an assistant message fixture with deterministic error-style defaults. */
export function makeAssistantMessageFixture(
  overrides: Partial<AssistantMessage> = {},
): AssistantMessage {
  const errorText = typeof overrides.errorMessage === "string" ? overrides.errorMessage : "error";
  return {
    role: "assistant",
    api: "openai-responses",
    provider: "openai",
    model: "test-model",
    usage: ZERO_USAGE_FIXTURE,
    timestamp: 0,
    stopReason: "error",
    errorMessage: errorText,
    content: [{ type: "text", text: errorText }],
    ...overrides,
  };
}
