// Google tests cover provider registration plugin behavior.
import type { Model } from "openclaw/plugin-sdk/llm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildGoogleProvider } from "./provider-registration.js";

const streamFns = vi.hoisted(() => ({
  createGenerativeAi: vi.fn(() => vi.fn()),
  createVertex: vi.fn(() => vi.fn()),
}));

vi.mock("./transport-stream.js", () => ({
  createGoogleGenerativeAiTransportStreamFn: streamFns.createGenerativeAi,
  createGoogleVertexTransportStreamFn: streamFns.createVertex,
}));

function model(overrides: Partial<Model> = {}): Model {
  return {
    id: "gemini-2.5-flash",
    name: "Gemini 2.5 Flash",
    provider: "google-vertex",
    api: "google-generative-ai",
    baseUrl: "https://aiplatform.googleapis.com",
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 1_048_576,
    maxTokens: 65_536,
    ...overrides,
  } as Model;
}

describe("buildGoogleProvider createStreamFn", () => {
  beforeEach(() => {
    streamFns.createGenerativeAi.mockClear();
    streamFns.createVertex.mockClear();
  });

  it("routes native Vertex hosts through the Vertex transport", () => {
    const provider = buildGoogleProvider();

    provider.createStreamFn?.({
      provider: "google-vertex",
      modelId: "gemini-2.5-flash",
      model: model(),
    } as never);

    expect(streamFns.createVertex).toHaveBeenCalledTimes(1);
    expect(streamFns.createGenerativeAi).not.toHaveBeenCalled();
  });

  it("preserves explicit OpenAI-compatible Vertex endpoint configs", () => {
    const provider = buildGoogleProvider();

    const result = provider.createStreamFn?.({
      provider: "google-vertex",
      modelId: "gemini-2.5-flash",
      model: model({
        api: "openai-completions",
        baseUrl:
          "https://aiplatform.googleapis.com/v1/projects/test/locations/us-central1/endpoints/openapi",
      }),
    } as never);

    expect(result).toBeUndefined();
    expect(streamFns.createVertex).not.toHaveBeenCalled();
    expect(streamFns.createGenerativeAi).not.toHaveBeenCalled();
  });
});
