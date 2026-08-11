import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from "vitest";
import { configureAiTransportHost, getAiTransportHost } from "../host.js";
import type { BaseOpenAIStreamOptions } from "../provider-options.js";
import {
  closeOpenAICodexWebSocketSessions,
  resetOpenAICodexWebSocketStateForTest,
  streamOpenAICodexResponses,
} from "../providers/openai-chatgpt-responses.js";
import { streamOpenAIResponses } from "../providers/openai-responses.js";
import type { AssistantMessageEventStreamLike, Context, Model, StreamFn } from "../types.js";
import {
  createAzureOpenAIResponsesTransportStreamFn,
  createOpenAIResponsesTransportStreamFn,
} from "./openai-responses-client.js";

const openAIModel = {
  id: "gpt-5.6-luna",
  name: "Responses hook lifecycle",
  api: "openai-responses",
  provider: "openai",
  baseUrl: "https://api.openai.com/v1",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128_000,
  maxTokens: 4_096,
} satisfies Model<"openai-responses">;

const azureModel = {
  ...openAIModel,
  api: "azure-openai-responses",
  provider: "azure-openai-responses",
  baseUrl: "https://project.services.ai.azure.com/openai/v1",
} satisfies Model<"azure-openai-responses">;

const chatGptModel = {
  ...openAIModel,
  api: "openai-chatgpt-responses",
  baseUrl: "https://chatgpt.test/backend-api",
  reasoning: true,
} satisfies Model<"openai-chatgpt-responses">;

const context = {
  messages: [{ role: "user", content: "hello", timestamp: 1 }],
} satisfies Context;

const chatGptToken = (() => {
  const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
  const body = Buffer.from(
    JSON.stringify({
      "https://api.openai.com/auth": { chatgpt_account_id: "acct-response-hook" },
    }),
  ).toString("base64url");
  return `${header}.${body}.signature`;
})();

type RequestLifecycle = {
  requestAborted: ReturnType<typeof vi.fn>;
  assertListenersRemoved(): void;
};

function completedResponse(init?: ResponseInit): Response {
  const response = {
    id: "resp_response_hook",
    object: "response",
    status: "completed",
    model: openAIModel.id,
    output: [
      {
        id: "msg_response_hook",
        type: "message",
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text: "hello", annotations: [] }],
      },
    ],
    usage: { input_tokens: 5, output_tokens: 3, total_tokens: 8 },
  };
  const events = [
    { type: "response.created", response: { ...response, output: [], status: "in_progress" } },
    { type: "response.completed", response },
  ];
  const body = `${events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")}data: [DONE]\n\n`;
  return new Response(body, {
    status: 202,
    headers: {
      "content-type": "text/event-stream",
      "x-ratelimit-remaining-requests": "42",
      "x-request-id": "req_observable",
    },
    ...init,
  });
}

function trackedFetch(responseFactory: () => Response): {
  fetch: typeof fetch;
  lifecycle: RequestLifecycle;
} {
  let addAbortListener: MockInstance<AbortSignal["addEventListener"]> | undefined;
  let removeAbortListener: MockInstance<AbortSignal["removeEventListener"]> | undefined;
  const requestAborted = vi.fn();
  const fetchMock = vi.fn<typeof fetch>(async (_input, init) => {
    const signal = init?.signal;
    if (signal) {
      signal.addEventListener("abort", requestAborted, { once: true });
      addAbortListener = vi.spyOn(signal, "addEventListener");
      removeAbortListener = vi.spyOn(signal, "removeEventListener");
    }
    return responseFactory();
  });
  return {
    fetch: fetchMock,
    lifecycle: {
      requestAborted,
      assertListenersRemoved() {
        for (const [event, listener] of addAbortListener?.mock.calls ?? []) {
          if (event === "abort") {
            expect(removeAbortListener).toHaveBeenCalledWith("abort", listener);
          }
        }
      },
    },
  };
}

function installSdkResponse(): RequestLifecycle {
  const tracked = trackedFetch(completedResponse);
  configureAiTransportHost({ buildModelFetch: () => tracked.fetch });
  return tracked.lifecycle;
}

function installChatGptResponse(): RequestLifecycle {
  const tracked = trackedFetch(completedResponse);
  vi.stubGlobal("fetch", tracked.fetch);
  return tracked.lifecycle;
}

function createManagedFixtureStream(
  createStream: StreamFn,
  model: Model,
  options?: BaseOpenAIStreamOptions,
): AssistantMessageEventStreamLike {
  const result = createStream(model, context, { apiKey: "fixture-token", ...options });
  if (result instanceof Promise) {
    throw new Error("OpenAI Responses transport must return its event stream synchronously");
  }
  return result;
}

