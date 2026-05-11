import { createAssistantMessageEventStream, type Model } from "@earendil-works/pi-ai";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { AnthropicVertexStreamDeps } from "./stream-runtime.js";

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

let createAnthropicVertexStreamFn: typeof import("./api.js").createAnthropicVertexStreamFn;
let createAnthropicVertexStreamFnForModel: typeof import("./api.js").createAnthropicVertexStreamFnForModel;

function makeModel(): Model<"anthropic-messages"> {
  return {
    id: "claude-sonnet-4-6",
    api: "anthropic-messages",
    provider: "anthropic-vertex",
    maxTokens: 128000,
  } as Model<"anthropic-messages">;
}

describe("Anthropic Vertex API stream factories", () => {
  beforeAll(async () => {
    ({ createAnthropicVertexStreamFn, createAnthropicVertexStreamFnForModel } =
      await import("./api.js"));
  });

  it("reuses the runtime stream factory across direct stream calls", async () => {
    const { deps, streamAnthropicMock, anthropicVertexCtorMock } = createStreamDeps();
    const streamFn = createAnthropicVertexStreamFn("vertex-project", "us-east5", undefined, deps);
    const model = makeModel();

    await streamFn(model, { messages: [] }, {});
    await streamFn(model, { messages: [] }, {});

    expect(anthropicVertexCtorMock).toHaveBeenCalledTimes(1);
    expect(streamAnthropicMock).toHaveBeenCalledTimes(2);
  });

  it("reuses the runtime stream factory across model-derived stream calls", async () => {
    const { deps, streamAnthropicMock, anthropicVertexCtorMock } = createStreamDeps();
    const streamFn = createAnthropicVertexStreamFnForModel(
      makeModel(),
      {
        ANTHROPIC_VERTEX_PROJECT_ID: "vertex-project",
        GOOGLE_CLOUD_LOCATION: "us-east5",
      } as NodeJS.ProcessEnv,
      deps,
    );
    const model = makeModel();

    await streamFn(model, { messages: [] }, {});
    await streamFn(model, { messages: [] }, {});

    expect(anthropicVertexCtorMock).toHaveBeenCalledTimes(1);
    expect(streamAnthropicMock).toHaveBeenCalledTimes(2);
  });
});
