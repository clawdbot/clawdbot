// Xai tests cover stream plugin behavior.
import type { StreamFn } from "openclaw/plugin-sdk/agent-core";
import {
  streamSimple,
  type Api,
  type Context,
  type Model,
  type ModelThinkingLevel,
} from "openclaw/plugin-sdk/llm";
import { describe, expect, it } from "vitest";
import { applyXaiRuntimeModelCompat } from "./runtime-model-compat.js";
import {
  createXaiFastModeWrapper,
  createXaiToolPayloadCompatibilityWrapper,
  wrapXaiProviderStream,
} from "./stream.js";
import {
  createXaiPayloadCaptureStream,
  expectXaiFastToolStreamShaping,
  runXaiGrok4ResponseStream,
} from "./test-helpers.js";
type XaiStreamApi = Extract<Api, "openai-completions" | "openai-responses">;
type StreamEvent = Record<string, unknown> & { type?: string };

async function collectEvents(stream: ReturnType<StreamFn>): Promise<StreamEvent[]> {
  const events: StreamEvent[] = [];
  for await (const event of stream as AsyncIterable<StreamEvent>) {
    events.push(event);
  }
  return events;
}

function buildEventStreamFn(events: unknown[]): StreamFn {
  return (() =>
    ({
      result: async () => {
        const done = events.find((event) => {
          const record = event && typeof event === "object" ? (event as { type?: unknown }) : {};
          return record.type === "done";
        }) as { message?: unknown } | undefined;
        return (done?.message ?? { role: "assistant", content: [] }) as never;
      },
      async *[Symbol.asyncIterator]() {
        for (const event of events) {
          yield event as never;
        }
      },
    }) as unknown as ReturnType<StreamFn>) as StreamFn;
}

function captureWrappedModelId(params: {
  modelId: string;
  fastMode: boolean | (() => boolean | undefined);
  api?: XaiStreamApi;
  provider?: string;
}): string {
  let capturedModelId = "";
  const baseStreamFn: StreamFn = (model) => {
    capturedModelId = model.id;
    return {} as ReturnType<StreamFn>;
  };

  const wrapped = createXaiFastModeWrapper(baseStreamFn, params.fastMode);
  void wrapped(
    {
      api: params.api ?? "openai-responses",
      provider: params.provider ?? "xai",
      id: params.modelId,
    } as Model<Extract<Api, "openai-completions" | "openai-responses">>,
    { messages: [] } as Context,
    {},
  );

  return capturedModelId;
}

function runXaiToolPayloadWrapper(params: {
  payload: Record<string, unknown>;
  api?: XaiStreamApi;
  modelId?: string;
  input?: string[];
  provider?: string;
}) {
  const baseStreamFn: StreamFn = (_model, _context, options) => {
    options?.onPayload?.(params.payload, {} as Model<XaiStreamApi>);
    return {} as ReturnType<StreamFn>;
  };
  const wrapped = createXaiToolPayloadCompatibilityWrapper(baseStreamFn);
  const api = params.api ?? "openai-responses";

  void wrapped(
    {
      api,
      provider: params.provider ?? "xai",
      id:
        params.modelId ??
        (api === "openai-completions" ? "grok-4-1-fast-reasoning" : "grok-4-fast"),
      reasoning: params.modelId ? !params.modelId.includes("non-reasoning") : true,
      ...(params.input ? { input: params.input } : {}),
    } as Model<XaiStreamApi>,
    { messages: [] } as Context,
    {},
  );
}

