import { zstdDecompressSync } from "node:zlib";
import type { Api, Context, Model } from "@openclaw/llm-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { configureAiTransportHost, getAiTransportHost } from "../host.js";
import { responsesPromptObserver, type ResponsesPromptObservation } from "../internal/openai.js";
import {
  closeOpenAICodexWebSocketSessions,
  resetOpenAICodexWebSocketStateForTest,
  streamOpenAICodexResponses,
  streamSimpleOpenAICodexResponses,
} from "../providers/openai-chatgpt-responses.js";
import { SYSTEM_PROMPT_CACHE_BOUNDARY } from "../utils/system-prompt-cache-boundary.js";

const sdkState = vi.hoisted(() => ({
  clients: [] as Array<"openai" | "azure">,
  errors: [] as Error[],
  order: [] as string[],
  requests: [] as Array<Record<string, unknown>>,
}));

vi.mock("openai", () => {
  const createClient = (client: "openai" | "azure") =>
    class MockOpenAI {
      responses = {
        create: (request: Record<string, unknown>) => {
          sdkState.clients.push(client);
          sdkState.order.push(`${client}.create`);
          sdkState.requests.push(request);
          const error = sdkState.errors.shift() ?? new Error("stop after request");
          return {
            withResponse: async () => {
              throw error;
            },
          };
        },
      };
    };
  return { default: createClient("openai"), AzureOpenAI: createClient("azure") };
});

import {
  createAzureOpenAIResponsesTransportStreamFn,
  createOpenAIResponsesTransportStreamFn,
} from "./openai-responses-client.js";

const initialHost = getAiTransportHost();

function createModel<TApi extends Api = "openai-responses">(
  overrides: Partial<Model<TApi>> = {},
): Model<TApi> {
  return {
    id: "gpt-5.4",
    name: "GPT-5.4",
    api: "openai-responses",
    provider: "openai",
    baseUrl: "https://api.openai.com/v1",
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200_000,
    maxTokens: 8192,
    ...overrides,
  } as Model<TApi>;
}

function createContext(systemPrompt: string, overrides: Partial<Context> = {}): Context {
  return {
    systemPrompt,
    messages: [{ role: "user", content: "hello", timestamp: 1 }],
    tools: [],
    ...overrides,
  } as Context;
}

