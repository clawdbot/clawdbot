import { clearLiveCatalogCacheForTests } from "openclaw/plugin-sdk/provider-catalog-shared";
import {
  expectExplicitVideoGenerationCapabilities,
  expectUnifiedModelCatalogEntries,
} from "openclaw/plugin-sdk/provider-test-contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildOpenRouterVideoGenerationProvider,
  listOpenRouterVideoModelCatalog,
} from "./video-generation-provider.js";

const SUPPORTED_DURATIONS_HINT = Symbol.for("openclaw.videoGeneration.supportedDurations");

const {
  assertOkOrThrowHttpErrorMock,
  fetchWithTimeoutGuardedMock,
  postJsonRequestMock,
  resolveApiKeyForProviderMock,
  resolveProviderHttpRequestConfigMock,
  waitProviderOperationPollIntervalMock,
} = vi.hoisted(() => ({
  assertOkOrThrowHttpErrorMock: vi.fn(async () => {}),
  fetchWithTimeoutGuardedMock: vi.fn(),
  postJsonRequestMock: vi.fn(),
  resolveApiKeyForProviderMock: vi.fn(async () => ({ apiKey: "openrouter-key" })),
  resolveProviderHttpRequestConfigMock: vi.fn((params: Record<string, unknown>) => ({
    baseUrl: params.baseUrl ?? params.defaultBaseUrl ?? "https://openrouter.ai/api/v1",
    allowPrivateNetwork: false,
    headers: new Headers(params.defaultHeaders as HeadersInit | undefined),
    dispatcherPolicy: undefined,
    requestConfig: {},
  })),
  waitProviderOperationPollIntervalMock: vi.fn(async () => {}),
}));

vi.mock("openclaw/plugin-sdk/provider-auth-runtime", () => ({
  resolveApiKeyForProvider: resolveApiKeyForProviderMock,
}));

vi.mock("openclaw/plugin-sdk/provider-http", async () => {
  const actual = await vi.importActual<typeof import("openclaw/plugin-sdk/provider-http")>(
    "openclaw/plugin-sdk/provider-http",
  );
  return {
    ...actual,
    assertOkOrThrowHttpError: assertOkOrThrowHttpErrorMock,
    fetchWithTimeoutGuarded: fetchWithTimeoutGuardedMock,
    postJsonRequest: postJsonRequestMock,
    resolveProviderHttpRequestConfig: resolveProviderHttpRequestConfigMock,
    waitProviderOperationPollInterval: waitProviderOperationPollIntervalMock,
  };
});

function releasedJson(value: unknown) {
  return {
    response: {
      json: async () => value,
    },
    release: vi.fn(async () => {}),
  };
}

function releasedVideo(params: { contentType: string; bytes: string }) {
  return {
    response: {
      headers: new Headers({ "content-type": params.contentType }),
      arrayBuffer: async () => Buffer.from(params.bytes),
    },
    release: vi.fn(async () => {}),
  };
}

type OpenRouterVideoProvider = ReturnType<typeof buildOpenRouterVideoGenerationProvider>;
type OpenRouterVideoResult = Awaited<ReturnType<OpenRouterVideoProvider["generateVideo"]>>;

function requireGenerateCapabilities(provider: OpenRouterVideoProvider) {
  const capabilities = provider.capabilities.generate;
  if (!capabilities) {
    throw new Error("expected OpenRouter generate capabilities");
  }
  return capabilities;
}

function requireFetchCallHeaders(index: number): Headers {
  const call = fetchWithTimeoutGuardedMock.mock.calls[index];
  if (!call) {
    throw new Error(`expected OpenRouter fetch call ${index + 1}`);
  }
  const init = call[1] as { headers?: HeadersInit } | undefined;
  if (!init) {
    throw new Error(`expected OpenRouter fetch call ${index + 1} init`);
  }
  return new Headers(init.headers);
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  expect(typeof value).toBe("object");
  expect(value).not.toBeNull();
  if (typeof value !== "object" || value === null) {
    throw new Error(`${label} was not an object`);
  }
  return value as Record<string, unknown>;
}

function expectRecordFields(record: Record<string, unknown>, fields: Record<string, unknown>) {
  for (const [key, value] of Object.entries(fields)) {
    expect(record[key]).toEqual(value);
  }
}

