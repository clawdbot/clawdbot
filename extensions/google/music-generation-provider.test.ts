// Google tests cover music generation provider plugin behavior.
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

const { createGoogleGenAIMock, generateContentMock } = vi.hoisted(() => {
  const generateContentMockLocal = vi.fn();
  const createGoogleGenAIMockLocal = vi.fn(() => {
    return {
      models: {
        generateContent: generateContentMockLocal,
      },
    };
  });
  return {
    createGoogleGenAIMock: createGoogleGenAIMockLocal,
    generateContentMock: generateContentMockLocal,
  };
});

vi.mock("./google-genai-runtime.js", () => ({
  createGoogleGenAI: createGoogleGenAIMock,
}));

import * as providerAuthRuntime from "openclaw/plugin-sdk/provider-auth-runtime";
import { expectExplicitMusicGenerationCapabilities } from "openclaw/plugin-sdk/provider-test-contracts";
import { buildGoogleMusicGenerationProvider } from "./music-generation-provider.js";

type GoogleGenAIConfig = {
  apiKey?: string;
  httpOptions?: {
    baseUrl?: string;
    timeout?: number;
  };
};

type GenerateContentRequest = {
  model?: string;
  config?: unknown;
};

function lastGoogleGenAIConfig(): GoogleGenAIConfig {
  const calls = createGoogleGenAIMock.mock.calls as unknown[][];
  const config = calls.at(-1)?.[0];
  if (!config) {
    throw new Error("Expected GoogleGenAI config");
  }
  return config as GoogleGenAIConfig;
}

function allGoogleGenAIConfigs(): GoogleGenAIConfig[] {
  return (createGoogleGenAIMock.mock.calls as unknown[][]).map((call) => {
    const config = call[0];
    if (!config) {
      throw new Error("Expected GoogleGenAI config");
    }
    return config as GoogleGenAIConfig;
  });
}

function firstGenerateContentRequest(): GenerateContentRequest {
  const calls = generateContentMock.mock.calls as unknown[][];
  const request = calls[0]?.[0];
  if (!request) {
    throw new Error("Expected generateContent request");
  }
  return request as GenerateContentRequest;
}

function googleMusicAudioResponse(bytes = "mp3-bytes") {
  return {
    candidates: [
      {
        content: {
          parts: [
            {
              inlineData: {
                data: Buffer.from(bytes).toString("base64"),
                mimeType: "audio/mpeg",
              },
            },
          ],
        },
        finishReason: "STOP",
      },
    ],
  };
}

function mockGoogleAuth(): void {
  vi.spyOn(providerAuthRuntime, "resolveApiKeyForProvider").mockResolvedValue({
    apiKey: "google-key",
    source: "env",
    mode: "api-key",
  });
}

