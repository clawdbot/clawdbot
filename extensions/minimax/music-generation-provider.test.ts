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

    expect(postJsonRequestMock).toHaveBeenCalledWith(
      expect.objectContaining({
        url: "https://api.minimax.io/v1/music_generation",
        headers: expect.objectContaining({
          get: expect.any(Function),
        }),
        body: expect.objectContaining({
          model: "music-2.6",
          lyrics: "our city wakes",
          output_format: "url",
          audio_setting: {
            sample_rate: 44100,
            bitrate: 256000,
            format: "mp3",
          },
        }),
      }),
    );
    const headers = postJsonRequestMock.mock.calls[0]?.[0]?.headers as Headers | undefined;
    expect(headers?.get("content-type")).toBe("application/json");
    expect(result.tracks).toHaveLength(1);
    expect(result.lyrics).toEqual(["our city wakes"]);
    expect(result.metadata).toEqual(
      expect.objectContaining({
        taskId: "task-123",
        audioUrl: "https://example.com/out.mp3",
      }),
    );
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

    expect(postJsonRequestMock).toHaveBeenCalledWith(
      expect.objectContaining({
        body: expect.objectContaining({
          model: "music-2.6",
          lyrics_optimizer: true,
        }),
      }),
    );
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

    expect(resolveApiKeyForProviderMock).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "minimax-portal",
      }),
    );
    expect(resolveProviderHttpRequestConfigMock).toHaveBeenCalledWith(
      expect.objectContaining({
        baseUrl: "https://api.minimaxi.com",
        provider: "minimax-portal",
        capability: "audio",
        transport: "http",
      }),
    );
    expect(postJsonRequestMock).toHaveBeenCalledWith(
      expect.objectContaining({
        url: "https://api.minimaxi.com/v1/music_generation",
      }),
    );
  });
});
