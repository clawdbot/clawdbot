import { afterEach, describe, expect, it, vi } from "vitest";

const { createGoogleGenAIMock, generateContentMock } = vi.hoisted(() => {
  const generateContentMock = vi.fn();
  const createGoogleGenAIMock = vi.fn(() => {
    return {
      models: {
        generateContent: generateContentMock,
      },
    };
  });
  return { createGoogleGenAIMock, generateContentMock };
});

vi.mock("./google-genai-runtime.js", () => ({
  createGoogleGenAI: createGoogleGenAIMock,
}));

import * as providerAuthRuntime from "openclaw/plugin-sdk/provider-auth-runtime";
import { expectExplicitMusicGenerationCapabilities } from "openclaw/plugin-sdk/provider-test-contracts";
import { buildGoogleMusicGenerationProvider } from "./music-generation-provider.js";

describe("google music generation provider", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    generateContentMock.mockReset();
    createGoogleGenAIMock.mockClear();
  });

  it("declares explicit mode capabilities", () => {
    expectExplicitMusicGenerationCapabilities(buildGoogleMusicGenerationProvider());
  });

  it("submits generation and returns inline audio bytes plus lyrics", async () => {
    vi.spyOn(providerAuthRuntime, "resolveApiKeyForProvider").mockResolvedValue({
      apiKey: "google-key",
      source: "env",
      mode: "api-key",
    });
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

    expect(generateContentMock).toHaveBeenCalledWith(
      expect.objectContaining({
        model: "lyria-3-clip-preview",
        config: {
          responseModalities: ["AUDIO", "TEXT"],
        },
      }),
    );
    expect(result.tracks).toHaveLength(1);
    expect(result.tracks[0]?.mimeType).toBe("audio/mpeg");
    expect(result.lyrics).toEqual(["wake the city up"]);
    expect(createGoogleGenAIMock).toHaveBeenCalledWith(
      expect.objectContaining({
        apiKey: "google-key",
      }),
    );
  });

  it("strips /v1beta suffix from configured baseUrl before passing to GoogleGenAI SDK", async () => {
    vi.spyOn(providerAuthRuntime, "resolveApiKeyForProvider").mockResolvedValue({
      apiKey: "google-key",
      source: "env",
      mode: "api-key",
    });
    generateContentMock.mockResolvedValue({
      candidates: [
        {
          content: {
            parts: [
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
    await provider.generateMusic({
      provider: "google",
      model: "lyria-3-clip-preview",
      prompt: "ambient ocean",
      cfg: {
        models: {
          providers: {
            google: { baseUrl: "https://generativelanguage.googleapis.com/v1beta", models: [] },
          },
        },
      },
      instrumental: true,
    });

    expect(createGoogleGenAIMock).toHaveBeenCalledWith(
      expect.objectContaining({
        httpOptions: expect.objectContaining({
          baseUrl: "https://generativelanguage.googleapis.com",
        }),
      }),
    );
  });

  it("does NOT strip /v1beta when it appears mid-path (end-anchor proof)", async () => {
    vi.spyOn(providerAuthRuntime, "resolveApiKeyForProvider").mockResolvedValue({
      apiKey: "google-key",
      source: "env",
      mode: "api-key",
    });
    generateContentMock.mockResolvedValue({
      candidates: [
        {
          content: {
            parts: [
              { inlineData: { data: Buffer.from("x").toString("base64"), mimeType: "audio/mpeg" } },
            ],
          },
        },
      ],
    });

    const provider = buildGoogleMusicGenerationProvider();
    await provider.generateMusic({
      provider: "google",
      model: "lyria-3-clip-preview",
      prompt: "test",
      cfg: {
        models: {
          providers: { google: { baseUrl: "https://proxy.example.com/v1beta/route", models: [] } },
        },
      },
      instrumental: true,
    });

    expect(createGoogleGenAIMock).toHaveBeenCalledWith(
      expect.objectContaining({
        httpOptions: expect.objectContaining({
          baseUrl: "https://proxy.example.com/v1beta/route",
        }),
      }),
    );
  });

  it("passes baseUrl unchanged when no /v1beta suffix is present", async () => {
    vi.spyOn(providerAuthRuntime, "resolveApiKeyForProvider").mockResolvedValue({
      apiKey: "google-key",
      source: "env",
      mode: "api-key",
    });
    generateContentMock.mockResolvedValue({
      candidates: [
        {
          content: {
            parts: [
              { inlineData: { data: Buffer.from("x").toString("base64"), mimeType: "audio/mpeg" } },
            ],
          },
        },
      ],
    });

    const provider = buildGoogleMusicGenerationProvider();
    await provider.generateMusic({
      provider: "google",
      model: "lyria-3-clip-preview",
      prompt: "test",
      cfg: {
        models: {
          providers: {
            google: { baseUrl: "https://generativelanguage.googleapis.com", models: [] },
          },
        },
      },
      instrumental: true,
    });

    expect(createGoogleGenAIMock).toHaveBeenCalledWith(
      expect.objectContaining({
        httpOptions: expect.objectContaining({
          baseUrl: "https://generativelanguage.googleapis.com",
        }),
      }),
    );
  });

  it("does not set baseUrl when none is configured", async () => {
    vi.spyOn(providerAuthRuntime, "resolveApiKeyForProvider").mockResolvedValue({
      apiKey: "google-key",
      source: "env",
      mode: "api-key",
    });
    generateContentMock.mockResolvedValue({
      candidates: [
        {
          content: {
            parts: [
              { inlineData: { data: Buffer.from("x").toString("base64"), mimeType: "audio/mpeg" } },
            ],
          },
        },
      ],
    });

    const provider = buildGoogleMusicGenerationProvider();
    await provider.generateMusic({
      provider: "google",
      model: "lyria-3-clip-preview",
      prompt: "test",
      cfg: {},
      instrumental: true,
    });

    expect(createGoogleGenAIMock).toHaveBeenCalledWith(
      expect.objectContaining({
        httpOptions: expect.not.objectContaining({
          baseUrl: expect.anything(),
        }),
      }),
    );
  });

  it("rejects unsupported wav output on clip model", async () => {
    vi.spyOn(providerAuthRuntime, "resolveApiKeyForProvider").mockResolvedValue({
      apiKey: "google-key",
      source: "env",
      mode: "api-key",
    });
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