function createJwt(): string {
  const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "none", typ: "JWT" })}.${encode({
    "https://api.openai.com/auth": { chatgpt_account_id: "acct-1" },
  })}.signature`;
}

function completedSseResponse(responseId = "resp_test"): Response {
  return new Response(
    `data: ${JSON.stringify({
      type: "response.completed",
      response: {
        id: responseId,
        status: "completed",
        output: [],
        usage: { input_tokens: 5, output_tokens: 3, total_tokens: 8 },
      },
    })}\n\n`,
    { status: 200, headers: { "content-type": "text/event-stream" } },
  );
}

async function runObservedRequest(params: {
  context: Context;
  model?: Model;
  azure?: boolean;
  errors?: Error[];
  options?: Record<string, unknown>;
}) {
  const observations: ResponsesPromptObservation[] = [];
  const options = { apiKey: "test-key", ...params.options };
  const requestStart = sdkState.requests.length;
  const orderStart = sdkState.order.length;
  sdkState.errors = params.errors ?? [new Error("stop after request")];
  responsesPromptObserver.set(options, (observation) => {
    sdkState.order.push("observe");
    observations.push(observation);
  });
  const streamFn = params.azure
    ? createAzureOpenAIResponsesTransportStreamFn()
    : createOpenAIResponsesTransportStreamFn();
  const stream = await Promise.resolve(
    streamFn(params.model ?? createModel(), params.context, options as never),
  );
  expect((await stream.result()).stopReason).toBe("error");
  return {
    observations,
    order: sdkState.order.slice(orderStart),
    requests: sdkState.requests.slice(requestStart),
  };
}

beforeEach(() => {
  sdkState.clients = [];
  sdkState.errors = [];
  sdkState.order = [];
  sdkState.requests = [];
  configureAiTransportHost(initialHost);
});

afterEach(() => {
  closeOpenAICodexWebSocketSessions();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  resetOpenAICodexWebSocketStateForTest();
  configureAiTransportHost(initialHost);
});

describe("OpenAI Responses provider prompt observer", () => {
  it.each([
    { reasoning: true, promptSource: "input.developer" },
    { reasoning: false, promptSource: "input.system" },
  ] as const)("observes the final $promptSource prompt", async ({ reasoning, promptSource }) => {
    const prompt = `PRIVATE-${promptSource}-PROMPT`;
    const run = await runObservedRequest({
      context: createContext(prompt),
      model: createModel({ reasoning }),
    });

    expect(run.observations).toEqual([
      {
        egress: "responses-sdk",
        payloadVariant: "initial",
        promptSource,
        expectedChars: prompt.length,
        observedChars: prompt.length,
        matchesAssembledPrompt: true,
      },
    ]);
    expect(JSON.stringify(run.observations)).not.toContain(prompt);
  });

  it("observes Azure Responses egress", async () => {
    const prompt = "PRIVATE-AZURE-PROMPT";
    const run = await runObservedRequest({
      azure: true,
      context: createContext(prompt),
      model: createModel({
        api: "azure-openai-responses",
        provider: "azure-openai-responses",
        baseUrl: "https://example.openai.azure.com",
      }),
    });

    expect(sdkState.clients).toEqual(["azure"]);
    expect(run.order).toEqual(["observe", "azure.create"]);
    expect(run.observations[0]).toMatchObject({
      egress: "responses-sdk",
      payloadVariant: "initial",
      promptSource: "input.developer",
      matchesAssembledPrompt: true,
    });
  });

  it("observes the async replacement immediately before final transformed egress", async () => {
    const prompt = "PRIVATE-FINAL-TRANSFORMED-PROMPT";
    const tool = (name: string) => ({
      name,
      description: name,
      parameters: { type: "object", properties: {} },
    });
    configureAiTransportHost({
      ...initialHost,
      plugin: {
        ...initialHost.plugin,
        resolveTransportTurnState: () => ({ metadata: { host: "added" } }),
      },
    });
    const run = await runObservedRequest({
      context: createContext(prompt, { tools: [tool("exec"), tool("wait")] as never }),
      options: {
        openclawCodeModeToolSurface: true,
        onPayload: async () => {
          await Promise.resolve();
          return {
            model: "gpt-5.4",
            stream: true,
            metadata: { caller: "kept" },
            input: [
              { type: "message", role: "developer", content: prompt },
              {
                type: "message",
                role: "user",
                content: [{ type: "input_image", image_url: "data:image/png;base64,invalid!" }],
              },
            ],
            tools: [tool("exec"), tool("wait"), tool("rogue")],
          };
        },
      },
    });

    expect(run.order).toEqual(["observe", "openai.create"]);
    expect(run.observations[0]?.matchesAssembledPrompt).toBe(true);
    expect(run.requests[0]?.metadata).toEqual({ caller: "kept", host: "added" });
    expect(run.requests[0]?.tools).toEqual([tool("exec"), tool("wait")]);
    expect(JSON.stringify(run.requests[0]?.input)).toContain("omitted image payload");
  });

  it("observes initial and encrypted-content retry application attempts", async () => {
    const prompt = "PRIVATE-REPLAY-PROMPT";
    const invalidEncryptedContent = Object.assign(new Error("invalid encrypted content"), {
      code: "invalid_encrypted_content",
    });
    const run = await runObservedRequest({
      context: createContext(prompt),
      errors: [invalidEncryptedContent, new Error("stop after retry")],
      options: {
        onPayload: (request: Record<string, unknown>) => ({
          ...request,
          input: [
            ...((request.input as unknown[]) ?? []),
            { type: "reasoning", encrypted_content: "opaque", summary: [] },
          ],
        }),
      },
    });

    expect(run.order).toEqual(["observe", "openai.create", "observe", "openai.create"]);
    expect(run.observations.map((entry) => entry.payloadVariant)).toEqual([
      "initial",
      "encrypted-content-retry",
    ]);
    expect(run.observations.every((entry) => entry.egress === "responses-sdk")).toBe(true);
    expect(run.observations.every((entry) => entry.matchesAssembledPrompt)).toBe(true);
    expect(JSON.stringify(run.requests[0])).toContain("encrypted_content");
    expect(JSON.stringify(run.requests[1])).not.toContain("encrypted_content");
  });

  it("uses cache-boundary and surrogate normalization as the expected prompt owner", async () => {
    const systemPrompt = `stable${SYSTEM_PROMPT_CACHE_BOUNDARY}dynamic\ud800`;
    const normalizedPrompt = "stable\ndynamic";
    const run = await runObservedRequest({ context: createContext(systemPrompt) });

    expect(run.observations[0]).toMatchObject({
      expectedChars: normalizedPrompt.length,
      observedChars: normalizedPrompt.length,
      matchesAssembledPrompt: true,
    });
    const request = run.requests[0];
    if (!request) {
      throw new Error("missing captured request");
    }
    expect((request.input as Array<Record<string, unknown>>)[0]).toMatchObject({
      content: [{ type: "input_text", text: normalizedPrompt }],
    });
  });

  it("reports missing and same-length mutated prompts without retaining content", async () => {
    const missingPrompt = "PRIVATE-MISSING-PROMPT";
    const missing = await runObservedRequest({
      context: createContext(missingPrompt),
      options: {
        onPayload: () => ({
          model: "gpt-5.4",
          stream: true,
          input: [{ type: "message", role: "user", content: "hello" }],
        }),
      },
    });
    const mismatch = await runObservedRequest({
      context: createContext("trusted"),
      options: {
        onPayload: () => ({
          model: "gpt-5.4",
          stream: true,
          input: [{ type: "message", role: "developer", content: "altered" }],
        }),
      },
    });

    expect(missing.observations[0]).toMatchObject({
      promptSource: "missing",
      observedChars: 0,
      matchesAssembledPrompt: false,
    });
    expect(mismatch.observations[0]).toMatchObject({
      promptSource: "input.developer",
      expectedChars: 7,
      observedChars: 7,
      matchesAssembledPrompt: false,
    });
    expect(JSON.stringify([...missing.observations, ...mismatch.observations])).not.toContain(
      missingPrompt,
    );
  });

  it("observes each native WebSocket connection-limit dispatch before send", async () => {
    const prompt = "PRIVATE-NATIVE-WEBSOCKET-PROMPT";
    const observations: ResponsesPromptObservation[] = [];
    const order: string[] = [];
    const sentRequests: Array<Record<string, unknown>> = [];
    let connections = 0;
    class ConnectionLimitWebSocket extends EventTarget {
      private readonly limitReached = connections++ === 0;

      constructor() {
        super();
        queueMicrotask(() => this.dispatchEvent(new Event("open")));
      }

      send(payload: string): void {
        order.push("send");
        sentRequests.push(JSON.parse(payload) as Record<string, unknown>);
        const event = this.limitReached
          ? { type: "error", error: { code: "websocket_connection_limit_reached" } }
          : {
              type: "response.completed",
              response: {
                id: "resp_ws",
                status: "completed",
                output: [],
                usage: { input_tokens: 5, output_tokens: 3, total_tokens: 8 },
              },
            };
        queueMicrotask(() => {
          this.dispatchEvent(Object.assign(new Event("message"), { data: JSON.stringify(event) }));
        });
      }

      close(): void {}
    }
    vi.stubGlobal("WebSocket", ConnectionLimitWebSocket);
    vi.stubGlobal("fetch", vi.fn());
    const options = { apiKey: createJwt(), transport: "websocket" as const };
    responsesPromptObserver.set(options, (observation) => {
      order.push("observe");
      observations.push(observation);
    });

    const result = await streamOpenAICodexResponses(
      createModel({
        api: "openai-chatgpt-responses",
        baseUrl: "https://chatgpt.test/backend-api",
      }),
      createContext(prompt),
      options,
    ).result();

    expect(result.stopReason).toBe("stop");
    expect(connections).toBe(2);
    expect(order).toEqual(["observe", "send", "observe", "send"]);
    expect(sentRequests.map((request) => request.instructions)).toEqual([prompt, prompt]);
    expect(observations).toEqual([
      {
        egress: "native-codex-websocket",
        payloadVariant: "initial",
        promptSource: "instructions",
        expectedChars: prompt.length,
        observedChars: prompt.length,
        matchesAssembledPrompt: true,
      },
      {
        egress: "native-codex-websocket",
        payloadVariant: "initial",
        promptSource: "instructions",
        expectedChars: prompt.length,
        observedChars: prompt.length,
        matchesAssembledPrompt: true,
      },
    ]);
    expect(JSON.stringify(observations)).not.toContain(prompt);
  });

  it("forwards the private observer through simple options to final native SSE egress", async () => {
    const prompt = "PRIVATE-NATIVE-SSE-PROMPT";
    const observations: ResponsesPromptObservation[] = [];
    const order: string[] = [];
    let sentRequest: Record<string, unknown> | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input, init) => {
        order.push("fetch");
        const body =
          typeof init?.body === "string"
            ? init.body
            : zstdDecompressSync(init?.body as Uint8Array).toString("utf8");
        sentRequest = JSON.parse(body) as Record<string, unknown>;
        return completedSseResponse();
      }),
    );
    const options = {
      apiKey: createJwt(),
      transport: "sse" as const,
      onPayload: async (body: unknown) => {
        await Promise.resolve();
        return { ...(body as Record<string, unknown>), finalTransform: true };
      },
    };
    responsesPromptObserver.set(options, (observation) => {
      order.push("observe");
      observations.push(observation);
    });

    const result = await streamSimpleOpenAICodexResponses(
      createModel({
        api: "openai-chatgpt-responses",
        baseUrl: "https://chatgpt.test/backend-api",
      }),
      createContext(prompt),
      options,
    ).result();

    expect(result.stopReason).toBe("stop");
    expect(order).toEqual(["observe", "fetch"]);
    expect(sentRequest).toMatchObject({ instructions: prompt, finalTransform: true });
    expect(observations).toEqual([
      {
        egress: "native-codex-sse",
        payloadVariant: "initial",
        promptSource: "instructions",
        expectedChars: prompt.length,
        observedChars: prompt.length,
        matchesAssembledPrompt: true,
      },
    ]);
    expect(JSON.stringify(observations)).not.toContain(prompt);
  });

  it("observes only SSE when automatic WebSocket fallback happens before send", async () => {
    const prompt = "PRIVATE-PRE-SEND-FALLBACK-PROMPT";
    const observations: ResponsesPromptObservation[] = [];
    class FailingWebSocket {
      constructor() {
        throw new Error("websocket connect failed");
      }
      send(): void {}
      close(): void {}
      addEventListener(): void {}
      removeEventListener(): void {}
    }
    vi.stubGlobal("WebSocket", FailingWebSocket);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => completedSseResponse()),
    );
    const options = { apiKey: createJwt(), transport: "auto" as const };
    responsesPromptObserver.set(options, (observation) => observations.push(observation));

    const result = await streamOpenAICodexResponses(
      createModel({
        api: "openai-chatgpt-responses",
        baseUrl: "https://chatgpt.test/backend-api",
      }),
      createContext(prompt),
      options,
    ).result();

    expect(result.stopReason).toBe("stop");
    expect(observations.map((entry) => entry.egress)).toEqual(["native-codex-sse"]);
  });

  it("observes WebSocket then SSE when fallback happens after send", async () => {
    const prompt = "PRIVATE-POST-SEND-FALLBACK-PROMPT";
    const observations: ResponsesPromptObservation[] = [];
    const order: string[] = [];
    class SendThenFailWebSocket extends EventTarget {
      constructor() {
        super();
        queueMicrotask(() => this.dispatchEvent(new Event("open")));
      }

      send(): void {
        order.push("send");
        queueMicrotask(() =>
          this.dispatchEvent(
            Object.assign(new Event("error"), { message: "connection dropped after send" }),
          ),
        );
      }

      close(): void {}
    }
    vi.stubGlobal("WebSocket", SendThenFailWebSocket);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        order.push("fetch");
        return completedSseResponse();
      }),
    );
    const options = { apiKey: createJwt(), transport: "auto" as const };
    responsesPromptObserver.set(options, (observation) => {
      order.push(`observe:${observation.egress}`);
      observations.push(observation);
    });

    const result = await streamOpenAICodexResponses(
      createModel({
        api: "openai-chatgpt-responses",
        baseUrl: "https://chatgpt.test/backend-api",
      }),
      createContext(prompt),
      options,
    ).result();

    expect(result.stopReason).toBe("stop");
    expect(order).toEqual([
      "observe:native-codex-websocket",
      "send",
      "observe:native-codex-sse",
      "fetch",
    ]);
    expect(observations.map((entry) => entry.egress)).toEqual([
      "native-codex-websocket",
      "native-codex-sse",
    ]);
  });
});
