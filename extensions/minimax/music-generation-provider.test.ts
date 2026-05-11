import { expectExplicitMusicGenerationCapabilities } from "openclaw/plugin-sdk/provider-test-contracts";
import { beforeAll, describe, expect, it, vi } from "vitest";
import {
  getMinimaxProviderHttpMocks,
  installMinimaxProviderHttpMockCleanup,
  loadMinimaxMusicGenerationProviderModule,
} from "./provider-http.test-helpers.js";

const {
  resolveApiKeyForProviderMock,
  postJsonRequestMock,
  fetchWithTimeoutMock,
  resolveProviderHttpRequestConfigMock,
} = getMinimaxProviderHttpMocks();

let buildMinimaxMusicGenerationProvider: Awaited<
  ReturnType<typeof loadMinimaxMusicGenerationProviderModule>
>["buildMinimaxMusicGenerationProvider"];
let buildMinimaxPortalMusicGenerationProvider: Awaited<
  ReturnType<typeof loadMinimaxMusicGenerationProviderModule>
>["buildMinimaxPortalMusicGenerationProvider"];

beforeAll(async () => {
  ({ buildMinimaxMusicGenerationProvider, buildMinimaxPortalMusicGenerationProvider } =
    await loadMinimaxMusicGenerationProviderModule());
});

installMinimaxProviderHttpMockCleanup();

function mockMusicGenerationResponse(json: Record<string, unknown>): void {
  postJsonRequestMock.mockResolvedValue({
    response: {
      json: async () => json,
    },
    release: vi.fn(async () => {}),
  });
  fetchWithTimeoutMock.mockResolvedValue({
    headers: new Headers({ "content-type": "audio/mpeg" }),
    arrayBuffer: async () => Buffer.from("mp3-bytes"),
  });
}

function mockCallArg(mock: { mock: { calls: unknown[][] } }, index = 0): Record<string, unknown> {
  const call = mock.mock.calls[index];
  if (!call) {
    throw new Error(`expected mock call ${index}`);
  }
  return call[0] as Record<string, unknown>;
}

describe("minimax music generation provider", () => {
  it("declares explicit mode capabilities", () => {
    expectExplicitMusicGenerationCapabilities(buildMinimaxMusicGenerationProvider());
  });

  it("creates music and downloads the generated track", async () => {
    mockMusicGenerationResponse({
      task_id: "task-123",
      audio_url: "https://example.com/out.mp3",
      lyrics: "our city wakes",
      base_resp: { status_code: 0 },
    });

    const provider = buildMinimaxMusicGenerationProvider();
    const result = await provider.generateMusic({
      provider: "minimax",
      model: "",
      prompt: "upbeat dance-pop with female vocals",
      cfg: {},
      lyrics: "our city wakes",
      durationSeconds: 45,
    });

    const request = mockCallArg(postJsonRequestMock);
    expect(request.url).toBe("https://api.minimax.io/v1/music_generation");
    const body = request.body as Record<string, unknown>;
    expect(body.model).toBe("music-2.6");
    expect(body.lyrics).toBe("our city wakes");
    expect(body.output_format).toBe("url");
    expect(body.audio_setting).toEqual({
      sample_rate: 44100,
      bitrate: 256000,
      format: "mp3",
    });
    expect(request?.headers).toBeInstanceOf(Headers);
    const headers = request?.headers as Headers | undefined;
    expect(headers?.get("content-type")).toBe("application/json");
    expect(result.tracks).toHaveLength(1);
    expect(result.lyrics).toEqual(["our city wakes"]);
    expect(result.metadata?.taskId).toBe("task-123");
    expect(result.metadata?.audioUrl).toBe("https://example.com/out.mp3");
  });

  it("downloads tracks when url output is returned in data.audio", async () => {
    mockMusicGenerationResponse({
      data: {
        audio: "https://example.com/url-audio.mp3",
      },
      base_resp: { status_code: 0 },
    });

    const provider = buildMinimaxMusicGenerationProvider();
    const result = await provider.generateMusic({
      provider: "minimax",
      model: "music-2.6",
      prompt: "upbeat dance-pop with female vocals",
      cfg: {},
      lyrics: "our city wakes",
    });

    expect(fetchWithTimeoutMock).toHaveBeenCalledWith(
      "https://example.com/url-audio.mp3",
      { method: "GET" },
      120000,
      fetch,
    );
    expect(result.tracks[0]?.buffer.byteLength).toBeGreaterThan(0);
  });

  it("rejects instrumental requests that also include lyrics", async () => {
    const provider = buildMinimaxMusicGenerationProvider();

    await expect(
      provider.generateMusic({
        provider: "minimax",
        model: "music-2.6",
        prompt: "driving techno",
        cfg: {},
        instrumental: true,
        lyrics: "do not sing this",
      }),
    ).rejects.toThrow("cannot use lyrics when instrumental=true");
  });

  it("uses lyrics optimizer when lyrics are omitted", async () => {
    mockMusicGenerationResponse({
      task_id: "task-456",
      audio_url: "https://example.com/out.mp3",
      base_resp: { status_code: 0 },
    });

    const provider = buildMinimaxMusicGenerationProvider();
    await provider.generateMusic({
      provider: "minimax",
      model: "music-2.6",
      prompt: "upbeat dance-pop",
      cfg: {},
    });

    const request = mockCallArg(postJsonRequestMock);
    const body = request.body as Record<string, unknown>;
    expect(body.model).toBe("music-2.6");
    expect(body.lyrics_optimizer).toBe(true);
  });

  it("routes portal music generation through minimax-portal auth and HTTP config", async () => {
    mockMusicGenerationResponse({
      task_id: "task-portal",
      audio_url: "https://example.com/portal.mp3",
      base_resp: { status_code: 0 },
    });

    const provider = buildMinimaxPortalMusicGenerationProvider();
    await provider.generateMusic({
      provider: "minimax-portal",
      model: "",
      prompt: "cinematic synth theme",
      cfg: {
        models: {
          providers: {
            minimax: {
              baseUrl: "https://wrong.example/anthropic",
              models: [],
            },
            "minimax-portal": {
              baseUrl: "https://api.minimaxi.com/anthropic",
              models: [],
            },
          },
        },
      },
    });

    expect(mockCallArg(resolveApiKeyForProviderMock).provider).toBe("minimax-portal");
    const httpConfigParams = mockCallArg(resolveProviderHttpRequestConfigMock);
    expect(httpConfigParams.baseUrl).toBe("https://api.minimaxi.com");
    expect(httpConfigParams.provider).toBe("minimax-portal");
    expect(httpConfigParams.capability).toBe("audio");
    expect(httpConfigParams.transport).toBe("http");
    expect(mockCallArg(postJsonRequestMock).url).toBe(
      "https://api.minimaxi.com/v1/music_generation",
    );
  });
});
