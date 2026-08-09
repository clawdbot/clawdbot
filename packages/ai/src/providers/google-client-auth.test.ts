import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { configureAiTransportHost } from "../host.js";
import type { Context, Model } from "../types.js";

const googleMockState = vi.hoisted(() => ({ configs: [] as unknown[], requests: [] as unknown[] }));

vi.mock("@google/genai", () => ({
  GoogleGenAI: class MockGoogleGenAI {
    models = {
      generateContentStream: vi.fn((params: unknown) => {
        googleMockState.requests.push(params);
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

import { streamGoogleVertex, streamSimpleGoogleVertex } from "./google-vertex.js";
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
    googleMockState.requests = [];
  });

  afterEach(() => {
    vi.unstubAllEnvs();
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

  it.each([
    {
      modelId: "gemma-4-26b-a4b-it",
      reasoning: "low",
      expectedThinking: { includeThoughts: true, thinkingLevel: "MINIMAL" },
    },
    {
      modelId: "gemma-4-26b-a4b-it",
      reasoning: "adaptive",
      expectedThinking: { includeThoughts: true, thinkingLevel: "HIGH" },
    },
    {
      modelId: "gemini-2.5-flash-lite",
      reasoning: "minimal",
      expectedThinking: { includeThoughts: true, thinkingBudget: 512 },
    },
  ] as const)(
    "keeps the supported Vertex thinking policy for $modelId",
    async ({ modelId, reasoning, expectedThinking }) => {
      configureAiTransportHost({ resolveSecretSentinel: (value) => value });

      await streamSimpleGoogleVertex({ ...vertexModel(), id: modelId }, context, {
        apiKey: "test-vertex-key",
        reasoning: reasoning as never,
      }).result();

      expect(googleMockState.requests[0]).toMatchObject({
        config: { thinkingConfig: expectedThinking },
      });
    },
  );

  it.each(["gemma-4-26b-a4b-it", "gemini-2.5-pro"])(
    "keeps unsupported disabled-thinking config out of Vertex requests for %s",
    async (modelId) => {
      configureAiTransportHost({ resolveSecretSentinel: (value) => value });

      await streamSimpleGoogleVertex({ ...vertexModel(), id: modelId }, context, {
        apiKey: "test-vertex-key",
        reasoning: "off",
      }).result();

      expect(googleMockState.requests[0]).toMatchObject({ config: {} });
      expect((googleMockState.requests[0] as { config: unknown }).config).not.toHaveProperty(
        "thinkingConfig",
      );
    },
  );

  it("ignores blank Vertex project and location env fallbacks", async () => {
    vi.stubEnv("GOOGLE_CLOUD_PROJECT", "   ");
    vi.stubEnv("GCLOUD_PROJECT", "   ");
    vi.stubEnv("GOOGLE_CLOUD_LOCATION", "   ");

    const missingProject = await streamGoogleVertex(vertexModel(), context).result();

    expect(missingProject.stopReason).toBe("error");
    expect(JSON.stringify(missingProject)).toContain("Vertex AI requires a project ID");
    expect(googleMockState.configs).toHaveLength(0);

    vi.stubEnv("GOOGLE_CLOUD_PROJECT", " vertex-project ");
    vi.stubEnv("GCLOUD_PROJECT", "");
    vi.stubEnv("GOOGLE_CLOUD_LOCATION", "   ");

    const missingLocation = await streamGoogleVertex(vertexModel(), context).result();

    expect(missingLocation.stopReason).toBe("error");
    expect(JSON.stringify(missingLocation)).toContain("Vertex AI requires a location");
    expect(googleMockState.configs).toHaveLength(0);

    vi.stubEnv("GOOGLE_CLOUD_LOCATION", " us-central1 ");

    const configured = await streamGoogleVertex(vertexModel(), context).result();

    expect(configured.stopReason).toBe("error");
    expect(googleMockState.configs[0]).toMatchObject({
      vertexai: true,
      project: "vertex-project",
      location: "us-central1",
    });
  });
});
