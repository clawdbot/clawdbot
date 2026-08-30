// Gandr tests cover tts plugin behavior.
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

import { GANDR_MAX_INPUT_CHARS, gandrTTS, listGandrVoices } from "./tts.js";

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

afterAll(() => {
  vi.doUnmock("openclaw/plugin-sdk/ssrf-runtime");
  vi.resetModules();
});

describe("listGandrVoices", () => {
  it("returns the stock voice catalog without a network request", () => {
    const voices = listGandrVoices();

    expect(voices).toEqual([
      { id: "gandr-mia", name: "Mia" },
      { id: "gandr-ava", name: "Ava" },
      { id: "gandr-jenny", name: "Jenny" },
      { id: "gandr-dane", name: "Dane" },
      { id: "gandr-leo", name: "Leo" },
      { id: "gandr-lewis", name: "Lewis" },
    ]);
    expect(fetchWithSsrFGuardMock).not.toHaveBeenCalled();
  });
});

describe("gandrTTS", () => {
  afterEach(() => {
    fetchWithSsrFGuardMock.mockReset();
    vi.restoreAllMocks();
  });

  it("returns the response bytes as a single buffer", async () => {
    queueGuardedResponse(new Response(Buffer.from("audio-bytes"), { status: 200 }));

    const buffer = await gandrTTS({ text: "Hello world", apiKey: "test-key" });

    expect(buffer).toEqual(Buffer.from("audio-bytes"));
  });

  it("sends correct request body with defaults", async () => {
    queueGuardedResponse(new Response(Buffer.from("audio"), { status: 200 }));

    await gandrTTS({ text: "Hello", apiKey: "test-key" });

    const request = lastGuardRequest();
    expect(request.url).toBe("https://tts.gandr.ai/v1/audio/speech");
    expect(request.auditContext).toBe("gandr-tts");
    expect(request.policy).toEqual({ hostnameAllowlist: ["tts.gandr.ai"] });
    if (!request.init) {
      throw new Error("expected Gandr TTS request init");
    }
    expect(request.init.method).toBe("POST");
    const headers = new Headers(request.init.headers);
    expect(headers.get("authorization")).toBe("Bearer test-key");
    expect(headers.get("content-type")).toBe("application/json");
    expect(JSON.parse(readRequestBody(request))).toEqual({
      model: "tts-1",
      input: "Hello",
      voice: "gandr-mia",
      response_format: "mp3",
    });
  });

  it("includes voice, model, and response format overrides when provided", async () => {
    queueGuardedResponse(new Response(Buffer.from("audio"), { status: 200 }));

    await gandrTTS({
      text: "Hello",
      apiKey: "test-key",
      voiceId: "gandr-leo",
      modelId: "tts-1",
      responseFormat: "pcm",
    });

    const callBody = JSON.parse(readRequestBody(lastGuardRequest()));
    expect(callBody.voice).toBe("gandr-leo");
    expect(callBody.model).toBe("tts-1");
    expect(callBody.response_format).toBe("pcm");
  });

  it("uses custom base URL", async () => {
    queueGuardedResponse(new Response(Buffer.from("audio"), { status: 200 }));

    await gandrTTS({
      text: "Hello",
      apiKey: "test-key",
      baseUrl: "https://custom.gandr.example.com/v1/",
    });

    expect(lastGuardRequest().url).toBe("https://custom.gandr.example.com/v1/audio/speech");
    expect(lastGuardRequest().policy).toEqual({
      hostnameAllowlist: ["custom.gandr.example.com"],
    });
  });

  it("rejects input above the per-request character cap before any request", async () => {
    const text = "a".repeat(GANDR_MAX_INPUT_CHARS + 1);

    await expect(gandrTTS({ text, apiKey: "test-key" })).rejects.toThrow(
      "Gandr TTS input too long: 2001 chars (limit: 2000 chars)",
    );
    expect(fetchWithSsrFGuardMock).not.toHaveBeenCalled();
  });

  it("accepts input at exactly the per-request character cap", async () => {
    queueGuardedResponse(new Response(Buffer.from("audio"), { status: 200 }));

    await gandrTTS({ text: "a".repeat(GANDR_MAX_INPUT_CHARS), apiKey: "test-key" });

    expect(fetchWithSsrFGuardMock).toHaveBeenCalledTimes(1);
  });

  it("throws on HTTP errors with response body", async () => {
    queueGuardedResponse(new Response("bad request body", { status: 400 }));

    await expect(gandrTTS({ text: "test", apiKey: "test-key" })).rejects.toThrow(
      "Gandr TTS API error (400): bad request body",
    );
  });

  it("keeps truncated HTTP error bodies UTF-16 safe", async () => {
    queueGuardedResponse(new Response(`${"e".repeat(399)}😀tail`, { status: 400 }));

    await expect(gandrTTS({ text: "test", apiKey: "test-key" })).rejects.toMatchObject({
      message: `Gandr TTS API error (400): ${"e".repeat(399)}…`,
    });
  });

  it("throws on empty audio response", async () => {
    queueGuardedResponse(new Response(Buffer.alloc(0), { status: 200 }));

    await expect(gandrTTS({ text: "test", apiKey: "test-key" })).rejects.toThrow(
      "Gandr TTS returned no audio data",
    );
  });

  it("releases the guarded dispatcher after success", async () => {
    const { release } = queueGuardedResponse(new Response(Buffer.from("audio"), { status: 200 }));

    await gandrTTS({ text: "test", apiKey: "test-key" });

    expect(release).toHaveBeenCalledTimes(1);
  });

  it("releases the guarded dispatcher after failure", async () => {
    const { release } = queueGuardedResponse(new Response("fail", { status: 500 }));

    await expect(gandrTTS({ text: "test", apiKey: "test-key" })).rejects.toThrow(
      "Gandr TTS API error (500): fail",
    );
    expect(release).toHaveBeenCalledTimes(1);
  });
});

