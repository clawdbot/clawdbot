import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { beforeAll, describe, expect, it, vi } from "vitest";
import "../../test-helpers/pi-coding-agent-token-mock.js";
import { estimateToolResultReductionPotential } from "../tool-result-truncation.js";

let PREEMPTIVE_OVERFLOW_ERROR_TEXT: typeof import("./preemptive-compaction.js").PREEMPTIVE_OVERFLOW_ERROR_TEXT;
let estimatePrePromptTokens: typeof import("./preemptive-compaction.js").estimatePrePromptTokens;
let shouldPreemptivelyCompactBeforePrompt: typeof import("./preemptive-compaction.js").shouldPreemptivelyCompactBeforePrompt;

beforeAll(async () => {
  vi.resetModules();
  ({
    PREEMPTIVE_OVERFLOW_ERROR_TEXT,
    estimatePrePromptTokens,
    shouldPreemptivelyCompactBeforePrompt,
  } = await import("./preemptive-compaction.js"));
});

let timestamp = 1;

function makeAssistantHistory(text: string): AgentMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    timestamp: timestamp++,
  } as AgentMessage;
}

function makeToolResultMessage(...texts: string[]): AgentMessage {
  return {
    role: "toolResult",
    toolCallId: `call_${timestamp}`,
    toolName: "read",
    content: texts.map((text) => ({ type: "text", text })),
    isError: false,
    timestamp: timestamp++,
  } as AgentMessage;
}