function expectOpenRouterFetchCall(index: number, url: string, auditContext: string) {
  const call = fetchWithTimeoutGuardedMock.mock.calls[index];
  if (!call) {
    throw new Error(`expected OpenRouter fetch call ${index + 1}`);
  }
  const [actualUrl, init, timeoutMs, fetchFn, guardOptions] = call;
  expect(actualUrl).toBe(url);
  expect(requireRecord(init, "OpenRouter fetch init").method).toBe("GET");
  expect(Number.isInteger(timeoutMs)).toBe(true);
  expect(timeoutMs).toBeGreaterThan(0);
  expect(fetchFn).toBe(fetch);
  expect(requireRecord(guardOptions, "OpenRouter fetch guard options").auditContext).toBe(
    auditContext,
  );
}

function requirePostJsonParams(index = 0): Record<string, unknown> {
  const call = postJsonRequestMock.mock.calls[index] as unknown[] | undefined;
  if (!call) {
    throw new Error(`expected OpenRouter POST JSON call ${index + 1}`);
  }
  return requireRecord(call[0], "OpenRouter POST JSON params");
}

function requireMockCallArg(
  mockCalls: unknown[][],
  index: number,
  argIndex: number,
  label: string,
) {
  const call = mockCalls[index];
  if (!call) {
    throw new Error(`expected ${label} call ${index + 1}`);
  }
  return call[argIndex];
}

function requireGeneratedVideo(result: OpenRouterVideoResult, index: number) {
  const video = result.videos[index];
  if (!video) {
    throw new Error(`expected OpenRouter generated video at index ${index}`);
  }
  return video;
}

function requireGeneratedVideoBuffer(result: OpenRouterVideoResult, index: number) {
  const video = requireGeneratedVideo(result, index);
  expect(video.buffer).toBeInstanceOf(Buffer);
  if (!video.buffer) {
    throw new Error(`expected OpenRouter generated video ${index} buffer`);
  }
  return { video, buffer: video.buffer };
}

