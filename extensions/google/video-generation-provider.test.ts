import { writeFile } from "node:fs/promises";
import path from "node:path";
import { mockPinnedHostnameResolution } from "openclaw/plugin-sdk/test-env";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { createGoogleGenAIMock, downloadMock, generateVideosMock, getVideosOperationMock } =
  vi.hoisted(() => {
    const generateVideosMock = vi.fn();
    const getVideosOperationMock = vi.fn();
    const downloadMock = vi.fn();
    const createGoogleGenAIMock = vi.fn(() => {
      return {
        models: {
          generateVideos: generateVideosMock,
        },
        operations: {
          getVideosOperation: getVideosOperationMock,
        },
        files: {
          download: downloadMock,
        },
      };
    });
    return { createGoogleGenAIMock, downloadMock, generateVideosMock, getVideosOperationMock };
  });

vi.mock("./google-genai-runtime.js", () => ({
  createGoogleGenAI: createGoogleGenAIMock,
}));

import * as providerAuthRuntime from "openclaw/plugin-sdk/provider-auth-runtime";
import { expectExplicitVideoGenerationCapabilities } from "openclaw/plugin-sdk/provider-test-contracts";
import { buildGoogleVideoGenerationProvider } from "./video-generation-provider.js";

type MockWithCalls = {
  mock: { calls: unknown[][] };
};

function firstObjectArg(mock: MockWithCalls): Record<string, unknown> {
  const [call] = mock.mock.calls;
  if (!call) {
    throw new Error("expected first mock call to receive an object argument");
  }
  const value = call[0];
  if (value === undefined || value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("expected first mock call to receive an object argument");
  }
  return value as Record<string, unknown>;
}

function recordField(value: unknown, field: string): Record<string, unknown> {
  if (value === undefined || value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`expected ${field} to be an object`);
  }
  return value as Record<string, unknown>;
}

function firstGoogleClientHttpOptions(): Record<string, unknown> {
  return recordField(firstObjectArg(createGoogleGenAIMock).httpOptions, "httpOptions");
}

function requireFetchCall(
  fetchMock: ReturnType<typeof vi.fn>,
  index: number,
): [RequestInfo | URL, RequestInit | undefined] {
  const call = fetchMock.mock.calls[index];
  if (!call) {
    throw new Error(`expected Google video fetch call ${index}`);
  }
  return call as [RequestInfo | URL, RequestInit | undefined];
}

function parseFetchJsonBody(fetchMock: ReturnType<typeof vi.fn>, index: number): unknown {
  const [, init] = requireFetchCall(fetchMock, index);
  const body = init?.body;
  if (typeof body !== "string") {
    throw new Error(`expected Google video fetch body ${index}`);
  }
  return JSON.parse(body) as unknown;
}

function fetchInputUrl(fetchMock: ReturnType<typeof vi.fn>, index: number): string {
  const [input] = requireFetchCall(fetchMock, index);
  if (typeof input === "string") {
    return input;
  }
  if (input instanceof URL) {
    return input.toString();
  }
  return input.url;
}

let ssrfMock: { mockRestore: () => void } | undefined;