const managedOpenAIStream = createOpenAIResponsesTransportStreamFn();
const managedAzureStream = createAzureOpenAIResponsesTransportStreamFn();

const fixtures = [
  {
    name: "SDK OpenAI",
    model: openAIModel,
    installResponse: installSdkResponse,
    createStream: (options?: BaseOpenAIStreamOptions) =>
      createManagedFixtureStream(managedOpenAIStream, openAIModel, options),
  },
  {
    name: "SDK Azure",
    model: azureModel,
    installResponse: installSdkResponse,
    createStream: (options?: BaseOpenAIStreamOptions) =>
      createManagedFixtureStream(managedAzureStream, azureModel, options),
  },
  {
    name: "shared Responses provider",
    model: openAIModel,
    installResponse: installSdkResponse,
    createStream: (options?: BaseOpenAIStreamOptions) =>
      streamOpenAIResponses(openAIModel, context, { apiKey: "fixture-token", ...options }),
  },
  {
    name: "native ChatGPT SSE",
    model: chatGptModel,
    installResponse: installChatGptResponse,
    createStream: (options?: BaseOpenAIStreamOptions) =>
      streamOpenAICodexResponses(chatGptModel, context, {
        apiKey: chatGptToken,
        transport: "sse",
        ...options,
      }),
  },
];

async function settleWithin<T>(promise: Promise<T>, timeoutMs = 500): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("response hook lifecycle timed out")), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

let previousHost: ReturnType<typeof getAiTransportHost>;

beforeEach(() => {
  previousHost = getAiTransportHost();
});

