import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from "vitest";
import { configureAiTransportHost, getAiTransportHost } from "../host.js";
import { streamOpenAICompletions } from "../providers/openai-completions.js";
import type { AssistantMessageEventStreamLike, Context, Model, StreamOptions } from "../types.js";
import { createOpenAICompletionsTransportStreamFn } from "./openai-completions-transport.js";

const model = {
  id: "gpt-5.5",
  name: "Response hook lifecycle",
  api: "openai-completions",
  provider: "openai",
  baseUrl: "https://api.openai.com/v1",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128_000,
  maxTokens: 4_096,
} satisfies Model<"openai-completions">;
const context = {
  messages: [{ role: "user", content: "hello", timestamp: 1 }],
} satisfies Context;

type RequestLifecycle = {
  requestAborted: ReturnType<typeof vi.fn>;
  assertListenersRemoved(): void;
};

function installResponse(): RequestLifecycle {
  let addAbortListener: MockInstance<AbortSignal["addEventListener"]> | undefined;
  let removeAbortListener: MockInstance<AbortSignal["removeEventListener"]> | undefined;
  const requestAborted = vi.fn();
  const chunk = {
    id: "chatcmpl-response-hook",
    object: "chat.completion.chunk",
    created: 1,
    model: model.id,
    choices: [{ index: 0, delta: { content: "hello" }, finish_reason: "stop" }],
  };
  const body = `data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`;
  configureAiTransportHost({
    buildModelFetch: () => async (_input, init) => {
      const signal = init?.signal;
      if (signal) {
        signal.addEventListener("abort", requestAborted, { once: true });
        addAbortListener = vi.spyOn(signal, "addEventListener");
        removeAbortListener = vi.spyOn(signal, "removeEventListener");
      }
      return new Response(body, {
        status: 202,
        headers: {
          "content-type": "text/event-stream",
          "x-ratelimit-remaining-requests": "42",
          "x-request-id": "req_observable",
        },
      });
    },
  });
  return {
    requestAborted,
    assertListenersRemoved() {
      for (const [event, listener] of addAbortListener?.mock.calls ?? []) {
        if (event === "abort") {
          expect(removeAbortListener).toHaveBeenCalledWith("abort", listener);
        }
      }
    },
  };
}

const createManagedStream = createOpenAICompletionsTransportStreamFn();

function createManagedFixtureStream(
  fixtureModel: Model<"openai-completions">,
  fixtureContext: Context,
  fixtureOptions?: StreamOptions,
): AssistantMessageEventStreamLike {
  const stream = createManagedStream(fixtureModel, fixtureContext, fixtureOptions);
  if (stream instanceof Promise) {
    throw new Error("OpenAI Chat transport must return its event stream synchronously");
  }
  return stream;
}

async function settleWithin<T>(promise: Promise<T>, timeoutMs = 250): Promise<T> {
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
  configureAiTransportHost(previousHost);
});

describe.each([
  { name: "package", createStream: streamOpenAICompletions },
  { name: "managed", createStream: createManagedFixtureStream },
])("$name OpenAI Chat response hook", ({ createStream }) => {
  it("awaits response metadata before exposing the first stream event", async () => {
    installResponse();
    const order: string[] = [];
    let continueHook!: () => void;
    const hookCompleted = new Promise<void>((resolve) => {
      continueHook = resolve;
    });
    const onProviderAccepted = vi.fn<NonNullable<StreamOptions["onProviderAccepted"]>>(
      (acceptance) => {
        order.push(`accepted:${acceptance.kind}`);
      },
    );
    const onResponse = vi.fn<NonNullable<StreamOptions["onResponse"]>>(async () => {
      order.push("hook:start");
      await hookCompleted;
      order.push("hook:end");
    });
    const stream = createStream(model, context, {
      apiKey: "fixture-token",
      onProviderAccepted,
      onResponse,
    });
    const consume = (async () => {
      for await (const event of stream) {
        order.push(event.type);
      }
    })();

    await vi.waitFor(() => expect(onResponse).toHaveBeenCalledOnce());
    expect(order).toEqual(["accepted:http_response", "hook:start"]);
    expect(onProviderAccepted).toHaveBeenCalledWith(
      {
        kind: "http_response",
        status: 202,
        headers: {
          "content-type": "text/event-stream",
          "x-ratelimit-remaining-requests": "42",
          "x-request-id": "req_observable",
        },
      },
      model,
    );
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
    expect(order.slice(0, 4)).toEqual([
      "accepted:http_response",
      "hook:start",
      "hook:end",
      "start",
    ]);
  });

  it.each(["throw", "reject"] as const)(
    "preserves a hook %s and closes the unread request",
    async (failure) => {
      const lifecycle = installResponse();
      const hookError = new Error("after_provider_response hook failed");
      const onResponse = vi.fn<NonNullable<StreamOptions["onResponse"]>>(() => {
        if (failure === "throw") {
          throw hookError;
        }
        return Promise.reject(hookError);
      });
      const stream = createStream(model, context, { apiKey: "fixture-token", onResponse });
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

  it("preserves an acceptance hook failure and closes the unread request", async () => {
    const lifecycle = installResponse();
    const hookError = new Error("provider acceptance hook failed");
    const onProviderAccepted = vi.fn(() => Promise.reject(hookError));
    const onResponse = vi.fn();
    const stream = createStream(model, context, {
      apiKey: "fixture-token",
      onProviderAccepted,
      onResponse,
    });
    const eventTypes: string[] = [];

    for await (const event of stream) {
      eventTypes.push(event.type);
    }

    expect(await stream.result()).toMatchObject({
      stopReason: "error",
      errorMessage: "provider acceptance hook failed",
    });
    expect(onProviderAccepted).toHaveBeenCalledOnce();
    expect(onResponse).not.toHaveBeenCalled();
    expect(eventTypes).toEqual(["error"]);
    expect(lifecycle.requestAborted).toHaveBeenCalledOnce();
  });

  it("applies the first-event timeout while the hook is pending", async () => {
    const lifecycle = installResponse();
    const onFirstEventTimeout = vi.fn();
    const onResponse = vi.fn(() => new Promise<void>(() => {}));
    const stream = createStream(model, context, {
      apiKey: "fixture-token",
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
      /completions HTTP stream opened but did not deliver a first SSE event within 20ms/,
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
      const stream = createStream(model, context, {
        apiKey: "fixture-token",
        signal: controller.signal,
        onResponse,
      });
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