describe("google video generation provider", () => {
  beforeEach(() => {
    ssrfMock = mockPinnedHostnameResolution();
  });

  afterEach(() => {
    ssrfMock?.mockRestore();
    ssrfMock = undefined;
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    downloadMock.mockReset();
    generateVideosMock.mockReset();
    getVideosOperationMock.mockReset();
    createGoogleGenAIMock.mockClear();
  });

  afterAll(() => {
    vi.doUnmock("./google-genai-runtime.js");
    vi.resetModules();
  });

  it("declares explicit mode capabilities", () => {
    const provider = buildGoogleVideoGenerationProvider();
    expectExplicitVideoGenerationCapabilities(provider);
    expect(provider.capabilities.generate?.supportsAudio).toBe(false);
    expect(provider.capabilities.imageToVideo?.supportsAudio).toBe(false);
    expect(provider.capabilities.videoToVideo?.supportsAudio).toBe(false);
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
    const request = firstObjectArg(generateVideosMock);
    expect(request.model).toBe("veo-3.1-fast-generate-preview");
    expect(request.prompt).toBe("A tiny robot watering a windowsill garden");
    const config = recordField(request.config, "config");
    expect(config.durationSeconds).toBe(4);
    expect(config.aspectRatio).toBe("16:9");
    expect(config.resolution).toBe("720p");
    expect(config).not.toHaveProperty("generateAudio");
    expect(config).not.toHaveProperty("numberOfVideos");
    expect(result.videos).toHaveLength(1);
    expect(result.videos[0]?.mimeType).toBe("video/mp4");
    const clientOptions = firstObjectArg(createGoogleGenAIMock);
    expect(clientOptions.apiKey).toBe("google-key");
    const httpOptions = recordField(clientOptions.httpOptions, "httpOptions");
    expect(httpOptions).not.toHaveProperty("baseUrl");
    expect(httpOptions).not.toHaveProperty("apiVersion");
  });

  it("strips /v1beta suffix from configured baseUrl before passing to GoogleGenAI SDK", async () => {
    vi.spyOn(providerAuthRuntime, "resolveApiKeyForProvider").mockResolvedValue({
      apiKey: "google-key",
      source: "env",
      mode: "api-key",
    });
    generateVideosMock.mockResolvedValue({
      done: true,
      response: {
        generatedVideos: [
          { video: { videoBytes: Buffer.from("mp4").toString("base64"), mimeType: "video/mp4" } },
        ],
      },
    });

    const provider = buildGoogleVideoGenerationProvider();
    await provider.generateVideo({
      provider: "google",
      model: "veo-3.1-fast-generate-preview",
      prompt: "A tiny robot watering a windowsill garden",
      cfg: {
        models: {
          providers: {
            google: { baseUrl: "https://generativelanguage.googleapis.com/v1beta", models: [] },
          },
        },
      },
      durationSeconds: 3,
    });

    expect(firstGoogleClientHttpOptions().baseUrl).toBe(
      "https://generativelanguage.googleapis.com",
    );
  });

  it("downloads MLDev direct video uri responses without routing through the Files API", async () => {
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
              uri: "https://generativelanguage.googleapis.com/v1beta/files/generated-video:download?alt=media",
              mimeType: "video/mp4",
            },
          },
        ],
      },
    });
    const fetchMock = vi.fn(async () => {
      return new Response("direct-mp4", {
        status: 200,
        statusText: "OK",
        headers: { "content-type": "video/mp4" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const provider = buildGoogleVideoGenerationProvider();
    const result = await provider.generateVideo({
      provider: "google",
      model: "veo-3.1-fast-generate-preview",
      prompt: "A tiny robot watering a windowsill garden",
      cfg: {},
      durationSeconds: 3,
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [[downloadUrl]] = fetchMock.mock.calls as unknown as [[string, RequestInit?]];
    expect(downloadUrl).toBe(
      "https://generativelanguage.googleapis.com/v1beta/files/generated-video:download?alt=media&key=google-key",
    );
    expect(downloadMock).not.toHaveBeenCalled();
    expect(result.videos[0]?.buffer).toEqual(Buffer.from("direct-mp4"));
    expect(result.videos[0]?.mimeType).toBe("video/mp4");
  });

  it("stages SDK file downloads before finalizing generated video bytes", async () => {
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
              name: "files/generated-video",
              mimeType: "video/mp4",
            },
          },
        ],
      },
    });
    downloadMock.mockImplementation(async ({ downloadPath }: { downloadPath: string }) => {
      await writeFile(downloadPath, "sdk-video");
    });

    const provider = buildGoogleVideoGenerationProvider();
    const result = await provider.generateVideo({
      provider: "google",
      model: "veo-3.1-fast-generate-preview",
      prompt: "A tiny robot watering a windowsill garden",
      cfg: {},
      durationSeconds: 3,
    });

    const [{ downloadPath }] = downloadMock.mock.calls[0] ?? [{}];
    const downloadBaseName = path.basename(String(downloadPath));
    expect(downloadBaseName).toContain("video-1.mp4");
    expect(downloadBaseName).toMatch(/\.part$/);
    expect(result.videos[0]?.buffer).toEqual(Buffer.from("sdk-video"));
    expect(result.videos[0]?.fileName).toBe("video-1.mp4");
  });

  it("falls back to REST predictLongRunning when text-only SDK video generation returns 404", async () => {
    vi.spyOn(providerAuthRuntime, "resolveApiKeyForProvider").mockResolvedValue({
      apiKey: "google-key",
      source: "env",
      mode: "api-key",
    });
    generateVideosMock.mockRejectedValue(Object.assign(new Error("sdk 404"), { status: 404 }));
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            done: true,
            name: "operations/rest-123",
            response: {
              generateVideoResponse: {
                generatedSamples: [
                  {
                    video: {
                      uri: "https://generativelanguage.googleapis.com/v1beta/files/rest-video:download?alt=media",
                      mimeType: "video/mp4",
                    },
                  },
                ],
              },
            },
          }),
        ),
      )
      .mockResolvedValueOnce(
        new Response("rest-video", {
          status: 200,
          statusText: "OK",
          headers: { "content-type": "video/mp4" },
        }),
      );
    vi.stubGlobal("fetch", fetchMock);

    const provider = buildGoogleVideoGenerationProvider();
    const result = await provider.generateVideo({
      provider: "google",
      model: "google/models/veo-3.1-fast-generate-preview",
      prompt: "A tiny robot watering a windowsill garden",
      cfg: {},
      durationSeconds: 3,
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchInputUrl(fetchMock, 0)).toBe(
      "https://generativelanguage.googleapis.com/v1beta/models/veo-3.1-fast-generate-preview:predictLongRunning",
    );
    expect(parseFetchJsonBody(fetchMock, 0)).toEqual({
      instances: [{ prompt: "A tiny robot watering a windowsill garden" }],
      parameters: { durationSeconds: 4 },
    });
    expect(fetchInputUrl(fetchMock, 1)).toBe(
      "https://generativelanguage.googleapis.com/v1beta/files/rest-video:download?alt=media&key=google-key",
    );
    expect(downloadMock).not.toHaveBeenCalled();
    expect(result.videos[0]?.buffer).toEqual(Buffer.from("rest-video"));
  });

  it("does not fall back to REST when SDK video generation with reference inputs returns 404", async () => {
    vi.spyOn(providerAuthRuntime, "resolveApiKeyForProvider").mockResolvedValue({
      apiKey: "google-key",
      source: "env",
      mode: "api-key",
    });
    generateVideosMock.mockRejectedValue(Object.assign(new Error("sdk 404"), { status: 404 }));
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const provider = buildGoogleVideoGenerationProvider();
    await expect(
      provider.generateVideo({
        provider: "google",
        model: "veo-3.1-fast-generate-preview",
        prompt: "Animate this sketch",
        cfg: {},
        inputImages: [{ buffer: Buffer.from("img"), mimeType: "image/png" }],
      }),
    ).rejects.toThrow("sdk 404");

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does NOT strip /v1beta when it appears mid-path (end-anchor proof)", async () => {
    vi.spyOn(providerAuthRuntime, "resolveApiKeyForProvider").mockResolvedValue({
      apiKey: "google-key",
      source: "env",
      mode: "api-key",
    });
    generateVideosMock.mockResolvedValue({
      done: true,
      response: {
        generatedVideos: [
          { video: { videoBytes: Buffer.from("mp4").toString("base64"), mimeType: "video/mp4" } },
        ],
      },
    });

    const provider = buildGoogleVideoGenerationProvider();
    await provider.generateVideo({
      provider: "google",
      model: "veo-3.1-fast-generate-preview",
      prompt: "test",
      cfg: {
        models: {
          providers: { google: { baseUrl: "https://proxy.example.com/v1beta/route", models: [] } },
        },
      },
      durationSeconds: 3,
    });

    expect(firstGoogleClientHttpOptions().baseUrl).toBe("https://proxy.example.com/v1beta/route");
  });

  it("passes baseUrl unchanged when no /v1beta suffix is present", async () => {
    vi.spyOn(providerAuthRuntime, "resolveApiKeyForProvider").mockResolvedValue({
      apiKey: "google-key",
      source: "env",
      mode: "api-key",
    });
    generateVideosMock.mockResolvedValue({
      done: true,
      response: {
        generatedVideos: [
          { video: { videoBytes: Buffer.from("mp4").toString("base64"), mimeType: "video/mp4" } },
        ],
      },
    });

    const provider = buildGoogleVideoGenerationProvider();
    await provider.generateVideo({
      provider: "google",
      model: "veo-3.1-fast-generate-preview",
      prompt: "test",
      cfg: {
        models: {
          providers: {
            google: { baseUrl: "https://generativelanguage.googleapis.com", models: [] },
          },
        },
      },
      durationSeconds: 3,
    });

    expect(firstGoogleClientHttpOptions().baseUrl).toBe(
      "https://generativelanguage.googleapis.com",
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

    const request = firstObjectArg(generateVideosMock);
    const config = recordField(request.config, "config");
    expect(config.durationSeconds).toBe(6);
  });
});
