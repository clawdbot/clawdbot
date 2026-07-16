// Embedded run helper tests cover final assistant text extraction and error
// metadata assembly shared by normal exits and failure paths.
import type { AssistantMessage } from "openclaw/plugin-sdk/llm";
import { describe, expect, it } from "vitest";
import type { NormalizedUsage } from "../../usage.js";
import { createUsageAccumulator, mergeUsageIntoAccumulator } from "../usage-accumulator.js";
import {
  buildUsageAgentMetaFields,
  buildErrorAgentMeta,
  resolveEmbeddedAttemptBasePrompt,
  resolveFinalAssistantRawText,
  resolveFinalAssistantVisibleText,
  resolveLatestCallUsage,
  resolveNextSameModelRateLimitRetryCount,
  resolveSameModelRateLimitRetryDelayMs,
} from "./helpers.js";

describe("resolveEmbeddedAttemptBasePrompt", () => {
  const refusalTrigger = "ANTHROPIC_MAGIC_STRING_TRIGGER_REFUSAL";

  it("preserves prompts verbatim for native model-owned harnesses", () => {
    expect(
      resolveEmbeddedAttemptBasePrompt({
        nativeModelOwned: true,
        provider: "anthropic",
        prompt: refusalTrigger,
      }),
    ).toBe(refusalTrigger);
  });

  it("keeps the outer Anthropic transport scrub for ordinary runs", () => {
    expect(
      resolveEmbeddedAttemptBasePrompt({
        nativeModelOwned: false,
        provider: "anthropic",
        prompt: refusalTrigger,
      }),
    ).not.toContain(refusalTrigger);
  });
});

function makeAssistantMessage(
  content: AssistantMessage["content"],
  phase?: string,
): AssistantMessage {
  // Minimal assistant fixture with usage fields required by the SDK type; the
  // tested helpers only care about content, phase, and final metadata.
  return {
    api: "responses",
    provider: "openai",
    model: "gpt-5.4",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    role: "assistant",
    content,
    timestamp: Date.now(),
    stopReason: "stop",
    ...(phase ? { phase } : {}),
  };
}

describe("resolveFinalAssistantVisibleText", () => {
  it("prefers final_answer text over commentary blocks", () => {
    // Commentary can be streamed before the final answer; user-visible result
    // extraction must choose the signed final phase when present.
    const lastAssistant = makeAssistantMessage([
      {
        type: "text",
        text: "Working...",
        textSignature: JSON.stringify({ v: 1, id: "item_commentary", phase: "commentary" }),
      },
      {
        type: "text",
        text: "Section 1\nSection 2",
        textSignature: JSON.stringify({ v: 1, id: "item_final", phase: "final_answer" }),
      },
    ]);

    expect(resolveFinalAssistantVisibleText(lastAssistant)).toBe("Section 1\nSection 2");
  });

  it("returns undefined when the final visible text is empty", () => {
    const lastAssistant = makeAssistantMessage([
      {
        type: "text",
        text: "Working...",
        textSignature: JSON.stringify({ v: 1, id: "item_commentary", phase: "commentary" }),
      },
      {
        type: "text",
        text: "   ",
        textSignature: JSON.stringify({ v: 1, id: "item_final", phase: "final_answer" }),
      },
    ]);

    expect(resolveFinalAssistantVisibleText(lastAssistant)).toBeUndefined();
  });

  it("preserves raw final answer text without visible-text sanitization", () => {
    const lastAssistant = makeAssistantMessage([
      {
        type: "text",
        text: "<final>keep this</final>",
        textSignature: JSON.stringify({ v: 1, id: "item_final", phase: "final_answer" }),
      },
    ]);

    expect(resolveFinalAssistantRawText(lastAssistant)).toBe("<final>keep this</final>");
  });
});

describe("resolveSameModelRateLimitRetryDelayMs", () => {
  it("waits 10s/20s/30s linearly before the 1st/2nd/3rd same-model retry", () => {
    expect(resolveSameModelRateLimitRetryDelayMs({ retriesSoFar: 0 })).toBe(10_000);
    expect(resolveSameModelRateLimitRetryDelayMs({ retriesSoFar: 1 })).toBe(20_000);
    expect(resolveSameModelRateLimitRetryDelayMs({ retriesSoFar: 2 })).toBe(30_000);
  });

  it("caps at 60s if the retry count is ever raised further", () => {
    expect(resolveSameModelRateLimitRetryDelayMs({ retriesSoFar: 10 })).toBe(60_000);
  });

  it("is deterministic so RPM windows clear predictably", () => {
    expect(resolveSameModelRateLimitRetryDelayMs({ retriesSoFar: 2 })).toBe(
      resolveSameModelRateLimitRetryDelayMs({ retriesSoFar: 2 }),
    );
  });

  it("honors a short provider Retry-After when it is longer than the fixed backoff", () => {
    expect(
      resolveSameModelRateLimitRetryDelayMs({
        retriesSoFar: 0,
        retryAfterSeconds: 30,
      }),
    ).toBe(30_000);
  });

  it("keeps the existing fixed backoff when Retry-After is shorter", () => {
    expect(
      resolveSameModelRateLimitRetryDelayMs({
        retriesSoFar: 1,
        retryAfterSeconds: 5,
      }),
    ).toBe(20_000);
  });

  it("caps provider Retry-After at the same short-window retry ceiling", () => {
    expect(
      resolveSameModelRateLimitRetryDelayMs({
        retriesSoFar: 0,
        retryAfterSeconds: 120,
      }),
    ).toBe(60_000);
  });
});

