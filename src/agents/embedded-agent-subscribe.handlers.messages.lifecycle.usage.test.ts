import { describe, expect, it } from "vitest";
import type { AssistantMessage, Usage } from "../llm/types.js";
import { preservePendingAssistantUsage } from "./embedded-agent-subscribe.handlers.messages.lifecycle.js";
import { deriveContextPromptTokens, normalizeUsage, type NormalizedUsage } from "./usage.js";

const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } as const;

/**
 * Shapes taken from the #125333 report: a non-CLI provider reported attempt-cumulative totals on
 * the assistant message, while the final model call of that turn was two orders smaller.
 */
const CUMULATIVE_TOTALS: Usage = {
  input: 82_123,
  output: 3_000,
  cacheRead: 525_824,
  cacheWrite: 0,
  totalTokens: 610_947,
  cost: { ...ZERO_COST },
};

const FINAL_CALL_USAGE: NormalizedUsage = {
  input: 12_400,
  output: 3_000,
  cacheRead: 18_900,
  total: 34_300,
};

function makeAssistant(usage: Usage): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text: "final reply" }],
    api: "openai-completions",
    provider: "openai-sub2api",
    model: "gpt-5.6-sol",
    usage,
    stopReason: "stop",
    timestamp: 1,
  };
}

const contextSnapshotOf = (message: AssistantMessage): number | undefined =>
  deriveContextPromptTokens({ lastCallUsage: normalizeUsage(message.usage) });

describe("preservePendingAssistantUsage context fact", () => {
  it("records the final-call context fact when provider totals are attempt-cumulative", () => {
    const message = makeAssistant({ ...CUMULATIVE_TOTALS });

    preservePendingAssistantUsage(message, { ...FINAL_CALL_USAGE });

    expect(message.usage.contextUsage).toEqual({
      state: "available",
      promptTokens: 31_300,
      totalTokens: 34_300,
    });
    // Without the fact, readers derive the prompt size from the cumulative buckets instead.
    expect(contextSnapshotOf(message)).toBe(31_300);
    expect(contextSnapshotOf(makeAssistant({ ...CUMULATIVE_TOTALS }))).toBe(607_947);
  });

  it("leaves the provider's own token buckets untouched", () => {
    const message = makeAssistant({ ...CUMULATIVE_TOTALS });

    preservePendingAssistantUsage(message, { ...FINAL_CALL_USAGE });

    expect(message.usage).toMatchObject({
      input: 82_123,
      output: 3_000,
      cacheRead: 525_824,
      totalTokens: 610_947,
    });
  });

  it("never overwrites a context fact the provider already supplied", () => {
    const supplied = { state: "available", promptTokens: 99_000, totalTokens: 99_500 } as const;
    const message = makeAssistant({ ...CUMULATIVE_TOTALS, contextUsage: { ...supplied } });

    preservePendingAssistantUsage(message, { ...FINAL_CALL_USAGE });

    expect(message.usage.contextUsage).toEqual(supplied);
  });

  it("never overwrites an unavailable-context barrier", () => {
    const message = makeAssistant({
      ...CUMULATIVE_TOTALS,
      contextUsage: { state: "unavailable" },
    });

    preservePendingAssistantUsage(message, { ...FINAL_CALL_USAGE });

    expect(message.usage.contextUsage).toEqual({ state: "unavailable" });
  });

  it("records nothing when the pending snapshot carries no prompt tokens", () => {
    const message = makeAssistant({ ...CUMULATIVE_TOTALS });

    preservePendingAssistantUsage(message, { output: 3_000, total: 3_000 });

    expect(message.usage.contextUsage).toBeUndefined();
    expect(message.usage).toEqual({ ...CUMULATIVE_TOTALS });
  });

  it("still fills missing usage from the pending snapshot", () => {
    const message = makeAssistant({
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { ...ZERO_COST },
    });

    preservePendingAssistantUsage(message, { ...FINAL_CALL_USAGE });

    expect(message.usage).toMatchObject({
      input: 12_400,
      output: 3_000,
      cacheRead: 18_900,
      totalTokens: 34_300,
    });
  });
});
