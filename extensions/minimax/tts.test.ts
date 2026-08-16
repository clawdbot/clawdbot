// Minimax tests cover tts plugin behavior.
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { MAX_TIMER_TIMEOUT_MS } from "openclaw/plugin-sdk/number-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";

const fetchWithSsrFGuardMock = vi.hoisted(() => vi.fn());

vi.mock("openclaw/plugin-sdk/ssrf-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/ssrf-runtime")>();
  return {
    ...actual,
    fetchWithSsrFGuard: (...args: unknown[]) => fetchWithSsrFGuardMock(...args),
  };
});

import {
  buildMinimaxMusicGenerationProvider,
  buildMinimaxPortalMusicGenerationProvider,
} from "./music-generation-provider.js";
import { buildMinimaxSpeechProvider } from "./speech-provider.js";
import { minimaxTTS } from "./tts.js";

describe("minimaxTTS", () => {
  afterEach(() => {
    fetchWithSsrFGuardMock.mockReset();
    vi.restoreAllMocks();
  });

  it("caps oversized request timeout before arming abort timers", async () => {
    const timeoutSpy = vi
      .spyOn(globalThis, "setTimeout")
      .mockReturnValue(0 as unknown as ReturnType<typeof setTimeout>);
    fetchWithSsrFGuardMock.mockResolvedValue({
      response: new Response(
        JSON.stringify({ data: { audio: Buffer.from("audio").toString("hex") } }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
      release: vi.fn(async () => undefined),
    });

    const audio = await minimaxTTS({
      text: "hello",
      apiKey: "sk-test",
      baseUrl: "https://api.minimax.io",
      model: "speech-2.8-hd",
      voiceId: "English_expressive_narrator",
      timeoutMs: Number.MAX_SAFE_INTEGER,
    });

    expect(audio.toString()).toBe("audio");
    expect(timeoutSpy).toHaveBeenCalledWith(expect.any(Function), MAX_TIMER_TIMEOUT_MS);
    expect(fetchWithSsrFGuardMock.mock.calls[0]?.[0]).toMatchObject({
      timeoutMs: MAX_TIMER_TIMEOUT_MS,
    });
    expect(fetchWithSsrFGuardMock.mock.calls[0]?.[0]?.init?.signal).toBeInstanceOf(AbortSignal);
  });

  it("throws on base_resp envelope error even when data.audio is present (regression #76904)", async () => {
    fetchWithSsrFGuardMock.mockResolvedValue({
      response: new Response(
        JSON.stringify({
          data: { audio: Buffer.from("placeholder").toString("hex") },
          base_resp: { status_code: 1002, status_msg: "Quota exceeded" },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
      release: vi.fn(async () => undefined),
    });

    await expect(
      minimaxTTS({
        text: "hello",
        apiKey: "sk-test",
        baseUrl: "https://api.minimax.io",
        model: "speech-2.8-hd",
        voiceId: "English_expressive_narrator",
        timeoutMs: 10_000,
      }),
    ).rejects.toThrow("MiniMax TTS API error (1002): Quota exceeded");
  });

  it("throws on base_resp envelope error with empty audio", async () => {
    fetchWithSsrFGuardMock.mockResolvedValue({
      response: new Response(
        JSON.stringify({
          base_resp: { status_code: 1001, status_msg: "Rate limit" },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
      release: vi.fn(async () => undefined),
    });

    await expect(
      minimaxTTS({
        text: "hello",
        apiKey: "sk-test",
        baseUrl: "https://api.minimax.io",
        model: "speech-2.8-hd",
        voiceId: "English_expressive_narrator",
        timeoutMs: 10_000,
      }),
    ).rejects.toThrow("MiniMax TTS API error (1001): Rate limit");
  });

  it("succeeds when base_resp.status_code is 0", async () => {
    fetchWithSsrFGuardMock.mockResolvedValue({
      response: new Response(
        JSON.stringify({
          data: { audio: Buffer.from("real-audio").toString("hex") },
          base_resp: { status_code: 0, status_msg: "success" },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
      release: vi.fn(async () => undefined),
    });

    const audio = await minimaxTTS({
      text: "hello",
      apiKey: "sk-test",
      baseUrl: "https://api.minimax.io",
      model: "speech-2.8-hd",
      voiceId: "English_expressive_narrator",
      timeoutMs: 10_000,
    });

    expect(audio.toString()).toBe("real-audio");
  });

  it("rejects a null response body with a malformed-response error", async () => {
    fetchWithSsrFGuardMock.mockResolvedValue({
      response: new Response("null", {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
      release: vi.fn(async () => undefined),
    });

    await expect(
      minimaxTTS({
        text: "hello",
        apiKey: "sk-test",
        baseUrl: "https://api.minimax.io",
        model: "speech-2.8-hd",
        voiceId: "English_expressive_narrator",
        timeoutMs: 10_000,
      }),
    ).rejects.toThrow("minimax.tts: malformed JSON response");
  });

  it("rejects a primitive string response body with a malformed-response error", async () => {
    fetchWithSsrFGuardMock.mockResolvedValue({
      response: new Response('"not-an-object"', {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
      release: vi.fn(async () => undefined),
    });

    await expect(
      minimaxTTS({
        text: "hello",
        apiKey: "sk-test",
        baseUrl: "https://api.minimax.io",
        model: "speech-2.8-hd",
        voiceId: "English_expressive_narrator",
        timeoutMs: 10_000,
      }),
    ).rejects.toThrow("minimax.tts: malformed JSON response");
  });

});

type MinimaxWireFixture = {
  entryPoint: "tts" | "speech" | "music";
  provider?: "minimax" | "minimax-portal";
  audio?: string;
  frames?: Array<{ status?: number | string; audio?: string } | "[DONE]">;
  mediaMaxMb?: number;
};

async function runMinimaxLoopbackFixture(fixture: MinimaxWireFixture): Promise<Buffer> {
  const originalFetch = globalThis.fetch;
  const server = createServer((request, response) => {
    request.resume();
    if (fixture.entryPoint === "music") {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(
        fixture.frames
          ?.map((frame) =>
            frame === "[DONE]"
              ? "data: [DONE]"
              : `data: ${JSON.stringify({
                  data: frame,
                  base_resp: { status_code: 0, status_msg: "success" },
                })}`,
          )
          .join("\n\n") + "\n\n",
      );
      return;
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      JSON.stringify({
        data: { audio: fixture.audio, status: 2 },
        base_resp: { status_code: 0, status_msg: "success" },
      }),
    );
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const { port } = server.address() as AddressInfo;
  const pathname = fixture.entryPoint === "music" ? "/v1/music_generation" : "/v1/t2a_v2";

  vi.stubEnv("MINIMAX_API_KEY", "fixture-provider-key");
  vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
    const { dispatcher: _dispatcher, ...forwardedInit } = (init ?? {}) as RequestInit & {
      dispatcher?: unknown;
    };
    return originalFetch(`http://127.0.0.1:${port}${pathname}`, forwardedInit);
  });
  fetchWithSsrFGuardMock.mockImplementation(async ({ url, init }) => ({
    response: await fetch(url, init),
    release: async () => {},
  }));

  try {
    if (fixture.entryPoint === "tts") {
      return await minimaxTTS({
        text: "loopback fixture",
        apiKey: "fixture-provider-key",
        baseUrl: "https://api.minimax.io",
        model: "speech-2.8-hd",
        voiceId: "English_expressive_narrator",
        timeoutMs: 1_000,
      });
    }
    if (fixture.entryPoint === "speech") {
      const result = await buildMinimaxSpeechProvider().synthesize({
        text: "loopback fixture",
        cfg: {},
        providerConfig: { apiKey: "fixture-provider-key", baseUrl: "https://api.minimax.io" },
        target: "audio-file",
        timeoutMs: 1_000,
      });
      return result.audioBuffer;
    }

    const providerId = fixture.provider ?? "minimax";
    const provider =
      providerId === "minimax-portal"
        ? buildMinimaxPortalMusicGenerationProvider()
        : buildMinimaxMusicGenerationProvider();
    const result = await provider.generateMusic({
      provider: providerId,
      model: "music-2.6",
      prompt: "loopback fixture",
      cfg:
        fixture.mediaMaxMb === undefined
          ? {}
          : { agents: { defaults: { mediaMaxMb: fixture.mediaMaxMb } } },
    });
    const track = result.tracks[0];
    if (!track) {
      throw new Error("Music provider returned no track");
    }
    return track.buffer;
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
    fetchWithSsrFGuardMock.mockReset();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  }
}

describe("MiniMax media producers through real localhost HTTP", () => {
  it.each([
    { name: "trailing non-hex", audio: "666f6fZZ" },
    { name: "odd-length hex", audio: "666f6" },
    { name: "entirely non-hex", audio: "ZZ" },
  ])("rejects $name TTS audio without truncating it", async ({ audio }) => {
    await expect(runMinimaxLoopbackFixture({ entryPoint: "tts", audio })).rejects.toThrow(
      "MiniMax TTS API returned malformed hex audio",
    );
  });

  it("reports malformed audio through the user-facing speech provider", async () => {
    await expect(
      runMinimaxLoopbackFixture({ entryPoint: "speech", audio: "666f6fZZ" }),
    ).rejects.toThrow("MiniMax TTS API returned malformed hex audio");
  });

  it.each([
    { provider: "minimax" as const, done: false },
    { provider: "minimax-portal" as const, done: true },
  ])(
    "rejects incomplete $provider music after its HTTP stream closes",
    async ({ provider, done }) => {
      const frames: MinimaxWireFixture["frames"] = [
        { status: 1, audio: Buffer.from("partial-audio").toString("hex") },
        ...(done ? (["[DONE]"] as const) : []),
      ];
      await expect(
        runMinimaxLoopbackFixture({ entryPoint: "music", provider, frames }),
      ).rejects.toThrow("MiniMax music generation stream ended without completion");
    },
  );

  it.each([{ status: 2 }, { status: "2" }])(
    "accepts a terminal music frame with status $status",
    async ({ status }) => {
      const audio = Buffer.from("complete-audio");
      await expect(
        runMinimaxLoopbackFixture({
          entryPoint: "music",
          frames: [{ status, audio: audio.toString("hex") }],
        }),
      ).resolves.toEqual(audio);
    },
  );

  it("preserves progressive audio when its terminal frame repeats the aggregate", async () => {
    const first = Buffer.from("first-");
    const second = Buffer.from("second");
    await expect(
      runMinimaxLoopbackFixture({
        entryPoint: "music",
        provider: "minimax-portal",
        frames: [
          { status: 1, audio: first.toString("hex") },
          { status: 1, audio: second.toString("hex") },
          { status: 2, audio: Buffer.concat([first, second]).toString("hex") },
        ],
      }),
    ).resolves.toEqual(Buffer.concat([first, second]));
  });

  it("accepts a terminal status without audio after progressive audio", async () => {
    const audio = Buffer.from("complete-progress");
    await expect(
      runMinimaxLoopbackFixture({
        entryPoint: "music",
        frames: [{ status: 1, audio: audio.toString("hex") }, { status: 2 }, "[DONE]"],
      }),
    ).resolves.toEqual(audio);
  });

  it("keeps the configured music byte limit before decoding terminal audio", async () => {
    await expect(
      runMinimaxLoopbackFixture({
        entryPoint: "music",
        frames: [{ status: 2, audio: Buffer.from("oversized").toString("hex") }],
        mediaMaxMb: 0.000_001,
      }),
    ).rejects.toThrow("MiniMax generated music download exceeds 1 bytes");
  });

  it("keeps valid speech-provider audio unchanged", async () => {
    const audio = Buffer.from("complete-audio");
    await expect(
      runMinimaxLoopbackFixture({ entryPoint: "speech", audio: audio.toString("hex") }),
    ).resolves.toEqual(audio);
  });
});