describe("openrouter video generation provider", () => {
  beforeEach(() => {
    clearLiveCatalogCacheForTests();
  });

  afterEach(() => {
    assertOkOrThrowHttpErrorMock.mockClear();
    fetchWithTimeoutGuardedMock.mockReset();
    postJsonRequestMock.mockReset();
    resolveApiKeyForProviderMock.mockClear();
    resolveProviderHttpRequestConfigMock.mockClear();
    waitProviderOperationPollIntervalMock.mockClear();
  });

  it("declares explicit mode capabilities", () => {
    const provider = buildOpenRouterVideoGenerationProvider();

    expectExplicitVideoGenerationCapabilities(provider);
    expect(provider.id).toBe("openrouter");
    expect(provider.defaultModel).toBe("google/veo-3.1-fast");
    const generateCapabilities = requireGenerateCapabilities(provider);
    expect(generateCapabilities.supportsAudio).toBe(true);
    expect(generateCapabilities.supportedDurationSeconds).toEqual([4, 6, 8]);
    expect(generateCapabilities.resolutions).toEqual(["720P", "1080P"]);
    expect(generateCapabilities.aspectRatios).toEqual(["16:9", "9:16"]);
    expect(provider.capabilities.imageToVideo?.enabled).toBe(true);
    expect(provider.capabilities.videoToVideo?.enabled).toBe(false);
  });

  it("maps OpenRouter video model discovery into unified catalog rows", async () => {
    fetchWithTimeoutGuardedMock.mockResolvedValueOnce(
      releasedJson({
        data: [
          {
            id: "google/veo-3.1",
            name: "Veo 3.1",
            canonical_slug: "google/veo-3.1",
            description: "Google video generation model",
            created: 1_700_000_000,
            generate_audio: true,
            supported_aspect_ratios: ["16:9"],
            supported_durations: [5, 8],
            supported_frame_images: ["first_frame", "last_frame"],
            supported_resolutions: ["720p"],
            supported_sizes: ["1280x720"],
            allowed_passthrough_parameters: ["provider"],
            pricing_skus: { generate: "0.50" },
          },
        ],
      }),
    );

    const rows = await listOpenRouterVideoModelCatalog({
      config: {
        models: {
          providers: {
            openrouter: {
              baseUrl: "https://custom.openrouter.test/openrouter/api/v1",
            },
          },
        },
      } as never,
      env: {},
      resolveProviderApiKey: () => ({
        apiKey: "OPENROUTER_API_KEY",
        discoveryApiKey: "resolved-openrouter-key",
      }),
      resolveProviderAuth: () => ({
        apiKey: "OPENROUTER_API_KEY",
        discoveryApiKey: "resolved-openrouter-key",
        mode: "api_key",
        source: "env",
      }),
    });

    expectRecordFields(
      requireRecord(resolveProviderHttpRequestConfigMock.mock.calls[0]?.[0], "request config"),
      {
        baseUrl: "https://custom.openrouter.test/openrouter/api/v1",
        defaultBaseUrl: "https://openrouter.ai/api/v1",
        provider: "openrouter",
        capability: "video",
      },
    );
    expectOpenRouterFetchCall(
      0,
      "https://custom.openrouter.test/openrouter/api/v1/videos/models",
      "openrouter-video-models",
    );
    expect(requireFetchCallHeaders(0).get("authorization")).toBe("Bearer resolved-openrouter-key");
    expectUnifiedModelCatalogEntries(rows, {
      provider: "openrouter",
      kind: "video_generation",
    });
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row).toBeDefined();
    if (!row) {
      throw new Error("expected OpenRouter catalog row");
    }
    expectRecordFields(row as unknown as Record<string, unknown>, {
      kind: "video_generation",
      provider: "openrouter",
      model: "google/veo-3.1",
      label: "Veo 3.1",
      source: "live",
    });
    const capabilities = requireRecord(row.capabilities, "catalog row capabilities");
    expectRecordFields(capabilities, {
      canonicalSlug: "google/veo-3.1",
      description: "Google video generation model",
      created: 1_700_000_000,
      pricingSkus: { generate: "0.50" },
      allowedPassthroughParameters: ["provider"],
      videoToVideo: { enabled: false },
    });
    expectRecordFields(requireRecord(capabilities.generate, "generate capabilities"), {
      supportsAudio: true,
      supportedDurationSeconds: [5, 8],
      aspectRatios: ["16:9"],
      resolutions: ["720P"],
      sizes: ["1280x720"],
    });
    expectRecordFields(requireRecord(capabilities.imageToVideo, "image-to-video capabilities"), {
      enabled: true,
      maxInputImages: 2,
    });
  });

  it("skips live OpenRouter video catalog discovery without an API key", async () => {
    await expect(
      listOpenRouterVideoModelCatalog({
        config: {} as never,
        env: {},
        resolveProviderApiKey: () => ({ apiKey: "OPENROUTER_API_KEY" }),
        resolveProviderAuth: () => ({ apiKey: undefined, mode: "none", source: "none" }),
      }),
    ).resolves.toBeNull();
    expect(fetchWithTimeoutGuardedMock).not.toHaveBeenCalled();
  });

  it("resolves live per-model capabilities for runtime overlays", async () => {
    fetchWithTimeoutGuardedMock.mockResolvedValueOnce(
      releasedJson({
        data: [
          {
            id: "google/veo-3.1",
            name: "Veo 3.1",
            generate_audio: false,
            supported_durations: [5],
            supported_resolutions: ["720p"],
            allowed_passthrough_parameters: ["seed"],
          },
        ],
      }),
    );

    const provider = buildOpenRouterVideoGenerationProvider();
    const capabilities = await provider.resolveModelCapabilities?.({
      provider: "openrouter",
      model: "google/veo-3.1",
      cfg: {
        models: {
          providers: {
            openrouter: {
              baseUrl: "https://custom.openrouter.test/openrouter/api/v1",
            },
          },
        },
      } as never,
      timeoutMs: 12_345,
    });

    expect(
      requireRecord(
        requireMockCallArg(resolveApiKeyForProviderMock.mock.calls, 0, 0, "API key request"),
        "API key request",
      ).provider,
    ).toBe("openrouter");
    expectOpenRouterFetchCall(
      0,
      "https://custom.openrouter.test/openrouter/api/v1/videos/models",
      "openrouter-video-models",
    );
    expect(fetchWithTimeoutGuardedMock.mock.calls[0]?.[2]).toBe(12_345);
    expect(fetchWithTimeoutGuardedMock.mock.calls[0]?.[3]).toBeTypeOf("function");
    const resolvedCapabilities = requireRecord(capabilities, "resolved capabilities");
    expect(resolvedCapabilities.providerOptions).toEqual({
      callback_url: "string",
      seed: "number",
    });
    expectRecordFields(requireRecord(resolvedCapabilities.generate, "generate capabilities"), {
      supportsAudio: false,
      supportedDurationSeconds: [5],
      resolutions: ["720P"],
    });
  });

  it("clamps direct exact integer durations to static OpenRouter supported values", async () => {
    postJsonRequestMock.mockResolvedValue(
      releasedJson({
        id: "job-123",
        polling_url: "/api/v1/videos/job-123",
        status: "completed",
        unsigned_urls: ["/api/v1/videos/job-123/content?index=0"],
      }),
    );
    fetchWithTimeoutGuardedMock.mockResolvedValueOnce(
      releasedVideo({ contentType: "video/mp4", bytes: "mp4-bytes" }),
    );

    const provider = buildOpenRouterVideoGenerationProvider();
    await provider.generateVideo({
      provider: "openrouter",
      model: "google/veo-3.1",
      prompt: "A brushed steel logo rotates against a clean white backdrop",
      durationSeconds: 7,
      cfg: {} as never,
    });

    expect(requireRecord(requirePostJsonParams().body, "OpenRouter request body").duration).toBe(8);
  });

  it("preserves runtime-normalized live catalog durations in request bodies", async () => {
    postJsonRequestMock.mockResolvedValue(
      releasedJson({
        id: "job-123",
        polling_url: "/api/v1/videos/job-123",
        status: "completed",
        unsigned_urls: ["/api/v1/videos/job-123/content?index=0"],
      }),
    );
    fetchWithTimeoutGuardedMock.mockResolvedValueOnce(
      releasedVideo({ contentType: "video/mp4", bytes: "mp4-bytes" }),
    );

    const provider = buildOpenRouterVideoGenerationProvider();
    await provider.generateVideo({
      provider: "openrouter",
      model: "google/veo-3.1",
      prompt: "A brushed steel logo rotates against a clean white backdrop",
      durationSeconds: 5,
      cfg: {} as never,
      [SUPPORTED_DURATIONS_HINT]: [5],
    } as Parameters<typeof provider.generateVideo>[0] & {
      [SUPPORTED_DURATIONS_HINT]: readonly number[];
    });

    expect(requireRecord(requirePostJsonParams().body, "OpenRouter request body").duration).toBe(5);
  });

  it("submits OpenRouter video jobs, polls completion, and downloads the result", async () => {
    postJsonRequestMock.mockResolvedValue(
      releasedJson({
        id: "job-123",
        polling_url: "/api/v1/videos/job-123",
        status: "pending",
      }),
    );
    fetchWithTimeoutGuardedMock
      .mockResolvedValueOnce(
        releasedJson({
          id: "job-123",
          generation_id: "gen-123",
          status: "completed",
          model: "google/veo-3.1",
          unsigned_urls: ["/api/v1/videos/job-123/content?index=0"],
          usage: { cost: 0.25, is_byok: false },
        }),
      )
      .mockResolvedValueOnce(releasedVideo({ contentType: "video/mp4", bytes: "mp4-bytes" }));

    const requestOverrides = {
      proxy: { mode: "explicit-proxy", url: "https://proxy.example" },
    };
    const provider = buildOpenRouterVideoGenerationProvider();
    const result = await provider.generateVideo({
      provider: "openrouter",
      model: "google/veo-3.1",
      prompt: "A chrome sphere glides across a quiet moonlit beach",
      durationSeconds: 5.4,
      aspectRatio: "16:9",
      resolution: "720P",
      size: "1280x720",
      audio: false,
      inputImages: [
        { buffer: Buffer.from("first-frame"), mimeType: "image/png" },
        { buffer: Buffer.from("last-frame"), mimeType: "image/png", role: "last_frame" },
        {
          buffer: Buffer.from("style-reference"),
          mimeType: "image/webp",
          role: "reference_image",
        },
      ],
      providerOptions: {
        callback_url: "https://example.com/openrouter-video-hook",
        seed: 42,
      },
      timeoutMs: 120_000,
      cfg: {
        models: {
          providers: {
            openrouter: {
              baseUrl: "https://custom.openrouter.test/api/v1",
              request: requestOverrides,
            },
          },
        },
      } as never,
    });

    expect(
      requireRecord(
        requireMockCallArg(resolveApiKeyForProviderMock.mock.calls, 0, 0, "API key request"),
        "API key request",
      ).provider,
    ).toBe("openrouter");
    expectRecordFields(
      requireRecord(resolveProviderHttpRequestConfigMock.mock.calls[0]?.[0], "request config"),
      {
        provider: "openrouter",
        capability: "video",
        baseUrl: "https://custom.openrouter.test/api/v1",
        request: requestOverrides,
      },
    );
    const postParams = requirePostJsonParams();
    expect(postParams.url).toBe("https://custom.openrouter.test/api/v1/videos");
    expect(postParams.body).toEqual({
      model: "google/veo-3.1",
      prompt: "A chrome sphere glides across a quiet moonlit beach",
      duration: 6,
      resolution: "720p",
      aspect_ratio: "16:9",
      size: "1280x720",
      generate_audio: false,
      frame_images: [
        {
          type: "image_url",
          image_url: {
            url: `data:image/png;base64,${Buffer.from("first-frame").toString("base64")}`,
          },
          frame_type: "first_frame",
        },
        {
          type: "image_url",
          image_url: {
            url: `data:image/png;base64,${Buffer.from("last-frame").toString("base64")}`,
          },
          frame_type: "last_frame",
        },
      ],
      input_references: [
        {
          type: "image_url",
          image_url: {
            url: `data:image/webp;base64,${Buffer.from("style-reference").toString("base64")}`,
          },
        },
      ],
      callback_url: "https://example.com/openrouter-video-hook",
      seed: 42,
    });
    expectOpenRouterFetchCall(
      0,
      "https://custom.openrouter.test/api/v1/videos/job-123",
      "openrouter-video-status",
    );
    expect(requireFetchCallHeaders(0).get("authorization")).toBe("Bearer openrouter-key");
    expectOpenRouterFetchCall(
      1,
      "https://custom.openrouter.test/api/v1/videos/job-123/content?index=0",
      "openrouter-video-download",
    );
    expect(requireFetchCallHeaders(1).get("authorization")).toBe("Bearer openrouter-key");
    const { video, buffer } = requireGeneratedVideoBuffer(result, 0);
    expect(buffer.toString()).toBe("mp4-bytes");
    expect(video.mimeType).toBe("video/mp4");
    expect(result.metadata).toEqual({
      jobId: "job-123",
      status: "completed",
      generationId: "gen-123",
      usage: { cost: 0.25, is_byok: false },
    });
  });

  it("does not forward auth headers to cross-origin polling URLs", async () => {
    postJsonRequestMock.mockResolvedValue(
      releasedJson({
        id: "job-123",
        polling_url: "https://polling.example.test/videos/job-123",
        status: "pending",
      }),
    );
    fetchWithTimeoutGuardedMock
      .mockResolvedValueOnce(
        releasedJson({
          id: "job-123",
          status: "completed",
          unsigned_urls: ["https://cdn.openrouter.test/video.mp4"],
        }),
      )
      .mockResolvedValueOnce(releasedVideo({ contentType: "video/mp4", bytes: "mp4-bytes" }));

    const provider = buildOpenRouterVideoGenerationProvider();
    await provider.generateVideo({
      provider: "openrouter",
      model: "google/veo-3.1",
      prompt: "A gentle camera pan across a neon reef",
      cfg: {} as never,
    });

    expectOpenRouterFetchCall(
      0,
      "https://polling.example.test/videos/job-123",
      "openrouter-video-status",
    );
    expect(requireFetchCallHeaders(0).get("authorization")).toBeNull();
    expectOpenRouterFetchCall(
      1,
      "https://cdn.openrouter.test/video.mp4",
      "openrouter-video-download",
    );
    expect(requireFetchCallHeaders(1).get("authorization")).toBeNull();
  });

  it("falls back to the documented content endpoint when a completed job has no output URL", async () => {
    postJsonRequestMock.mockResolvedValue(
      releasedJson({
        id: "job-123",
        polling_url: "https://openrouter.ai/api/v1/videos/job-123",
        status: "completed",
      }),
    );
    fetchWithTimeoutGuardedMock.mockResolvedValueOnce(
      releasedVideo({ contentType: "video/webm", bytes: "webm-bytes" }),
    );

    const provider = buildOpenRouterVideoGenerationProvider();
    const result = await provider.generateVideo({
      provider: "openrouter",
      model: "google/veo-3.1",
      prompt: "A tiny robot watering a bonsai",
      cfg: {} as never,
    });

    expectOpenRouterFetchCall(
      0,
      "https://openrouter.ai/api/v1/videos/job-123/content?index=0",
      "openrouter-video-download",
    );
    const { video, buffer } = requireGeneratedVideoBuffer(result, 0);
    expect(buffer.toString()).toBe("webm-bytes");
    expect(video.fileName).toBe("video-1.webm");
  });

  it("rejects video reference inputs", async () => {
    const provider = buildOpenRouterVideoGenerationProvider();

    await expect(
      provider.generateVideo({
        provider: "openrouter",
        model: "google/veo-3.1",
        prompt: "remix this clip",
        inputVideos: [{ url: "https://example.com/source.mp4", mimeType: "video/mp4" }],
        cfg: {} as never,
      }),
    ).rejects.toThrow("does not support video reference inputs");
  });
});
