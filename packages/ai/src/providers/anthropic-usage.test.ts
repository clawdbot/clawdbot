import { describe, expect, it } from "vitest";
import {
  readAnthropicCacheWriteUsage,
  readLastAnthropicIterationUsage,
} from "./anthropic-usage.js";

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
