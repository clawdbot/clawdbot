// Stream message tests lock down the sanitized assistant message emitted when a
// provider stream fails mid-response.
import { describe, expect, it } from "vitest";
import {
  STREAM_ERROR_FALLBACK_TEXT,
  buildStreamErrorAssistantMessage,
  buildUsageWithNoCost,
} from "./stream-message-shared.js";

const model = {
  api: "bedrock-converse-stream",
  provider: "amazon-bedrock",
  id: "anthropic.claude-3-haiku-20240307-v1:0",
};

describe("buildStreamErrorAssistantMessage", () => {
  it("never returns an empty content array", () => {
    const message = buildStreamErrorAssistantMessage({
      model,
      errorMessage: "stream aborted by upstream host=internal.example.com",
    });
    expect(message.content).toStrictEqual([{ type: "text", text: STREAM_ERROR_FALLBACK_TEXT }]);
  });

  it("places only the sentinel in content and never echoes the raw error text", () => {
    const message = buildStreamErrorAssistantMessage({
      model,
      errorMessage: "stream aborted by upstream host=internal.example.com",
    });
    // Replay-visible content must be the canonical sentinel — replaying raw
    // provider error strings could leak hostnames/metadata to the model and
    // turn them into a prompt-injection surface.
    expect(message.content).toEqual([{ type: "text", text: STREAM_ERROR_FALLBACK_TEXT }]);
    expect(JSON.stringify(message.content)).not.toContain("internal.example.com");
    // The detailed error remains available in the peer field for clients/UIs.
    expect(message.errorMessage).toBe("stream aborted by upstream host=internal.example.com");
    expect(message.stopReason).toBe("error");
  });

  it("uses the same sentinel when errorMessage is blank", () => {
    const message = buildStreamErrorAssistantMessage({ model, errorMessage: "   " });
    expect(message.content).toEqual([{ type: "text", text: STREAM_ERROR_FALLBACK_TEXT }]);
    // Original errorMessage is preserved verbatim for clients that surface it.
    expect(message.errorMessage).toBe("   ");
  });
});

describe("buildUsageWithNoCost", () => {
  it("synthesizes a cache-inclusive total when no upstream aggregate is present", () => {
    // Claude CLI transcripts carry input/output/cache buckets without a total_tokens
    // aggregate. The persisted total must cover cacheRead/cacheWrite so context
    // accounting sees the real context instead of input + output (issue #117470).
    const usage = buildUsageWithNoCost({
      input: 2,
      output: 1,
      cacheRead: 133_495,
      cacheWrite: 1_432,
    });
    expect(usage.totalTokens).toBe(134_930);
    expect(usage.input).toBe(2);
    expect(usage.output).toBe(1);
    expect(usage.cacheRead).toBe(133_495);
    expect(usage.cacheWrite).toBe(1_432);
  });

  it("does not count cached OpenAI input twice after provider normalization", () => {
    // OpenAI reports cached input inside input_tokens; CLI normalization already
    // splits 15 input tokens into 9 uncached and 6 cached before this owner.
    expect(buildUsageWithNoCost({ input: 9, output: 4, cacheRead: 6 }).totalTokens).toBe(19);
  });

  it("counts normalized Codex cache reads and writes only once", () => {
    const usage = buildUsageWithNoCost({ input: 0, output: 10, cacheRead: 40, cacheWrite: 60 });

    expect(usage.totalTokens).toBe(110);
  });

  it("keeps the explicit aggregate total when one is provided", () => {
    const usage = buildUsageWithNoCost({
      input: 2,
      output: 1,
      cacheRead: 133_495,
      cacheWrite: 1_432,
      totalTokens: 158_719,
    });
    expect(usage.totalTokens).toBe(158_719);
  });

  it("keeps a zero-cost empty usage record unchanged", () => {
    const usage = buildUsageWithNoCost({});
    expect(usage.totalTokens).toBe(0);
    expect(usage.cost).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 });
  });
});