describe("Gandr response read bounding", () => {
  const MiB = 1024 * 1024;

  afterEach(() => {
    fetchWithSsrFGuardMock.mockReset();
    vi.restoreAllMocks();
  });

  // A never-ending stream that enqueues one fixed-size chunk per pull. An
  // unbounded reader would buffer this forever and OOM; the bounded reader
  // must stop at the cap and cancel the stream.
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

  it("fail-closed: rejects and cancels an oversized audio response instead of buffering it (16 MiB cap)", async () => {
    const { stream, state } = infiniteByteStream(8 * MiB);
    queueGuardedResponse(new Response(stream, { status: 200 }));

    await expect(gandrTTS({ text: "test", apiKey: "test-key" })).rejects.toThrow(
      /Gandr TTS audio response too large: \d+ bytes \(limit: 16777216 bytes\)/,
    );
    // Enforced after a bounded number of 8 MiB chunks, never the full
    // unbounded stream, and the stream is cancelled so the socket/buffers are
    // released.
    expect(state.enqueued).toBeLessThanOrEqual(4);
    expect(state.cancelled).toBe(true);
  });

  it("edge: an under-cap ~1 MiB audio payload is read intact, not truncated", async () => {
    const payload = Buffer.alloc(MiB, 0x78);
    queueGuardedResponse(new Response(payload, { status: 200 }));

    const audio = await gandrTTS({ text: "test", apiKey: "test-key" });
    expect(audio.length).toBe(payload.length);
    expect(audio).toEqual(payload);
  });

  it("fail-closed: truncates an oversized HTTP error body to a bounded marker", async () => {
    queueGuardedResponse(new Response("E".repeat(64 * 1024), { status: 500 }));

    let captured: unknown;
    await gandrTTS({ text: "test", apiKey: "test-key" }).catch((error: unknown) => {
      captured = error;
    });

    expect(captured).toBeInstanceOf(Error);
    const message = (captured as Error).message;
    expect(message.startsWith("Gandr TTS API error (500): ")).toBe(true);
    // Never the full 64 KiB hostile body: it collapses to a fixed marker.
    expect(message).toContain("(error body exceeded diagnostic limit; truncated)");
    expect(message.length).toBeLessThan(512);
  });

  it("edge: a small error body is preserved verbatim in the thrown message", async () => {
    queueGuardedResponse(new Response("invalid api key", { status: 401 }));
    await expect(gandrTTS({ text: "test", apiKey: "test-key" })).rejects.toThrow(
      "Gandr TTS API error (401): invalid api key",
    );
  });
});
