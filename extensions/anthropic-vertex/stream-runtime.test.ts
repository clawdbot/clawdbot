import { createAssistantMessageEventStream, type Model } from "@earendil-works/pi-ai";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { AnthropicVertexStreamDeps } from "./stream-runtime.js";

const SYSTEM_PROMPT_CACHE_BOUNDARY = "\n<!-- OPENCLAW_CACHE_BOUNDARY -->\n";

function createStreamDeps(): {
  deps: AnthropicVertexStreamDeps;
  streamAnthropicMock: ReturnType<typeof vi.fn>;
  anthropicVertexCtorMock: ReturnType<typeof vi.fn>;
} {
  const streamAnthropicMock = vi.fn(
    (..._args: Parameters<AnthropicVertexStreamDeps["streamAnthropic"]>) =>
      createAssistantMessageEventStream(),
  );
  const anthropicVertexCtorMock = vi.fn();
  const MockAnthropicVertex = function MockAnthropicVertex(options: unknown) {
    anthropicVertexCtorMock(options);
  } as unknown as AnthropicVertexStreamDeps["AnthropicVertex"];

  return {
    deps: {
      AnthropicVertex: MockAnthropicVertex,
      streamAnthropic: streamAnthropicMock,
    },
    streamAnthropicMock,
    anthropicVertexCtorMock,
  };
}

let createAnthropicVertexStreamFn: typeof import("./stream-runtime.js").createAnthropicVertexStreamFn;
let createAnthropicVertexStreamFnForModel: typeof import("./stream-runtime.js").createAnthropicVertexStreamFnForModel;

function makeModel(params: { id: string; maxTokens?: number }): Model<"anthropic-messages"> {
  return {
    id: params.id,
    api: "anthropic-messages",
    provider: "anthropic-vertex",
    ...(params.maxTokens !== undefined ? { maxTokens: params.maxTokens } : {}),
  } as Model<"anthropic-messages">;
}

const CACHE_BOUNDARY_PROMPT = `Stable prefix${SYSTEM_PROMPT_CACHE_BOUNDARY}Dynamic suffix`;

type PayloadHook = (payload: unknown, payloadModel: unknown) => Promise<unknown>;

function captureCacheBoundaryPayloadHook(
  onPayload: PayloadHook,
  deps: AnthropicVertexStreamDeps,
  streamAnthropicMock: ReturnType<typeof vi.fn>,
) {
  const streamFn = createAnthropicVertexStreamFn("vertex-project", "us-east5", undefined, deps);
  const model = makeModel({ id: "claude-sonnet-4-6", maxTokens: 64000 });

  void streamFn(
    model,
    {
      systemPrompt: CACHE_BOUNDARY_PROMPT,
      messages: [{ role: "user", content: "Hello" }],
    } as never,
    {
      cacheRetention: "short",
      onPayload,
    } as never,
  );

  const transportOptions = streamAnthropicMock.mock.calls[0]?.[2] as {
    onPayload?: PayloadHook;
  };

  return { model, onPayload: transportOptions.onPayload };
}

function buildExpectedCacheBoundaryPayload(messageText: string) {
  return {
    system: [
      {
        type: "text",
        text: "Stable prefix",
        cache_control: { type: "ephemeral" },
      },
      {
        type: "text",
        text: "Dynamic suffix",
      },
    ],
    messages: [
      {
        role: "user",
        content: [
          {
            type: "text",
            text: messageText,
            cache_control: { type: "ephemeral" },
          },
        ],
      },
    ],
  };
}

