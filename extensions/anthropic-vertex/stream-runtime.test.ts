// Anthropic Vertex tests cover stream runtime plugin behavior.
import { once } from "node:events";
import { createServer } from "node:http";
import { createAssistantMessageEventStream, type Model } from "openclaw/plugin-sdk/llm";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { AnthropicVertexStreamDeps } from "./stream-runtime.js";

function createStreamDeps(): {
  deps: AnthropicVertexStreamDeps;
  streamAnthropicMock: ReturnType<typeof vi.fn>;
  anthropicVertexCtorMock: ReturnType<typeof vi.fn>;
  googleAuthCtorMock: ReturnType<typeof vi.fn>;
  googleAuthClient: InstanceType<AnthropicVertexStreamDeps["GoogleAuth"]>;
} {
  const streamAnthropicMock = vi.fn(
    (..._args: Parameters<AnthropicVertexStreamDeps["streamAnthropic"]>) =>
      createAssistantMessageEventStream(),
  );
  const anthropicVertexCtorMock = vi.fn();
  const MockAnthropicVertex = function MockAnthropicVertex(options: unknown) {
    anthropicVertexCtorMock(options);
  } as unknown as AnthropicVertexStreamDeps["AnthropicVertex"];
  const googleAuthCtorMock = vi.fn();
  const googleAuthClient = {} as InstanceType<AnthropicVertexStreamDeps["GoogleAuth"]>;
  const MockGoogleAuth = function MockGoogleAuth(options: unknown) {
    googleAuthCtorMock(options);
    return googleAuthClient;
  } as unknown as AnthropicVertexStreamDeps["GoogleAuth"];

  return {
    deps: {
      AnthropicVertex: MockAnthropicVertex,
      GoogleAuth: MockGoogleAuth,
      streamAnthropic: streamAnthropicMock,
    },
    streamAnthropicMock,
    anthropicVertexCtorMock,
    googleAuthCtorMock,
    googleAuthClient,
  };
}

let createAnthropicVertexStreamFn: typeof import("./stream-runtime.js").createAnthropicVertexStreamFn;
let createAnthropicVertexStreamFnForModel: typeof import("./stream-runtime.js").createAnthropicVertexStreamFnForModel;

function makeModel(params: {
  id: string;
  maxTokens?: number;
  params?: Record<string, unknown>;
  reasoning?: boolean;
  thinkingLevelMap?: Model<"anthropic-messages">["thinkingLevelMap"];
}): Model<"anthropic-messages"> {
  return {
    id: params.id,
    api: "anthropic-messages",
    provider: "anthropic-vertex",
    reasoning: params.reasoning ?? true,
    ...(params.maxTokens !== undefined ? { maxTokens: params.maxTokens } : {}),
    ...(params.params ? { params: params.params } : {}),
    ...(params.thinkingLevelMap ? { thinkingLevelMap: params.thinkingLevelMap } : {}),
  } as Model<"anthropic-messages">;
}

type PayloadHook = (payload: unknown, payloadModel: unknown) => Promise<unknown>;

function streamAnthropicCall(streamAnthropicMock: ReturnType<typeof vi.fn>): unknown[] {
  const call = streamAnthropicMock.mock.calls[0];
  if (!call) {
    throw new Error("Expected streamAnthropic call");
  }
  return call;
}

function streamTransportOptions(
  streamAnthropicMock: ReturnType<typeof vi.fn>,
): Record<string, unknown> {
  const options = streamAnthropicCall(streamAnthropicMock)[2];
  if (!options || typeof options !== "object") {
    throw new Error("Expected streamAnthropic transport options");
  }
  return options as Record<string, unknown>;
}

function captureTransportPayloadHook(
  onPayload: PayloadHook | undefined,
  deps: AnthropicVertexStreamDeps,
  streamAnthropicMock: ReturnType<typeof vi.fn>,
) {
  const streamFn = createAnthropicVertexStreamFn("vertex-project", "us-east5", undefined, deps);
  const model = makeModel({ id: "claude-sonnet-4-6", maxTokens: 64000 });

  void streamFn(
    model,
    { messages: [{ role: "user", content: "Hello" }] } as never,
    { cacheRetention: "short", ...(onPayload ? { onPayload } : {}) } as never,
  );

  const transportOptions = streamTransportOptions(streamAnthropicMock);

  return { model, onPayload: transportOptions.onPayload as PayloadHook | undefined };
}

