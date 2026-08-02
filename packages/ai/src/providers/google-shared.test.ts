// Google shared provider tests cover response conversion and finish reasons.
import { ApiError, FinishReason, GoogleGenAI, type GenerateContentResponse } from "@google/genai";
import { describe, expect, it, vi } from "vitest";
import type { AssistantMessage, Model } from "../types.js";
import { AssistantMessageEventStream } from "../utils/event-stream.js";
import { SYSTEM_PROMPT_CACHE_BOUNDARY } from "../utils/system-prompt-cache-boundary.js";
import {
  buildGoogleGenerateContentParams,
  buildGoogleSimpleThinking,
  convertMessages,
  consumeGoogleGenerateContentStream,
  runGoogleGenerateContentLifecycle,
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

describe("buildGoogleSimpleThinking", () => {
  it.each([
    { id: "gemini-pro-latest", expectedLevel: "LOW" },
    { id: "gemini-flash-latest", expectedLevel: "LOW" },
  ])("recognizes the supported $id Gemini 3 alias", ({ id, expectedLevel }) => {
    const aliasModel = { ...model, id };

    expect(buildGoogleSimpleThinking(aliasModel, { reasoning: "low" })).toEqual({
      enabled: true,
      level: expectedLevel,
    });
    expect(
      buildGoogleGenerateContentParams(
        aliasModel,
        { messages: [{ role: "user", content: "hello", timestamp: 0 }] },
        { thinking: { enabled: false } },
      ).config?.thinkingConfig,
    ).not.toHaveProperty("thinkingBudget");
  });

  it.each([
    { id: "gemini-2.5-pro", expected: { enabled: true, budgetTokens: -1 } },
    { id: "gemini-2.5-flash", expected: { enabled: true, budgetTokens: -1 } },
    { id: "gemini-3.1-pro-preview", expected: { enabled: true } },
    { id: "gemini-3-flash-preview", expected: { enabled: true } },
    { id: "gemma-4-26b-a4b-it", expected: { enabled: true, level: "HIGH" } },
  ])("keeps Google's dynamic adaptive thinking for $id", ({ id, expected }) => {
    expect(buildGoogleSimpleThinking({ ...model, id }, { reasoning: "adaptive" } as never)).toEqual(
      expected,
    );
  });

  it.each(["gemini-2.5-pro", "gemma-4-26b-a4b-it"])(
    "omits unsupported disabled-thinking config for %s",
    (id) => {
      const params = buildGoogleGenerateContentParams(
        { ...model, id },
        { messages: [{ role: "user", content: "hello", timestamp: 0 }] },
        { thinking: { enabled: false } },
      );

      expect(params.config).not.toHaveProperty("thinkingConfig");
    },
  );

  it("keeps thinking disabled when a non-reasoning model clamps low to off", () => {
    const nonReasoningModel = { ...model, reasoning: false };

    expect(buildGoogleSimpleThinking(nonReasoningModel, { reasoning: "low" })).toEqual({
      enabled: false,
    });
  });

  it.each(["xhigh", "max"] as const)(
    "keeps thinking disabled when reasoning=%s clamps to off",
    (reasoning) => {
      const offOnlyThinkingModel = {
        ...model,
        id: "gemini-3-flash-preview",
        thinkingLevelMap: {
          minimal: null,
          low: null,
          medium: null,
          high: null,
          xhigh: null,
          max: null,
        },
      } satisfies Model<"google-generative-ai">;

      expect(buildGoogleSimpleThinking(offOnlyThinkingModel, { reasoning })).toEqual({
        enabled: false,
      });
    },
  );
});

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

  it.each([
    {
      name: "includes billed tool-result prompt tokens in input accounting",
      usageMetadata: {
        promptTokenCount: 10,
        cachedContentTokenCount: 2,
        candidatesTokenCount: 3,
        thoughtsTokenCount: 1,
        toolUsePromptTokenCount: 5,
        totalTokenCount: 19,
      },
      expectedInput: 13,
      expectedTotal: 19,
    },
    {
      name: "derives the total when Google omits its optional aggregate",
      usageMetadata: {
        promptTokenCount: 10,
        cachedContentTokenCount: 2,
        candidatesTokenCount: 3,
        thoughtsTokenCount: 1,
      },
      expectedInput: 8,
      expectedTotal: 14,
    },
  ])("$name", async ({ usageMetadata, expectedInput, expectedTotal }) => {
    const output = createOutput();

    await consumeGoogleGenerateContentStream({
      chunks: chunks([
        {
          candidates: [{ finishReason: FinishReason.STOP }],
          usageMetadata,
        } as GenerateContentResponse,
      ]),
      model,
      output,
      stream: new AssistantMessageEventStream(),
      nextToolCallId: () => "call_1",
    });

    expect(output.usage).toMatchObject({
      input: expectedInput,
      output: 4,
      cacheRead: 2,
      totalTokens: expectedTotal,
      cost: { input: expectedInput / 1_000_000 },
    });
  });

  it("retains prompt, cache, and tool-token facts across sparse Google usage chunks", async () => {
    const output = createOutput();

    await consumeGoogleGenerateContentStream({
      chunks: chunks([
        {
          usageMetadata: {
            promptTokenCount: 100,
            cachedContentTokenCount: 40,
            toolUsePromptTokenCount: 6,
            candidatesTokenCount: 1,
            totalTokenCount: 107,
          },
        } as GenerateContentResponse,
        {
          candidates: [{ finishReason: FinishReason.STOP }],
          usageMetadata: { candidatesTokenCount: 12, thoughtsTokenCount: 3 },
        } as GenerateContentResponse,
      ]),
      model,
      output,
      stream: new AssistantMessageEventStream(),
      nextToolCallId: () => "call_1",
    });

    expect(output.usage).toMatchObject({ input: 66, output: 15, cacheRead: 40, totalTokens: 121 });
  });

  it("never reports negative input when Google only provides sparse cached-token facts", async () => {
    const output = createOutput();

    await consumeGoogleGenerateContentStream({
      chunks: chunks([
        {
          candidates: [{ finishReason: FinishReason.STOP }],
          usageMetadata: { cachedContentTokenCount: 40, toolUsePromptTokenCount: 6 },
        } as GenerateContentResponse,
      ]),
      model,
      output,
      stream: new AssistantMessageEventStream(),
      nextToolCallId: () => "call_1",
    });

    expect(output.usage).toMatchObject({ input: 6, cacheRead: 40 });
  });

  it("preserves MAX_TOKENS when the partial response contains a function call", async () => {
    const output = createOutput();
    const stream = new AssistantMessageEventStream();
    const terminalReason = (async () => {
      for await (const event of stream) {
        if (event.type === "done") {
          return event.reason;
        }
      }
      return undefined;
    })();

    await consumeGoogleGenerateContentStream({
      chunks: chunks([
        {
          candidates: [
            {
              content: {
                parts: [{ functionCall: { name: "lookup", args: { query: "cats" } } }],
              },
              finishReason: FinishReason.MAX_TOKENS,
            },
          ],
        } as unknown as GenerateContentResponse,
      ]),
      model,
      output,
      stream,
      nextToolCallId: (name) => `generated-${name}`,
    });

    expect(await terminalReason).toBe("length");
    expect(output.stopReason).toBe("length");
    expect(output.content).toEqual([expect.objectContaining({ type: "toolCall", name: "lookup" })]);
  });

  it("generates a new id when Google repeats a streamed tool-call id", async () => {
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
          candidates: [
            {
              content: {
                parts: [{ functionCall: { id: "call_1", name: "lookup", args: {} } }],
              },
            },
          ],
        } as GenerateContentResponse,
        {
          candidates: [
            {
              content: {
                parts: [{ functionCall: { id: "call_1", name: "lookup", args: {} } }],
              },
              finishReason: FinishReason.STOP,
            },
          ],
        } as GenerateContentResponse,
      ]),
      model,
      output,
      stream,
      nextToolCallId: (name) => `generated-${name}`,
    });
    await collect;

    expect(events.at(-1)).toBe("done");
    expect(output.content).toEqual([
      {
        type: "toolCall",
        id: "call_1",
        name: "lookup",
        arguments: {},
      },
      {
        type: "toolCall",
        id: "generated-lookup",
        name: "lookup",
        arguments: {},
      },
    ]);
  });

  it("attaches a standalone thought signature to the preceding canonical tool call", async () => {
    const output = createOutput();

    await consumeGoogleGenerateContentStream({
      chunks: chunks([
        {
          candidates: [
            {
              content: {
                parts: [
                  {
                    functionCall: { id: "call_1", name: "lookup", args: { query: "cats" } },
                  },
                ],
              },
            },
          ],
        } as unknown as GenerateContentResponse,
        {
          candidates: [
            {
              content: { parts: [{ thoughtSignature: "Y2FsbF9zaWc=" }] },
              finishReason: FinishReason.STOP,
            },
          ],
        } as GenerateContentResponse,
      ]),
      model,
      output,
      stream: new AssistantMessageEventStream(),
      nextToolCallId: () => "generated-lookup",
    });

    expect(output.content).toEqual([
      {
        type: "toolCall",
        id: "call_1",
        name: "lookup",
        arguments: { query: "cats" },
        thoughtSignature: "Y2FsbF9zaWc=",
      },
    ]);
  });

  it.each([
    {
      label: "the first thinking delta",
      parts: [
        { thoughtSignature: "c2lnXzE=" },
        { thought: true, text: "draft" },
        { text: "answer" },
      ],
      content: [
        { type: "text", text: "", textSignature: "c2lnXzE=" },
        { type: "thinking", thinking: "draft", thinkingSignature: undefined },
        { type: "text", text: "answer", textSignature: undefined },
      ],
    },
    {
      label: "a later thinking delta",
      parts: [
        { thought: true, text: "draft", thoughtSignature: "c2lnXzE=" },
        { thoughtSignature: "c2lnXzI=" },
        { text: "answer" },
      ],
      content: [
        { type: "thinking", thinking: "draft", thinkingSignature: "c2lnXzE=" },
        { type: "text", text: "", textSignature: "c2lnXzI=" },
        { type: "text", text: "answer", textSignature: undefined },
      ],
    },
  ])("retains a standalone thought signature beside $label", async ({ parts, content }) => {
    const output = createOutput();
    const stream = new AssistantMessageEventStream();
    const events: Array<{ type: string; delta?: string }> = [];
    const collect = (async () => {
      for await (const event of stream) {
        events.push(event);
      }
    })();

    await consumeGoogleGenerateContentStream({
      chunks: chunks([
        {
          candidates: [{ content: { parts }, finishReason: FinishReason.STOP }],
        } as GenerateContentResponse,
      ]),
      model,
      output,
      stream,
      nextToolCallId: () => "generated-lookup",
    });
    await collect;

    expect(output.content).toEqual(content);
    expect(events).toContainEqual(expect.objectContaining({ type: "text_delta", delta: "" }));
    expect(convertMessages(model, { messages: [output] })).toEqual([
      {
        role: "model",
        parts: parts.map((part) =>
          "thoughtSignature" in part && !("text" in part) ? { ...part, text: "" } : part,
        ),
      },
    ]);
  });

  it("keeps an explicit signature-only thought separate from the preceding tool call", async () => {
    const output = createOutput();

    await consumeGoogleGenerateContentStream({
      chunks: chunks([
        {
          candidates: [
            {
              content: {
                parts: [
                  { functionCall: { id: "call_1", name: "lookup", args: {} } },
                  { thought: true, thoughtSignature: "dGhvdWdodF9zaWc=" },
                  { thought: true, text: "draft" },
                ],
              },
              finishReason: FinishReason.STOP,
            },
          ],
        } as GenerateContentResponse,
      ]),
      model,
      output,
      stream: new AssistantMessageEventStream(),
      nextToolCallId: () => "generated-lookup",
    });

    expect(output.content).toEqual([
      { type: "toolCall", id: "call_1", name: "lookup", arguments: {} },
      { type: "thinking", thinking: "", thinkingSignature: "dGhvdWdodF9zaWc=" },
      { type: "thinking", thinking: "draft", thinkingSignature: undefined },
    ]);
  });

  it.each([
    { label: "different", signature: "c2lnXzI=" },
    { label: "identical", signature: "c2lnXzE=" },
  ])(
    "never overwrites a signed tool call with a separate $label provider signature part",
    async ({ signature }) => {
      const output = createOutput();

      await consumeGoogleGenerateContentStream({
        chunks: chunks([
          {
            candidates: [
              {
                content: {
                  parts: [
                    {
                      functionCall: { id: "call_1", name: "lookup", args: {} },
                      thoughtSignature: "c2lnXzE=",
                    },
                    { thoughtSignature: signature },
                  ],
                },
                finishReason: FinishReason.STOP,
              },
            ],
          } as GenerateContentResponse,
        ]),
        model,
        output,
        stream: new AssistantMessageEventStream(),
        nextToolCallId: () => "generated-lookup",
      });

      expect(output.content).toEqual([
        {
          type: "toolCall",
          id: "call_1",
          name: "lookup",
          arguments: {},
          thoughtSignature: "c2lnXzE=",
        },
        { type: "text", text: "", textSignature: signature },
      ]);
    },
  );

  it("never attaches a signed media Part to the preceding unsigned tool call", async () => {
    const output = createOutput();

    await consumeGoogleGenerateContentStream({
      chunks: chunks([
        {
          candidates: [
            {
              content: {
                parts: [
                  { functionCall: { id: "call_1", name: "lookup", args: {} } },
                  {
                    inlineData: { mimeType: "image/png", data: "aW1hZ2U=" },
                    thoughtSignature: "c2lnXzE=",
                  },
                ],
              },
              finishReason: FinishReason.STOP,
            },
          ],
        } as GenerateContentResponse,
      ]),
      model,
      output,
      stream: new AssistantMessageEventStream(),
      nextToolCallId: () => "generated-lookup",
    });

    expect(output.content).toEqual([
      { type: "toolCall", id: "call_1", name: "lookup", arguments: {} },
    ]);
  });

  it("keeps a same-candidate standalone signature separate from an unsigned tool call", async () => {
    const output = createOutput();

    await consumeGoogleGenerateContentStream({
      chunks: chunks([
        {
          candidates: [
            {
              content: {
                parts: [
                  { functionCall: { id: "call_1", name: "lookup", args: {} } },
                  { thoughtSignature: "c2lnXzE=" },
                ],
              },
              finishReason: FinishReason.STOP,
            },
          ],
        } as GenerateContentResponse,
      ]),
      model,
      output,
      stream: new AssistantMessageEventStream(),
      nextToolCallId: () => "generated-lookup",
    });

    expect(output.content).toEqual([
      { type: "toolCall", id: "call_1", name: "lookup", arguments: {} },
      { type: "text", text: "", textSignature: "c2lnXzE=" },
    ]);
  });

  it.each([
    {
      label: "signed text followed by unsigned text",
      parts: [{ text: "signed", thoughtSignature: "c2lnXzE=" }, { text: "unsigned" }],
      content: [
        { type: "text", text: "signed", textSignature: "c2lnXzE=" },
        { type: "text", text: "unsigned", textSignature: undefined },
      ],
    },
    {
      label: "signed thinking followed by unsigned thinking",
      parts: [
        { thought: true, text: "signed", thoughtSignature: "c2lnXzE=" },
        { thought: true, text: "unsigned" },
      ],
      content: [
        { type: "thinking", thinking: "signed", thinkingSignature: "c2lnXzE=" },
        { type: "thinking", thinking: "unsigned", thinkingSignature: undefined },
      ],
    },
    {
      label: "separately signed text parts",
      parts: [
        { text: "first", thoughtSignature: "c2lnXzE=" },
        { text: "second", thoughtSignature: "c2lnXzI=" },
      ],
      content: [
        { type: "text", text: "first", textSignature: "c2lnXzE=" },
        { type: "text", text: "second", textSignature: "c2lnXzI=" },
      ],
    },
    {
      label: "separately signed text parts with the same signature",
      parts: [
        { text: "first", thoughtSignature: "c2lnXzE=" },
        { text: "second", thoughtSignature: "c2lnXzE=" },
      ],
      content: [
        { type: "text", text: "first", textSignature: "c2lnXzE=" },
        { type: "text", text: "second", textSignature: "c2lnXzE=" },
      ],
    },
    {
      label: "separately signed thought parts with the same signature",
      parts: [
        { thought: true, text: "first", thoughtSignature: "c2lnXzE=" },
        { thought: true, text: "second", thoughtSignature: "c2lnXzE=" },
      ],
      content: [
        { type: "thinking", thinking: "first", thinkingSignature: "c2lnXzE=" },
        { type: "thinking", thinking: "second", thinkingSignature: "c2lnXzE=" },
      ],
    },
  ])("keeps exact provider part ownership for $label", async ({ parts, content }) => {
    const output = createOutput();

    await consumeGoogleGenerateContentStream({
      chunks: chunks([
        {
          candidates: [{ content: { parts }, finishReason: FinishReason.STOP }],
        } as GenerateContentResponse,
      ]),
      model,
      output,
      stream: new AssistantMessageEventStream(),
      nextToolCallId: () => "generated-lookup",
    });

    expect(output.content).toEqual(content);
    expect(convertMessages(model, { messages: [output] })).toEqual([{ role: "model", parts }]);
  });
});

