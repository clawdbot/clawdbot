import { afterEach, describe, expect, it, vi } from "vitest";

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
  const call = fetchWithSsrFGuardMock.mock.calls.at(-1);
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

describe("listInworldVoices", () => {
  afterEach(() => {
    fetchWithSsrFGuardMock.mockClear();
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
    expect(voices).toEqual([]);
  });

  it("passes language filter as query parameter", async () => {
    queueGuardedResponse(new Response(JSON.stringify({ voices: [] }), { status: 200 }));

    await listInworldVoices({ apiKey: "test-key", language: "EN_US" });

    expect(lastGuardRequest().url).toBe("https://api.inworld.ai/voices/v1/voices?languages=EN_US");
  });

  it("releases the guarded dispatcher after success", async () => {
    const { release } = queueGuardedResponse(
      new Response(JSON.stringify({ voices: [] }), { status: 200 }),
    );

    await listInworldVoices({ apiKey: "test-key" });

    expect(release).toHaveBeenCalledTimes(1);
  });
});

describe("inworldTTS", () => {
  afterEach(() => {
    fetchWithSsrFGuardMock.mockClear();
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
    queueGuardedResponse(new Response("<html>Rate limited</html>", { status: 200 }));

    await expect(inworldTTS({ text: "test", apiKey: "test-key" })).rejects.toThrow(
      "Inworld TTS stream parse error: unexpected non-JSON line:",
    );
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
    expect(request.init?.method).toBe("POST");
    const headers = new Headers(request.init?.headers);
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

  it("releases the guarded dispatcher after success", async () => {
    const chunk = Buffer.from("audio").toString("base64");
    const { release } = queueGuardedResponse(
      new Response(JSON.stringify({ result: { audioContent: chunk } }), { status: 200 }),
    );

    await inworldTTS({ text: "test", apiKey: "test-key" });

    expect(release).toHaveBeenCalledTimes(1);
  });

  it("releases the guarded dispatcher after failure", async () => {
    const { release } = queueGuardedResponse(new Response("fail", { status: 500 }));

    await expect(inworldTTS({ text: "test", apiKey: "test-key" })).rejects.toThrow();
    expect(release).toHaveBeenCalledTimes(1);
  });
});