afterEach(() => {
  closeOpenAICodexWebSocketSessions();
  resetOpenAICodexWebSocketStateForTest();
  configureAiTransportHost(previousHost);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe.each(fixtures)("$name response hook", ({ createStream, installResponse, model }) => {
  it("awaits response metadata before exposing the first stream event", async () => {
    installResponse();
    const order: string[] = [];
    let continueHook!: () => void;
    const hookCompleted = new Promise<void>((resolve) => {
      continueHook = resolve;
    });
    const onResponse = vi.fn(async () => {
      order.push("hook:start");
      await hookCompleted;
      order.push("hook:end");
    });
    const stream = createStream({ onResponse });
    const consume = (async () => {
      for await (const event of stream) {
        order.push(event.type);
      }
    })();

    await vi.waitFor(() => expect(onResponse).toHaveBeenCalledOnce());
    expect(order).toEqual(["hook:start"]);
    expect(onResponse).toHaveBeenCalledWith(
      {
        status: 202,
        headers: {
          "content-type": "text/event-stream",
          "x-ratelimit-remaining-requests": "42",
          "x-request-id": "req_observable",
        },
      },
      model,
    );

    continueHook();
    await consume;
    expect((await stream.result()).stopReason).toBe("stop");
    expect(order.slice(0, 3)).toEqual(["hook:start", "hook:end", "start"]);
  });

  it.each(["throw", "reject"] as const)(
    "preserves a hook %s and aborts the unread request",
    async (failure) => {
      const lifecycle = installResponse();
      const hookError = new Error("after_provider_response hook failed");
      const onResponse = vi.fn(() => {
        if (failure === "throw") {
          throw hookError;
        }
        return Promise.reject(hookError);
      });
      const stream = createStream({ onResponse });
      const eventTypes: string[] = [];
      for await (const event of stream) {
        eventTypes.push(event.type);
      }
      const result = await stream.result();

      expect(onResponse).toHaveBeenCalledOnce();
      expect(result).toMatchObject({
        stopReason: "error",
        errorMessage: "after_provider_response hook failed",
      });
      expect(eventTypes).toEqual(["error"]);
      expect(lifecycle.requestAborted).toHaveBeenCalledOnce();
      lifecycle.assertListenersRemoved();
    },
  );

  it("applies the first-event timeout while the hook is pending", async () => {
    const lifecycle = installResponse();
    const onFirstEventTimeout = vi.fn();
    const onResponse = vi.fn(() => new Promise<void>(() => {}));
    const stream = createStream({
      firstEventTimeoutMs: 20,
      onFirstEventTimeout,
      onResponse,
    });
    const eventTypes: string[] = [];
    const consume = (async () => {
      for await (const event of stream) {
        eventTypes.push(event.type);
      }
    })();
    const result = await settleWithin(stream.result());
    await consume;

    expect(onResponse).toHaveBeenCalledOnce();
    expect(result.stopReason).toBe("error");
    expect(result.errorMessage).toMatch(
      /responses HTTP stream opened but did not deliver a first SSE event within 20ms/,
    );
    expect(onFirstEventTimeout).toHaveBeenCalledWith(expect.any(Error));
    expect(eventTypes).toEqual(["error"]);
    expect(lifecycle.requestAborted).toHaveBeenCalledOnce();
    lifecycle.assertListenersRemoved();
  });

  it.each(["resolve", "reject"] as const)(
    "keeps caller cancellation terminal after a late hook %s",
    async (settlement) => {
      const lifecycle = installResponse();
      const controller = new AbortController();
      let settleHook!: () => void;
      const pendingHook = new Promise<void>((resolve, reject) => {
        settleHook = () => {
          if (settlement === "resolve") {
            resolve();
          } else {
            reject(new Error("late response hook rejection"));
          }
        };
      });
      const onResponse = vi.fn(() => pendingHook);
      const stream = createStream({ signal: controller.signal, onResponse });
      const eventTypes: string[] = [];
      const consume = (async () => {
        for await (const event of stream) {
          eventTypes.push(event.type);
        }
      })();

      await vi.waitFor(() => expect(onResponse).toHaveBeenCalledOnce());
      const abortReason = Object.assign(new Error("caller canceled the provider response"), {
        code: "CALLER_ABORTED",
      });
      controller.abort(abortReason);
      const result = await settleWithin(stream.result());
      await consume;
      expect(result).toMatchObject({
        stopReason: "aborted",
        errorCode: "CALLER_ABORTED",
        errorMessage: "caller canceled the provider response",
      });
      expect(eventTypes).toEqual(["error"]);
      expect(lifecycle.requestAborted).toHaveBeenCalledOnce();

      settleHook();
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
      expect(eventTypes).toEqual(["error"]);
      lifecycle.assertListenersRemoved();
    },
  );
});

describe("native ChatGPT SSE non-success response hooks", () => {
  it("runs the hook for every retry response before the successful SSE stream", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response("overloaded", { status: 503, headers: { "retry-after-ms": "0" } }),
      )
      .mockResolvedValueOnce(completedResponse());
    vi.stubGlobal("fetch", fetchMock);
    const onResponse = vi.fn();

    const result = await streamOpenAICodexResponses(chatGptModel, context, {
      apiKey: chatGptToken,
      transport: "sse",
      maxRetries: 1,
      onResponse,
    }).result();

    expect(result.stopReason).toBe("stop");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(onResponse.mock.calls.map(([response]) => response.status)).toEqual([503, 202]);
  });

  it("cancels a terminal non-success body when its hook rejects", async () => {
    const bodyCancelled = vi.fn();
    let sentBody = false;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (!sentBody) {
          sentBody = true;
          controller.enqueue(new TextEncoder().encode('{"error":{"message":"bad request"}}'));
        }
      },
      cancel: bodyCancelled,
    });
    vi.stubGlobal(
      "fetch",
      vi
        .fn<typeof fetch>()
        .mockResolvedValue(
          new Response(body, { status: 400, headers: { "content-type": "application/json" } }),
        ),
    );

    const result = await settleWithin(
      streamOpenAICodexResponses(chatGptModel, context, {
        apiKey: chatGptToken,
        transport: "sse",
        maxRetries: 0,
        onResponse: async () => {
          throw new Error("non-success response hook failed");
        },
      }).result(),
    );

    expect(result).toMatchObject({
      stopReason: "error",
      errorMessage: "non-success response hook failed",
    });
    expect(bodyCancelled).toHaveBeenCalledOnce();
  });

  it("times out a stalled non-success hook and cancels its body", async () => {
    const bodyCancelled = vi.fn();
    const body = new ReadableStream<Uint8Array>({
      pull() {},
      cancel: bodyCancelled,
    });
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>().mockResolvedValue(new Response(body, { status: 503 })),
    );
    const onFirstEventTimeout = vi.fn();

    const result = await settleWithin(
      streamOpenAICodexResponses(chatGptModel, context, {
        apiKey: chatGptToken,
        transport: "sse",
        maxRetries: 0,
        firstEventTimeoutMs: 20,
        onFirstEventTimeout,
        onResponse: () => new Promise<void>(() => {}),
      }).result(),
    );

    expect(result.stopReason).toBe("error");
    expect(result.errorMessage).toMatch(
      /responses HTTP stream opened but did not deliver a first SSE event within 20ms/,
    );
    expect(onFirstEventTimeout).toHaveBeenCalledWith(expect.any(Error));
    expect(bodyCancelled).toHaveBeenCalledOnce();
  });
});
