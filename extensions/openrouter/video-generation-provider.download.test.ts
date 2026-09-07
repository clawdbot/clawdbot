import { afterEach, describe, expect, it, vi } from "vitest";
import { buildOpenRouterVideoGenerationProvider } from "./video-generation-provider.js";

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
  resolveApiKeyForProviderMock: vi.fn(async () => ({
    apiKey: "openrouter-key",
  })),
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
    response: new Response(JSON.stringify(value), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
    release: vi.fn(async () => {}),
  };
}

function releasedVideo(params: { contentType: string; bytes: string }) {
  return {
    response: new Response(Buffer.from(params.bytes), {
      status: 200,
      headers: { "content-type": params.contentType },
    }),
    release: vi.fn(async () => {}),
  };
}

describe("openrouter generated video download", () => {
  afterEach(() => {
    assertOkOrThrowHttpErrorMock.mockClear();
    fetchWithTimeoutGuardedMock.mockReset();
    postJsonRequestMock.mockReset();
    resolveApiKeyForProviderMock.mockClear();
    resolveProviderHttpRequestConfigMock.mockClear();
    waitProviderOperationPollIntervalMock.mockClear();
  });

  it.each([
    {
      name: "JSON error",
      contentType: "application/json",
      bytes: '{"error":"denied"}',
    },
    {
      name: "problem JSON",
      contentType: "application/problem+json",
      bytes: '{"title":"denied"}',
    },
    {
      name: "HTML",
      contentType: "text/html; charset=utf-8",
      bytes: "<html>sign in</html>",
    },
    { name: "empty video", contentType: "video/mp4", bytes: "" },
  ])(
    "rejects a successful $name response as a downloaded OpenRouter video",
    async ({ contentType, bytes }) => {
      postJsonRequestMock.mockResolvedValue(
        releasedJson({
          id: "job-123",
          polling_url: "/api/v1/videos/job-123",
          status: "completed",
          unsigned_urls: ["https://cdn.openrouter.test/video.mp4"],
        }),
      );
      const download = releasedVideo({ contentType, bytes });
      fetchWithTimeoutGuardedMock.mockResolvedValueOnce(download);

      const provider = buildOpenRouterVideoGenerationProvider();
      await expect(
        provider.generateVideo({
          provider: "openrouter",
          model: "google/veo-3.1",
          prompt: "A glass cube reflects a neon skyline",
          cfg: {},
        }),
      ).rejects.toThrow("OpenRouter generated video download: malformed video response");

      expect(download.release).toHaveBeenCalledTimes(1);
    },
  );
});
