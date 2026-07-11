// Inworld tests cover tts plugin behavior.
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

const { fetchWithSsrFGuardMock } = vi.hoisted(() => ({
  fetchWithSsrFGuardMock: vi.fn(),
}));

vi.mock("openclaw/plugin-sdk/ssrf-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/ssrf-runtime")>();
  return {
    ...actual,
    fetchWithSsrFGuard: fetchWithSsrFGuardMock,
  };
});

import { inworldTTS, listInworldVoices } from "./tts.js";

type GuardRequest = {
  url: string;
  init?: RequestInit;
  auditContext?: string;
  policy?: unknown;
  timeoutMs?: number;
};

function queueGuardedResponse(response: Response): { release: ReturnType<typeof vi.fn> } {
  const release = vi.fn(async () => {});
  fetchWithSsrFGuardMock.mockResolvedValueOnce({ response, release });
  return { release };
}

function lastGuardRequest(): GuardRequest {
  const calls = fetchWithSsrFGuardMock.mock.calls;
  const call = calls[calls.length - 1];
  if (!call) {
    throw new Error("fetchWithSsrFGuard was not called");
  }
  return call[0] as GuardRequest;
}

function readRequestBody(request: GuardRequest): string {
  const body = request.init?.body;
  if (typeof body !== "string") {
    throw new Error("expected request body to be a string");
  }
  return body;
}

const guardedSuccessReleaseCases = [
  {
    name: "listInworldVoices",
    run: async () => {
      const { release } = queueGuardedResponse(
        new Response(JSON.stringify({ voices: [] }), { status: 200 }),
      );

      await listInworldVoices({ apiKey: "test-key" });
      return release;
    },
  },
  {
    name: "inworldTTS",
    run: async () => {
      const chunk = Buffer.from("audio").toString("base64");
      const { release } = queueGuardedResponse(
        new Response(JSON.stringify({ result: { audioContent: chunk } }), { status: 200 }),
      );

      await inworldTTS({ text: "test", apiKey: "test-key" });
      return release;
    },
  },
];

afterAll(() => {
  vi.doUnmock("openclaw/plugin-sdk/ssrf-runtime");
  vi.resetModules();
});

describe("Inworld guarded dispatcher lifecycle", () => {
  afterEach(() => {
    fetchWithSsrFGuardMock.mockReset();
    vi.restoreAllMocks();
  });

  it.each(guardedSuccessReleaseCases)(
    "$name releases the guarded dispatcher after success",
    async ({ run }) => {
      const release = await run();

      expect(release).toHaveBeenCalledTimes(1);
    },
  );
});

describe("listInworldVoices", () => {
  afterEach(() => {
    fetchWithSsrFGuardMock.mockReset();
    vi.restoreAllMocks();
  });

  it("maps Inworld voice metadata into speech voice options", async () => {
    queueGuardedResponse(
      new Response(
        JSON.stringify({
          voices: [
            {
              voiceId: "Dennis",
              displayName: "Dennis",
              description: "Middle-aged man with a smooth, calm and friendly voice",
              langCode: "EN_US",
              tags: ["male", "middle-aged", "smooth", "calm", "friendly"],
              source: "SYSTEM",
            },
            {
              voiceId: "Ashley",
              displayName: "Ashley",
              description: "A warm, natural female voice",
              langCode: "EN_US",
              tags: ["female", "warm", "natural"],
              source: "SYSTEM",
            },
          ],
        }),
        { status: 200 },
      ),
    );

    const voices = await listInworldVoices({ apiKey: "test-key" });

    expect(voices).toEqual([
      {
        id: "Dennis",
        name: "Dennis",
        description: "Middle-aged man with a smooth, calm and friendly voice",
        locale: "EN_US",
        gender: "male",
      },
      {
        id: "Ashley",
        name: "Ashley",
        description: "A warm, natural female voice",
        locale: "EN_US",
        gender: "female",
      },
    ]);
    const request = lastGuardRequest();
    expect(request.url).toBe("https://api.inworld.ai/voices/v1/voices");
    expect(request.auditContext).toBe("inworld-voices");
    expect(request.policy).toEqual({ hostnameAllowlist: ["api.inworld.ai"] });
    const headers = new Headers(request.init?.headers);
    expect(headers.get("authorization")).toBe("Basic test-key");
  });

  it("throws on API errors with response body", async () => {
    queueGuardedResponse(new Response("service unavailable", { status: 503 }));

    await expect(listInworldVoices({ apiKey: "test-key" })).rejects.toThrow(
      "Inworld voices API error (503): service unavailable",
    );
  });

  it("filters out voices with empty voiceId", async () => {
    queueGuardedResponse(
      new Response(
        JSON.stringify({
          voices: [
            { voiceId: "", displayName: "Empty" },
            { voiceId: "Dennis", displayName: "Dennis" },
          ],
        }),
        { status: 200 },
      ),
    );

    const voices = await listInworldVoices({ apiKey: "test-key" });
    expect(voices).toHaveLength(1);
    expect(voices[0].id).toBe("Dennis");
  });

  it("returns empty array when no voices present", async () => {
    queueGuardedResponse(new Response(JSON.stringify({}), { status: 200 }));

    const voices = await listInworldVoices({ apiKey: "test-key" });
    expect(voices).toStrictEqual([]);
  });

  it("passes language filter as query parameter", async () => {
    queueGuardedResponse(new Response(JSON.stringify({ voices: [] }), { status: 200 }));

    await listInworldVoices({ apiKey: "test-key", language: "EN_US" });

    expect(lastGuardRequest().url).toBe("https://api.inworld.ai/voices/v1/voices?languages=EN_US");
  });

  it("defaults to a bounded timeout for voice list requests", async () => {
    queueGuardedResponse(new Response(JSON.stringify({ voices: [] }), { status: 200 }));

    await listInworldVoices({ apiKey: "test-key" });

    expect(lastGuardRequest().timeoutMs).toBe(30_000);
  });

  it("preserves an explicit timeout for voice list requests", async () => {
    queueGuardedResponse(new Response(JSON.stringify({ voices: [] }), { status: 200 }));

    await listInworldVoices({ apiKey: "test-key", timeoutMs: 5_000 });

    expect(lastGuardRequest().timeoutMs).toBe(5_000);
  });
});

