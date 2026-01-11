import {
  convertMessages,
  convertTools,
} from "@mariozechner/pi-ai/dist/providers/google-shared.js";
import type { Context, Model, Tool } from "@mariozechner/pi-ai/dist/types.js";
import { describe, expect, it } from "vitest";

const asRecord = (value: unknown): Record<string, unknown> => {
  expect(value).toBeTruthy();
  expect(typeof value).toBe("object");
  expect(Array.isArray(value)).toBe(false);
  return value as Record<string, unknown>;
};

const makeModel = (id: string): Model<"google-generative-ai"> =>
  ({
    id,
    name: id,
    api: "google-generative-ai",
    provider: "google",
    baseUrl: "https://example.invalid",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 1,
    maxTokens: 1,
  }) as Model<"google-generative-ai">;

describe("google-shared convertTools", () => {
  it("preserves parameters when type is missing", () => {
    const tools = [
      {
        name: "noType",
        description: "Tool with properties but no type",
        parameters: {
          properties: {
            action: { type: "string" },
          },
          required: ["action"],
        },
      },
    ] as unknown as Tool[];

    const converted = convertTools(tools);
    const params = asRecord(
      converted?.[0]?.functionDeclarations?.[0]?.parameters,
    );

    expect(params.type).toBeUndefined();
    expect(params.properties).toBeDefined();
    expect(params.required).toEqual(["action"]);
  });

  it("keeps unsupported JSON Schema keywords intact", () => {
    const tools = [
      {
        name: "example",
        description: "Example tool",
        parameters: {
          type: "object",
          patternProperties: {
            "^x-": { type: "string" },
          },
          additionalProperties: false,
          properties: {
            mode: {
              type: "string",
              const: "fast",
            },
            options: {
              anyOf: [{ type: "string" }, { type: "number" }],
            },
            list: {
              type: "array",
              items: {
                type: "string",
                const: "item",
              },
            },
          },
          required: ["mode"],
        },
      },
    ] as unknown as Tool[];

    const converted = convertTools(tools);
    const params = asRecord(
      converted?.[0]?.functionDeclarations?.[0]?.parameters,
    );
    const properties = asRecord(params.properties);
    const mode = asRecord(properties.mode);
    const options = asRecord(properties.options);
    const list = asRecord(properties.list);
    const items = asRecord(list.items);

    expect(params.patternProperties).toEqual({ "^x-": { type: "string" } });
    expect(params.additionalProperties).toBe(false);
    expect(mode.const).toBe("fast");
    expect(options.anyOf).toEqual([{ type: "string" }, { type: "number" }]);
    expect(items.const).toBe("item");
    expect(params.required).toEqual(["mode"]);
  });

  it("keeps supported schema fields", () => {
    const tools = [
      {
        name: "settings",
        description: "Settings tool",
        parameters: {
          type: "object",
          properties: {
            config: {
              type: "object",
              properties: {
                retries: { type: "number", minimum: 1 },
                tags: {
                  type: "array",
                  items: { type: "string" },
                },
              },
              required: ["retries"],
            },
          },
          required: ["config"],
        },
      },
    ] as unknown as Tool[];

    const converted = convertTools(tools);
    const params = asRecord(
      converted?.[0]?.functionDeclarations?.[0]?.parameters,
    );
    const config = asRecord(asRecord(params.properties).config);
    const configProps = asRecord(config.properties);
    const retries = asRecord(configProps.retries);
    const tags = asRecord(configProps.tags);
    const items = asRecord(tags.items);

    expect(params.type).toBe("object");
    expect(config.type).toBe("object");
    expect(retries.minimum).toBe(1);
    expect(tags.type).toBe("array");
    expect(items.type).toBe("string");
    expect(config.required).toEqual(["retries"]);
    expect(params.required).toEqual(["config"]);
  });
});

