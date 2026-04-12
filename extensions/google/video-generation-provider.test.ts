import { afterEach, describe, expect, it, vi } from "vitest";

const { GoogleGenAIMock, generateVideosMock, getVideosOperationMock } = vi.hoisted(() => {
  const generateVideosMock = vi.fn();
  const getVideosOperationMock = vi.fn();
  const GoogleGenAIMock = vi.fn(function GoogleGenAI() {
    return {
      models: {
        generateVideos: generateVideosMock,
      },
      operations: {
        getVideosOperation: getVideosOperationMock,
      },
      files: {
        download: vi.fn(),
      },
    };
  });
  return { GoogleGenAIMock, generateVideosMock, getVideosOperationMock };
});

vi.mock("@google/genai", () => ({
  GoogleGenAI: GoogleGenAIMock,
}));

import * as providerAuthRuntime from "openclaw/plugin-sdk/provider-auth-runtime";
import { expectExplicitVideoGenerationCapabilities } from "../../test/helpers/media-generation/provider-capability-assertions.js";
import { buildGoogleVideoGenerationProvider } from "./video-generation-provider.js";

describe("google video generation provider", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    generateVideosMock.mockReset();
    getVideosOperationMock.mockReset();
    GoogleGenAIMock.mockClear();
  });

  it("declares explicit mode capabilities", () => {
    expectExplicitVideoGenerationCapabilities(buildGoogleVideoGenerationProvider());
  });

  it("submits generation and returns inline video bytes", async () => {
    vi.spyOn(providerAuthRuntime, "resolveApiKeyForProvider").mockResolvedValue({
      apiKey: "google-key",
      source: "env",
      mode: "api-key",
    });
    generateVideosMock.mockResolvedValue({
      done: true,
      name: "operations/123",
      response: {
        generatedVideos: [
          {
            video: {
              videoBytes: Buffer.from("mp4-bytes").toString("base64"),
              mimeType: "video/mp4",
            },
          },
        ],
      },
    });

    const provider = buildGoogleVideoGenerationProvider();
    const result = await provider.generateVideo({
      provider: "google",
      model: "veo-3.1-fast-generate-preview",
      prompt: "A tiny robot watering a windowsill garden",
      cfg: {},
      aspectRatio: "16:9",
      resolution: "720P",
      durationSeconds: 3,
      audio: true,
    });

    expect(generateVideosMock).toHaveBeenCalledTimes(1);
    const [request] = generateVideosMock.mock.calls[0] ?? [];
    expect(request).toEqual(
      expect.objectContaining({
        model: "veo-3.1-fast-generate-preview",
        prompt: "A tiny robot watering a windowsill garden",
        config: expect.objectContaining({
          durationSeconds: 4,
          aspectRatio: "16:9",
          resolution: "720p",
          generateAudio: true,
        }),
      }),
    );
    expect(request?.config).not.toHaveProperty("numberOfVideos");
    expect(result.videos).toHaveLength(1);
    expect(result.videos[0]?.mimeType).toBe("video/mp4");
    expect(GoogleGenAIMock).toHaveBeenCalledWith(
      expect.objectContaining({
        apiKey: "google-key",
        httpOptions: expect.not.objectContaining({
          baseUrl: expect.anything(),
          apiVersion: expect.anything(),
        }),
      }),
    );
  });

  it("rejects mixed image and video inputs", async () => {
    vi.spyOn(providerAuthRuntime, "resolveApiKeyForProvider").mockResolvedValue({
      apiKey: "google-key",
      source: "env",
      mode: "api-key",
    });
    const provider = buildGoogleVideoGenerationProvider();

    await expect(
      provider.generateVideo({
        provider: "google",
        model: "veo-3.1-fast-generate-preview",
        prompt: "Animate",
        cfg: {},
        inputImages: [{ buffer: Buffer.from("img"), mimeType: "image/png" }],
        inputVideos: [{ buffer: Buffer.from("vid"), mimeType: "video/mp4" }],
      }),
    ).rejects.toThrow("Google video generation does not support image and video inputs together.");
  });

  it("rounds unsupported durations to the nearest Veo value", async () => {
    vi.spyOn(providerAuthRuntime, "resolveApiKeyForProvider").mockResolvedValue({
      apiKey: "google-key",
      source: "env",
      mode: "api-key",
    });
    generateVideosMock.mockResolvedValue({
      done: true,
      response: {
        generatedVideos: [
          {
            video: {
              videoBytes: Buffer.from("mp4-bytes").toString("base64"),
              mimeType: "video/mp4",
            },
          },
        ],
      },
    });

    const provider = buildGoogleVideoGenerationProvider();
    await provider.generateVideo({
      provider: "google",
      model: "veo-3.1-fast-generate-preview",
      prompt: "A tiny robot watering a windowsill garden",
      cfg: {},
      durationSeconds: 5,
    });

    expect(generateVideosMock).toHaveBeenCalledWith(
      expect.objectContaining({
        config: expect.objectContaining({
          durationSeconds: 6,
        }),
      }),
    );
  });
});
