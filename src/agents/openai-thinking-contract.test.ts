// Verifies session thinking levels reach OpenAI and Codex Responses transports.
import { createServer } from "node:http";
import { createLlmRuntime } from "@openclaw/ai";
import { Agent, type StreamFn } from "openclaw/plugin-sdk/agent-core";
import {
  createAssistantMessageEventStream,
  type AssistantMessage,
  type Context,
  type Model,
  type SimpleStreamOptions,
  streamSimple,
} from "openclaw/plugin-sdk/llm";
import { describe, expect, it } from "vitest";
import { resolveEmbeddedAgentStreamFn } from "./embedded-agent-runner/stream-resolution.js";

type ResponsesModel = Model<"openai-responses"> | Model<"openai-chatgpt-responses">;

const openaiModel = {
  api: "openai-responses",
  provider: "openai",
  id: "gpt-5.5",
  input: ["text"],
  reasoning: true,
} as Model<"openai-responses">;

const codexModel = {
  api: "openai-chatgpt-responses",
  provider: "openai",
  id: "gpt-5.5",
  input: ["text"],
  reasoning: true,
  baseUrl: "https://chatgpt.com/backend-api",
} as Model<"openai-chatgpt-responses">;

const codexTestToken = [
  "eyJhbGciOiJub25lIn0",
  "eyJodHRwczovL2FwaS5vcGVuYWkuY29tL2F1dGgiOnsiY2hhdGdwdF9hY2NvdW50X2lkIjoiYWNjdF90ZXN0In19",
  "signature",
].join(".");

describe("OpenAI thinking contract", () => {
  it.each(
    (["qwen", "qwen-chat-template"] as const).flatMap((thinkingFormat) =>
      (["managed", "direct"] as const).flatMap((transport) =>
        ([undefined, null, "low", "none"] as const).flatMap((offFallback) =>
          ([undefined, "off", "high"] as const).map((thinkingLevel) => ({
            thinkingFormat,
            transport,
            offFallback,
            thinkingLevel,
          })),
        ),
      ),
    ),
  )(
    "honors Agent $thinkingLevel with off=$offFallback over $transport $thinkingFormat HTTP",
    async ({ thinkingFormat, transport, offFallback, thinkingLevel }) => {
      const payload = await captureHttpProviderPayload({
        api: "openai-completions",
        thinkingFormat,
        transport,
        thinkingLevelMap: { off: offFallback },
        thinkingLevel,
        mode: "agent",
      });
      const thinking = thinkingFormat === "qwen" ? payload : payload.chat_template_kwargs;
      expect(thinking).toMatchObject({
        enable_thinking:
          thinkingLevel === "high" ||
          offFallback === "low" ||
          (offFallback === null && transport === "managed"),
      });
    },
  );

  it("preserves explicit Agent off when a managed Responses request asks for a summary", async () => {
    for (const thinkingLevel of ["off", "high"] as const) {
      const payload = await captureHttpProviderPayload({
        api: "openai-responses",
        thinkingLevel,
        reasoningSummary: "auto",
        mode: "agent",
      });
      expect(payload.reasoning).toEqual(
        thinkingLevel === "off" ? undefined : { effort: "high", summary: "auto" },
      );
    }
  });

  it("retains standalone managed defaults when no reasoning option is supplied", async () => {
    const completions = await captureHttpProviderPayload({
      api: "openai-completions",
      thinkingFormat: "qwen-chat-template",
      mode: "standalone",
    });
    expect(completions.chat_template_kwargs).toMatchObject({ enable_thinking: true });
    for (const reasoningSummary of [undefined, "auto"] as const) {
      const responses = await captureHttpProviderPayload({
        api: "openai-responses",
        reasoningSummary,
        mode: "standalone",
      });
      expect(responses.reasoning).toEqual(
        reasoningSummary ? { effort: "high", summary: "auto" } : undefined,
      );
    }
  });

  it.each([
    { model: openaiModel, expectedReasoning: "high" },
    { model: codexModel, expectedReasoning: "high" },
  ])(
    "forwards enabled session thinkingLevel to shared model runtime options for $model.provider/$model.id",
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

      expect(capturedOptions.map(({ reasoning }) => reasoning)).toStrictEqual([expectedReasoning]);
    },
  );

  it.each([openaiModel, codexModel])(
    "preserves explicit off when session thinkingLevel is off for $provider/$id",
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

      expect(capturedOptions.map(({ reasoning }) => reasoning)).toStrictEqual(["off"]);
    },
  );

  it("serializes OpenAI Responses reasoning effort from shared model runtime simple options", async () => {
    const payload = await captureProviderPayload({
      model: openaiModel,
      streamFn: streamSimple,
      options: { reasoning: "high" },
    });

    expect(payload.reasoning).toEqual({ effort: "high", summary: "auto" });
  });

  it("serializes Codex Responses reasoning effort from shared model runtime simple options", async () => {
    const payload = await captureProviderPayload({
      model: codexModel,
      streamFn: streamSimple,
      options: { reasoning: "high", transport: "sse" },
    });

    expect(payload.reasoning).toEqual({ effort: "high", summary: "auto" });
  });

  it.each([undefined, "off"] as const)(
    "leaves direct Codex Responses reasoning absent for %s",
    async (reasoning) => {
      const payload = await captureProviderPayload({
        model: codexModel,
        streamFn: streamSimple,
        options: { transport: "sse", reasoning },
      });

      expect(payload).not.toHaveProperty("reasoning");
    },
  );

  it.each([undefined, "off"] as const)(
    "keeps direct OpenAI Responses reasoning disabled for %s",
    async (reasoning) => {
      const payload = await captureProviderPayload({
        model: openaiModel,
        streamFn: streamSimple,
        options: { reasoning },
      });

      expect(payload.reasoning).toEqual({ effort: "none" });
    },
  );
});