describe("createAnthropicVertexStreamFn", () => {
  beforeAll(async () => {
    ({ createAnthropicVertexStreamFn, createAnthropicVertexStreamFnForModel } =
      await import("./stream-runtime.js"));
  });

  it("omits projectId when ADC credentials are used without an explicit project", () => {
    const { deps, anthropicVertexCtorMock } = createStreamDeps();
    const streamFn = createAnthropicVertexStreamFn(undefined, "global", undefined, deps);

    void streamFn(makeModel({ id: "claude-sonnet-4-6", maxTokens: 128000 }), { messages: [] }, {});

    expect(anthropicVertexCtorMock).toHaveBeenCalledWith({
      region: "global",
    });
  });

  it("passes an explicit baseURL through to the Vertex client", () => {
    const { deps, anthropicVertexCtorMock } = createStreamDeps();
    const streamFn = createAnthropicVertexStreamFn(
      "vertex-project",
      "us-east5",
      "https://proxy.example.test/vertex/v1",
      deps,
    );

    void streamFn(makeModel({ id: "claude-sonnet-4-6", maxTokens: 128000 }), { messages: [] }, {});

    expect(anthropicVertexCtorMock).toHaveBeenCalledWith({
      projectId: "vertex-project",
      region: "us-east5",
      baseURL: "https://proxy.example.test/vertex/v1",
    });
  });

  it("defaults maxTokens to the model limit instead of the old 32000 cap", () => {
    const { deps, streamAnthropicMock } = createStreamDeps();
    const streamFn = createAnthropicVertexStreamFn("vertex-project", "us-east5", undefined, deps);
    const model = makeModel({ id: "claude-opus-4-6", maxTokens: 128000 });

    void streamFn(model, { messages: [] }, {});

    const transportOptions = streamAnthropicMock.mock.calls[0]?.[2] as
      | { maxTokens?: number }
      | undefined;
    expect(transportOptions?.maxTokens).toBe(128000);
  });

  it("clamps explicit maxTokens to the selected model limit", () => {
    const { deps, streamAnthropicMock } = createStreamDeps();
    const streamFn = createAnthropicVertexStreamFn("vertex-project", "us-east5", undefined, deps);
    const model = makeModel({ id: "claude-sonnet-4-6", maxTokens: 128000 });

    void streamFn(model, { messages: [] }, { maxTokens: 999999 });

    const transportOptions = streamAnthropicMock.mock.calls[0]?.[2] as
      | { maxTokens?: number }
      | undefined;
    expect(transportOptions?.maxTokens).toBe(128000);
  });

  it("maps xhigh reasoning to max effort for adaptive Opus models", () => {
    const { deps, streamAnthropicMock } = createStreamDeps();
    const streamFn = createAnthropicVertexStreamFn("vertex-project", "us-east5", undefined, deps);
    const model = makeModel({ id: "claude-opus-4-6", maxTokens: 64000 });

    void streamFn(model, { messages: [] }, { reasoning: "xhigh" });

    const transportOptions = streamAnthropicMock.mock.calls[0]?.[2] as
      | { effort?: string; thinkingEnabled?: boolean }
      | undefined;
    expect(transportOptions?.thinkingEnabled).toBe(true);
    expect(transportOptions?.effort).toBe("max");
  });

  it("maps xhigh reasoning to xhigh effort for Opus 4.7", () => {
    const { deps, streamAnthropicMock } = createStreamDeps();
    const streamFn = createAnthropicVertexStreamFn("vertex-project", "us-east5", undefined, deps);
    const model = makeModel({ id: "claude-opus-4-7", maxTokens: 64000 });

    void streamFn(model, { messages: [] }, { reasoning: "xhigh" });

    const transportOptions = streamAnthropicMock.mock.calls[0]?.[2] as
      | { effort?: string; thinkingEnabled?: boolean }
      | undefined;
    expect(transportOptions?.thinkingEnabled).toBe(true);
    expect(transportOptions?.effort).toBe("xhigh");
  });

  it("applies Anthropic cache-boundary shaping before forwarding payload hooks", async () => {
    const { deps, streamAnthropicMock } = createStreamDeps();
    const onPayload = vi.fn(async (payload: unknown) => payload);
    const { model, onPayload: transportPayloadHook } = captureCacheBoundaryPayloadHook(
      onPayload,
      deps,
      streamAnthropicMock,
    );
    const payload = {
      system: [
        {
          type: "text",
          text: CACHE_BOUNDARY_PROMPT,
          cache_control: { type: "ephemeral" },
        },
      ],
      messages: [{ role: "user", content: "Hello" }],
    };

    const nextPayload = await transportPayloadHook?.(payload, model);

    const expectedPayload = buildExpectedCacheBoundaryPayload("Hello");
    expect(onPayload).toHaveBeenCalledWith(expectedPayload, model);
    expect(nextPayload).toEqual(expectedPayload);
  });

  it("reapplies Anthropic cache-boundary shaping when payload hooks return a fresh payload", async () => {
    const { deps, streamAnthropicMock } = createStreamDeps();
    const onPayload = vi.fn(async () => ({
      system: [
        {
          type: "text",
          text: CACHE_BOUNDARY_PROMPT,
        },
      ],
      messages: [{ role: "user", content: "Hello again" }],
    }));
    const { model, onPayload: transportPayloadHook } = captureCacheBoundaryPayloadHook(
      onPayload,
      deps,
      streamAnthropicMock,
    );

    const nextPayload = await transportPayloadHook?.(
      {
        system: [
          {
            type: "text",
            text: CACHE_BOUNDARY_PROMPT,
          },
        ],
        messages: [{ role: "user", content: "Hello" }],
      },
      model,
    );

    expect(nextPayload).toEqual(buildExpectedCacheBoundaryPayload("Hello again"));
  });

  it("omits maxTokens when neither the model nor request provide a finite limit", () => {
    const { deps, streamAnthropicMock } = createStreamDeps();
    const streamFn = createAnthropicVertexStreamFn("vertex-project", "us-east5", undefined, deps);
    const model = makeModel({ id: "claude-sonnet-4-6" });

    void streamFn(model, { messages: [] }, { maxTokens: Number.NaN });

    expect(streamAnthropicMock).toHaveBeenCalledTimes(1);
    const [calledModel, payload, transportOptions] = streamAnthropicMock.mock.calls[0] ?? [];
    expect(calledModel).toBe(model);
    expect(payload).toEqual({ messages: [] });
    expect(transportOptions).toBeTypeOf("object");
    expect(Object.hasOwn(transportOptions as object, "maxTokens")).toBe(false);
  });
});