describe("inworldTTS", () => {
  afterEach(() => {
    fetchWithSsrFGuardMock.mockReset();
    vi.restoreAllMocks();
  });

  it("concatenates base64 audio chunks from streaming response", async () => {
    const chunk1 = Buffer.from("audio-chunk-1").toString("base64");
    const chunk2 = Buffer.from("audio-chunk-2").toString("base64");
    const body = [
      JSON.stringify({ result: { audioContent: chunk1 } }),
      JSON.stringify({ result: { audioContent: chunk2 } }),
    ].join("\n");

    queueGuardedResponse(new Response(body, { status: 200 }));

    const buffer = await inworldTTS({
      text: "Hello world",
      apiKey: "test-key",
    });

    expect(buffer).toEqual(
      Buffer.concat([Buffer.from("audio-chunk-1"), Buffer.from("audio-chunk-2")]),
    );
  });

  it("throws on HTTP errors with response body", async () => {
    queueGuardedResponse(new Response("bad request body", { status: 400 }));

    await expect(inworldTTS({ text: "test", apiKey: "test-key" })).rejects.toThrow(
      "Inworld TTS API error (400): bad request body",
    );
  });

  it("keeps truncated HTTP error bodies UTF-16 safe", async () => {
    queueGuardedResponse(new Response(`${"e".repeat(399)}😀tail`, { status: 400 }));

    await expect(inworldTTS({ text: "test", apiKey: "test-key" })).rejects.toMatchObject({
      message: `Inworld TTS API error (400): ${"e".repeat(399)}…`,
    });
  });

  it("throws on in-stream errors", async () => {
    const body = JSON.stringify({
      error: { code: 3, message: "Invalid voice ID" },
    });
    queueGuardedResponse(new Response(body, { status: 200 }));

    await expect(inworldTTS({ text: "test", apiKey: "test-key" })).rejects.toThrow(
      "Inworld TTS stream error (3): Invalid voice ID",
    );
  });

  it("throws on empty audio response", async () => {
    const body = JSON.stringify({ result: { audioContent: "" } });
    queueGuardedResponse(new Response(body, { status: 200 }));

    await expect(inworldTTS({ text: "test", apiKey: "test-key" })).rejects.toThrow(
      "Inworld TTS returned no audio data",
    );
  });

  it("throws descriptive error on non-JSON line in stream", async () => {
    queueGuardedResponse(new Response(`${"p".repeat(79)}😀tail`, { status: 200 }));

    await expect(inworldTTS({ text: "test", apiKey: "test-key" })).rejects.toMatchObject({
      message: `Inworld TTS stream parse error: unexpected non-JSON line: ${"p".repeat(79)}`,
    });
  });

  it("sends correct request body with defaults", async () => {
    const chunk = Buffer.from("audio").toString("base64");
    queueGuardedResponse(
      new Response(JSON.stringify({ result: { audioContent: chunk } }), { status: 200 }),
    );

    await inworldTTS({ text: "Hello", apiKey: "test-key" });

    const request = lastGuardRequest();
    expect(request.url).toBe("https://api.inworld.ai/tts/v1/voice:stream");
    expect(request.auditContext).toBe("inworld-tts");
    expect(request.policy).toEqual({ hostnameAllowlist: ["api.inworld.ai"] });
    if (!request.init) {
      throw new Error("expected Inworld TTS request init");
    }
    expect(request.init.method).toBe("POST");
    const headers = new Headers(request.init.headers);
    expect(headers.get("authorization")).toBe("Basic test-key");
    expect(headers.get("content-type")).toBe("application/json");
    expect(JSON.parse(readRequestBody(request))).toEqual({
      text: "Hello",
      voiceId: "Sarah",
      modelId: "inworld-tts-1.5-max",
      audioConfig: { audioEncoding: "MP3" },
    });
  });

  it("includes temperature and sampleRateHertz when provided", async () => {
    const chunk = Buffer.from("audio").toString("base64");
    queueGuardedResponse(
      new Response(JSON.stringify({ result: { audioContent: chunk } }), { status: 200 }),
    );

    await inworldTTS({
      text: "Hello",
      apiKey: "test-key",
      voiceId: "Ashley",
      modelId: "inworld-tts-1.5-mini",
      audioEncoding: "PCM",
      sampleRateHertz: 22_050,
      temperature: 0.8,
    });

    const callBody = JSON.parse(readRequestBody(lastGuardRequest()));
    expect(callBody.voiceId).toBe("Ashley");
    expect(callBody.modelId).toBe("inworld-tts-1.5-mini");
    expect(callBody.audioConfig.audioEncoding).toBe("PCM");
    expect(callBody.audioConfig.sampleRateHertz).toBe(22_050);
    expect(callBody.temperature).toBe(0.8);
  });

  it("uses custom base URL", async () => {
    const chunk = Buffer.from("audio").toString("base64");
    queueGuardedResponse(
      new Response(JSON.stringify({ result: { audioContent: chunk } }), { status: 200 }),
    );

    await inworldTTS({
      text: "Hello",
      apiKey: "test-key",
      baseUrl: "https://custom.inworld.example.com/",
    });

    expect(lastGuardRequest().url).toBe("https://custom.inworld.example.com/tts/v1/voice:stream");
    expect(lastGuardRequest().policy).toEqual({
      hostnameAllowlist: ["custom.inworld.example.com"],
    });
  });

  it("skips empty lines in streaming response", async () => {
    const chunk = Buffer.from("audio").toString("base64");
    const body = `\n${JSON.stringify({ result: { audioContent: chunk } })}\n\n`;
    queueGuardedResponse(new Response(body, { status: 200 }));

    const buffer = await inworldTTS({ text: "test", apiKey: "test-key" });
    expect(buffer).toEqual(Buffer.from("audio"));
  });

  it("releases the guarded dispatcher after failure", async () => {
    const { release } = queueGuardedResponse(new Response("fail", { status: 500 }));

    await expect(inworldTTS({ text: "test", apiKey: "test-key" })).rejects.toThrow(
      "Inworld TTS API error (500): fail",
    );
    expect(release).toHaveBeenCalledTimes(1);
  });
});

