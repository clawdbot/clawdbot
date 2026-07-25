import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { configureAiTransportHost } from "../host.js";
import type { Context, Model } from "../types.js";

const googleMockState = vi.hoisted(() => ({ configs: [] as unknown[] }));

vi.mock("@google/genai", () => ({
  GoogleGenAI: class MockGoogleGenAI {
    models = {
      generateContentStream: vi.fn(() => {
        throw new Error("stop after constructor");
      }),
    };

    constructor(config: unknown) {
      googleMockState.configs.push(config);
    }
  },
  ResourceScope: { COLLECTION: "COLLECTION" },
  ThinkingLevel: {
    THINKING_LEVEL_UNSPECIFIED: "THINKING_LEVEL_UNSPECIFIED",
    MINIMAL: "MINIMAL",
    LOW: "LOW",
    MEDIUM: "MEDIUM",
    HIGH: "HIGH",
  },
}));

import { streamGoogleVertex } from "./google-vertex.js";
import { streamGoogle } from "./google.js";

const context = {
  messages: [{ role: "user", content: "hello", timestamp: 0 }],
} satisfies Context;
const sentinel = "oc-sent-v2.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA.end";

function googleModel(): Model<"google-generative-ai"> {
  return {
    id: "gemini-3-flash-preview",
    name: "Gemini 3 Flash Preview",
    api: "google-generative-ai",
    provider: "google",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta",
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 1_000_000,
    maxTokens: 8192,
  };
}

function vertexModel(): Model<"google-vertex"> {
  return {
    ...googleModel(),
    api: "google-vertex",
    provider: "google-vertex",
    baseUrl: "https://us-central1-aiplatform.googleapis.com/v1",
  };
}

describe("Google SDK construction auth", () => {
  beforeEach(() => {
    googleMockState.configs = [];
  });

  afterEach(() => {
    configureAiTransportHost({});
  });

  it("unwraps Google API-key sentinels immediately before client construction", async () => {
    const buildModelFetch = vi.fn();
    configureAiTransportHost({
      buildModelFetch,
      resolveSecretSentinel: (value) => value.replaceAll(sentinel, "google-construction-secret"),
    });

    const result = await streamGoogle(
      {
        ...googleModel(),
        headers: { Authorization: `Bearer ${sentinel}` },
      },
      context,
      { apiKey: sentinel },
    ).result();

    expect(result.stopReason).toBe("error");
    expect(googleMockState.configs[0]).toMatchObject({
      apiKey: "google-construction-secret",
      httpOptions: { headers: { Authorization: "Bearer google-construction-secret" } },
    });
    expect(JSON.stringify(googleMockState.configs[0])).not.toContain(sentinel);
    expect(buildModelFetch).not.toHaveBeenCalled();
  });

  it("unwraps Vertex API-key sentinels immediately before client construction", async () => {
    const buildModelFetch = vi.fn();
    configureAiTransportHost({
      buildModelFetch,
      resolveSecretSentinel: (value) => value.replaceAll(sentinel, "vertex-construction-secret"),
    });

    const result = await streamGoogleVertex(
      {
        ...vertexModel(),
        headers: { "X-Provider-Token": sentinel },
      },
      context,
      {
        apiKey: sentinel,
        project: "demo-project",
        location: "us-central1",
      },
    ).result();

    expect(result.stopReason).toBe("error");
    expect(googleMockState.configs[0]).toMatchObject({
      apiKey: "vertex-construction-secret",
      vertexai: true,
      httpOptions: { headers: { "X-Provider-Token": "vertex-construction-secret" } },
    });
    expect(JSON.stringify(googleMockState.configs[0])).not.toContain(sentinel);
    expect(buildModelFetch).not.toHaveBeenCalled();
  });
});