describe("createAnthropicVertexStreamFnForModel", () => {
  it("derives project and region from the model and env", () => {
    const { deps, anthropicVertexCtorMock } = createStreamDeps();
    const streamFn = createAnthropicVertexStreamFnForModel(
      { baseUrl: "https://europe-west4-aiplatform.googleapis.com" },
      { GOOGLE_CLOUD_PROJECT_ID: "vertex-project" } as NodeJS.ProcessEnv,
      deps,
    );

    void streamFn(makeModel({ id: "claude-sonnet-4-6", maxTokens: 64000 }), { messages: [] }, {});

    expect(anthropicVertexCtorMock).toHaveBeenCalledWith({
      projectId: "vertex-project",
      region: "europe-west4",
      baseURL: "https://europe-west4-aiplatform.googleapis.com/v1",
    });
  });

  it("preserves explicit custom provider base URLs", () => {
    const { deps, anthropicVertexCtorMock } = createStreamDeps();
    const streamFn = createAnthropicVertexStreamFnForModel(
      { baseUrl: "https://proxy.example.test/custom-root/v1" },
      { GOOGLE_CLOUD_PROJECT_ID: "vertex-project" } as NodeJS.ProcessEnv,
      deps,
    );

    void streamFn(makeModel({ id: "claude-sonnet-4-6", maxTokens: 64000 }), { messages: [] }, {});

    expect(anthropicVertexCtorMock).toHaveBeenCalledWith({
      projectId: "vertex-project",
      region: "global",
      baseURL: "https://proxy.example.test/custom-root/v1",
    });
  });

  it("adds /v1 for path-prefixed custom provider base URLs", () => {
    const { deps, anthropicVertexCtorMock } = createStreamDeps();
    const streamFn = createAnthropicVertexStreamFnForModel(
      { baseUrl: "https://proxy.example.test/custom-root" },
      { GOOGLE_CLOUD_PROJECT_ID: "vertex-project" } as NodeJS.ProcessEnv,
      deps,
    );

    void streamFn(makeModel({ id: "claude-sonnet-4-6", maxTokens: 64000 }), { messages: [] }, {});

    expect(anthropicVertexCtorMock).toHaveBeenCalledWith({
      projectId: "vertex-project",
      region: "global",
      baseURL: "https://proxy.example.test/custom-root/v1",
    });
  });
});
