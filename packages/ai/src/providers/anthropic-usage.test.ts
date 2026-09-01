import { describe, expect, it } from "vitest";
import {
  applyAnthropicMessageDeltaUsage,
  readAnthropicCacheWriteUsage,
  readLastAnthropicIterationUsage,
} from "./anthropic-usage.js";

function emptyUsage() {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
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

describe("applyAnthropicMessageDeltaUsage", () => {
  it("sums compaction and message iterations for billed usage", () => {
    const usage = emptyUsage();

    applyAnthropicMessageDeltaUsage(
      usage,
      {
        input_tokens: 5,
        output_tokens: 7,
        cache_read_input_tokens: 11,
        cache_creation_input_tokens: 13,
        iterations: [
          {
            type: "compaction",
            input_tokens: 17,
            output_tokens: 19,
            cache_read_input_tokens: 23,
            cache_creation_input_tokens: 29,
          },
          {
            type: "message",
            input_tokens: 31,
            output_tokens: 37,
            cache_read_input_tokens: 41,
            cache_creation_input_tokens: 43,
          },
        ],
      },
      undefined,
    );

    expect(usage).toMatchObject({
      input: 48,
      output: 56,
      cacheRead: 64,
      cacheWrite: 72,
      totalTokens: 240,
      contextUsage: { state: "available", promptTokens: 115, totalTokens: 152 },
    });
  });

  it("keeps top-level billing when compaction iterations are malformed", () => {
    const usage = emptyUsage();

    applyAnthropicMessageDeltaUsage(
      usage,
      {
        input_tokens: 5,
        output_tokens: 7,
        cache_read_input_tokens: 11,
        cache_creation_input_tokens: 13,
        iterations: [
          {
            type: "compaction",
            input_tokens: "invalid",
            output_tokens: 19,
            cache_read_input_tokens: 23,
            cache_creation_input_tokens: 29,
          },
        ],
      },
      undefined,
    );

    expect(usage).toMatchObject({
      input: 5,
      output: 7,
      cacheRead: 11,
      cacheWrite: 13,
      totalTokens: 36,
      contextUsage: { state: "unavailable" },
    });
  });
});