describe("Inworld response read bounding", () => {
  const MiB = 1024 * 1024;

  // A never-ending stream that enqueues one fixed-size chunk per pull. An
  // unbounded reader (the previous `await response.text()` / `response.json()`)
  // would buffer this forever and OOM; the bounded reader must stop at the cap
  // and cancel the stream.
  function infiniteByteStream(chunkBytes: number): {
    stream: ReadableStream<Uint8Array>;
    state: { enqueued: number; cancelled: boolean };
  } {
    const state = { enqueued: 0, cancelled: false };
    const chunk = new Uint8Array(chunkBytes).fill(0x61); // "a"
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        state.enqueued += 1;
        controller.enqueue(chunk);
      },
      cancel() {
        state.cancelled = true;
      },
    });
    return { stream, state };
  }

  it("fail-closed: rejects and cancels an oversized TTS audio stream instead of buffering it (32 MiB cap)", async () => {
    const { stream, state } = infiniteByteStream(8 * MiB);
    queueGuardedResponse(new Response(stream, { status: 200 }));

    await expect(inworldTTS({ text: "test", apiKey: "test-key" })).rejects.toThrow(
      /Inworld TTS audio stream too large: \d+ bytes \(limit: 33554432 bytes\)/,
    );
    // Enforced after a bounded number of 8 MiB chunks, never the full unbounded
    // stream, and the stream is cancelled so the socket/buffers are released.
    expect(state.enqueued).toBeLessThanOrEqual(8);
    expect(state.cancelled).toBe(true);
  });

  it("happy-path: a normal multi-line NDJSON audio payload still decodes unchanged", async () => {
    const part1 = Buffer.from("hello-").toString("base64");
    const part2 = Buffer.from("world").toString("base64");
    const body = [
      JSON.stringify({ result: { audioContent: part1 } }),
      JSON.stringify({ result: { audioContent: part2 } }),
    ].join("\n");
    queueGuardedResponse(new Response(body, { status: 200 }));

    const audio = await inworldTTS({ text: "test", apiKey: "test-key" });
    expect(audio.toString("utf8")).toBe("hello-world");
  });

  it("edge: an under-cap ~1 MiB audio payload is read intact, not truncated", async () => {
    const payload = "x".repeat(MiB);
    const encoded = Buffer.from(payload).toString("base64");
    const body = JSON.stringify({ result: { audioContent: encoded } });
    queueGuardedResponse(new Response(body, { status: 200 }));

    const audio = await inworldTTS({ text: "test", apiKey: "test-key" });
    expect(audio.length).toBe(payload.length);
    expect(audio.toString("utf8")).toBe(payload);
  });

  it("fail-closed: rejects decoded audio that exceeds the shared audio cap", async () => {
    const decodedPayload = Buffer.alloc(16 * MiB + 1, 0x61);
    const body = JSON.stringify({
      result: { audioContent: decodedPayload.toString("base64") },
    });
    queueGuardedResponse(new Response(body, { status: 200 }));

    await expect(inworldTTS({ text: "test", apiKey: "test-key" })).rejects.toThrow(
      /Inworld TTS decoded audio too large: 16777217 bytes \(limit: 16777216 bytes\)/,
    );
  });

  it("regression: a malformed NDJSON line under the cap still throws a bounded parse error", async () => {
    queueGuardedResponse(new Response("this-is-not-json", { status: 200 }));
    await expect(inworldTTS({ text: "test", apiKey: "test-key" })).rejects.toThrow(
      /Inworld TTS stream parse error/,
    );
  });

  it("fail-closed: truncates an oversized HTTP error body to a bounded marker", async () => {
    queueGuardedResponse(new Response("E".repeat(64 * 1024), { status: 500 }));

    let captured: unknown;
    await inworldTTS({ text: "test", apiKey: "test-key" }).catch((error: unknown) => {
      captured = error;
    });

    expect(captured).toBeInstanceOf(Error);
    const message = (captured as Error).message;
    expect(message.startsWith("Inworld TTS API error (500): ")).toBe(true);
    // Never the full 64 KiB hostile body: it collapses to a fixed marker.
    expect(message).toContain("(error body exceeded diagnostic limit; truncated)");
    expect(message.length).toBeLessThan(512);
  });

  it("edge: a small error body is preserved verbatim in the thrown message", async () => {
    queueGuardedResponse(new Response("invalid api key", { status: 401 }));
    await expect(inworldTTS({ text: "test", apiKey: "test-key" })).rejects.toThrow(
      "Inworld TTS API error (401): invalid api key",
    );
  });

  it("fail-closed: rejects and cancels an oversized voices JSON stream (16 MiB cap)", async () => {
    const { stream, state } = infiniteByteStream(8 * MiB);
    queueGuardedResponse(new Response(stream, { status: 200 }));

    await expect(listInworldVoices({ apiKey: "test-key" })).rejects.toThrow(
      /Inworld voices response too large: \d+ bytes \(limit: 16777216 bytes\)/,
    );
    expect(state.enqueued).toBeLessThanOrEqual(4);
    expect(state.cancelled).toBe(true);
  });

  it("happy-path: a normal voices JSON list still parses unchanged", async () => {
    queueGuardedResponse(
      new Response(
        JSON.stringify({
          voices: [{ voiceId: "Sarah", displayName: "Sarah", langCode: "en-US", tags: ["female"] }],
        }),
        { status: 200 },
      ),
    );

    const voices = await listInworldVoices({ apiKey: "test-key" });
    expect(voices).toEqual([
      { id: "Sarah", name: "Sarah", description: undefined, locale: "en-US", gender: "female" },
    ]);
  });

  it("regression: malformed voices JSON under the cap throws descriptive error", async () => {
    queueGuardedResponse(new Response("{not-json", { status: 200 }));
    await expect(listInworldVoices({ apiKey: "test-key" })).rejects.toThrow(
      "Inworld voices API returned malformed JSON",
    );
  });
});