async function captureXaiResponsesPayloadWithThinking(
  reasoning: ModelThinkingLevel = "low",
  modelId = "grok-4.5",
): Promise<Record<string, unknown>> {
  const model = applyXaiRuntimeModelCompat({
    api: "openai-responses",
    provider: "xai",
    id: modelId,
    baseUrl: "https://api.x.ai/v1",
    reasoning: true,
    input: ["text", "image"],
    cost: { input: 2, output: 6, cacheRead: 0.5, cacheWrite: 0 },
    contextWindow: 500_000,
    maxTokens: 64_000,
  } as Model<"openai-responses">);

  const payloadPromise = new Promise<Record<string, unknown>>((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error("provider payload callback was not invoked")),
      1_000,
    );
    const stream = streamSimple(
      model,
      { messages: [{ role: "user", content: "hello", timestamp: 0 }] },
      {
        apiKey: "test-api-key",
        cacheRetention: "none",
        reasoning,
        onPayload: (payload) => {
          clearTimeout(timeout);
          resolve(structuredClone(payload as Record<string, unknown>));
          throw new Error("stop after payload capture");
        },
      },
    );
    void stream.result();
  });

  return await payloadPromise;
}

describe("xai stream wrappers", () => {
  it("rewrites supported Grok models to fast variants when fast mode is enabled", () => {
    expect(captureWrappedModelId({ modelId: "grok-3", fastMode: true })).toBe("grok-3-fast");
    expect(
      captureWrappedModelId({
        modelId: "grok-3",
        fastMode: true,
        api: "openai-completions",
      }),
    ).toBe("grok-3-fast");
    expect(captureWrappedModelId({ modelId: "grok-4", fastMode: true })).toBe("grok-4-fast");
    expect(
      captureWrappedModelId({
        modelId: "grok-3",
        fastMode: true,
        api: "openai-responses",
      }),
    ).toBe("grok-3-fast");
    expect(captureWrappedModelId({ modelId: "grok-4", fastMode: true, provider: "x-ai" })).toBe(
      "grok-4-fast",
    );
  });

  it("leaves unsupported or disabled models unchanged", () => {
    expect(captureWrappedModelId({ modelId: "grok-3-fast", fastMode: true })).toBe("grok-3-fast");
    expect(captureWrappedModelId({ modelId: "grok-3", fastMode: false })).toBe("grok-3");
  });

  it("resolves dynamic fast mode for each xai stream call", () => {
    const capturedModelIds: string[] = [];
    const baseStreamFn: StreamFn = (model) => {
      capturedModelIds.push(model.id);
      return {
        result: async () => ({}),
        async *[Symbol.asyncIterator]() {},
      } as unknown as ReturnType<StreamFn>;
    };
    let enabled = true;
    const wrapped = createXaiFastModeWrapper(baseStreamFn, () => enabled);
    const model = {
      api: "openai-responses",
      provider: "xai",
      id: "grok-4",
    } as Model<XaiStreamApi>;

    void wrapped(model, { messages: [] } as Context, {});
    enabled = false;
    void wrapped(model, { messages: [] } as Context, {});

    expect(capturedModelIds).toEqual(["grok-4-fast", "grok-4"]);
  });

  it("composes the xai provider stream chain from extra params", () => {
    const capture = createXaiPayloadCaptureStream();

    const wrapped = wrapXaiProviderStream({
      streamFn: capture.streamFn,
      extraParams: { fastMode: true },
    } as never);

    runXaiGrok4ResponseStream(wrapped);
    expectXaiFastToolStreamShaping(capture);
  });

  it("leaves tool-call argument html entities untouched, delegating decode to the core path", async () => {
    const toolCall = {
      type: "toolCall",
      id: "call_1",
      name: "write",
      arguments: { content: "&amp;amp;" },
    };
    const assistant = {
      role: "assistant",
      content: [toolCall],
      stopReason: "toolUse",
    };
    const baseStream = buildEventStreamFn([
      { type: "toolcall_end", contentIndex: 0, toolCall, partial: assistant },
      { type: "done", reason: "toolUse", message: assistant },
    ]);
    const wrapped = wrapXaiProviderStream({
      streamFn: baseStream,
      extraParams: { tool_stream: false },
    } as never);

    const events = await collectEvents(
      wrapped!(
        { api: "openai-responses", provider: "xai", id: "grok-4.3" } as Model<"openai-responses">,
        { messages: [], tools: [] } as unknown as Context,
        {},
      ),
    );

    const done = events.find((event) => event.type === "done") as {
      message?: { content?: Array<{ arguments?: { content?: string } }> };
    };
    expect(done.message?.content?.[0]?.arguments?.content).toBe("&amp;amp;");
  });

  it("promotes standalone Grok-style tool text to a structured tool call", async () => {
    const rawToolText = '[tool:read] {"path":"/app/skills/meme-maker/SKILL.md"}';
    const baseStream = buildEventStreamFn([
      { type: "start", partial: { content: [] } },
      { type: "text_start", contentIndex: 0, partial: { content: [{ type: "text", text: "" }] } },
      { type: "text_delta", contentIndex: 0, delta: rawToolText },
      { type: "text_end", contentIndex: 0, content: rawToolText },
      {
        type: "done",
        reason: "stop",
        message: {
          role: "assistant",
          content: [{ type: "text", text: rawToolText }],
          stopReason: "stop",
        },
      },
    ]);
    const wrapped = wrapXaiProviderStream({
      streamFn: baseStream,
      extraParams: { tool_stream: false },
    } as never);

    const events = await collectEvents(
      wrapped!(
        {
          api: "openai-responses",
          provider: "xai",
          id: "grok-4.3",
        } as Model<"openai-responses">,
        {
          messages: [],
          tools: [{ name: "read", description: "Read", parameters: { type: "object" } }],
        } as unknown as Context,
        {},
      ),
    );

    expect(events.map((event) => event.type)).toEqual([
      "start",
      "toolcall_start",
      "toolcall_delta",
      "done",
    ]);
    const done = events.find((event) => event.type === "done") as {
      message?: { content?: Array<Record<string, unknown>>; stopReason?: string };
      reason?: string;
    };
    expect(done.reason).toBe("toolUse");
    expect(done.message?.stopReason).toBe("toolUse");
    expect(done.message?.content?.[0]).toMatchObject({
      type: "toolCall",
      name: "read",
      arguments: { path: "/app/skills/meme-maker/SKILL.md" },
    });
  });

  it("resolves dynamic fast mode in the composed xai provider stream chain", () => {
    const capturedModelIds: string[] = [];
    const baseStreamFn: StreamFn = (model) => {
      capturedModelIds.push(model.id);
      return {
        result: async () => ({}),
        async *[Symbol.asyncIterator]() {},
      } as unknown as ReturnType<StreamFn>;
    };
    let enabled = true;
    const wrapped = wrapXaiProviderStream({
      streamFn: baseStreamFn,
      extraParams: { fastMode: () => enabled },
    } as never);
    const model = {
      api: "openai-responses",
      provider: "xai",
      id: "grok-4",
    } as Model<XaiStreamApi>;

    void wrapped?.(model, { messages: [] } as Context, {});
    enabled = false;
    void wrapped?.(model, { messages: [] } as Context, {});

    expect(capturedModelIds).toEqual(["grok-4-fast", "grok-4"]);
  });

  it("preserves supported strict flags while stripping unsupported reasoning controls", () => {
    const payload = {
      reasoning: "high",
      reasoningEffort: "high",
      reasoning_effort: "high",
      tools: [
        {
          type: "function",
          function: {
            name: "write",
            parameters: { type: "object", properties: {} },
            strict: true,
          },
        },
      ],
    };
    runXaiToolPayloadWrapper({
      payload,
      api: "openai-completions",
      modelId: "grok-4-fast-non-reasoning",
    });

    expect(payload).not.toHaveProperty("reasoning");
    expect(payload).not.toHaveProperty("reasoningEffort");
    expect(payload).not.toHaveProperty("reasoning_effort");
    expect(payload.tools[0]?.function).toHaveProperty("strict", true);
  });

  it("strips unsupported reasoning controls from non-reasoning xai payloads", () => {
    const payload: Record<string, unknown> = {
      reasoning: { effort: "high" },
      reasoningEffort: "high",
      reasoning_effort: "high",
    };
    runXaiToolPayloadWrapper({ payload, modelId: "grok-4-fast-non-reasoning" });

    expect(payload).not.toHaveProperty("reasoning");
    expect(payload).not.toHaveProperty("reasoningEffort");
    expect(payload).not.toHaveProperty("reasoning_effort");
  });

  it("passes reasoning controls through for reasoning-capable xai payloads", () => {
    const payload: Record<string, unknown> = {
      reasoning: { effort: "high" },
      reasoningEffort: "high",
      reasoning_effort: "high",
    };
    runXaiToolPayloadWrapper({ payload, modelId: "grok-4.5" });

    expect(payload.reasoning).toEqual({ effort: "high" });
    expect(payload.reasoningEffort).toBe("high");
    expect(payload.reasoning_effort).toBe("high");
  });

  it("strips reasoning controls when compat disables reasoning effort", () => {
    const payload: Record<string, unknown> = {
      reasoning: { effort: "high" },
      reasoningEffort: "high",
      reasoning_effort: "high",
    };
    const baseStreamFn: StreamFn = (model, _context, options) => {
      options?.onPayload?.(payload, model);
      return {} as ReturnType<StreamFn>;
    };
    const wrapped = createXaiToolPayloadCompatibilityWrapper(baseStreamFn);

    void wrapped(
      {
        api: "openai-responses",
        provider: "xai",
        id: "grok-4.20-0309-reasoning",
        reasoning: true,
        compat: { supportsReasoningEffort: false },
      } as unknown as Model<"openai-responses">,
      { messages: [] } as Context,
      {},
    );

    expect(payload).not.toHaveProperty("reasoning");
    expect(payload).not.toHaveProperty("reasoningEffort");
    expect(payload).not.toHaveProperty("reasoning_effort");
  });

  it.each(["xai", "x-ai"])(
    "still requests encrypted reasoning include for %s when effort is unsupported",
    (provider) => {
      const payload: Record<string, unknown> = {
        reasoning: { effort: "high" },
        input: [],
      };
      const baseStreamFn: StreamFn = (model, _context, options) => {
        options?.onPayload?.(payload, model);
        return {} as ReturnType<StreamFn>;
      };
      const wrapped = createXaiToolPayloadCompatibilityWrapper(baseStreamFn);

      void wrapped(
        {
          api: "openai-responses",
          provider,
          id: "grok-build-0.1",
          reasoning: true,
          compat: { supportsReasoningEffort: false },
        } as unknown as Model<"openai-responses">,
        { messages: [] } as Context,
        {},
      );

      expect(payload).not.toHaveProperty("reasoning");
      expect(payload.include).toEqual(["reasoning.encrypted_content"]);
    },
  );

  it("merges encrypted reasoning include with existing include entries", () => {
    const payload: Record<string, unknown> = {
      include: ["file_search_call.results"],
    };
    runXaiToolPayloadWrapper({
      payload,
      modelId: "grok-build-0.1",
    });

    expect(payload.include).toEqual(["file_search_call.results", "reasoning.encrypted_content"]);
  });

  it("does not request encrypted reasoning include for non-reasoning xai models", () => {
    const payload: Record<string, unknown> = {};
    runXaiToolPayloadWrapper({
      payload,
      modelId: "grok-4-fast-non-reasoning",
    });

    expect(payload).not.toHaveProperty("include");
  });

  it("keeps native xAI Responses thinking efforts before the shared runtime dispatches payloads", async () => {
    const payload = await captureXaiResponsesPayloadWithThinking();

    expect(payload.reasoning).toEqual({ effort: "low", summary: "auto" });
    expect(payload.include).toEqual(["reasoning.encrypted_content"]);
  });

  it("clamps unsupported Grok 4.5 off reasoning to low", async () => {
    const payload = await captureXaiResponsesPayloadWithThinking("off");

    expect(payload.reasoning).toEqual({ effort: "low", summary: "auto" });
  });

  it("maps Grok 4.3 off reasoning to xAI none", async () => {
    const payload = await captureXaiResponsesPayloadWithThinking("off", "grok-4.3");

    expect(payload.reasoning).toEqual({ effort: "none" });
  });

  it("moves image-bearing tool results out of function_call_output payloads", () => {
    const payload: Record<string, unknown> = {
      input: [
        {
          type: "function_call_output",
          call_id: "call_1",
          output: [
            { type: "input_text", text: "Read image" },
            {
              type: "input_image",
              detail: "auto",
              image_url: "data:image/png;base64,QUJDRA==",
            },
          ],
        },
      ],
    };
    runXaiToolPayloadWrapper({ payload, input: ["text", "image"] });

    expect(payload.input).toEqual([
      {
        type: "function_call_output",
        call_id: "call_1",
        output: "Read image",
      },
      {
        type: "message",
        role: "user",
        content: [
          { type: "input_text", text: "Attached image(s) from tool result:" },
          {
            type: "input_image",
            detail: "auto",
            image_url: "data:image/png;base64,QUJDRA==",
          },
        ],
      },
    ]);
  });

  it("replays source-based input_image parts from tool results", () => {
    const payload: Record<string, unknown> = {
      input: [
        {
          type: "function_call_output",
          call_id: "call_1",
          output: [
            { type: "input_text", text: "Read image" },
            {
              type: "input_image",
              source: {
                type: "base64",
                media_type: "image/png",
                data: "QUJDRA==",
              },
            },
          ],
        },
      ],
    };
    runXaiToolPayloadWrapper({ payload, input: ["text", "image"] });

    expect(payload.input).toEqual([
      {
        type: "function_call_output",
        call_id: "call_1",
        output: "Read image",
      },
      {
        type: "message",
        role: "user",
        content: [
          { type: "input_text", text: "Attached image(s) from tool result:" },
          {
            type: "input_image",
            source: {
              type: "base64",
              media_type: "image/png",
              data: "QUJDRA==",
            },
          },
        ],
      },
    ]);
  });

  it("keeps multiple tool outputs contiguous before replaying collected images", () => {
    const payload: Record<string, unknown> = {
      input: [
        {
          type: "function_call_output",
          call_id: "call_1",
          output: [
            { type: "input_text", text: "first" },
            {
              type: "input_image",
              detail: "auto",
              image_url: "data:image/png;base64,QUFBQQ==",
            },
          ],
        },
        {
          type: "function_call_output",
          call_id: "call_2",
          output: [
            { type: "input_text", text: "second" },
            {
              type: "input_image",
              detail: "auto",
              image_url: "data:image/png;base64,QkJCQg==",
            },
          ],
        },
      ],
    };
    runXaiToolPayloadWrapper({ payload, input: ["text", "image"] });

    expect(payload.input).toEqual([
      {
        type: "function_call_output",
        call_id: "call_1",
        output: "first",
      },
      {
        type: "function_call_output",
        call_id: "call_2",
        output: "second",
      },
      {
        type: "message",
        role: "user",
        content: [
          { type: "input_text", text: "Attached image(s) from tool result:" },
          {
            type: "input_image",
            detail: "auto",
            image_url: "data:image/png;base64,QUFBQQ==",
          },
          {
            type: "input_image",
            detail: "auto",
            image_url: "data:image/png;base64,QkJCQg==",
          },
        ],
      },
    ]);
  });

  it("drops image blocks and uses fallback text for models without image input", () => {
    const payload: Record<string, unknown> = {
      input: [
        {
          type: "function_call_output",
          call_id: "call_1",
          output: [
            {
              type: "input_image",
              detail: "auto",
              image_url: "data:image/png;base64,QUJDRA==",
            },
          ],
        },
      ],
    };
    runXaiToolPayloadWrapper({ payload, input: ["text"] });

    expect(payload.input).toEqual([
      {
        type: "function_call_output",
        call_id: "call_1",
        output: "(see attached image)",
      },
    ]);
  });

  it("uses audio fallback text for audio-only tool outputs", () => {
    const payload: Record<string, unknown> = {
      input: [
        {
          type: "function_call_output",
          call_id: "call_audio",
          output: [
            {
              type: "input_audio",
              mimeType: "audio/wav",
              data: "QUJDRA==",
            },
          ],
        },
      ],
    };
    runXaiToolPayloadWrapper({ payload, input: ["text"] });

    expect(payload.input).toEqual([
      {
        type: "function_call_output",
        call_id: "call_audio",
        output: "(see attached audio)",
      },
    ]);
  });
});