describe("resolveNextSameModelRateLimitRetryCount", () => {
  it("counts only consecutive same-model rate-limit retries", () => {
    let retriesSoFar = 0;

    retriesSoFar = resolveNextSameModelRateLimitRetryCount({
      retriesSoFar,
      retriedSameModelRateLimit: true,
    });
    retriesSoFar = resolveNextSameModelRateLimitRetryCount({
      retriesSoFar,
      retriedSameModelRateLimit: true,
    });
    expect(retriesSoFar).toBe(2);

    retriesSoFar = resolveNextSameModelRateLimitRetryCount({
      retriesSoFar,
      retriedSameModelRateLimit: false,
    });
    expect(retriesSoFar).toBe(0);

    retriesSoFar = resolveNextSameModelRateLimitRetryCount({
      retriesSoFar,
      retriedSameModelRateLimit: true,
    });
    expect(retriesSoFar).toBe(1);
  });
});

describe("resolveLatestCallUsage", () => {
  it("preserves the previous exact call across a zero-usage retry", () => {
    const previous = { input: 12, output: 3, total: 15 };

    expect(
      resolveLatestCallUsage({
        currentAttemptCandidates: [{ input: 0, output: 0, total: 0 }, undefined],
        carriedCandidates: [previous],
      }),
    ).toEqual({
      currentAttempt: undefined,
      latest: previous,
    });
  });

  it("replaces the previous call when a new nonzero snapshot arrives", () => {
    const latest = { input: 20, output: 4, total: 24 };

    expect(
      resolveLatestCallUsage({
        currentAttemptCandidates: [{ input: 0, output: 0, total: 0 }, latest],
        carriedCandidates: [{ input: 12, output: 3, total: 15 }],
      }),
    ).toEqual({
      currentAttempt: latest,
      latest,
    });
  });
});

describe("buildUsageAgentMetaFields", () => {
  it("keeps aggregate billing buckets out of the latest context snapshot", () => {
    const usageAccumulator = createUsageAccumulator();
    const latestCallUsage = {
      input: 12,
      output: 15_104,
      cacheRead: 819_661,
      cacheWrite: 93_130,
      contextUsage: {
        state: "available",
        promptTokens: 148_874,
        totalTokens: 163_978,
      },
      total: 927_907,
    } satisfies NormalizedUsage;
    mergeUsageIntoAccumulator(usageAccumulator, latestCallUsage);

    const fields = buildUsageAgentMetaFields({
      usageAccumulator,
      lastAssistantUsage: undefined,
      lastRunPromptUsage: latestCallUsage,
      lastTurnTotal: latestCallUsage.total,
    });

    expect(fields.usage).toMatchObject({
      input: 12,
      output: 15_104,
      cacheRead: 819_661,
      cacheWrite: 93_130,
      total: 927_907,
    });
    expect(fields.lastCallUsage).toEqual(latestCallUsage);
    expect(fields.promptTokens).toBe(148_874);
  });

  it("does not derive a prompt override from unavailable context usage", () => {
    const usageAccumulator = createUsageAccumulator();
    const latestCallUsage = {
      input: 12,
      output: 15_104,
      cacheRead: 819_661,
      cacheWrite: 93_130,
      contextUsage: { state: "unavailable" },
      total: 927_907,
    } satisfies NormalizedUsage;
    mergeUsageIntoAccumulator(usageAccumulator, latestCallUsage);

    const fields = buildUsageAgentMetaFields({
      usageAccumulator,
      lastAssistantUsage: latestCallUsage,
      lastRunPromptUsage: latestCallUsage,
      lastTurnTotal: latestCallUsage.total,
    });

    expect(fields.lastCallUsage).toEqual(latestCallUsage);
    expect(fields.promptTokens).toBeUndefined();
  });
});

describe("buildErrorAgentMeta", () => {
  it("preserves active session file for error exits after transcript rotation", () => {
    // Error metadata follows the active session after transcript rotation so
    // diagnostics and resume links point at the file that contains the failure.
    expect(
      buildErrorAgentMeta({
        sessionId: "session-rotated",
        sessionFile: "/tmp/session-rotated.jsonl",
        provider: "anthropic",
        model: "claude-opus-4-6",
        usageAccumulator: createUsageAccumulator(),
        lastRunPromptUsage: undefined,
      }),
    ).toMatchObject({
      sessionId: "session-rotated",
      sessionFile: "/tmp/session-rotated.jsonl",
    });
  });
});
