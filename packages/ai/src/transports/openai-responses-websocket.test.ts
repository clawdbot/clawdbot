import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const websocketState = vi.hoisted(() => ({
  instances: [] as Array<{
    socket: { readyState: number };
    closed: boolean;
    emitError(error: Error): void;
  }>,
  clients: [] as Array<{ apiKey?: string }>,
  options: [] as Array<{ headers?: Record<string, string> }>,
  requests: [] as Array<Record<string, unknown>>,
  responseBatches: [] as Array<Array<Record<string, unknown>>>,
}));

vi.mock("openai/resources/responses/ws.js", () => ({
  ResponsesWS: class MockResponsesWS {
    socket = { readyState: 1 };
    closed = false;
    private events: Array<Record<string, unknown>> = [];
    private errorListeners: Array<(error: Error) => void> = [];

    constructor(client: { apiKey?: string }, options: { headers?: Record<string, string> }) {
      websocketState.instances.push(this);
      websocketState.clients.push(client);
      websocketState.options.push(options);
    }

    send(request: Record<string, unknown>) {
      websocketState.requests.push(request);
      this.events = websocketState.responseBatches.shift() ?? [];
    }

    close() {
      this.closed = true;
      this.socket.readyState = 3;
    }

    on(event: string, listener: (error: Error) => void) {
      if (event === "error") {
        this.errorListeners.push(listener);
      }
      return this;
    }

    emitError(error: Error) {
      for (const listener of this.errorListeners) {
        listener(error);
      }
    }

    stream() {
      const readEvents = () => this.events;
      return (async function* () {
        yield { type: "open" as const };
        for (const message of readEvents()) {
          yield { type: "message" as const, message };
        }
      })();
    }
  },
}));

import { configureAiTransportHost, getAiTransportHost } from "../host.js";
import { cleanupSessionResources } from "../session-resources.js";
import {
  createOpenAIResponsesWebSocketStream,
  supportsNativeOpenAIResponsesEndpoint,
} from "./openai-responses-websocket.js";

const initialHost = getAiTransportHost();
const clientFixture = {
  apiKey: "test-key",
  baseURL: "https://api.openai.com/v1",
  withOptions(options: { apiKey?: string }) {
    return { ...this, ...options };
  },
};
const client = clientFixture as never;
const firstUser = { role: "user", content: "first" };
const assistantOutput = {
  type: "message",
  id: "msg_1",
  role: "assistant",
  status: "completed",
  content: [{ type: "output_text", text: "one", annotations: [] }],
  phase: "final_answer",
};

function completion(responseId: string, output: Array<Record<string, unknown>> = []) {
  return {
    type: "response.completed",
    response: {
      id: responseId,
      status: "completed",
      output,
      usage: { input_tokens: 5, output_tokens: 3, total_tokens: 8 },
    },
  };
}

async function consume(stream: AsyncIterable<unknown>): Promise<unknown[]> {
  const events: unknown[] = [];
  for await (const event of stream) {
    events.push(event);
  }
  return events;
}

async function consumeResponse(response: ReturnType<typeof createOpenAIResponsesWebSocketStream>) {
  const events = await consume(response.stream);
  response.finish();
  return events;
}

function createStream(request: Record<string, unknown>, overrides: { sessionId?: string } = {}) {
  return createOpenAIResponsesWebSocketStream({
    client,
    request,
    mode: "websocket-cached",
    sessionId: overrides.sessionId ?? "session-1",
    headers: { "x-stable-session": "session-1" },
  });
}

