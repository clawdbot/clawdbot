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

  it.each([
    ["gemini-2.5-flash", "https://generativelanguage.googleapis.com", true],
    ["google/gemini-3.1-pro-preview", "https://generativelanguage.googleapis.com/v1beta", true],
    ["models/gemini-2.5-pro", "https://generativelanguage.googleapis.com/v1beta/", true],
    ["gemma-4-26b-a4b-it", "https://generativelanguage.googleapis.com/v1beta", false],
    ["gemini-2.5-flash-image", "https://generativelanguage.googleapis.com/v1beta", false],
    ["gemini-2.5-flash", "https://proxy.example.test/v1beta", false],
    ["gemini-2.5-flash", "https://user@generativelanguage.googleapis.com/v1beta", false],
    ["gemini-2.5-flash", "https://generativelanguage.googleapis.com/v1beta?key=x", false],
    ["gemini-2.5-flash", "https://generativelanguage.googleapis.com:8443/v1beta", false],
    ["gemini-2.5-flash", "https://generativelanguage.googleapis.com/v1beta/openai", false],
  ])("normalizes native-video input for exact AI Studio route %s", (modelId, baseUrl, expected) => {
    const provider = buildGoogleProvider();
    const normalized = provider.normalizeResolvedModel?.({
      provider: "google",
      modelId,
      model: model({
        id: modelId,
        provider: "google",
        api: "google-generative-ai",
        baseUrl,
        input: ["text", "image", "video"] as never,
      }),
    } as never);

    expect(((normalized?.input ?? []) as string[]).includes("video")).toBe(expected);
  });

  it("strips inherited video for Vertex and non-Google provider routes", () => {
    const provider = buildGoogleProvider();
    for (const [providerId, api] of [
      ["google-vertex", "google-vertex"],
      ["custom-google", "google-generative-ai"],
    ] as const) {
      const normalized = provider.normalizeResolvedModel?.({
        provider: providerId,
        modelId: "gemini-2.5-flash",
        model: model({ provider: providerId, api, input: ["text", "image", "video"] as never }),
      } as never);
      expect(normalized?.input).toEqual(["text", "image"]);
    }
  });

  it.each(["google-vertex", "google-antigravity"])(
    "does not resolve AI Studio credentials for %s-only catalog scope",
    async (providerId) => {
      const resolveProviderApiKey = vi.fn(() => {
        throw new Error("unselected Google credential read");
      });

      await expect(
        buildGoogleProvider().catalog?.run({
          providerIds: [providerId],
          config: {},
          env: {},
          resolveProviderApiKey,
          resolveProviderAuth: () => ({ apiKey: undefined, mode: "none", source: "none" }),
        }),
      ).resolves.toBeNull();
      expect(resolveProviderApiKey).not.toHaveBeenCalled();
    },
  );
});