describe("preemptive-compaction", () => {
  const verboseHistory =
    "alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu ".repeat(40);
  const verboseSystem =
    "system guidance with multiple distinct words to avoid tokenizer overcompression ".repeat(25);
  const verbosePrompt =
    "user request with distinct content asking for a detailed answer and more context ".repeat(25);

  it("exports a context-overflow-compatible precheck error text", () => {
    expect(PREEMPTIVE_OVERFLOW_ERROR_TEXT).toContain("Context overflow:");
    expect(PREEMPTIVE_OVERFLOW_ERROR_TEXT).toContain("(precheck)");
  });

  it("raises the estimate as prompt-side content grows", () => {
    const smaller = estimatePrePromptTokens({
      messages: [makeAssistantHistory(verboseHistory)],
      systemPrompt: "sys",
      prompt: "hello",
    });
    const larger = estimatePrePromptTokens({
      messages: [makeAssistantHistory(verboseHistory)],
      systemPrompt: verboseSystem,
      prompt: verbosePrompt,
    });

    expect(larger).toBeGreaterThan(smaller);
  });

  it("requests preemptive compaction when the reserve-based prompt budget would be exceeded", () => {
    const result = shouldPreemptivelyCompactBeforePrompt({
      messages: [makeAssistantHistory(verboseHistory)],
      systemPrompt: verboseSystem,
      prompt: verbosePrompt,
      contextTokenBudget: 500,
      reserveTokens: 50,
    });

    expect(result.shouldCompact).toBe(true);
    expect(result.route).toBe("compact_only");
    expect(result.estimatedPromptTokens).toBeGreaterThan(result.promptBudgetBeforeReserve);
  });

  it("does not request preemptive compaction when the reserve-based prompt budget still fits", () => {
    const result = shouldPreemptivelyCompactBeforePrompt({
      messages: [makeAssistantHistory("short history")],
      systemPrompt: "sys",
      prompt: "hello",
      contextTokenBudget: 10_000,
      reserveTokens: 1_000,
    });

    expect(result.shouldCompact).toBe(false);
    expect(result.route).toBe("fits");
    expect(result.estimatedPromptTokens).toBeLessThan(result.promptBudgetBeforeReserve);
  });

  it("uses the larger unwindowed message estimate when explicitly provided", () => {
    const result = shouldPreemptivelyCompactBeforePrompt({
      messages: [makeAssistantHistory("small assembled window")],
      unwindowedMessages: [makeAssistantHistory(verboseHistory.repeat(4))],
      systemPrompt: "sys",
      prompt: "hello",
      contextTokenBudget: 500,
      reserveTokens: 50,
    });

    expect(result.shouldCompact).toBe(true);
    expect(result.route).toBe("compact_only");
    expect(result.estimatedPromptTokens).toBeGreaterThan(result.promptBudgetBeforeReserve);
  });

  it("caps reserve tokens so small context models keep usable prompt budget", () => {
    const result = shouldPreemptivelyCompactBeforePrompt({
      messages: [makeAssistantHistory("short history")],
      systemPrompt: "sys",
      prompt: "hello",
      contextTokenBudget: 16_000,
      reserveTokens: 20_000,
    });

    expect(result.effectiveReserveTokens).toBe(8_000);
    expect(result.promptBudgetBeforeReserve).toBe(8_000);
    expect(result.shouldCompact).toBe(false);
    expect(result.route).toBe("fits");
  });

  it("keeps the requested reserve when it leaves enough prompt budget", () => {
    const result = shouldPreemptivelyCompactBeforePrompt({
      messages: [makeAssistantHistory("short history")],
      systemPrompt: "sys",
      prompt: "hello",
      contextTokenBudget: 32_000,
      reserveTokens: 20_000,
    });

    expect(result.effectiveReserveTokens).toBe(20_000);
    expect(result.promptBudgetBeforeReserve).toBe(12_000);
    expect(result.shouldCompact).toBe(false);
  });

  it("routes to direct tool-result truncation when recent tool tails can clearly absorb the overflow", () => {
    const medium = "alpha beta gamma delta epsilon ".repeat(2200);
    const messages: AgentMessage[] = [
      makeAssistantHistory("short history"),
      makeToolResultMessage(medium, medium, medium, medium),
    ];
    const reserveTokens = 2_000;
    const contextTokenBudget = 26_000;
    const estimatedPromptTokens = estimatePrePromptTokens({
      messages,
      systemPrompt: "sys",
      prompt: "hello",
    });
    const desiredOverflowTokens = 200;
    const adjustedContextTokenBudget =
      estimatedPromptTokens - desiredOverflowTokens + reserveTokens;
    const result = shouldPreemptivelyCompactBeforePrompt({
      messages,
      systemPrompt: "sys",
      prompt: "hello",
      contextTokenBudget: Math.max(contextTokenBudget, adjustedContextTokenBudget),
      reserveTokens,
    });

    expect(result.route).toBe("truncate_tool_results_only");
    expect(result.shouldCompact).toBe(false);
    expect(result.overflowTokens).toBeGreaterThan(0);
    expect(result.toolResultReducibleChars).toBeGreaterThan(0);
  });

  it("routes to compact then truncate when recent tool tails help but cannot fully cover the overflow", () => {
    const medium = "alpha beta gamma delta epsilon ".repeat(220);
    const longHistory = "old discussion with substantial retained context and decisions ".repeat(
      5000,
    );
    const messages = [
      makeAssistantHistory(longHistory),
      makeToolResultMessage(medium),
      makeToolResultMessage(medium),
      makeToolResultMessage(medium),
    ];
    const reserveTokens = 500;
    const result = shouldPreemptivelyCompactBeforePrompt({
      messages,
      systemPrompt: verboseSystem,
      prompt: verbosePrompt,
      contextTokenBudget: 12_000,
      reserveTokens,
    });

    expect(result.route).toBe("compact_then_truncate");
    expect(result.shouldCompact).toBe(true);
    expect(result.overflowTokens).toBeGreaterThan(0);
    expect(result.toolResultReducibleChars).toBeGreaterThan(0);
  });

  it("treats mixed oversized-plus-aggregate tool tails as cumulative recovery potential", () => {
    const oversized = "x".repeat(45_000);
    const medium = "alpha beta gamma delta epsilon ".repeat(500);
    const messages: AgentMessage[] = [
      makeAssistantHistory("short history"),
      makeToolResultMessage(oversized),
      makeToolResultMessage(medium),
      makeToolResultMessage(medium),
    ];
    const reserveTokens = 2_000;
    const estimatedPromptTokens = estimatePrePromptTokens({
      messages,
      systemPrompt: "sys",
      prompt: "hello",
    });
    const potential = estimateToolResultReductionPotential({
      messages,
      contextWindowTokens: 128_000,
    });
    const desiredOverflowTokens = 2_000;
    const result = shouldPreemptivelyCompactBeforePrompt({
      messages,
      systemPrompt: "sys",
      prompt: "hello",
      contextTokenBudget: estimatedPromptTokens - desiredOverflowTokens + reserveTokens,
      reserveTokens,
    });

    expect(potential.oversizedReducibleChars).toBeGreaterThan(0);
    expect(potential.aggregateReducibleChars).toBeGreaterThan(0);
    expect(potential.oversizedReducibleChars).toBeLessThan(potential.maxReducibleChars);
    expect(potential.maxReducibleChars).toBeGreaterThan(desiredOverflowTokens * 4);
    expect(result.route).toBe("truncate_tool_results_only");
    expect(result.shouldCompact).toBe(false);
  });
});
