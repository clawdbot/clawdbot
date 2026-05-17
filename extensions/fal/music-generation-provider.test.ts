import { expectExplicitMusicGenerationCapabilities } from "openclaw/plugin-sdk/provider-test-contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildFalMusicGenerationProvider } from "./music-generation-provider.js";

const {
  assertOkOrThrowHttpErrorMock,
  postJsonRequestMock,
  resolveApiKeyForProviderMock,
  resolveProviderHttpRequestConfigMock,
} = vi.hoisted(() => ({
  assertOkOrThrowHttpErrorMock: vi.fn(async () => {}),
  postJsonRequestMock: vi.fn(),
  resolveApiKeyForProviderMock: vi.fn(async () => ({
    apiKey: "fal-key",
    source: "env",
    mode: "api-key",
  })),
  resolveProviderHttpRequestConfigMock: vi.fn((params: Record<string, unknown>) => ({
    baseUrl: params.baseUrl ?? params.defaultBaseUrl,
    allowPrivateNetwork: false,
    headers: new Headers(params.defaultHeaders as HeadersInit | undefined),
    dispatcherPolicy: undefined,
  })),
}));

vi.mock("openclaw/plugin-sdk/provider-auth-runtime", () => ({
  resolveApiKeyForProvider: resolveApiKeyForProviderMock,
}));

vi.mock("openclaw/plugin-sdk/provider-http", async (importOriginal) => {
  const original = await importOriginal<typeof import("openclaw/plugin-sdk/provider-http")>();
  return {
    ...original,
    assertOkOrThrowHttpError: assertOkOrThrowHttpErrorMock,
    postJsonRequest: postJsonRequestMock,
    resolveProviderHttpRequestConfig: resolveProviderHttpRequestConfigMock,
  };
});

function postRequest(): Record<string, unknown> {
  const request = postJsonRequestMock.mock.calls[0]?.[0];
  if (!request || typeof request !== "object" || Array.isArray(request)) {
    throw new Error("expected fal music request");
  }
  return request as Record<string, unknown>;
}

describe("fal music generation provider", () => {
  afterEach(() => {
    assertOkOrThrowHttpErrorMock.mockClear();
    postJsonRequestMock.mockReset();
    resolveApiKeyForProviderMock.mockClear();
    resolveProviderHttpRequestConfigMock.mockClear();
    vi.unstubAllGlobals();
  });

  it("declares explicit mode capabilities", () => {
    expectExplicitMusicGenerationCapabilities(buildFalMusicGenerationProvider());
  });

  it("submits MiniMax music through fal and downloads the generated track", async () => {
    postJsonRequestMock.mockResolvedValue({
      response: {
        json: async () => ({
          audio: {
            url: "https://v3b.fal.media/files/b/kangaroo/out.mp3",
            content_type: "audio/mpeg",
            file_name: "out.mp3",
          },
        }),
      },
      release: vi.fn(async () => {}),
    });
    const fetchMock = vi.fn(
      async () =>
        new Response(Buffer.from("mp3-bytes"), {
          headers: { "content-type": "application/octet-stream" },
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await buildFalMusicGenerationProvider().generateMusic({
      provider: "fal",
      model: "",
      prompt: "city pop chorus",
      cfg: {},
      lyrics: "[Verse]\nNeon rain",
      durationSeconds: 42,
      format: "mp3",
    });

    expect(postRequest().url).toBe("https://fal.run/fal-ai/minimax-music/v2.6");
    expect(postRequest().body).toEqual({
      prompt: "city pop chorus",
      lyrics: "[Verse]\nNeon rain",
      duration: 42,
      audio_setting: {
        sample_rate: 44100,
        bitrate: 256000,
        format: "mp3",
      },
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://v3b.fal.media/files/b/kangaroo/out.mp3",
      expect.objectContaining({ method: "GET" }),
    );
    expect(result.model).toBe("fal-ai/minimax-music/v2.6");
    expect(result.tracks[0]?.mimeType).toBe("audio/mpeg");
    expect(result.tracks[0]?.buffer).toEqual(Buffer.from("mp3-bytes"));
    expect(result.tracks[0]?.fileName).toBe("out.mp3");
    expect(result.metadata?.audioUrl).toBe("https://v3b.fal.media/files/b/kangaroo/out.mp3");
  });

  it("rejects MiniMax lyrics requests that also ask for instrumental output", async () => {
    await expect(
      buildFalMusicGenerationProvider().generateMusic({
        provider: "fal",
        model: "fal-ai/minimax-music/v2.6",
        prompt: "city pop chorus",
        cfg: {},
        lyrics: "[Verse]\nNeon rain",
        instrumental: true,
      }),
    ).rejects.toThrow("fal MiniMax music generation cannot use lyrics when instrumental=true.");

    expect(postJsonRequestMock).not.toHaveBeenCalled();
  });

  it("maps ACE-Step duration and instrumental controls", async () => {
    postJsonRequestMock.mockResolvedValue({
      response: {
        json: async () => ({
          audio: { url: "https://example.com/out.wav", content_type: "audio/wav" },
          seed: 42,
          tags: "lofi, chill",
        }),
      },
      release: vi.fn(async () => {}),
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(Buffer.from("wav-bytes"), {
            headers: { "content-type": "audio/wav" },
          }),
      ),
    );

    await buildFalMusicGenerationProvider().generateMusic({
      provider: "fal",
      model: "fal-ai/ace-step/prompt-to-audio",
      prompt: "lofi beach loop",
      cfg: {},
      instrumental: true,
      durationSeconds: 30,
    });

    expect(postRequest().url).toBe("https://fal.run/fal-ai/ace-step/prompt-to-audio");
    expect(postRequest().body).toEqual({
      prompt: "lofi beach loop",
      instrumental: true,
      duration: 30,
    });
  });

  it("maps Stable Audio duration controls", async () => {
    postJsonRequestMock.mockResolvedValue({
      response: {
        json: async () => ({
          audio: "https://example.com/stable.wav",
        }),
      },
      release: vi.fn(async () => {}),
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(Buffer.from("wav-bytes"), {
            headers: { "content-type": "audio/wav" },
          }),
      ),
    );

    await buildFalMusicGenerationProvider().generateMusic({
      provider: "fal",
      model: "fal-ai/stable-audio-25/text-to-audio",
      prompt: "orchestral hit",
      cfg: {},
      durationSeconds: 12,
    });

    expect(postRequest().url).toBe("https://fal.run/fal-ai/stable-audio-25/text-to-audio");
    expect(postRequest().body).toEqual({
      prompt: "orchestral hit",
      seconds_total: 12,
    });
  });
});
