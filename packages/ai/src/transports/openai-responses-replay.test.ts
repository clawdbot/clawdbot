import type { Context, Model } from "@openclaw/llm-core";
import { describe, expect, it } from "vitest";
import {
  convertResponsesMessages,
  encodeTextSignatureV1,
} from "./openai-responses-replay-internal.js";
import { parseResponsesReasoningSignature } from "./openai-responses-replay.js";

const nativeOpenAIModel = {
  id: "gpt-5.5",
  name: "GPT-5.5",
  api: "openai-responses",
  provider: "openai",
  baseUrl: "https://api.openai.com/v1",
  reasoning: true,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 200000,
  maxTokens: 8192,
} satisfies Model;

const allowedToolCallProviders = new Set(["openai"]);

describe("parseResponsesReasoningSignature", () => {
  it("returns undefined for missing, non-JSON, and malformed signatures", () => {
    expect(parseResponsesReasoningSignature(undefined)).toBeUndefined();
    // Plain provenance tags written by openai-completions reasoning paths.
    expect(parseResponsesReasoningSignature("reasoning")).toBeUndefined();
    expect(parseResponsesReasoningSignature("reasoning_content")).toBeUndefined();
    // Truncated JSON from a corrupted session-history entry.
    expect(parseResponsesReasoningSignature('{"type":"reasoning","summary":[')).toBeUndefined();
    // Valid JSON that is not an object cannot be a reasoning item.
    expect(parseResponsesReasoningSignature('"{}"')).toBeUndefined();
  });

  it("parses a JSON-encoded reasoning item", () => {
    expect(
      parseResponsesReasoningSignature(
        JSON.stringify({ type: "reasoning", id: "rs_1", summary: [] }),
      ),
    ).toMatchObject({ type: "reasoning", id: "rs_1", summary: [] });
  });
});

describe("convertResponsesMessages reasoning replay", () => {
  const assistantWithSignature = (
    thinkingSignature: string,
    text: string,
  ): Context["messages"][number] => ({
    role: "assistant",
    api: nativeOpenAIModel.api,
    provider: nativeOpenAIModel.provider,
    model: nativeOpenAIModel.id,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: 1,
    content: [
      { type: "thinking", thinking: "hidden chain of thought", thinkingSignature },
      { type: "text", text, textSignature: encodeTextSignatureV1(`msg_${text}`) },
    ],
  });

  it("skips malformed thinking signatures as untrusted JSON during replay", () => {
    const input = convertResponsesMessages(
      nativeOpenAIModel,
      {
        systemPrompt: "system",
        messages: [
          assistantWithSignature("reasoning", "first"),
          { role: "user", content: "next", timestamp: 2 },
          assistantWithSignature('{"type":"reasoning","summary":[', "second"),
          { role: "user", content: "again", timestamp: 3 },
          assistantWithSignature(
            JSON.stringify({
              type: "reasoning",
              id: "rs_valid",
              summary: [],
              encrypted_content: "ciphertext",
            }),
            "third",
          ),
        ],
      } satisfies Context,
      allowedToolCallProviders,
      { includeSystemPrompt: false },
    ) as unknown as Array<Record<string, unknown>>;

    const reasoningItems = input.filter((item) => item.type === "reasoning");
    expect(reasoningItems).toHaveLength(1);
    expect(reasoningItems[0]).toMatchObject({
      type: "reasoning",
      id: "rs_valid",
    });
    // prepareOpenAIResponsesReasoningItemForReplay intentionally strips
    // encrypted_content when no matching replay metadata is present.
    expect(reasoningItems[0]).not.toHaveProperty("encrypted_content");

    const assistantTexts = input.filter(
      (item) => item.type === "message" && item.role === "assistant",
    );
    expect(assistantTexts).toHaveLength(3);
    // A dropped reasoning item breaks the pairing for signed text ids.
    expect(assistantTexts[0]).not.toHaveProperty("id");
    expect(assistantTexts[1]).not.toHaveProperty("id");
    expect(assistantTexts[2]).toHaveProperty("id", "msg_third");
  });
});
