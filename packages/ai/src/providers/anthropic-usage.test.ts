import { describe, expect, it } from "vitest";
import type { Usage } from "../types.js";
import {
  applyAnthropicMessageDeltaUsage,
  applyAnthropicMessageStartUsage,
  readAnthropicCacheWriteUsage,
  readLastAnthropicIterationUsage,
} from "./anthropic-usage.js";

function makeUsage(): Usage {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    tokenCountsOrigin: "runtime-placeholder",
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

describe("readAnthropicCacheWriteUsage", () => {
  it("reads independent 5-minute and 1-hour cache-write buckets", () => {
    expect(
      readAnthropicCacheWriteUsage({
        cache_creation: {
          ephemeral_5m_input_tokens: 600_000,
          ephemeral_1h_input_tokens: 400_000,
        },
      }),
    ).toEqual({ cacheWrite5m: 600_000, cacheWrite1h: 400_000 });
  });

  it("keeps a valid bucket when its sibling is absent or malformed", () => {
    expect(
      readAnthropicCacheWriteUsage({
        cache_creation: {
          ephemeral_5m_input_tokens: "malformed",
          ephemeral_1h_input_tokens: 12,
        },
      }),
    ).toEqual({ cacheWrite1h: 12 });
    expect(readAnthropicCacheWriteUsage({})).toEqual({});
  });
});

describe("readLastAnthropicIterationUsage", () => {
  it.each(["message", "compaction", "advisor_message"])(
    "reads the final %s iteration as the context snapshot",
    (type) => {
      expect(
        readLastAnthropicIterationUsage({
          iterations: [
            {
              type: "message",
              input_tokens: 1,
              output_tokens: 2,
              cache_read_input_tokens: 3,
              cache_creation_input_tokens: 4,
            },
            {
              type,
              input_tokens: 12,
              output_tokens: 15_104,
              cache_read_input_tokens: 148_862,
              cache_creation_input_tokens: 0,
            },
          ],
        }),
      ).toEqual({
        state: "valid",
        usage: {
          contextPromptTokens: 148_874,
          totalTokens: 163_978,
        },
      });
    },
  );

  it("reports absent iterations separately from malformed iterations", () => {
    expect(readLastAnthropicIterationUsage({ input_tokens: 1 })).toEqual({ state: "absent" });
  });

  it("does not reuse an earlier iteration when the final iteration is malformed", () => {
    expect(
      readLastAnthropicIterationUsage({
        iterations: [
          {
            type: "message",
            input_tokens: 12,
            output_tokens: 15_104,
            cache_read_input_tokens: 148_862,
            cache_creation_input_tokens: 0,
          },
          {
            type: "message",
            input_tokens: "malformed",
            output_tokens: 1,
            cache_read_input_tokens: 0,
            cache_creation_input_tokens: 0,
          },
        ],
      }),
    ).toEqual({ state: "invalid" });
  });

  it("rejects a final iteration with incomplete cache usage", () => {
    expect(
      readLastAnthropicIterationUsage({
        iterations: [
          {
            type: "message",
            input_tokens: 12,
            output_tokens: 15_104,
          },
        ],
      }),
    ).toEqual({ state: "invalid" });
  });
});

describe("Anthropic usage projection", () => {
  it("keeps message-start output provisional and omits terminal reasoning", () => {
    const usage = makeUsage();

    const promptUsage = applyAnthropicMessageStartUsage(usage, {
      input_tokens: 12,
      output_tokens: 5,
      cache_read_input_tokens: 3,
      cache_creation_input_tokens: 4,
      output_tokens_details: { thinking_tokens: 2 },
    });

    expect(promptUsage).toEqual({ input: 12, cacheRead: 3, cacheWrite: 4 });
    expect(usage).toMatchObject({
      input: 12,
      output: 5,
      cacheRead: 3,
      cacheWrite: 4,
      tokenCountsObserved: ["input", "cacheRead", "cacheWrite"],
      totalTokens: 24,
    });
    expect(usage).not.toHaveProperty("tokenCountsOrigin");
    expect(usage).not.toHaveProperty("reasoningTokens");
    expect(usage).not.toHaveProperty("contextUsage");
  });

  it("does not make explicit message-start zero output terminally authoritative", () => {
    const usage = makeUsage();

    applyAnthropicMessageStartUsage(usage, {
      input_tokens: 0,
      output_tokens: 0,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
      output_tokens_details: { thinking_tokens: 0 },
    });

    expect(usage).toMatchObject({
      tokenCountsObserved: ["input", "cacheRead", "cacheWrite"],
      totalTokens: 0,
    });
    expect(usage).not.toHaveProperty("reasoningTokens");
  });

  it("keeps null Anthropic cache fields ambiguous", () => {
    const usage = makeUsage();

    const promptUsage = applyAnthropicMessageStartUsage(usage, {
      input_tokens: 12,
      output_tokens: 0,
      cache_read_input_tokens: null,
      cache_creation_input_tokens: null,
      output_tokens_details: null,
    });

    expect(promptUsage).toBeUndefined();
    expect(usage).toMatchObject({
      input: 12,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      tokenCountsObserved: ["input"],
      totalTokens: 12,
    });
    expect(usage).not.toHaveProperty("reasoningTokens");
  });

  it("keeps omitted Anthropic cache fields ambiguous", () => {
    const usage = makeUsage();

    const promptUsage = applyAnthropicMessageStartUsage(usage, {
      input_tokens: 12,
      output_tokens: 0,
    });

    expect(promptUsage).toBeUndefined();
    expect(usage).toMatchObject({
      input: 12,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      tokenCountsObserved: ["input"],
      totalTokens: 12,
    });
  });

  it("preserves message-start facts across a sparse message delta", () => {
    const usage = makeUsage();
    const promptUsage = applyAnthropicMessageStartUsage(usage, {
      input_tokens: 12,
      output_tokens: 0,
      cache_read_input_tokens: 3,
      cache_creation_input_tokens: 4,
      output_tokens_details: { thinking_tokens: 0 },
    });

    applyAnthropicMessageDeltaUsage(
      usage,
      {
        output_tokens: 9,
        cache_read_input_tokens: null,
        cache_creation_input_tokens: null,
        output_tokens_details: null,
      },
      promptUsage,
    );

    expect(usage).toMatchObject({
      input: 12,
      output: 9,
      cacheRead: 3,
      cacheWrite: 4,
      tokenCountsObserved: ["input", "output", "cacheRead", "cacheWrite", "total"],
      totalTokens: 28,
      contextUsage: { state: "available", promptTokens: 19, totalTokens: 28 },
    });
  });

  it("keeps failed or malformed terminal usage partial after message-start", () => {
    for (const payload of [undefined, { output_tokens: "malformed" }] as const) {
      const usage = makeUsage();
      const promptUsage = applyAnthropicMessageStartUsage(usage, {
        input_tokens: 12,
        output_tokens: 0,
        cache_read_input_tokens: 3,
        cache_creation_input_tokens: 4,
        output_tokens_details: { thinking_tokens: 0 },
      });

      applyAnthropicMessageDeltaUsage(usage, payload, promptUsage);

      expect(usage).toMatchObject({
        input: 12,
        output: 0,
        cacheRead: 3,
        cacheWrite: 4,
        tokenCountsObserved: ["input", "cacheRead", "cacheWrite"],
        totalTokens: 19,
        contextUsage: { state: "unavailable" },
      });
    }
  });

  it("makes terminal zero output and reasoning authoritative", () => {
    const usage = makeUsage();
    const promptUsage = applyAnthropicMessageStartUsage(usage, {
      input_tokens: 0,
      output_tokens: 0,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
      output_tokens_details: { thinking_tokens: 0 },
    });

    applyAnthropicMessageDeltaUsage(
      usage,
      {
        output_tokens: 0,
        output_tokens_details: { thinking_tokens: 0 },
      },
      promptUsage,
    );

    expect(usage).toMatchObject({
      reasoningTokens: 0,
      tokenCountsObserved: [
        "input",
        "output",
        "cacheRead",
        "cacheWrite",
        "reasoningTokens",
        "total",
      ],
      totalTokens: 0,
      contextUsage: { state: "available", promptTokens: 0, totalTokens: 0 },
    });
  });

  it("revokes authority for decreasing cumulative Anthropic counts", () => {
    const usage = makeUsage();
    const promptUsage = applyAnthropicMessageStartUsage(usage, {
      input_tokens: 12,
      output_tokens: 2,
      cache_read_input_tokens: 3,
      cache_creation_input_tokens: 4,
    });

    applyAnthropicMessageDeltaUsage(
      usage,
      {
        input_tokens: 11,
        output_tokens: 1,
        cache_read_input_tokens: 2,
        cache_creation_input_tokens: 3,
      },
      promptUsage,
    );

    expect(usage).toMatchObject({
      input: 12,
      output: 2,
      cacheRead: 3,
      cacheWrite: 4,
      tokenCountsObserved: [],
      totalTokens: 21,
      contextUsage: { state: "unavailable" },
    });
  });

  it("rejects Anthropic reasoning that exceeds terminal output", () => {
    const usage = makeUsage();
    const promptUsage = applyAnthropicMessageStartUsage(usage, {
      input_tokens: 12,
      output_tokens: 0,
      cache_read_input_tokens: 3,
      cache_creation_input_tokens: 4,
    });

    applyAnthropicMessageDeltaUsage(
      usage,
      {
        output_tokens: 5,
        output_tokens_details: { thinking_tokens: 6 },
      },
      promptUsage,
    );

    expect(usage).toMatchObject({
      output: 5,
      tokenCountsObserved: ["input", "output", "cacheRead", "cacheWrite", "total"],
      totalTokens: 24,
    });
    expect(usage).not.toHaveProperty("reasoningTokens");
  });

  it("retains runtime-placeholder provenance when no Anthropic counts are authoritative", () => {
    const usage = makeUsage();

    applyAnthropicMessageDeltaUsage(usage, undefined, undefined);

    expect(usage).toMatchObject({
      tokenCountsOrigin: "runtime-placeholder",
      totalTokens: 0,
      contextUsage: { state: "unavailable" },
    });
    expect(usage).not.toHaveProperty("tokenCountsObserved");
  });
});
