// Google shared conversion tests cover runtime-to-Google payload conversion.

import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it } from "vitest";
import type { Context, Tool } from "../types.js";
import { convertMessages, convertTools } from "./google-shared.js";
import {
  assertRecord,
  expectConvertedRoles,
  getFirstToolParameters,
  makeGeminiCliAssistantMessage,
  makeGeminiCliModel,
  makeGoogleAssistantMessage,
  makeModel,
} from "./google-shared.test-helpers.js";

type GoogleSharedTestModel = ReturnType<typeof makeModel> | ReturnType<typeof makeGeminiCliModel>;
const convertMessagesForTest = convertMessages as unknown as (
  model: GoogleSharedTestModel,
  context: Context,
) => ReturnType<typeof convertMessages>;

function requireRecordProperty(
  record: Record<string, unknown>,
  key: string,
): Record<string, unknown> {
  const value = record[key];
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`expected object property ${key}`);
  }
  return value as Record<string, unknown>;
}

describe("google-shared convertTools", () => {
  it("keeps Google tool declarations stable across discovery order", () => {
    const tools = [
      { name: "zeta", description: "Last", parameters: { type: "object" } },
      { name: "alpha", description: "First", parameters: { type: "object" } },
    ] as Tool[];

    expect(convertTools(tools)).toEqual(convertTools(tools.toReversed()));
    expect(convertTools(tools)?.[0]?.functionDeclarations.map((tool) => tool.name)).toEqual([
      "alpha",
      "zeta",
    ]);
  });

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
    const params = getFirstToolParameters(
      converted as Parameters<typeof getFirstToolParameters>[0],
    );

    expect(params.type).toBeUndefined();
    expect(params.properties).toEqual({
      action: { type: "string" },
    });
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
    const params = getFirstToolParameters(
      converted as Parameters<typeof getFirstToolParameters>[0],
    );
    const properties = assertRecord(params.properties);
    const mode = assertRecord(properties.mode);
    const options = assertRecord(properties.options);
    const list = assertRecord(properties.list);
    const items = assertRecord(list.items);

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
    const params = getFirstToolParameters(
      converted as Parameters<typeof getFirstToolParameters>[0],
    );
    const config = assertRecord(assertRecord(params.properties).config);
    const configProps = assertRecord(config.properties);
    const retries = assertRecord(configProps.retries);
    const tags = assertRecord(configProps.tags);
    const items = assertRecord(tags.items);

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
  it.each([
    { label: "serialized object", value: '{"query":"cats"}', expected: { query: "cats" } },
    { label: "malformed JSON", value: "{not valid json", expected: {} },
    { label: "JSON array", value: ["not", "an", "object"], expected: {} },
  ])("coerces $label tool-call arguments to the SDK object contract", ({ value, expected }) => {
    const model = makeModel("gemini-3-flash");
    const contents = convertMessagesForTest(model, {
      messages: [
        makeGoogleAssistantMessage(model.id, [
          { type: "toolCall", id: "call_1", name: "lookup", arguments: value },
        ]),
      ],
    } as Context);

    expect(contents[0]?.parts?.[0]?.functionCall?.args).toEqual(expected);
  });

  it.each([
    { label: "empty user text", messages: [{ role: "user", content: "" }] },
    {
      label: "empty user text part",
      messages: [{ role: "user", content: [{ type: "text", text: "" }] }],
    },
    { label: "empty user parts", messages: [{ role: "user", content: [] }] },
    {
      label: "whitespace-only assistant history",
      messages: [makeGoogleAssistantMessage("gemini-3-flash", [{ type: "text", text: "   " }])],
    },
  ])("keeps $label valid for the Google SDK", ({ messages }) => {
    expect(convertMessagesForTest(makeModel("gemini-3-flash"), { messages } as Context)).toEqual([
      { role: "user", parts: [{ text: " " }] },
    ]);
  });

  it.each([
    {
      label: "text",
      block: { type: "text", text: "", textSignature: "c2lnbmVk" },
      part: { text: "", thoughtSignature: "c2lnbmVk" },
    },
    {
      label: "thinking",
      block: { type: "thinking", thinking: "", thinkingSignature: "c2lnbmVk" },
      part: { thought: true, text: "", thoughtSignature: "c2lnbmVk" },
    },
  ])("preserves the empty content field of a signed $label part", ({ block, part }) => {
    const model = makeModel("gemini-3-flash");

    const contents = convertMessagesForTest(model, {
      messages: [makeGoogleAssistantMessage(model.id, [block])],
    } as Context);

    expect(contents).toEqual([{ role: "model", parts: [part] }]);
  });

  it("supplies the documented Gemini 3 thought-signature placeholder for unsigned calls", () => {
    const model = makeModel("gemini-3-flash");
    const contents = convertMessagesForTest(model, {
      messages: [
        makeGoogleAssistantMessage(model.id, [
          { type: "toolCall", id: "provider_alpha", name: "lookup", arguments: {} },
        ]),
      ],
    } as Context);

    expect(contents[0]?.parts?.[0]?.thoughtSignature).toBe("skip_thought_signature_validator");
  });

  it("keeps unsigned parallel Gemini 3 calls exactly as the provider issued them", () => {
    const model = makeModel("gemini-3-flash");
    const contents = convertMessagesForTest(model, {
      messages: [
        makeGoogleAssistantMessage(model.id, [
          {
            type: "toolCall",
            id: "call_1",
            name: "signed",
            arguments: {},
            thoughtSignature: "c2lnbmVk",
          },
          { type: "toolCall", id: "call_2", name: "unsigned", arguments: {} },
        ]),
      ],
    } as Context);

    expect(contents[0]?.parts).toEqual([
      { functionCall: { name: "signed", args: {} }, thoughtSignature: "c2lnbmVk" },
      { functionCall: { name: "unsigned", args: {} } },
    ]);
  });

  it.each([
    { label: "identical arguments", first: { q: "cats" }, second: { q: "cats" } },
    {
      label: "reordered nested arguments",
      first: { first: 1, nested: { alpha: 2, beta: 3 } },
      second: { nested: { beta: 3, alpha: 2 }, first: 1 },
    },
    {
      label: "canonically distinct Unicode keys",
      first: { é: 1, "e\u0301": 2 },
      second: { "e\u0301": 2, é: 1 },
    },
  ])(
    "keeps an earlier Gemini tool-call signature on its original $label part",
    ({ first, second }) => {
      const model = makeModel("gemini-3-flash");
      const toolCall = { type: "toolCall", id: "call_1", name: "lookup" };
      const contents = convertMessagesForTest(model, {
        messages: [
          makeGoogleAssistantMessage(model.id, [
            { ...toolCall, arguments: first, thoughtSignature: "c2lnbmVk" },
          ]),
          {
            role: "toolResult",
            toolCallId: "call_1",
            toolName: "lookup",
            content: [{ type: "text", text: "cats" }],
            isError: false,
            timestamp: 0,
          },
          makeGoogleAssistantMessage(model.id, [{ ...toolCall, arguments: second }]),
        ],
      } as Context);

      const signatures = contents
        .flatMap((content) => content.parts ?? [])
        .filter((part) => part.functionCall)
        .map((part) => part.thoughtSignature);
      expect(signatures).toEqual(["c2lnbmVk", "skip_thought_signature_validator"]);
    },
  );

  it("never replays a cached signature onto a later parallel Gemini function call", () => {
    const model = makeModel("gemini-3-flash");
    const cachedCall = { type: "toolCall", id: "call_1", name: "lookup", arguments: {} };
    const contents = convertMessagesForTest(model, {
      messages: [
        makeGoogleAssistantMessage(model.id, [{ ...cachedCall, thoughtSignature: "c2lnbmVk" }]),
        {
          role: "toolResult",
          toolCallId: "call_1",
          toolName: "lookup",
          content: [{ type: "text", text: "ok" }],
          isError: false,
          timestamp: 0,
        },
        makeGoogleAssistantMessage(model.id, [
          { type: "toolCall", id: "other", name: "different", arguments: {} },
          cachedCall,
        ]),
      ],
    } as Context);

    const signatures = contents
      .flatMap((content) => content.parts ?? [])
      .filter((part) => part.functionCall)
      .map((part) => part.thoughtSignature);
    expect(signatures).toEqual(["c2lnbmVk", "skip_thought_signature_validator", undefined]);
  });

  it.each(["google-vertex", "openai-responses"])(
    "never replays a Gemini tool-call signature onto the foreign %s API route",
    (api) => {
      const model = makeModel("gemini-3-flash");
      const toolCall = { type: "toolCall", id: "call_1", name: "lookup", arguments: {} };
      const contents = convertMessagesForTest(model, {
        messages: [
          makeGoogleAssistantMessage(model.id, [{ ...toolCall, thoughtSignature: "c2lnbmVk" }]),
          {
            ...makeGoogleAssistantMessage(model.id, [toolCall]),
            api,
          },
        ],
      } as Context);

      const signatures = contents
        .flatMap((content) => content.parts ?? [])
        .filter((part) => part.functionCall)
        .map((part) => part.thoughtSignature);
      expect(signatures).toEqual(["c2lnbmVk", "skip_thought_signature_validator"]);
    },
  );

  it("never replays a prior user turn's Gemini tool-call signature", () => {
    const model = makeModel("gemini-3-flash");
    const toolCall = { type: "toolCall", id: "call_1", name: "lookup", arguments: {} };
    const contents = convertMessagesForTest(model, {
      messages: [
        makeGoogleAssistantMessage(model.id, [{ ...toolCall, thoughtSignature: "c2lnbmVk" }]),
        { role: "user", content: "a new question", timestamp: 1 },
        makeGoogleAssistantMessage(model.id, [toolCall]),
      ],
    } as Context);

    const signatures = contents
      .flatMap((content) => content.parts ?? [])
      .filter((part) => part.functionCall)
      .map((part) => part.thoughtSignature);
    expect(signatures).toEqual(["c2lnbmVk", "skip_thought_signature_validator"]);
  });

  it("resets signature replay for runtime-context carriers emitted as Google user turns", () => {
    const model = makeModel("gemini-3-flash");
    const toolCall = { type: "toolCall", id: "call_1", name: "lookup", arguments: {} };
    const contents = convertMessagesForTest(model, {
      messages: [
        makeGoogleAssistantMessage(model.id, [{ ...toolCall, thoughtSignature: "c2lnbmVk" }]),
        {
          role: "user",
          content: "volatile runtime context",
          runtimeContextCarrier: true,
          timestamp: 1,
        },
        makeGoogleAssistantMessage(model.id, [toolCall]),
      ],
    } as Context);

    const signatures = contents
      .flatMap((content) => content.parts ?? [])
      .filter((part) => part.functionCall)
      .map((part) => part.thoughtSignature);
    expect(signatures).toEqual(["c2lnbmVk", "skip_thought_signature_validator"]);
  });

  it.each(["gemini-2.5-pro", "claude-3-opus"])(
    "does not replay thought signatures for the unsupported %s model",
    (modelId) => {
      const model = makeModel(modelId);
      const toolCall = { type: "toolCall", id: "call_1", name: "lookup", arguments: {} };
      const contents = convertMessagesForTest(model, {
        messages: [
          makeGoogleAssistantMessage(model.id, [{ ...toolCall, thoughtSignature: "c2lnbmVk" }]),
          makeGoogleAssistantMessage(model.id, [toolCall]),
        ],
      } as Context);

      const signatures = contents
        .flatMap((content) => content.parts ?? [])
        .filter((part) => part.functionCall)
        .map((part) => part.thoughtSignature);
      expect(signatures).toEqual(["c2lnbmVk", undefined]);
    },
  );

  function expectConsecutiveMessagesNotMerged(params: {
    modelId: string;
    first: string;
    second: string;
  }) {
    const model = makeModel(params.modelId);
    const context = {
      messages: [
        {
          role: "user",
          content: params.first,
        },
        {
          role: "user",
          content: params.second,
        },
      ],
    } as unknown as Context;

    const contents = convertMessagesForTest(model, context);
    expect(contents).toHaveLength(2);
    expect(expectDefined(contents[0], "contents[0] test invariant").role).toBe("user");
    expect(expectDefined(contents[1], "contents[1] test invariant").role).toBe("user");
    expect(expectDefined(contents[0], "contents[0] test invariant").parts).toHaveLength(1);
    expect(expectDefined(contents[1], "contents[1] test invariant").parts).toHaveLength(1);
  }

  it("keeps thinking blocks when provider/model match", () => {
    const model = makeModel("gemini-1.5-pro");
    const context = {
      messages: [
        makeGoogleAssistantMessage(model.id, [
          {
            type: "thinking",
            thinking: "hidden",
            thinkingSignature: "c2ln",
          },
        ]),
      ],
    } as unknown as Context;

    const contents = convertMessagesForTest(model, context);
    expect(contents).toHaveLength(1);
    expect(expectDefined(contents[0], "contents[0] test invariant").role).toBe("model");
    const part = assertRecord(expectDefined(contents[0], "contents[0] test invariant").parts?.[0]);
    expect(part.thought).toBe(true);
    expect(part.thoughtSignature).toBe("c2ln");
  });

  it("keeps thought signatures for Claude models", () => {
    const model = makeModel("claude-3-opus");
    const context = {
      messages: [
        makeGoogleAssistantMessage(model.id, [
          {
            type: "thinking",
            thinking: "structured",
            thinkingSignature: "c2ln",
          },
        ]),
      ],
    } as unknown as Context;

    const contents = convertMessagesForTest(model, context);
    const parts = contents?.[0]?.parts ?? [];
    expect(parts).toHaveLength(1);
    const part = assertRecord(parts[0]);
    expect(part.thought).toBe(true);
    expect(part.thoughtSignature).toBe("c2ln");
  });

  it("does not merge consecutive user messages for Gemini", () => {
    expectConsecutiveMessagesNotMerged({
      modelId: "gemini-1.5-pro",
      first: "Hello",
      second: "How are you?",
    });
  });

  it("does not merge consecutive user messages for non-Gemini Google models", () => {
    expectConsecutiveMessagesNotMerged({
      modelId: "claude-3-opus",
      first: "First",
      second: "Second",
    });
  });

  it("does not merge consecutive model messages for Gemini", () => {
    const model = makeModel("gemini-1.5-pro");
    const context = {
      messages: [
        {
          role: "user",
          content: "Hello",
        },
        makeGoogleAssistantMessage(model.id, [{ type: "text", text: "Hi there!" }]),
        makeGoogleAssistantMessage(model.id, [{ type: "text", text: "How can I help?" }]),
      ],
    } as unknown as Context;

    const contents = convertMessagesForTest(model, context);
    expectConvertedRoles(contents, ["user", "model", "model"]);
    expect(expectDefined(contents[1], "contents[1] test invariant").parts).toHaveLength(1);
    expect(expectDefined(contents[2], "contents[2] test invariant").parts).toHaveLength(1);
  });

  it("handles user message after tool result without model response in between", () => {
    const model = makeModel("gemini-1.5-pro");
    const context = {
      messages: [
        {
          role: "user",
          content: "Use a tool",
        },
        makeGoogleAssistantMessage(model.id, [
          {
            type: "toolCall",
            id: "call_1",
            name: "myTool",
            arguments: { arg: "value" },
          },
        ]),
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

    const contents = convertMessagesForTest(model, context);
    expect(contents).toHaveLength(4);
    expect(expectDefined(contents[0], "contents[0] test invariant").role).toBe("user");
    expect(expectDefined(contents[1], "contents[1] test invariant").role).toBe("model");
    expect(expectDefined(contents[2], "contents[2] test invariant").role).toBe("user");
    expect(expectDefined(contents[3], "contents[3] test invariant").role).toBe("user");
    const toolResponsePart = expectDefined(contents[2], "contents[2] test invariant").parts?.find(
      (part) => typeof part === "object" && part !== null && "functionResponse" in part,
    );
    const toolResponse = assertRecord(toolResponsePart);
    expect(requireRecordProperty(toolResponse, "functionResponse").name).toBe("myTool");
    expect(expectDefined(contents[3], "contents[3] test invariant").role).toBe("user");
  });

  it("ensures function call comes after user turn, not after model turn", () => {
    const model = makeModel("gemini-1.5-pro");
    const context = {
      messages: [
        {
          role: "user",
          content: "Hello",
        },
        makeGoogleAssistantMessage(model.id, [{ type: "text", text: "Hi!" }]),
        makeGoogleAssistantMessage(model.id, [
          {
            type: "toolCall",
            id: "call_1",
            name: "myTool",
            arguments: {},
          },
        ]),
      ],
    } as unknown as Context;

    const contents = convertMessagesForTest(model, context);
    expectConvertedRoles(contents, ["user", "model", "model", "user"]);
    const toolCallPart = expectDefined(contents[2], "contents[2] test invariant").parts?.find(
      (part) => typeof part === "object" && part !== null && "functionCall" in part,
    );
    const toolCall = assertRecord(toolCallPart);
    expect(requireRecordProperty(toolCall, "functionCall").name).toBe("myTool");
  });

  it("strips tool call and response ids for google-gemini-cli", () => {
    const model = makeGeminiCliModel("gemini-3-flash");
    const context = {
      messages: [
        {
          role: "user",
          content: "Use a tool",
        },
        makeGeminiCliAssistantMessage(model.id, [
          {
            type: "toolCall",
            id: "call_1",
            name: "myTool",
            arguments: { arg: "value" },
            thoughtSignature: "dGVzdA==",
          },
        ]),
        {
          role: "toolResult",
          toolCallId: "call_1",
          toolName: "myTool",
          content: [{ type: "text", text: "Tool result" }],
          isError: false,
          timestamp: 0,
        },
      ],
    } as unknown as Context;

    const contents = convertMessagesForTest(model, context);
    const parts = contents.flatMap((content) => content.parts ?? []);
    const toolCallPart = parts.find(
      (part) => typeof part === "object" && part !== null && "functionCall" in part,
    );
    const toolResponsePart = parts.find(
      (part) => typeof part === "object" && part !== null && "functionResponse" in part,
    );

    const toolCall = assertRecord(toolCallPart);
    const toolResponse = assertRecord(toolResponsePart);

    expect(assertRecord(toolCall.functionCall).id).toBeUndefined();
    expect(assertRecord(toolResponse.functionResponse).id).toBeUndefined();
  });

  it("serializes structured tool results into function responses", () => {
    const model = makeModel("gemini-1.5-pro");
    const context = {
      messages: [
        {
          role: "toolResult",
          toolCallId: "call_1",
          toolName: "session_status",
          content: [{ type: "json", payload: { sessionKey: "current", status: "ok" } }],
          isError: false,
          timestamp: 0,
        },
      ],
    } as unknown as Context;
    const contents = convertMessagesForTest(model, context);
    const toolResponsePart = contents[0]?.parts?.find(
      (part) => typeof part === "object" && part !== null && "functionResponse" in part,
    );
    expect(toolResponsePart).toBeDefined();
    const toolResponse = requireRecordProperty(assertRecord(toolResponsePart), "functionResponse");
    expect(assertRecord(toolResponse.response).output).toBe(
      '{"type":"json","payload":{"sessionKey":"current","status":"ok"}}',
    );
  });

  it("does not emit inline data or media placeholders for payload-less tool images", () => {
    const model = makeModel("gemini-3-flash");
    const contents = convertMessagesForTest(model, {
      messages: [
        {
          role: "toolResult",
          toolCallId: "call_husk",
          toolName: "screenshot",
          content: [{ type: "image", mimeType: "image/png", data: "" }],
          isError: false,
          timestamp: 0,
        },
      ],
    } as unknown as Context);

    const serialized = JSON.stringify(contents);
    expect(serialized).toContain('"output":""');
    expect(serialized).not.toContain("inlineData");
    expect(serialized).not.toContain("see attached image");
  });
});
