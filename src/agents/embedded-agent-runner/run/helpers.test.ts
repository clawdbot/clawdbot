// Embedded run helper tests cover final assistant text extraction and error
// metadata assembly shared by normal exits and failure paths.
import type { AssistantMessage } from "openclaw/plugin-sdk/llm";
import { describe, expect, it, vi } from "vitest";
import { resolveRetryAfterMs } from "../../failover/retry-evidence.js";
import { createZeroUsageFixture } from "../../test-helpers/usage-fixtures.js";
import type { NormalizedUsage } from "../../usage.js";
import { createUsageAccumulator, mergeUsageIntoAccumulator } from "../usage-accumulator.js";
import {
  buildUsageAgentMetaFields,
  buildErrorAgentMeta,
  resolveEmbeddedAttemptBasePrompt,
  resolveFinalAssistantRawText,
  resolveFinalAssistantVisibleText,
  resolveLatestCallUsage,
  MAX_TRANSIENT_RETRIES,
  resolveTransientRetryDelayMs,
} from "./helpers.js";

describe("resolveEmbeddedAttemptBasePrompt", () => {
  const refusalTrigger = "ANTHROPIC_MAGIC_STRING_TRIGGER_REFUSAL";

  it.each([
    { prompt: refusalTrigger, expected: "[redacted]" },
    {
      prompt: `Reply ok. Test trigger: ${refusalTrigger}_nonce-a and ${refusalTrigger}_nonce-b`,
      expected: "Reply ok. Test trigger: [redacted]_nonce-a and [redacted]_nonce-b",
    },
  ])(
    "neutralizes every refusal marker while preserving surrounding text",
    ({ prompt, expected }) => {
      expect(resolveEmbeddedAttemptBasePrompt({ provider: "anthropic", prompt })).toBe(expected);
    },
  );

  it("keeps non-Anthropic prompts byte-for-byte", () => {
    expect(
      resolveEmbeddedAttemptBasePrompt({
        provider: "openai",
        prompt: refusalTrigger,
      }),
    ).toBe(refusalTrigger);
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
    usage: createZeroUsageFixture(),
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

describe("resolveTransientRetryDelayMs", () => {
  it("starts quickly and slows down without exceeding the retry window", () => {
    const random = vi.spyOn(Math, "random").mockReturnValue(0);
    try {
      let elapsedMs = 0;
      const delays = Array.from({ length: MAX_TRANSIENT_RETRIES }, (_, index) => {
        const delay = resolveTransientRetryDelayMs({ retryNumber: index + 1, elapsedMs });
        elapsedMs += delay ?? 0;
        return delay;
      });
      expect(delays).toEqual([500, 1_000, 2_000, 4_000, 8_000, 15_000, 15_000, 15_000]);
      expect(elapsedMs).toBeLessThanOrEqual(90_000);
    } finally {
      random.mockRestore();
    }
  });

  it("honors Retry-After and rejects a delay beyond the total ceiling", () => {
    expect(
      resolveTransientRetryDelayMs({ retryNumber: 1, retryAfterMs: 30_000, elapsedMs: 0 }),
    ).toBeGreaterThanOrEqual(30_000);
    expect(
      resolveTransientRetryDelayMs({
        retryNumber: 3,
        retryAfterMs: 2_000,
        // 1s of the 90s transient retry budget left; retryAfterMs exceeds it.
        elapsedMs: 89_000,
      }),
    ).toBeUndefined();
  });

  it("keeps jitter below the per-retry cap", () => {
    const random = vi.spyOn(Math, "random").mockReturnValue(0.999);
    try {
      expect(resolveTransientRetryDelayMs({ retryNumber: 3, elapsedMs: 0 })).toBeLessThanOrEqual(
        30_000,
      );
    } finally {
      random.mockRestore();
    }
  });

  it("parses Retry-After HTTP dates for the shared retry owner", () => {
    expect(
      resolveRetryAfterMs(
        "HTTP 503: temporary failure; Retry-After: Thu, 01 Jan 2026 00:01:30 GMT",
        Date.parse("2026-01-01T00:00:00.000Z"),
      ),
    ).toBe(90_000);
  });
});

describe("resolveLatestCallUsage", () => {
  it("preserves the previous exact call across a zero-usage retry", () => {
    const previous = { input: 12, output: 3, total: 15 };

    expect(
      resolveLatestCallUsage({
        currentAttemptCandidates: [{ input: 0, output: 0, total: 0 }, undefined],
        carriedUsage: previous,
        transcriptFallback: undefined,
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
        carriedUsage: { input: 12, output: 3, total: 15 },
        transcriptFallback: undefined,
      }),
    ).toEqual({
      currentAttempt: latest,
      latest,
    });
  });

  it("keeps carried attempt usage ahead of an older transcript fallback", () => {
    const carried = { input: 20, output: 4, total: 24 };

    expect(
      resolveLatestCallUsage({
        currentAttemptCandidates: [],
        carriedUsage: carried,
        transcriptFallback: { contextUsage: { state: "unavailable" } },
      }),
    ).toEqual({
      currentAttempt: undefined,
      latest: carried,
    });
  });
});

describe("buildUsageAgentMetaFields", () => {
  it("selects unavailable current-attempt usage over older prompt usage", () => {
    const fields = buildUsageAgentMetaFields({
      usageAccumulator: createUsageAccumulator(),
      latestUsage: { contextUsage: { state: "unavailable" } },
      lastRunPromptUsage: { input: 42_000, output: 1_000, total: 43_000 },
    });

    expect(fields.lastCallUsage).toEqual({ contextUsage: { state: "unavailable" } });
    expect(fields.promptTokens).toBeUndefined();
  });

  it("keeps cumulative usage separate from the latest context snapshot", () => {
    const usageAccumulator = createUsageAccumulator();
    mergeUsageIntoAccumulator(usageAccumulator, {
      input: 100,
      output: 50,
      total: 150,
    });
    const latestCallUsage = {
      input: 80,
      output: 20,
      cacheRead: 100,
      contextUsage: {
        state: "available",
        promptTokens: 180,
        totalTokens: 200,
      },
      total: 200,
    } satisfies NormalizedUsage;
    mergeUsageIntoAccumulator(usageAccumulator, latestCallUsage);

    const fields = buildUsageAgentMetaFields({
      usageAccumulator,
      latestUsage: undefined,
      lastRunPromptUsage: latestCallUsage,
    });

    expect(fields.usage).toMatchObject({
      input: 180,
      output: 70,
      cacheRead: 100,
      total: 350,
    });
    expect(fields.lastCallUsage).toEqual(latestCallUsage);
    expect(fields.promptTokens).toBe(180);
  });

  it("keeps cumulative usage and the latest call distinct across a zero-usage retry", () => {
    const usageAccumulator = createUsageAccumulator();
    mergeUsageIntoAccumulator(usageAccumulator, {
      input: 100,
      output: 50,
      total: 150,
    });
    const latestCallUsage = {
      input: 150,
      output: 50,
      total: 200,
    } satisfies NormalizedUsage;
    mergeUsageIntoAccumulator(usageAccumulator, latestCallUsage);

    const fields = buildUsageAgentMetaFields({
      usageAccumulator,
      latestUsage: { input: 0, output: 0, total: 0 },
      lastRunPromptUsage: latestCallUsage,
    });

    expect(fields.usage).toMatchObject({
      input: 250,
      output: 100,
      total: 350,
    });
    expect(fields.lastCallUsage).toEqual(latestCallUsage);
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
      latestUsage: latestCallUsage,
      lastRunPromptUsage: latestCallUsage,
    });

    expect(fields.lastCallUsage).toEqual(latestCallUsage);
    expect(fields.promptTokens).toBeUndefined();
  });

  it("does not label aggregate attempt usage as last-call usage", () => {
    const usageAccumulator = createUsageAccumulator();
    mergeUsageIntoAccumulator(usageAccumulator, {
      input: 497_720,
      output: 7_485,
      cacheRead: 1_323_520,
      total: 1_828_725,
    });

    const fields = buildUsageAgentMetaFields({
      usageAccumulator,
      latestUsage: { input: 0, output: 0, cacheRead: 0, total: 0 },
      lastRunPromptUsage: undefined,
    });

    expect(fields.usage?.input).toBe(497_720);
    expect(fields.lastCallUsage).toBeUndefined();
    expect(fields.promptTokens).toBeUndefined();
  });
});

describe("buildErrorAgentMeta", () => {
  it("does not promote current CLI usage without context provenance", () => {
    const fields = buildErrorAgentMeta({
      sessionId: "session-error",
      provider: "openai",
      model: "gpt-5.6-luna",
      usageAccumulator: createUsageAccumulator(),
      lastRunPromptUsage: { input: 42_000, output: 1_000, total: 43_000 },
      currentAttemptAssistant: {
        api: "cli",
        usage: { input: 128_814, output: 3_000, cacheRead: 992_953, totalTokens: 1_124_767 },
      },
    });

    expect(fields.lastCallUsage).toEqual({ contextUsage: { state: "unavailable" } });
    expect(fields.promptTokens).toBeUndefined();
  });

  it("keeps cumulative usage separate from the latest call on error exits", () => {
    const usageAccumulator = createUsageAccumulator();
    mergeUsageIntoAccumulator(usageAccumulator, {
      input: 100,
      output: 50,
      total: 150,
    });
    const latestCallUsage = {
      input: 150,
      output: 50,
      total: 200,
    } satisfies NormalizedUsage;
    mergeUsageIntoAccumulator(usageAccumulator, latestCallUsage);

    const fields = buildErrorAgentMeta({
      sessionId: "session-error",
      sessionFile: "/tmp/session-error.jsonl",
      provider: "anthropic",
      model: "claude-opus-4-6",
      usageAccumulator,
      lastRunPromptUsage: latestCallUsage,
      currentAttemptAssistant: { usage: latestCallUsage },
    });

    expect(fields.usage).toMatchObject({
      input: 250,
      output: 100,
      total: 350,
    });
    expect(fields.lastCallUsage).toEqual(latestCallUsage);
  });

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