// Mirrors the shared anthropic-messages transport output: cache boundary already
// split (uncached dynamic suffix) and all four cache_control markers allocated.
function buildBudgetedTransportPayload() {
  return {
    system: [
      { type: "text", text: "Stable prefix", cache_control: { type: "ephemeral" } },
      { type: "text", text: "Dynamic suffix" },
    ],
    tools: [
      { name: "exec", input_schema: { type: "object" }, cache_control: { type: "ephemeral" } },
    ],
    messages: [
      {
        role: "user",
        content: [{ type: "text", text: "Hello", cache_control: { type: "ephemeral" } }],
      },
      { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "exec", input: {} }] },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "t1",
            content: [],
            cache_control: { type: "ephemeral" },
          },
        ],
      },
    ],
  };
}

function countCacheControlMarkers(payload: unknown): number {
  let count = 0;
  const visit = (value: unknown) => {
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    if (!value || typeof value !== "object") {
      return;
    }
    const record = value as Record<string, unknown>;
    if (record.cache_control !== undefined) {
      count += 1;
    }
    visit(record.content);
  };
  const record = payload as Record<string, unknown>;
  visit(record.system);
  visit(record.tools);
  visit(record.messages);
  return count;
}

describe("createAnthropicVertexStreamFn", () => {
  beforeAll(async () => {
    ({ createAnthropicVertexStreamFn, createAnthropicVertexStreamFnForModel } =
      await import("./stream-runtime.js"));
  });

  it("omits projectId when ADC credentials are used without an explicit project", () => {
    const { deps, anthropicVertexCtorMock, googleAuthClient } = createStreamDeps();
    const streamFn = createAnthropicVertexStreamFn(undefined, "global", undefined, deps);

    void streamFn(makeModel({ id: "claude-sonnet-4-6", maxTokens: 128000 }), { messages: [] }, {});

    expect(anthropicVertexCtorMock).toHaveBeenCalledWith({
      googleAuth: googleAuthClient,
      region: "global",
    });
  });

  it("uses provider-local proxy-aware fetch without mutating the global window", async () => {
    const { deps, anthropicVertexCtorMock, googleAuthCtorMock, googleAuthClient } =
      createStreamDeps();
    const windowDescriptor = Object.getOwnPropertyDescriptor(globalThis, "window");

    createAnthropicVertexStreamFn("vertex-project", "us-east5", undefined, deps);

    expect(googleAuthCtorMock).toHaveBeenCalledWith({
      scopes: ["https://www.googleapis.com/auth/cloud-platform"],
      clientOptions: {
        transporterOptions: { fetchImplementation: expect.any(Function) },
      },
    });
    const authOptions = googleAuthCtorMock.mock.calls[0]?.[0] as
      | {
          clientOptions?: {
            transporterOptions?: { fetchImplementation?: typeof globalThis.fetch };
          };
        }
      | undefined;
    const fetchImplementation = authOptions?.clientOptions?.transporterOptions?.fetchImplementation;
    expect(fetchImplementation).not.toBe(globalThis.fetch);

    let proxyHit = false;
    const proxy = createServer((_request, response) => {
      proxyHit = true;
      response.end("proxied");
    });
    proxy.on("connect", (_request, socket) => {
      proxyHit = true;
      socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      socket.once("data", () => {
        socket.end("HTTP/1.1 200 OK\r\nContent-Length: 7\r\n\r\nproxied");
      });
    });
    proxy.listen(0, "127.0.0.1");
    await once(proxy, "listening");
    const address = proxy.address();
    if (!address || typeof address === "string" || !fetchImplementation) {
      proxy.close();
      throw new Error("Expected local proxy and Google auth fetch implementation");
    }
    const proxyUrl = `http://127.0.0.1:${address.port}`;
    vi.stubEnv("HTTP_PROXY", proxyUrl);
    vi.stubEnv("http_proxy", proxyUrl);
    vi.stubEnv("NO_PROXY", "");
    vi.stubEnv("no_proxy", "");
    try {
      const response = await fetchImplementation("http://vertex-token.invalid/token", {
        agent: {},
      } as never);
      expect(await response.text()).toBe("proxied");
      expect(proxyHit).toBe(true);
    } finally {
      vi.unstubAllEnvs();
      proxy.close();
      await once(proxy, "close");
    }
    expect(anthropicVertexCtorMock).toHaveBeenCalledWith({
      googleAuth: googleAuthClient,
      projectId: "vertex-project",
      region: "us-east5",
    });
    expect(Object.getOwnPropertyDescriptor(globalThis, "window")).toEqual(windowDescriptor);
  });

  it("passes an explicit baseURL through to the Vertex client", () => {
    const { deps, anthropicVertexCtorMock, googleAuthClient } = createStreamDeps();
    const streamFn = createAnthropicVertexStreamFn(
      "vertex-project",
      "us-east5",
      "https://proxy.example.test/vertex/v1",
      deps,
    );

    void streamFn(makeModel({ id: "claude-sonnet-4-6", maxTokens: 128000 }), { messages: [] }, {});

    expect(anthropicVertexCtorMock).toHaveBeenCalledWith({
      googleAuth: googleAuthClient,
      projectId: "vertex-project",
      region: "us-east5",
      baseURL: "https://proxy.example.test/vertex/v1",
    });
  });

  it("restores the canonical API before calling the shared Anthropic transport", () => {
    const { deps, streamAnthropicMock } = createStreamDeps();
    const streamFn = createAnthropicVertexStreamFn("vertex-project", "us-east5", undefined, deps);
    const model = {
      ...makeModel({ id: "claude-fable-5", maxTokens: 128000 }),
      api: "openclaw-anthropic-vertex-simple:default",
    };

    void streamFn(model as never, { messages: [] }, {});

    expect(streamAnthropicCall(streamAnthropicMock)[0]).toMatchObject({
      api: "anthropic-messages",
      provider: "anthropic-vertex",
      id: "claude-fable-5",
    });
  });

  it("defaults maxTokens to the model limit instead of the old 32000 cap", () => {
    const { deps, streamAnthropicMock } = createStreamDeps();
    const streamFn = createAnthropicVertexStreamFn("vertex-project", "us-east5", undefined, deps);
    const model = makeModel({ id: "claude-opus-4-6", maxTokens: 128000 });

    void streamFn(model, { messages: [] }, {});

    expect(streamTransportOptions(streamAnthropicMock).maxTokens).toBe(128000);
  });

  it("clamps explicit maxTokens to the selected model limit", () => {
    const { deps, streamAnthropicMock } = createStreamDeps();
    const streamFn = createAnthropicVertexStreamFn("vertex-project", "us-east5", undefined, deps);
    const model = makeModel({ id: "claude-sonnet-4-6", maxTokens: 128000 });

    void streamFn(model, { messages: [] }, { maxTokens: 999999 });

    expect(streamTransportOptions(streamAnthropicMock).maxTokens).toBe(128000);
  });

  it.each(["claude-opus-4-8", "claude-opus-4-7", "claude-fable-5", "claude-mythos-5"])(
    "omits unsupported temperature for %s",
    (modelId) => {
      const { deps, streamAnthropicMock } = createStreamDeps();
      const streamFn = createAnthropicVertexStreamFn("vertex-project", "us-east5", undefined, deps);
      const model = makeModel({ id: modelId, maxTokens: 128000 });

      void streamFn(model, { messages: [] }, { temperature: 0.7 });

      const transportOptions = streamTransportOptions(streamAnthropicMock);
      expect(Object.hasOwn(transportOptions, "temperature")).toBe(false);
    },
  );

  it("preserves temperature for Vertex models that support custom sampling", () => {
    const { deps, streamAnthropicMock } = createStreamDeps();
    const streamFn = createAnthropicVertexStreamFn("vertex-project", "us-east5", undefined, deps);
    const model = makeModel({ id: "claude-sonnet-4-6", maxTokens: 128000 });

    void streamFn(model, { messages: [] }, { temperature: 0.7 });

    expect(streamTransportOptions(streamAnthropicMock).temperature).toBe(0.7);
  });

  it("uses Fable 5's always-adaptive Vertex contract", () => {
    const { deps, streamAnthropicMock } = createStreamDeps();
    const streamFn = createAnthropicVertexStreamFn("vertex-project", "us-east5", undefined, deps);
    const model = makeModel({ id: "claude-fable-5", maxTokens: 128000 });

    void streamFn(model, { messages: [] }, { temperature: 0.7 });

    expect(streamTransportOptions(streamAnthropicMock)).toMatchObject({
      thinkingEnabled: true,
      effort: "high",
      maxTokens: 128000,
    });
    expect(streamTransportOptions(streamAnthropicMock)).not.toHaveProperty("temperature");
  });

  it.each([
    { reasoning: undefined, thinkingEnabled: true, effort: "high" },
    { reasoning: "off" as const, thinkingEnabled: false, effort: undefined },
  ])(
    "supports Sonnet 5 reasoning=$reasoning on Vertex",
    ({ reasoning, thinkingEnabled, effort }) => {
      const { deps, streamAnthropicMock } = createStreamDeps();
      const streamFn = createAnthropicVertexStreamFn("vertex-project", "us-east5", undefined, deps);
      const model = makeModel({ id: "claude-sonnet-5", maxTokens: 128_000 });

      void streamFn(model, { messages: [] }, { reasoning, temperature: 0.7 });

      const options = streamTransportOptions(streamAnthropicMock);
      expect(options).toMatchObject({ thinkingEnabled, maxTokens: 128_000 });
      expect(options).not.toHaveProperty("temperature");
      if (effort) {
        expect(options.effort).toBe(effort);
      } else {
        expect(options).not.toHaveProperty("effort");
      }
    },
  );

  it("uses Mythos 5's mandatory adaptive Vertex contract by default", () => {
    const { deps, streamAnthropicMock } = createStreamDeps();
    const streamFn = createAnthropicVertexStreamFn("vertex-project", "us-east5", undefined, deps);
    const model = makeModel({ id: "claude-mythos-5", maxTokens: 128000 });

    void streamFn(model, { messages: [] }, { temperature: 0.7 });

    expect(streamTransportOptions(streamAnthropicMock)).toMatchObject({
      thinkingEnabled: true,
      effort: "high",
      maxTokens: 128000,
    });
    expect(streamTransportOptions(streamAnthropicMock)).not.toHaveProperty("temperature");
  });

  it("uses canonical Claude policy for Vertex deployment aliases", () => {
    const { deps, streamAnthropicMock } = createStreamDeps();
    const streamFn = createAnthropicVertexStreamFn("vertex-project", "us-east5", undefined, deps);
    const model = makeModel({
      id: "production-claude",
      maxTokens: 128000,
      params: { canonicalModelId: "claude-opus-4-8" },
    });

    void streamFn(model, { messages: [] }, { reasoning: "xhigh", temperature: 0.7 });

    expect(streamTransportOptions(streamAnthropicMock)).toMatchObject({
      thinkingEnabled: true,
      effort: "xhigh",
    });
    expect(streamTransportOptions(streamAnthropicMock)).not.toHaveProperty("temperature");
  });

  it("preserves Fable 5 low effort on Vertex", () => {
    const { deps, streamAnthropicMock } = createStreamDeps();
    const streamFn = createAnthropicVertexStreamFn("vertex-project", "us-east5", undefined, deps);
    const model = makeModel({ id: "claude-fable-5", maxTokens: 128000 });

    void streamFn(model, { messages: [] }, { reasoning: "low" });

    expect(streamTransportOptions(streamAnthropicMock)).toMatchObject({
      thinkingEnabled: true,
      effort: "low",
    });
  });

  it("preserves Fable 5 xhigh effort on Vertex", () => {
    const { deps, streamAnthropicMock } = createStreamDeps();
    const streamFn = createAnthropicVertexStreamFn("vertex-project", "us-east5", undefined, deps);
    const model = makeModel({ id: "claude-fable-5", maxTokens: 128000 });

    void streamFn(model, { messages: [] }, { reasoning: "xhigh" });

    expect(streamTransportOptions(streamAnthropicMock)).toMatchObject({
      thinkingEnabled: true,
      effort: "xhigh",
    });
  });

  it("maps unsupported xhigh reasoning to high effort for Opus 4.6", () => {
    const { deps, streamAnthropicMock } = createStreamDeps();
    const streamFn = createAnthropicVertexStreamFn("vertex-project", "us-east5", undefined, deps);
    const model = makeModel({ id: "claude-opus-4-6", maxTokens: 64000 });

    void streamFn(model, { messages: [] }, { reasoning: "xhigh" });

    const transportOptions = streamTransportOptions(streamAnthropicMock);
    expect(transportOptions.thinkingEnabled).toBe(true);
    expect(transportOptions.effort).toBe("high");
  });

  it("maps xhigh reasoning to xhigh effort for Opus 4.8", () => {
    const { deps, streamAnthropicMock } = createStreamDeps();
    const streamFn = createAnthropicVertexStreamFn("vertex-project", "us-east5", undefined, deps);
    const model = makeModel({ id: "claude-opus-4-8", maxTokens: 128000 });

    void streamFn(model, { messages: [] }, { reasoning: "xhigh" });

    const transportOptions = streamTransportOptions(streamAnthropicMock);
    expect(transportOptions.thinkingEnabled).toBe(true);
    expect(transportOptions.effort).toBe("xhigh");
  });

  it("preserves max reasoning for Opus 4.8", () => {
    const { deps, streamAnthropicMock } = createStreamDeps();
    const streamFn = createAnthropicVertexStreamFn("vertex-project", "us-east5", undefined, deps);
    const model = makeModel({ id: "claude-opus-4-8", maxTokens: 128000 });

    void streamFn(model, { messages: [] }, { reasoning: "max" });

    const transportOptions = streamTransportOptions(streamAnthropicMock);
    expect(transportOptions.thinkingEnabled).toBe(true);
    expect(transportOptions.effort).toBe("max");
  });

  it("disables manual thinking when the configured budget is below 1024", () => {
    const { deps, streamAnthropicMock } = createStreamDeps();
    const streamFn = createAnthropicVertexStreamFn("vertex-project", "us-east5", undefined, deps);
    const model = makeModel({ id: "claude-haiku-4-5", maxTokens: 8192 });

    void streamFn(
      model,
      { messages: [] },
      {
        reasoning: "low",
        thinkingBudgets: { low: 512 },
      },
    );

    const transportOptions = streamTransportOptions(streamAnthropicMock);
    expect(transportOptions.thinkingEnabled).toBe(false);
    expect(transportOptions).not.toHaveProperty("thinkingBudgetTokens");
  });

  it("preserves native max reasoning for Sonnet 4.6", () => {
    const { deps, streamAnthropicMock } = createStreamDeps();
    const streamFn = createAnthropicVertexStreamFn("vertex-project", "us-east5", undefined, deps);
    const model = makeModel({ id: "claude-sonnet-4-6", maxTokens: 128000 });

    void streamFn(model, { messages: [] }, { reasoning: "max" });

    const transportOptions = streamTransportOptions(streamAnthropicMock);
    expect(transportOptions.thinkingEnabled).toBe(true);
    expect(transportOptions.effort).toBe("max");
  });

  it("honors explicit max opt-outs for Vertex aliases", () => {
    const { deps, streamAnthropicMock } = createStreamDeps();
    const streamFn = createAnthropicVertexStreamFn("vertex-project", "us-east5", undefined, deps);
    const model = makeModel({
      id: "production-claude",
      params: { canonicalModelId: "claude-sonnet-4-6" },
      reasoning: false,
      thinkingLevelMap: { xhigh: null, max: null },
    });

    void streamFn(model, { messages: [] }, { reasoning: "max", temperature: 0.2 });

    const transportOptions = streamTransportOptions(streamAnthropicMock);
    expect(transportOptions.effort).toBe("high");
    expect(transportOptions).not.toHaveProperty("temperature");
  });

  it("keeps already-budgeted cache_control markers intact when forwarding payload hooks", async () => {
    const { deps, streamAnthropicMock } = createStreamDeps();
    const onPayload = vi.fn(async (payload: unknown) => payload);
    const { model, onPayload: transportPayloadHook } = captureTransportPayloadHook(
      onPayload,
      deps,
      streamAnthropicMock,
    );
    const payload = buildBudgetedTransportPayload();

    const nextPayload = await transportPayloadHook?.(payload, model);

    expect(onPayload).toHaveBeenCalledWith(payload, model);
    expect(countCacheControlMarkers(nextPayload)).toBe(4);
    expect((nextPayload as ReturnType<typeof buildBudgetedTransportPayload>).system[1]).toEqual({
      type: "text",
      text: "Dynamic suffix",
    });
  });

  it("omits the transport payload hook when the caller provides none", () => {
    const { deps, streamAnthropicMock } = createStreamDeps();
    const { onPayload: transportPayloadHook } = captureTransportPayloadHook(
      undefined,
      deps,
      streamAnthropicMock,
    );

    expect(transportPayloadHook).toBeUndefined();
  });

  it("omits maxTokens when neither the model nor request provide a finite limit", () => {
    const { deps, streamAnthropicMock } = createStreamDeps();
    const streamFn = createAnthropicVertexStreamFn("vertex-project", "us-east5", undefined, deps);
    const model = makeModel({ id: "claude-sonnet-4-6" });

    void streamFn(model, { messages: [] }, { maxTokens: Number.NaN });

    expect(streamAnthropicMock).toHaveBeenCalledTimes(1);
    const [calledModel, payload, transportOptions] = streamAnthropicCall(streamAnthropicMock);
    expect(calledModel).toBe(model);
    expect(payload).toEqual({ messages: [] });
    expect(transportOptions).toBeTypeOf("object");
    expect(Object.hasOwn(transportOptions as object, "maxTokens")).toBe(false);
  });
});

