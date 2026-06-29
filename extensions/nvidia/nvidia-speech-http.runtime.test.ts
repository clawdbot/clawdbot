import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  postMultipartRequest: vi.fn(),
  postTranscriptionRequest: vi.fn(),
}));

vi.mock("openclaw/plugin-sdk/provider-http", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/provider-http")>();
  return {
    ...actual,
    postMultipartRequest: mocks.postMultipartRequest,
    postTranscriptionRequest: mocks.postTranscriptionRequest,
  };
});

import { NVIDIA_DEFAULT_ASR_MODEL, NVIDIA_FALLBACK_ASR_MODEL } from "./nvidia-speech-config.js";
import { magpieSynthesize, transcribeNvidiaAudio } from "./nvidia-speech-http.runtime.js";

function transcriptionRequest(overrides: Record<string, unknown> = {}) {
  return {
    buffer: Buffer.from("audio"),
    fileName: "sample.wav",
    mime: "audio/wav",
    apiKey: "nvapi-test",
    timeoutMs: 30_000,
    ...overrides,
  } as Parameters<typeof transcribeNvidiaAudio>[0];
}

function okJson(text: string) {
  return {
    response: new Response(JSON.stringify({ text }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
    release: vi.fn(),
  };
}

describe("NVIDIA speech HTTP runtime", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.NVIDIA_TDT_ASR_BASE_URL;
    delete process.env.NVIDIA_CTC_ASR_BASE_URL;
  });

  it("uses Parakeet TDT by default and forwards ASR customizations", async () => {
    mocks.postTranscriptionRequest.mockResolvedValue(okJson("hello NVIDIA"));

    const result = await transcribeNvidiaAudio(
      transcriptionRequest({
        query: {
          boostedWords: '["Nemotron","OpenClaw"]',
          boostedWordsScore: 1.5,
          wordTimeOffsets: true,
          customConfiguration: "foo:bar",
        },
      }),
    );

    expect(result).toEqual({ text: "hello NVIDIA", model: NVIDIA_DEFAULT_ASR_MODEL });
    expect(mocks.postTranscriptionRequest).toHaveBeenCalledTimes(1);
    const request = mocks.postTranscriptionRequest.mock.calls[0]?.[0];
    expect(request.url).toContain(
      "d3fe9151-442b-4204-a70d-5fcc597fd610.invocation.api.nvcf.nvidia.com",
    );
    const form = request.body as FormData;
    expect(form.getAll("boosted_lm_words")).toEqual(["Nemotron", "OpenClaw"]);
    expect(form.get("boosted_lm_score")).toBe("1.5");
    expect(form.get("word_time_offsets")).toBe("true");
    expect(form.get("custom_configuration")).toBe("foo:bar");
  });

  it("falls back to Parakeet CTC 1.1b when TDT HTTP fails", async () => {
    mocks.postTranscriptionRequest
      .mockResolvedValueOnce({
        response: new Response('{"detail":"not available"}', { status: 404 }),
        release: vi.fn(),
      })
      .mockResolvedValueOnce(okJson("fallback transcript"));

    const result = await transcribeNvidiaAudio(transcriptionRequest());

    expect(result).toEqual({
      text: "fallback transcript",
      model: NVIDIA_FALLBACK_ASR_MODEL,
    });
    expect(mocks.postTranscriptionRequest).toHaveBeenCalledTimes(2);
    expect(mocks.postTranscriptionRequest.mock.calls[1]?.[0]?.url).toContain(
      "1598d209-5e27-4d3c-8079-4751568b1081.invocation.api.nvcf.nvidia.com",
    );
  });

  it("uses only CTC when it is explicitly selected", async () => {
    mocks.postTranscriptionRequest.mockResolvedValue(okJson("ctc transcript"));

    const result = await transcribeNvidiaAudio(
      transcriptionRequest({ model: NVIDIA_FALLBACK_ASR_MODEL }),
    );

    expect(result.model).toBe(NVIDIA_FALLBACK_ASR_MODEL);
    expect(mocks.postTranscriptionRequest).toHaveBeenCalledTimes(1);
    expect(mocks.postTranscriptionRequest.mock.calls[0]?.[0]?.url).toContain(
      "1598d209-5e27-4d3c-8079-4751568b1081.invocation.api.nvcf.nvidia.com",
    );
  });

  it("sends Magpie customization fields and returns the WAV response unchanged", async () => {
    const wav = Buffer.from("RIFF-test-wav");
    mocks.postMultipartRequest.mockResolvedValue({
      response: new Response(wav, {
        status: 200,
        headers: { "content-type": "audio/wav" },
      }),
      release: vi.fn(),
    });

    const result = await magpieSynthesize({
      text: "<speak>Hello</speak>",
      apiKey: "nvapi-test",
      baseUrl: "https://tts.example/",
      voice: "Magpie-Multilingual.EN-US.Aria",
      language: "en-US",
      sampleRateHz: 44_100,
      customDictionary: "tomato  pronunciation",
      customConfiguration: "key:value",
      timeoutMs: 30_000,
    });

    expect(result).toEqual(wav);
    const request = mocks.postMultipartRequest.mock.calls[0]?.[0];
    expect(request.url).toBe("https://tts.example/v1/audio/synthesize");
    const form = request.body as FormData;
    expect(form.get("custom_dictionary")).toBe("tomato  pronunciation");
    expect(form.get("custom_configuration")).toBe("key:value");
    expect(form.get("encoding")).toBe("LINEAR_PCM");
  });
});
