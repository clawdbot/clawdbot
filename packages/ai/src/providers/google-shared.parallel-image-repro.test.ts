import type { Part } from "@google/genai";
import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it } from "vitest";
import type { Context, Model } from "../types.js";
import { convertMessages } from "./google-shared.js";
import { makeGoogleAssistantMessage } from "./google-shared.test-helpers.js";

const convertMessagesForTest = convertMessages as unknown as (
  model: Model<"google-generative-ai">,
  context: Context,
) => ReturnType<typeof convertMessages>;

const makeVisionModel = (id: string): Model<"google-generative-ai"> =>
  ({
    id,
    name: id,
    api: "google-generative-ai",
    provider: "google",
    baseUrl: "https://example.invalid",
    reasoning: false,
    input: ["text", "image"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 1,
    maxTokens: 1,
  }) as Model<"google-generative-ai">;

function countFunctionResponses(parts: readonly Part[] | undefined): number {
  return (parts ?? []).filter((p) => p.functionResponse != null).length;
}

function functionResponseNames(parts: readonly Part[] | undefined): string[] {
  return (parts ?? []).flatMap((part) =>
    part.functionResponse?.name ? [part.functionResponse.name] : [],
  );
}

describe("google-shared convertMessages — parallel tool results with an image (Gemini < 3)", () => {
  it.each([
    ["bare Gemini 2.5 image first", "gemini-2.5-flash", ["screenshot", "weather"]],
    ["bare Gemini 2.5 image last", "gemini-2.5-flash", ["weather", "screenshot"]],
    [
      "provider-prefixed Gemini 2.5 image first",
      "google/gemini-2.5-pro",
      ["screenshot", "weather"],
    ],
    ["models-prefixed Gemini 2.5 image last", "models/gemini-2.5-pro", ["weather", "screenshot"]],
  ] as const)(
    "keeps the response run immediate and retains a deferred result for %s",
    (_label, modelId, resultOrder) => {
      const model = makeVisionModel(modelId);
      const toolResults = {
        screenshot: {
          role: "toolResult",
          toolCallId: "call_1",
          toolName: "screenshot",
          content: [{ type: "image", mimeType: "image/png", data: "AAAA" }],
          isError: false,
          timestamp: 0,
        },
        weather: {
          role: "toolResult",
          toolCallId: "call_2",
          toolName: "weather",
          content: [{ type: "text", text: "Sunny, 21C" }],
          isError: false,
          timestamp: 0,
        },
      } as const;
      const context = {
        messages: [
          { role: "user", content: "Screenshot the page and check the weather." },
          makeGoogleAssistantMessage(model.id, [
            { type: "toolCall", id: "call_1", name: "screenshot", arguments: {} },
            { type: "toolCall", id: "call_2", name: "weather", arguments: {} },
          ]),
          ...resultOrder.map((name) => toolResults[name]),
        ],
      } as unknown as Context;

      const contents = convertMessagesForTest(model, context);

      expect(contents.map((content) => content.role)).toEqual(["user", "model", "user", "user"]);
      expect(
        functionResponseNames(expectDefined(contents[2], "contents[2] test invariant").parts),
      ).toEqual(resultOrder);
      expect(contents[3]).toEqual({
        role: "user",
        parts: [
          { text: "Tool result image:" },
          { inlineData: { mimeType: "image/png", data: "AAAA" } },
        ],
      });
      expect(contents.slice(3).some((c) => countFunctionResponses(c.parts) > 0)).toBe(false);
    },
  );

  it.each(["google/gemini-3.1-pro-preview", "models/gemini-3.1-pro-preview"])(
    "keeps image parts inside function responses for prefixed Gemini 3 model %s",
    (modelId) => {
      const model = makeVisionModel(modelId);
      const contents = convertMessagesForTest(model, {
        messages: [
          { role: "user", content: "Take a screenshot." },
          makeGoogleAssistantMessage(model.id, [
            { type: "toolCall", id: "call_1", name: "screenshot", arguments: {} },
          ]),
          {
            role: "toolResult",
            toolCallId: "call_1",
            toolName: "screenshot",
            content: [{ type: "image", mimeType: "image/png", data: "AAAA" }],
            isError: false,
            timestamp: 0,
          },
        ],
      } as unknown as Context);

      expect(contents.map((content) => content.role)).toEqual(["user", "model", "user"]);
      expect(contents[2]?.parts?.[0]?.functionResponse?.parts).toEqual([
        { inlineData: { mimeType: "image/png", data: "AAAA" } },
      ]);
    },
  );
});
