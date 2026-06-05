// Google shared provider tests cover response conversion and finish reasons.
import { FinishReason, type GenerateContentResponse } from "@google/genai";
import { describe, expect, it } from "vitest";
import type { AssistantMessage, Model } from "../types.js";
import { AssistantMessageEventStream } from "../utils/event-stream.js";
import {
  buildGoogleGenerateContentParams,
  consumeGoogleGenerateContentStream,
} from "./google-shared.js";

const model: Model<"google-generative-ai"> = {
  id: "gemini-test",
  name: "Gemini Test",
  api: "google-generative-ai",
  provider: "google",
  baseUrl: "",
  reasoning: true,
  input: ["text"],
  cost: {
    input: 1,
    output: 2,
    cacheRead: 0.25,
    cacheWrite: 0,
  },
  contextWindow: 128_000,
  maxTokens: 8_192,
};

function createOutput(): AssistantMessage {
  return {
    role: "assistant",
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        total: 0,
      },
    },
    stopReason: "stop",
    timestamp: 0,
  };
}

async function* chunks(items: GenerateContentResponse[]) {
  yield* items;
}

describe("consumeGoogleGenerateContentStream", () => {
  it("projects text, thinking, tool calls, response id, and usage into one stream", async () => {
    const output = createOutput();
    const stream = new AssistantMessageEventStream();
    const events: string[] = [];
    const collect = (async () => {
      for await (const event of stream) {
        events.push(event.type);
      }
    })();

    await consumeGoogleGenerateContentStream({
      chunks: chunks([
        {
          responseId: "response-1",
          candidates: [
            {
              content: {
                parts: [
                  { text: "thinking", thought: true, thoughtSignature: "dGhpbms=" },
                  { text: "hello" },
                  { functionCall: { name: "lookup", args: { query: "cats" } } },
                ],
              },
            },
          ],
        } as GenerateContentResponse,
        {
          candidates: [{ finishReason: FinishReason.STOP }],
          usageMetadata: {
            promptTokenCount: 10,
            cachedContentTokenCount: 2,
            candidatesTokenCount: 3,
            thoughtsTokenCount: 4,
            totalTokenCount: 17,
          },
        } as GenerateContentResponse,
      ]),
      model,
      output,
      stream,
      nextToolCallId: (name) => `generated-${name}`,
    });
    await collect;

    expect(events).toEqual([
      "start",
      "thinking_start",
      "thinking_delta",
      "thinking_end",
      "text_start",
      "text_delta",
      "text_end",
      "toolcall_start",
      "toolcall_delta",
      "toolcall_end",
      "done",
    ]);
    expect(output.responseId).toBe("response-1");
    expect(output.stopReason).toBe("toolUse");
    expect(output.content).toEqual([
      { type: "thinking", thinking: "thinking", thinkingSignature: "dGhpbms=" },
      { type: "text", text: "hello" },
      {
        type: "toolCall",
        id: "generated-lookup",
        name: "lookup",
        arguments: { query: "cats" },
      },
    ]);
    expect(output.usage).toMatchObject({
      input: 8,
      output: 7,
      cacheRead: 2,
      totalTokens: 17,
    });
    expect(output.usage.cost.total).toBeGreaterThan(0);
  });
});

describe("buildGoogleGenerateContentParams", () => {
  it("forwards stop sequences to Google generation config", () => {
    const params = buildGoogleGenerateContentParams(
      model,
      { messages: [{ role: "user", content: "hello", timestamp: 0 }] },
      { stop: ["STOP"] },
    );

    expect(params.config?.stopSequences).toEqual(["STOP"]);
  });
});
