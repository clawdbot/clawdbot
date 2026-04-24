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
import { expectExplicitMusicGenerationCapabilities } from "../../test/helpers/media-generation/provider-capability-assertions.js";
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