describe("createAnthropicVertexStreamFnForModel", () => {
  it("derives project and region from the model and env", () => {
    const { deps, anthropicVertexCtorMock, googleAuthClient } = createStreamDeps();
    const streamFn = createAnthropicVertexStreamFnForModel(
      { baseUrl: "https://europe-west4-aiplatform.googleapis.com" },
      { GOOGLE_CLOUD_PROJECT_ID: "vertex-project" } as NodeJS.ProcessEnv,
      deps,
    );

    void streamFn(makeModel({ id: "claude-sonnet-4-6", maxTokens: 64000 }), { messages: [] }, {});

    expect(anthropicVertexCtorMock).toHaveBeenCalledWith({
      googleAuth: googleAuthClient,
      projectId: "vertex-project",
      region: "europe-west4",
      baseURL: "https://europe-west4-aiplatform.googleapis.com/v1",
    });
  });

  it("preserves explicit custom provider base URLs", () => {
    const { deps, anthropicVertexCtorMock, googleAuthClient } = createStreamDeps();
    const streamFn = createAnthropicVertexStreamFnForModel(
      { baseUrl: "https://proxy.example.test/custom-root/v1" },
      { GOOGLE_CLOUD_PROJECT_ID: "vertex-project" } as NodeJS.ProcessEnv,
      deps,
    );

    void streamFn(makeModel({ id: "claude-sonnet-4-6", maxTokens: 64000 }), { messages: [] }, {});

    expect(anthropicVertexCtorMock).toHaveBeenCalledWith({
      googleAuth: googleAuthClient,
      projectId: "vertex-project",
      region: "global",
      baseURL: "https://proxy.example.test/custom-root/v1",
    });
  });

  it("adds /v1 for path-prefixed custom provider base URLs", () => {
    const { deps, anthropicVertexCtorMock, googleAuthClient } = createStreamDeps();
    const streamFn = createAnthropicVertexStreamFnForModel(
      { baseUrl: "https://proxy.example.test/custom-root" },
      { GOOGLE_CLOUD_PROJECT_ID: "vertex-project" } as NodeJS.ProcessEnv,
      deps,
    );

    void streamFn(makeModel({ id: "claude-sonnet-4-6", maxTokens: 64000 }), { messages: [] }, {});

    expect(anthropicVertexCtorMock).toHaveBeenCalledWith({
      googleAuth: googleAuthClient,
      projectId: "vertex-project",
      region: "global",
      baseURL: "https://proxy.example.test/custom-root/v1",
    });
  });
});