async function captureHttpProviderPayload(params: {
  api: "openai-completions" | "openai-responses";
  thinkingFormat?: "qwen" | "qwen-chat-template";
  transport?: "managed" | "direct";
  thinkingLevelMap?: Model["thinkingLevelMap"];
  thinkingLevel?: "off" | "high";
  reasoningSummary?: "auto";
  mode: "agent" | "standalone";
}): Promise<Record<string, unknown>> {
  let payload: Record<string, unknown> | undefined;
  const server = createServer((request, response) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk: string) => {
      body += chunk;
    });
    request.on("end", () => {
      payload = JSON.parse(body) as Record<string, unknown>;
      const event =
        params.api === "openai-completions"
          ? {
              id: "chatcmpl_thinking",
              choices: [
                { index: 0, delta: { role: "assistant", content: "ok" }, finish_reason: "stop" },
              ],
            }
          : {
              type: "response.completed",
              response: { id: "resp_thinking", status: "completed", output: [] },
            };
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(`data: ${JSON.stringify(event)}\n\ndata: [DONE]\n\n`);
    });
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  try {
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Missing loopback server address");
    }
    const model: Model = {
      id: params.api === "openai-completions" ? "qwen3.6-27b" : "gpt-5.5",
      name: "Thinking contract model",
      api: params.api,
      provider: "local-thinking",
      baseUrl: `http://127.0.0.1:${address.port}/v1`,
      reasoning: true,
      thinkingLevelMap: params.thinkingLevelMap,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 128_000,
      maxTokens: 4_096,
      ...(params.thinkingFormat
        ? { compat: { thinkingFormat: params.thinkingFormat, supportsReasoningEffort: false } }
        : {}),
    };
    const providerStream =
      params.transport === "direct"
        ? streamSimple
        : resolveEmbeddedAgentStreamFn({
            llmRuntime: createLlmRuntime(),
            currentStreamFn: undefined,
            model,
            sessionId: "thinking-contract",
            resolvedApiKey: "synthetic-test-key",
          });
    const streamFn: StreamFn = (requestModel, context, options) =>
      providerStream(requestModel, context, {
        ...options,
        apiKey: "synthetic-test-key",
        ...(params.reasoningSummary ? { reasoningSummary: params.reasoningSummary } : {}),
      });
    if (params.mode === "agent") {
      const agent = new Agent({
        initialState: { model, thinkingLevel: params.thinkingLevel },
        streamFn,
      });
      await agent.prompt("hello");
      expect(agent.state.errorMessage).toBeUndefined();
    } else {
      const stream = await streamFn(model, {
        messages: [{ role: "user", content: "hello", timestamp: 0 }],
      });
      expect((await stream.result()).stopReason).toBe("stop");
    }
    if (!payload) {
      throw new Error("Provider did not receive a request");
    }
    return payload;
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
}

function createCapturingStreamFn(
  model: ResponsesModel,
  capturedOptions: SimpleStreamOptions[],
): StreamFn {
  // Captures Agent -> stream options while returning a complete assistant event.
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
  TApi extends "openai-responses" | "openai-chatgpt-responses",
>(params: {
  model: Model<TApi>;
  streamFn: (
    model: Model<TApi>,
    context: Context,
    options?: SimpleStreamOptions,
  ) => ReturnType<StreamFn>;
  options: SimpleStreamOptions;
}): Promise<Record<string, unknown>> {
  // Stop at onPayload so transport serialization can be asserted without HTTP.
  const payloadPromise = new Promise<Record<string, unknown>>((resolve, reject) => {
    let payloadCaptured = false;
    const abortController = new AbortController();
    abortController.abort(new Error("payload capture must not reach provider egress"));
    const stream = params.streamFn(
      params.model,
      {
        messages: [{ role: "user", content: "hello", timestamp: 0 }],
      },
      {
        apiKey: params.model.api === "openai-chatgpt-responses" ? codexTestToken : "test-api-key",
        cacheRetention: "none",
        ...params.options,
        signal: abortController.signal,
        onPayload: (payload) => {
          payloadCaptured = true;
          resolve(structuredClone(payload as Record<string, unknown>));
          throw new Error("stop after payload capture");
        },
      },
    );
    void Promise.resolve(stream).then(async (resolvedStream) => {
      const result = await resolvedStream.result();
      if (!payloadCaptured) {
        reject(
          new Error(
            `provider payload callback was not invoked for ${params.model.api}; stream ended with ${result.stopReason}: ${result.errorMessage ?? "no error"}`,
          ),
        );
      }
    }, reject);
  });

  return payloadPromise;
}