describe("google music generation provider", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    generateContentMock.mockReset();
    createGoogleGenAIMock.mockClear();
  });

  afterAll(() => {
    vi.doUnmock("./google-genai-runtime.js");
    vi.resetModules();
  });

  it("declares explicit mode capabilities", () => {
    expectExplicitMusicGenerationCapabilities(buildGoogleMusicGenerationProvider());
  });

  it("submits generation and returns inline audio bytes plus lyrics", async () => {
    mockGoogleAuth();
    generateContentMock.mockResolvedValue({
      candidates: [
        {
          content: {
            parts: [
              { text: "wake the city up" },
              {
                inlineData: {
                  data: Buffer.from("mp3-bytes").toString("base64"),
                  mimeType: "audio/mpeg",
                },
              },
            ],
          },
        },
      ],
    });

    const provider = buildGoogleMusicGenerationProvider();
    const result = await provider.generateMusic({
      provider: "google",
      model: "lyria-3-clip-preview",
      prompt: "upbeat synthpop anthem",
      cfg: {},
      instrumental: true,
    });

    const generateRequest = firstGenerateContentRequest();
    expect(generateRequest.model).toBe("lyria-3-clip-preview");
    expect(generateRequest.config).toEqual({
      responseModalities: ["AUDIO", "TEXT"],
    });
    expect(result.tracks).toHaveLength(1);
    expect(result.tracks[0]?.mimeType).toBe("audio/mpeg");
    expect(result.lyrics).toEqual(["wake the city up"]);
    expect(lastGoogleGenAIConfig().apiKey).toBe("google-key");
  });

  it.each([
    ["invalid alphabet", "not-base64!"],
    ["non-canonical pad bits", "ZE=="],
  ])("rejects %s in inline audio", async (_scenario, data) => {
    mockGoogleAuth();
    generateContentMock.mockResolvedValue({
      candidates: [
        {
          content: { parts: [{ inlineData: { data, mimeType: "audio/mpeg" } }] },
          finishReason: "STOP",
        },
      ],
    });

    await expect(
      buildGoogleMusicGenerationProvider().generateMusic({
        provider: "google",
        model: "lyria-3-clip-preview",
        prompt: "upbeat synthpop anthem",
        cfg: {},
      }),
    ).rejects.toThrow("Generated music asset contains malformed base64 audio data");

    expect(generateContentMock).toHaveBeenCalledTimes(1);
  });

  it("retries once when Lyria returns an unblocked text-only response", async () => {
    mockGoogleAuth();
    generateContentMock
      .mockResolvedValueOnce({
        candidates: [
          {
            content: { parts: [{ text: "[Verse]\nNeon lights" }] },
            finishReason: "STOP",
          },
        ],
      })
      .mockResolvedValueOnce(googleMusicAudioResponse("recovered-audio"));

    const result = await buildGoogleMusicGenerationProvider().generateMusic({
      provider: "google",
      model: "lyria-3-clip-preview",
      prompt: "upbeat synthpop anthem",
      cfg: {},
      instrumental: true,
    });

    expect(generateContentMock).toHaveBeenCalledTimes(2);
    expect(result.tracks[0]?.buffer).toEqual(Buffer.from("recovered-audio"));
  });

  it("shares the configured timeout budget across a no-audio retry", async () => {
    mockGoogleAuth();
    vi.spyOn(Date, "now")
      .mockReturnValueOnce(1_000)
      .mockReturnValueOnce(1_000)
      .mockReturnValue(2_500);
    generateContentMock
      .mockResolvedValueOnce({
        candidates: [
          {
            content: { parts: [{ text: "[Verse]\nNeon lights" }] },
            finishReason: "STOP",
          },
        ],
      })
      .mockResolvedValueOnce(googleMusicAudioResponse("recovered-audio"));

    await buildGoogleMusicGenerationProvider().generateMusic({
      provider: "google",
      model: "lyria-3-clip-preview",
      prompt: "upbeat synthpop anthem",
      cfg: {},
      timeoutMs: 5_000,
    });

    expect(allGoogleGenAIConfigs().map((config) => config.httpOptions?.timeout)).toEqual([
      5_000, 3_500,
    ]);
  });

  it("fails after one retry when Lyria keeps returning no audio", async () => {
    mockGoogleAuth();
    generateContentMock.mockResolvedValue({
      candidates: [
        {
          content: { parts: [{ text: "[Verse]\nStill no audio" }] },
          finishReason: "STOP",
        },
      ],
    });

    await expect(
      buildGoogleMusicGenerationProvider().generateMusic({
        provider: "google",
        model: "lyria-3-clip-preview",
        prompt: "upbeat synthpop anthem",
        cfg: {},
      }),
    ).rejects.toThrow("Google music generation response missing audio data");

    expect(generateContentMock).toHaveBeenCalledTimes(2);
  });

  it.each([
    {
      expectedError: "prompt blocked (SAFETY)",
      response: { promptFeedback: { blockReason: "SAFETY" } },
      scenario: "prompt block",
    },
    {
      expectedError: "generation stopped (SAFETY)",
      response: { candidates: [{ finishReason: "SAFETY" }] },
      scenario: "candidate stop",
    },
  ])("does not retry a terminal $scenario response", async ({ expectedError, response }) => {
    mockGoogleAuth();
    generateContentMock.mockResolvedValue(response);

    await expect(
      buildGoogleMusicGenerationProvider().generateMusic({
        provider: "google",
        model: "lyria-3-clip-preview",
        prompt: "upbeat synthpop anthem",
        cfg: {},
      }),
    ).rejects.toThrow(expectedError);

    expect(generateContentMock).toHaveBeenCalledTimes(1);
  });

  it("does not retry request errors", async () => {
    mockGoogleAuth();
    generateContentMock.mockRejectedValue(new Error("HTTP 400 invalid request"));

    await expect(
      buildGoogleMusicGenerationProvider().generateMusic({
        provider: "google",
        model: "lyria-3-clip-preview",
        prompt: "upbeat synthpop anthem",
        cfg: {},
      }),
    ).rejects.toThrow("HTTP 400 invalid request");

    expect(generateContentMock).toHaveBeenCalledTimes(1);
  });

  const baseUrlCases: Array<{
    name: string;
    baseUrl?: string;
    expectedBaseUrl?: string;
    prompt: string;
    audio: string;
  }> = [
    {
      name: "strips /v1beta suffix from configured baseUrl before passing to GoogleGenAI SDK",
      baseUrl: "https://generativelanguage.googleapis.com/v1beta",
      expectedBaseUrl: "https://generativelanguage.googleapis.com",
      prompt: "ambient ocean",
      audio: "mp3-bytes",
    },
    {
      name: "does NOT strip /v1beta when it appears mid-path (end-anchor proof)",
      baseUrl: "https://proxy.example.com/v1beta/route",
      expectedBaseUrl: "https://proxy.example.com/v1beta/route",
      prompt: "test",
      audio: "x",
    },
    {
      name: "passes baseUrl unchanged when no /v1beta suffix is present",
      baseUrl: "https://generativelanguage.googleapis.com",
      expectedBaseUrl: "https://generativelanguage.googleapis.com",
      prompt: "test",
      audio: "x",
    },
    {
      name: "does not set baseUrl when none is configured",
      prompt: "test",
      audio: "x",
    },
  ];

  it.each(baseUrlCases)("$name", async ({ baseUrl, expectedBaseUrl, prompt, audio }) => {
    mockGoogleAuth();
    generateContentMock.mockResolvedValue({
      candidates: [
        {
          content: {
            parts: [
              {
                inlineData: {
                  data: Buffer.from(audio).toString("base64"),
                  mimeType: "audio/mpeg",
                },
              },
            ],
          },
        },
      ],
    });

    await buildGoogleMusicGenerationProvider().generateMusic({
      provider: "google",
      model: "lyria-3-clip-preview",
      prompt,
      cfg: baseUrl ? { models: { providers: { google: { baseUrl, models: [] } } } } : {},
      instrumental: true,
    });

    expect(lastGoogleGenAIConfig().httpOptions?.baseUrl).toBe(expectedBaseUrl);
  });

  it("rejects unsupported wav output on clip model", async () => {
    mockGoogleAuth();
    const provider = buildGoogleMusicGenerationProvider();

    await expect(
      provider.generateMusic({
        provider: "google",
        model: "lyria-3-clip-preview",
        prompt: "ambient ocean",
        cfg: {},
        format: "wav",
      }),
    ).rejects.toThrow("supports mp3 output");
  });
});