describe("native OpenAI Responses WebSocket transport", () => {
  beforeEach(() => {
    websocketState.instances.length = 0;
    websocketState.clients.length = 0;
    websocketState.options.length = 0;
    websocketState.requests.length = 0;
    websocketState.responseBatches.length = 0;
    configureAiTransportHost(initialHost);
  });

  afterEach(() => {
    cleanupSessionResources();
    configureAiTransportHost(initialHost);
  });

  it("only enables WebSockets for the official native OpenAI Responses endpoint", () => {
    expect(
      supportsNativeOpenAIResponsesEndpoint({
        provider: "openai",
        api: "openai-responses",
        baseUrl: "https://api.openai.com/v1",
      }),
    ).toBe(true);
  });

  it.each([
    ["missing version path", "openai", "https://api.openai.com"],
    ["compatible endpoint", "openai", "https://compatible.example/v1"],
    ["missing endpoint", "openai", undefined],
    ["credentials and URL components", "openai", "https://user:pass@api.openai.com/v1?q=x#x"],
    ["lookalike host", "openai", "https://api.openai.com.evil.example/v1"],
    ["different provider", "azure-openai", "https://api.openai.com/v1"],
  ])("rejects %s", (_name, provider, baseUrl) => {
    expect(
      supportsNativeOpenAIResponsesEndpoint({ provider, api: "openai-responses", baseUrl }),
    ).toBe(false);
  });

  it("rejects an effective SDK client endpoint that is not the official API", () => {
    const compatibleClient = {
      ...clientFixture,
      baseURL: "https://compatible.example/v1",
    } as never;

    expect(() =>
      createOpenAIResponsesWebSocketStream({
        client: compatibleClient,
        request: { model: "gpt-5.6-luna", input: [firstUser] },
        mode: "websocket",
      }),
    ).toThrow("official API endpoint");
    expect(websocketState.instances).toHaveLength(0);
  });

  it("resolves credentials and forwards stable headers at the WebSocket boundary", async () => {
    configureAiTransportHost({
      ...initialHost,
      resolveSecretSentinel: (value) => value.replaceAll("SECRET_SENTINEL", "resolved"),
    });
    websocketState.responseBatches.push([completion("resp_1")]);
    const sentinelClient = {
      apiKey: "SECRET_SENTINEL-key",
      baseURL: "https://api.openai.com/v1",
      withOptions(options: { apiKey?: string }) {
        return { ...this, ...options };
      },
    };

    const response = createOpenAIResponsesWebSocketStream({
      client: sentinelClient as never,
      request: { model: "gpt-5.6-luna", input: [firstUser] },
      mode: "websocket",
      headers: {
        Authorization: "Bearer should-not-override-api-key",
        "x-provider-auth": "SECRET_SENTINEL-header",
      },
    });
    await consumeResponse(response);

    expect(websocketState.clients[0]?.apiKey).toBe("resolved-key");
    expect(websocketState.options[0]?.headers).toEqual({
      "x-provider-auth": "resolved-header",
    });
  });

  it("continues across equivalent request ordering, omissions, and persisted reasoning replay", async () => {
    const reasoning = { type: "reasoning", id: "rs_1", encrypted_content: "ciphertext" };
    websocketState.responseBatches.push(
      [completion("resp_1", [reasoning, assistantOutput])],
      [completion("resp_2")],
    );
    await consumeResponse(
      createStream({
        model: "gpt-5.6-luna",
        metadata: { beta: "2", alpha: "1" },
        max_output_tokens: undefined,
        input: [firstUser],
      }),
    );

    const second = createStream({
      input: [
        firstUser,
        { type: "reasoning", summary: [] },
        assistantOutput,
        { role: "user", content: "second" },
      ],
      metadata: { alpha: "1", beta: "2" },
      model: "gpt-5.6-luna",
    });

    expect(second.continuationStatus).toBe("continued");
    expect(second.request.input).toEqual([{ role: "user", content: "second" }]);
    await consumeResponse(second);
  });

  it("fails closed when a non-assistant history item changes", async () => {
    const firstInput = {
      type: "message",
      role: "user",
      id: "input_1",
      status: "completed",
      content: [{ type: "input_text", text: "first" }],
    };
    websocketState.responseBatches.push(
      [completion("resp_1", [assistantOutput])],
      [completion("resp_2")],
    );
    await consumeResponse(createStream({ model: "gpt-5.6-luna", input: [firstInput] as never }));

    const second = createStream({
      model: "gpt-5.6-luna",
      input: [
        { ...firstInput, id: "input_changed" },
        assistantOutput,
        { role: "user", content: "second" },
      ] as never,
    });

    expect(second.continuationStatus).toBe("history_changed");
    expect(second.request).not.toHaveProperty("previous_response_id");
    await consumeResponse(second);
  });

  it("does not retain a continuation after a terminal incomplete response", async () => {
    websocketState.responseBatches.push(
      [completion("resp_1", [assistantOutput])],
      [
        {
          type: "response.incomplete",
          response: { id: "resp_2", status: "incomplete", output: [] },
        },
      ],
      [completion("resp_3")],
    );
    const initial = { model: "gpt-5.6-luna", input: [firstUser] };
    await consumeResponse(createStream(initial));

    const secondRequest = {
      ...initial,
      input: [firstUser, assistantOutput, { role: "user", content: "second" }],
    };
    const second = createStream(secondRequest);
    expect(second.continuationStatus).toBe("continued");
    await consumeResponse(second);

    const third = createStream({
      ...secondRequest,
      input: [...secondRequest.input, { role: "user", content: "third" }],
    });
    expect(third.continuationStatus).toBe("no_previous_response");
    expect(third.request).not.toHaveProperty("previous_response_id");
    await consumeResponse(third);
    expect(websocketState.instances).toHaveLength(1);
  });

  it.each([
    {
      name: "tool schema change",
      mutate: (request: Record<string, unknown>) => ({
        ...request,
        tools: [{ type: "function", name: "write", parameters: { type: "object" } }],
      }),
    },
    {
      name: "history rewrite",
      mutate: (request: Record<string, unknown>) => ({
        ...request,
        input: [{ role: "user", content: "rewritten" }],
      }),
    },
    {
      name: "assistant phase change",
      mutate: (request: Record<string, unknown>) => ({
        ...request,
        input: [
          firstUser,
          { ...assistantOutput, phase: "commentary" },
          { role: "user", content: "second" },
        ],
      }),
    },
  ])("resets continuation on $name", async ({ mutate }) => {
    websocketState.responseBatches.push(
      [completion("resp_1", [assistantOutput])],
      [completion("resp_2")],
    );
    const initial = {
      model: "gpt-5.6-luna",
      stream: true,
      store: false,
      instructions: "stable prompt",
      tools: [{ type: "function", name: "read", parameters: { type: "object" } }],
      input: [firstUser],
    };
    await consumeResponse(createStream(initial));

    const changed = createStream(
      mutate({
        ...initial,
        input: [firstUser, assistantOutput, { role: "user", content: "second" }],
      }),
    );
    expect(changed.continuationStatus).not.toBe("continued");
    expect(changed.request).not.toHaveProperty("previous_response_id");
    await consumeResponse(changed);
    expect(websocketState.instances).toHaveLength(1);
  });

  it("uses a transient socket for a concurrent request and preserves the cached owner", async () => {
    websocketState.responseBatches.push(
      [completion("resp_cached")],
      [completion("resp_transient")],
      [completion("resp_reused")],
    );
    const request = { model: "gpt-5.6-luna", stream: true, input: [firstUser] };
    const cached = createStream(request);
    const concurrent = createStream(request);

    await consumeResponse(cached);
    await consumeResponse(concurrent);
    await consumeResponse(createStream(request));

    expect(websocketState.instances).toHaveLength(2);
    expect(websocketState.instances[1]?.closed).toBe(true);
    expect(websocketState.instances[0]?.closed).toBe(false);
  });

  it("evicts a cached idle socket when its lifetime error listener fires", async () => {
    websocketState.responseBatches.push([completion("resp_1")], [completion("resp_2")]);
    const request = { model: "gpt-5.6-luna", input: [firstUser] };
    await consumeResponse(createStream(request));

    websocketState.instances[0]?.emitError(new Error("idle connection failed"));
    expect(websocketState.instances[0]?.closed).toBe(true);

    await consumeResponse(createStream(request));
    expect(websocketState.instances).toHaveLength(2);
  });

  it("closes only the requested session resources", async () => {
    websocketState.responseBatches.push([completion("resp_1")], [completion("resp_2")]);
    await consumeResponse(createStream({ model: "gpt-5.6-luna", input: [firstUser] }));
    await consumeResponse(
      createStream(
        { model: "gpt-5.6-luna", input: [{ role: "user", content: "other" }] },
        { sessionId: "session-2" },
      ),
    );

    cleanupSessionResources("session-1");
    expect(websocketState.instances[0]?.closed).toBe(true);
    expect(websocketState.instances[1]?.closed).toBe(false);
  });
});
