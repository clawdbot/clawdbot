import { Agent, type StreamFn } from "@mariozechner/pi-agent-core";
import {
  createAssistantMessageEventStream,
  type AssistantMessage,
  type Context,
  type Model,
  type SimpleStreamOptions,
} from "@mariozechner/pi-ai";
import { streamSimpleOpenAICodexResponses } from "@mariozechner/pi-ai/openai-codex-responses";
import { streamSimpleOpenAIResponses } from "@mariozechner/pi-ai/openai-responses";
import { describe, expect, it } from "vitest";

type ResponsesModel = Model<"openai-responses"> | Model<"openai-codex-responses">;

const openaiModel = {
  api: "openai-responses",
  provider: "openai",
  id: "gpt-5.5",
  input: ["text"],
  reasoning: true,
} as Model<"openai-responses">;

const codexModel = {
  api: "openai-codex-responses",
  provider: "openai-codex",
  id: "gpt-5.5",
  input: ["text"],
  reasoning: true,
  baseUrl: "https://chatgpt.com/backend-api",
} as Model<"openai-codex-responses">;

const codexTestToken = [
  "eyJhbGciOiJub25lIn0",
  "eyJodHRwczovL2FwaS5vcGVuYWkuY29tL2F1dGgiOnsiY2hhdGdwdF9hY2NvdW50X2lkIjoiYWNjdF90ZXN0In19",
  "signature",
].join(".");

describe("OpenAI thinking contract", () => {
  it.each([
    { model: openaiModel, expectedReasoning: "high" },
    { model: codexModel, expectedReasoning: "high" },
  ])(
    "forwards enabled session thinkingLevel to pi-ai options for $model.provider/$model.id",
    async ({ model, expectedReasoning }) => {
      const capturedOptions: SimpleStreamOptions[] = [];
      const agent = new Agent({
        initialState: {
          model,
          thinkingLevel: "high",
        },
        streamFn: createCapturingStreamFn(model, capturedOptions),
      });

      await agent.prompt("hello");

      expect(capturedOptions).toHaveLength(1);
      expect(capturedOptions[0]?.reasoning).toBe(expectedReasoning);
    },
  );

  it.each([openaiModel, codexModel])(
    "does not forward reasoning when session thinkingLevel is off for $provider/$id",
    async (model) => {
      const capturedOptions: SimpleStreamOptions[] = [];
      const agent = new Agent({
        initialState: {
          model,
          thinkingLevel: "off",
        },
        streamFn: createCapturingStreamFn(model, capturedOptions),
      });

      await agent.prompt("hello");

      expect(capturedOptions).toHaveLength(1);
      expect(capturedOptions[0]?.reasoning).toBeUndefined();
    },
  );

  it("serializes OpenAI Responses reasoning effort from pi-ai simple options", async () => {
    const payload = await captureProviderPayload({
      model: openaiModel,
      streamFn: streamSimpleOpenAIResponses,
      options: { reasoning: "high" },
    });

    expect(payload.reasoning).toEqual({ effort: "high", summary: "auto" });
  });

  it("serializes Codex Responses reasoning effort from pi-ai simple options", async () => {
    const payload = await captureProviderPayload({
      model: codexModel,
      streamFn: streamSimpleOpenAICodexResponses,
      options: { reasoning: "high", transport: "sse" },
    });

    expect(payload.reasoning).toEqual({ effort: "high", summary: "auto" });
  });

  it("leaves Codex Responses reasoning absent when pi-agent-core disables thinking", async () => {
    const payload = await captureProviderPayload({
      model: codexModel,
      streamFn: streamSimpleOpenAICodexResponses,
      options: { transport: "sse" },
    });

    expect(payload).not.toHaveProperty("reasoning");
  });

  it("keeps OpenAI Responses reasoning explicitly disabled when pi-agent-core disables thinking", async () => {
    const payload = await captureProviderPayload({
      model: openaiModel,
      streamFn: streamSimpleOpenAIResponses,
      options: {},
    });

    expect(payload.reasoning).toEqual({ effort: "none" });
  });
});

function createCapturingStreamFn(
  model: ResponsesModel,
  capturedOptions: SimpleStreamOptions[],
): StreamFn {
  return (_model, _context, options) => {
    capturedOptions.push({ ...options });
    const stream = createAssistantMessageEventStream();
    queueMicrotask(() => {
      stream.push({
        type: "done",
        reason: "stop",
        message: createAssistantMessage(model),
      });
    });
    return stream;
  };
}

function createAssistantMessage(model: ResponsesModel): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text: "ok" }],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: 0,
  };
}

async function captureProviderPayload<
  TApi extends "openai-responses" | "openai-codex-responses",
>(params: {
  model: Model<TApi>;
  streamFn: (
    model: Model<TApi>,
    context: Context,
    options?: SimpleStreamOptions,
  ) => ReturnType<StreamFn>;
  options: SimpleStreamOptions;
}): Promise<Record<string, unknown>> {
  const payloadPromise = new Promise<Record<string, unknown>>((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error(`provider payload callback was not invoked for ${params.model.api}`)),
      1_000,
    );
    const stream = params.streamFn(
      params.model,
      {
        messages: [{ role: "user", content: "hello", timestamp: 0 }],
      },
      {
        apiKey: params.model.api === "openai-codex-responses" ? codexTestToken : "test-api-key",
        cacheRetention: "none",
        ...params.options,
        onPayload: (payload) => {
          clearTimeout(timeout);
          resolve(structuredClone(payload as Record<string, unknown>));
          throw new Error("stop after payload capture");
        },
      },
    );
    void Promise.resolve(stream).then((resolvedStream) => resolvedStream.result());
  });

  return payloadPromise;
}