describe("google-shared convertMessages", () => {
  it("keeps thinking blocks when provider/model match", () => {
    const model = makeModel("gemini-1.5-pro");
    const context = {
      messages: [
        {
          role: "assistant",
          content: [
            {
              type: "thinking",
              thinking: "hidden",
              thinkingSignature: "sig",
            },
          ],
          api: "google-generative-ai",
          provider: "google",
          model: "gemini-1.5-pro",
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
        },
      ],
    } as unknown as Context;

    const contents = convertMessages(model, context);
    expect(contents).toHaveLength(1);
    expect(contents[0].role).toBe("model");
    expect(contents[0].parts?.[0]).toMatchObject({
      thought: true,
      thoughtSignature: "sig",
    });
  });

  it("keeps thought signatures for Claude models", () => {
    const model = makeModel("claude-3-opus");
    const context = {
      messages: [
        {
          role: "assistant",
          content: [
            {
              type: "thinking",
              thinking: "structured",
              thinkingSignature: "sig",
            },
          ],
          api: "google-generative-ai",
          provider: "google",
          model: "claude-3-opus",
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
        },
      ],
    } as unknown as Context;

    const contents = convertMessages(model, context);
    const parts = contents?.[0]?.parts ?? [];
    expect(parts).toHaveLength(1);
    expect(parts[0]).toMatchObject({
      thought: true,
      thoughtSignature: "sig",
    });
  });

  it("does not merge consecutive user messages for Gemini", () => {
    const model = makeModel("gemini-1.5-pro");
    const context = {
      messages: [
        {
          role: "user",
          content: "Hello",
        },
        {
          role: "user",
          content: "How are you?",
        },
      ],
    } as unknown as Context;

    const contents = convertMessages(model, context);
    expect(contents).toHaveLength(2);
    expect(contents[0].role).toBe("user");
    expect(contents[1].role).toBe("user");
    expect(contents[0].parts).toHaveLength(1);
    expect(contents[1].parts).toHaveLength(1);
  });

  it("does not merge consecutive user messages for non-Gemini Google models", () => {
    const model = makeModel("claude-3-opus");
    const context = {
      messages: [
        {
          role: "user",
          content: "First",
        },
        {
          role: "user",
          content: "Second",
        },
      ],
    } as unknown as Context;

    const contents = convertMessages(model, context);
    expect(contents).toHaveLength(2);
    expect(contents[0].role).toBe("user");
    expect(contents[1].role).toBe("user");
    expect(contents[0].parts).toHaveLength(1);
    expect(contents[1].parts).toHaveLength(1);
  });

  it("does not merge consecutive model messages for Gemini", () => {
    const model = makeModel("gemini-1.5-pro");
    const context = {
      messages: [
        {
          role: "user",
          content: "Hello",
        },
        {
          role: "assistant",
          content: [{ type: "text", text: "Hi there!" }],
          api: "google-generative-ai",
          provider: "google",
          model: "gemini-1.5-pro",
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
        },
        {
          role: "assistant",
          content: [{ type: "text", text: "How can I help?" }],
          api: "google-generative-ai",
          provider: "google",
          model: "gemini-1.5-pro",
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
        },
      ],
    } as unknown as Context;

    const contents = convertMessages(model, context);
    expect(contents).toHaveLength(3);
    expect(contents[0].role).toBe("user");
    expect(contents[1].role).toBe("model");
    expect(contents[2].role).toBe("model");
    expect(contents[1].parts).toHaveLength(1);
    expect(contents[2].parts).toHaveLength(1);
  });

  it("handles user message after tool result without model response in between", () => {
    const model = makeModel("gemini-1.5-pro");
    const context = {
      messages: [
        {
          role: "user",
          content: "Use a tool",
        },
        {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              id: "call_1",
              name: "myTool",
              arguments: { arg: "value" },
            },
          ],
          api: "google-generative-ai",
          provider: "google",
          model: "gemini-1.5-pro",
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
        },
        {
          role: "toolResult",
          toolCallId: "call_1",
          toolName: "myTool",
          content: [{ type: "text", text: "Tool result" }],
          isError: false,
          timestamp: 0,
        },
        {
          role: "user",
          content: "Now do something else",
        },
      ],
    } as unknown as Context;

    const contents = convertMessages(model, context);
    expect(contents).toHaveLength(4);
    expect(contents[0].role).toBe("user");
    expect(contents[1].role).toBe("model");
    expect(contents[2].role).toBe("user");
    expect(contents[3].role).toBe("user");
    const toolResponsePart = contents[2].parts?.find(
      (part) =>
        typeof part === "object" && part !== null && "functionResponse" in part,
    );
    const toolResponse = asRecord(toolResponsePart);
    expect(toolResponse.functionResponse).toBeTruthy();
    expect(contents[3].role).toBe("user");
  });

  it("ensures function call comes after user turn, not after model turn", () => {
    const model = makeModel("gemini-1.5-pro");
    const context = {
      messages: [
        {
          role: "user",
          content: "Hello",
        },
        {
          role: "assistant",
          content: [{ type: "text", text: "Hi!" }],
          api: "google-generative-ai",
          provider: "google",
          model: "gemini-1.5-pro",
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
        },
        {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              id: "call_1",
              name: "myTool",
              arguments: {},
            },
          ],
          api: "google-generative-ai",
          provider: "google",
          model: "gemini-1.5-pro",
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
        },
      ],
    } as unknown as Context;

    const contents = convertMessages(model, context);
    expect(contents).toHaveLength(3);
    expect(contents[0].role).toBe("user");
    expect(contents[1].role).toBe("model");
    expect(contents[2].role).toBe("model");
    const toolCallPart = contents[2].parts?.find(
      (part) =>
        typeof part === "object" && part !== null && "functionCall" in part,
    );
    const toolCall = asRecord(toolCallPart);
    expect(toolCall.functionCall).toBeTruthy();
  });
});