describe("runGoogleGenerateContentLifecycle", () => {
  it.each(["google-generative-ai", "google-vertex"] as const)(
    "rejects an unfinished %s stream instead of silently completing partial output",
    async (api) => {
      const targetModel = {
        ...model,
        api,
        provider: api === "google-vertex" ? "google-vertex" : "google",
      } satisfies Model<"google-generative-ai" | "google-vertex">;
      const output: AssistantMessage = {
        ...createOutput(),
        api: targetModel.api,
        provider: targetModel.provider,
      };
      const stream = new AssistantMessageEventStream();

      await runGoogleGenerateContentLifecycle({
        stream,
        model: targetModel,
        output,
        createClient: () => ({
          models: {
            generateContentStream: async () =>
              chunks([
                {
                  candidates: [{ content: { parts: [{ text: "partial output" }] } }],
                } as GenerateContentResponse,
              ]),
          },
        }),
        buildParams: () => ({ model: targetModel.id, contents: [] }),
        nextToolCallId: () => "call_1",
      });

      expect(await stream.result()).toMatchObject({
        stopReason: "error",
        errorCode: "STREAM_INCOMPLETE",
        errorType: "google_incomplete_stream",
        errorMessage: "Google stream ended before a terminal finish reason",
      });
    },
  );

  it.each([FinishReason.SAFETY, FinishReason.MALFORMED_FUNCTION_CALL])(
    "preserves the actionable %s candidate finish message",
    async (finishReason) => {
      const output = createOutput();
      const stream = new AssistantMessageEventStream();

      await runGoogleGenerateContentLifecycle({
        stream,
        model,
        output,
        createClient: () => ({
          models: {
            generateContentStream: async () =>
              chunks([
                {
                  candidates: [
                    {
                      finishReason,
                      finishMessage: "Provider rejected the generated response",
                    },
                  ],
                } as GenerateContentResponse,
              ]),
          },
        }),
        buildParams: () => ({ model: model.id, contents: [] }),
        nextToolCallId: () => "call_1",
      });

      expect(await stream.result()).toMatchObject({
        stopReason: "error",
        errorCode: finishReason,
        errorType: "google_generation_failed",
        errorMessage: `Google generation stopped (${finishReason}): Provider rejected the generated response`,
      });
    },
  );

  it("closes partial text before reporting a failed candidate", async () => {
    const output = createOutput();
    const stream = new AssistantMessageEventStream();
    const eventTypes: string[] = [];
    const collect = (async () => {
      for await (const event of stream) {
        eventTypes.push(event.type);
      }
    })();

    await runGoogleGenerateContentLifecycle({
      stream,
      model,
      output,
      createClient: () => ({
        models: {
          generateContentStream: async () =>
            chunks([
              {
                candidates: [
                  {
                    content: { parts: [{ text: "partial output" }] },
                    finishReason: FinishReason.SAFETY,
                    finishMessage: "Provider rejected the generated response",
                  },
                ],
              } as GenerateContentResponse,
            ]),
        },
      }),
      buildParams: () => ({ model: model.id, contents: [] }),
      nextToolCallId: () => "call_1",
    });
    await collect;

    expect(eventTypes).toEqual(["start", "text_start", "text_delta", "text_end", "error"]);
    expect((await stream.result()).errorCode).toBe("SAFETY");
  });

  it("preserves cancellation precedence over an observed candidate failure", async () => {
    const controller = new AbortController();
    const abortReason = Object.assign(new Error("Google run restarted"), {
      code: "GATEWAY_RESTART",
    });
    const output = createOutput();
    const stream = new AssistantMessageEventStream();

    await runGoogleGenerateContentLifecycle({
      stream,
      model,
      output,
      options: { signal: controller.signal },
      createClient: () => ({
        models: {
          generateContentStream: async () => ({
            async *[Symbol.asyncIterator]() {
              yield {
                candidates: [
                  {
                    content: { parts: [{ text: "partial output" }] },
                    finishReason: FinishReason.SAFETY,
                  },
                ],
              } as GenerateContentResponse;
              controller.abort(abortReason);
            },
          }),
        },
      }),
      buildParams: () => ({ model: model.id, contents: [] }),
      nextToolCallId: () => "call_1",
    });

    expect(await stream.result()).toMatchObject({
      stopReason: "aborted",
      errorCode: "GATEWAY_RESTART",
      errorMessage: "Google run restarted",
    });
    expect(output.errorCode).toBe("GATEWAY_RESTART");
  });

  it.each([429, 503])("preserves the official Google SDK's %s API error status", async (status) => {
    const output = createOutput();
    const stream = new AssistantMessageEventStream();

    await runGoogleGenerateContentLifecycle({
      stream,
      model,
      output,
      createClient: () => ({
        models: {
          generateContentStream: async () => {
            throw new ApiError({ status, message: "Google quota exceeded" });
          },
        },
      }),
      buildParams: () => ({ model: model.id, contents: [] }),
      nextToolCallId: () => "call_1",
    });

    expect(await stream.result()).toMatchObject({
      stopReason: "error",
      errorCode: String(status),
      errorMessage: `${status}: Google quota exceeded`,
    });
  });

  it("preserves the typed Gemini finish reason when the official SDK omits finishMessage", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        `data: ${JSON.stringify({
          candidates: [
            {
              finishReason: "SAFETY",
              finishMessage: "Gemini Developer API strips this field",
            },
          ],
        })}\n\n`,
        { headers: { "content-type": "text/event-stream" } },
      ),
    );
    const output = createOutput();
    const stream = new AssistantMessageEventStream();

    try {
      await runGoogleGenerateContentLifecycle({
        stream,
        model,
        output,
        createClient: () => new GoogleGenAI({ apiKey: "test-gemini-api-key" }),
        buildParams: () => ({
          model: model.id,
          contents: [{ role: "user", parts: [{ text: "hello" }] }],
        }),
        nextToolCallId: () => "call_1",
      });

      expect(await stream.result()).toMatchObject({
        stopReason: "error",
        errorCode: "SAFETY",
        errorType: "google_generation_failed",
        errorMessage: "Google generation stopped (SAFETY)",
      });
      expect(fetchMock).toHaveBeenCalledOnce();
    } finally {
      fetchMock.mockRestore();
    }
  });

  it.each([
    { api: "google-generative-ai", blockReason: "SAFETY" },
    { api: "google-generative-ai", blockReason: undefined },
    { api: "google-vertex", blockReason: "SAFETY" },
    { api: "google-vertex", blockReason: undefined },
  ] as const)(
    "surfaces blocked $api prompts as typed stream errors when blockReason is $blockReason",
    async ({ api, blockReason }) => {
      const targetModel = {
        ...model,
        api,
        provider: api === "google-vertex" ? "google-vertex" : "google",
      } satisfies Model<"google-generative-ai" | "google-vertex">;
      const output: AssistantMessage = {
        ...createOutput(),
        api: targetModel.api,
        provider: targetModel.provider,
      };
      const stream = new AssistantMessageEventStream();

      await runGoogleGenerateContentLifecycle({
        stream,
        model: targetModel,
        output,
        createClient: () => ({
          models: {
            generateContentStream: async () =>
              chunks([
                {
                  promptFeedback: {
                    ...(blockReason ? { blockReason } : {}),
                    blockReasonMessage: "Prompt violates provider safety policy",
                  },
                  usageMetadata: {
                    promptTokenCount: 12,
                    cachedContentTokenCount: 2,
                    totalTokenCount: 12,
                  },
                } as GenerateContentResponse,
              ]),
          },
        }),
        buildParams: () => ({ model: targetModel.id, contents: [] }),
        nextToolCallId: () => "call_1",
      });

      const result = await stream.result();
      const expectedBlockReason = blockReason ?? "PROMPT_BLOCKED";
      expect(result).toMatchObject({
        stopReason: "error",
        errorCode: expectedBlockReason,
        errorType: "google_prompt_blocked",
        errorMessage: `Google prompt blocked (${expectedBlockReason}): Prompt violates provider safety policy`,
        content: [],
        usage: { input: 10, cacheRead: 2, totalTokens: 12 },
      });
      expect(result.usage.cost.total).toBeGreaterThan(0);
    },
  );

  it("surfaces HTTP response body text from Google-compatible errors", async () => {
    const output = createOutput();
    const stream = new AssistantMessageEventStream();
    const error = Object.assign(new Error("502 status code (no body)"), {
      status: 502,
      body: "gateway maintenance",
    });

    await runGoogleGenerateContentLifecycle({
      stream,
      model,
      output,
      createClient: () => ({
        models: {
          generateContentStream: async () => {
            throw error;
          },
        },
      }),
      buildParams: () => ({ model: model.id, contents: [] }),
      nextToolCallId: () => "call_1",
    });

    expect(output.errorMessage).toBe("502: gateway maintenance");
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

  it("strips the internal cache boundary marker from systemInstruction", () => {
    const params = buildGoogleGenerateContentParams(model, {
      systemPrompt: `Stable${SYSTEM_PROMPT_CACHE_BOUNDARY}Dynamic`,
      messages: [{ role: "user", content: "hello", timestamp: 0 }],
    });

    expect(params.config?.systemInstruction).toBe("Stable\nDynamic");
    expect(JSON.stringify(params)).not.toContain("OPENCLAW_CACHE_BOUNDARY");
  });
});
