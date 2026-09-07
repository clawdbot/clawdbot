import { describe, expect, it } from "vitest";
import { transformProviderMessages } from "../provider-transcript-transform.js";
import type { ProviderMessage, ProviderModel } from "../provider-types.js";
import type { Message, Model, ToolResultMessage } from "../types.js";
import { createZeroUsage } from "../usage.test-support.js";
import { transformMessages } from "./transform-messages.js";

const model: Model<"openai-completions"> = {
  id: "text-only-model",
  name: "Text-only model",
  api: "openai-completions",
  provider: "openai",
  baseUrl: "https://example.invalid/v1",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128_000,
  maxTokens: 4_096,
};

describe("transformMessages", () => {
  it("normalizes null or missing content before provider transforms", () => {
    const messages = [
      { role: "user", content: null, timestamp: 1 },
      {
        role: "assistant",
        content: null,
        api: model.api,
        provider: model.provider,
        model: model.id,
        usage: createZeroUsage(),
        stopReason: "stop",
        timestamp: 2,
      },
      {
        role: "toolResult",
        toolCallId: "call_1",
        toolName: "lookup",
        isError: false,
        timestamp: 3,
      },
    ] as unknown as ProviderMessage[];

    const transformed = transformProviderMessages(messages, model);

    expect(transformed.map((message) => message.content)).toEqual([[], [], []]);
  });

  it("replaces unsupported user media in order without exposing video bytes", () => {
    const sentinel = "video-secret-sentinel";
    const messages = [
      {
        role: "user",
        content: [
          { type: "text", text: "before" },
          { type: "image", data: "image-one", mimeType: "image/png" },
          { type: "video", data: sentinel, mimeType: "video/mp4" },
          { type: "text", text: "after" },
          { type: "image", data: "image-two", mimeType: "image/jpeg" },
        ],
        timestamp: 1,
      },
    ] satisfies ProviderMessage[];

    const transformed = transformProviderMessages(messages, model);

    expect(transformed[0]?.content).toEqual([
      { type: "text", text: "before" },
      { type: "text", text: "(image omitted: model does not support images)" },
      { type: "text", text: "(video omitted: provider does not support video input)" },
      { type: "text", text: "after" },
      { type: "text", text: "(image omitted: model does not support images)" },
    ]);
    expect(JSON.stringify(transformed)).not.toContain(sentinel);

    const advertisedVideoModel: ProviderModel<"openai-completions"> = {
      ...model,
      input: ["text", "image", "video"],
    };
    const advertised = transformProviderMessages(messages, advertisedVideoModel);
    expect(advertised[0]?.content).toEqual([
      { type: "text", text: "before" },
      { type: "image", data: "image-one", mimeType: "image/png" },
      { type: "video", data: sentinel, mimeType: "video/mp4" },
      { type: "text", text: "after" },
      { type: "image", data: "image-two", mimeType: "image/jpeg" },
    ]);

    const responsesModel = {
      ...advertisedVideoModel,
      api: "openai-responses" as const,
    } as ProviderModel<"openai-responses">;
    const responses = transformProviderMessages(messages, responsesModel);
    expect(responses[0]?.content).toContainEqual({
      type: "text",
      text: "(video omitted: provider does not support video input)",
    });
    expect(JSON.stringify(responses)).not.toContain(sentinel);
  });

  it("preserves structured tool blocks while projecting only real images", () => {
    const resource = { type: "resource", uri: "file:///tmp/result.json" };
    const metadata = { type: "metadata", value: { count: 2 } };
    const content = [
      resource,
      { type: "image", data: "image-one", mimeType: "image/png" },
      { type: "image", data: "", mimeType: "image/png" },
      { type: "image", data: "image-two", mimeType: "image/jpeg" },
      metadata,
      { type: "image", data: "image-three", mimeType: "image/webp" },
    ] as unknown as ToolResultMessage["content"];
    const messages: Message[] = [
      {
        role: "toolResult",
        toolCallId: "call_1",
        toolName: "lookup",
        content,
        isError: false,
        timestamp: 1,
      },
    ];

    const transformed = transformMessages(messages, model);
    const projected = (transformed[0] as ToolResultMessage).content;

    expect(projected).toEqual([
      resource,
      { type: "text", text: "(tool image omitted: model does not support images)" },
      metadata,
      { type: "text", text: "(tool image omitted: model does not support images)" },
    ]);
    expect(projected[0]).toBe(resource);
    expect(projected[2]).toBe(metadata);
  });

  it.each([
    ["synchronous call", false, " call_1 ", "call_1"],
    ["synchronous result", false, "call_1", " call_1 "],
    ["asynchronous call", true, " call_1 ", "call_1"],
    ["asynchronous result", true, "call_1", " call_1 "],
  ] as const)(
    "pairs padded %s ids without synthesizing an error",
    (_name, async, id, toolCallId) => {
      const assistant: Extract<Message, { role: "assistant" }> = {
        role: "assistant",
        content: [
          { type: "toolCall", id, name: "lookup", arguments: {}, ...(async ? { async } : {}) },
        ],
        api: model.api,
        provider: model.provider,
        model: async ? "source-model" : model.id,
        usage: createZeroUsage(),
        stopReason: "toolUse",
        timestamp: 1,
      };
      const messages: Message[] = [
        assistant,
        ...(async
          ? [{ ...assistant, content: [{ type: "text" as const, text: "later answer" }] }]
          : []),
        {
          role: "toolResult",
          toolCallId,
          toolName: "lookup",
          content: [{ type: "text", text: "actual result" }],
          isError: false,
          timestamp: 2,
        },
      ];
      const original = structuredClone(messages);

      const transformed = transformMessages(messages, model);

      expect(transformed.map((message) => message.role)).toEqual([
        "assistant",
        "toolResult",
        ...(async ? ["assistant"] : []),
      ]);
      expect(transformed[0]?.content).toEqual([
        { type: "toolCall", id: "call_1", name: "lookup", arguments: {} },
      ]);
      expect(transformed[1]).toMatchObject({
        role: "toolResult",
        toolCallId: "call_1",
        isError: false,
        content: [{ type: "text", text: "actual result" }],
      });
      expect(messages).toEqual(original);
    },
  );
});
