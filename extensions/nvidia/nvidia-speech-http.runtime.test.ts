import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  postMultipartRequest: vi.fn(),
  postTranscriptionRequest: vi.fn(),
  resolveNvidiaSpeechCatalogModel: vi.fn(),
  transcodeAudioBufferToOpus: vi.fn(async (_params: { timeoutMs: number }) =>
    Buffer.from("transcoded-opus"),
  ),
}));

vi.mock("openclaw/plugin-sdk/media-runtime", () => ({
  transcodeAudioBufferToOpus: mocks.transcodeAudioBufferToOpus,
}));

vi.mock("openclaw/plugin-sdk/provider-http", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/provider-http")>();
  return {
    ...actual,
    postMultipartRequest: mocks.postMultipartRequest,
    postTranscriptionRequest: mocks.postTranscriptionRequest,
  };
});

vi.mock("./nvidia-speech-catalog.js", () => ({
  NVIDIA_CATALOG_ASR_MODEL_ID: "nvidia/parakeet-ctc-1.1b-asr",
  NVIDIA_CATALOG_TTS_MODEL_ID: "nvidia/magpie-tts-multilingual",
  resolveNvidiaSpeechCatalogModel: mocks.resolveNvidiaSpeechCatalogModel,
}));

import { NVIDIA_DEFAULT_ASR_MODEL } from "./nvidia-speech-config.js";
import {
  magpieSynthesize,
  magpieSynthesizeStream,
  transcribeNvidiaAudio,
} from "./nvidia-speech-http.runtime.js";

function transcriptionRequest(overrides: Record<string, unknown> = {}) {
  return {
    buffer: monoPcm16Wav(),
    fileName: "sample.wav",
    mime: "audio/wav",
    apiKey: "nvapi-test",
    baseUrl: "https://integrate.api.nvidia.com/v1",
    timeoutMs: 30_000,
    ...overrides,
  } as Parameters<typeof transcribeNvidiaAudio>[0];
}

function monoPcm16Wav(): Buffer {
  const wav = Buffer.alloc(44);
  wav.write("RIFF", 0, "ascii");
  wav.writeUInt32LE(36, 4);
  wav.write("WAVE", 8, "ascii");
  wav.write("fmt ", 12, "ascii");
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(16_000, 24);
  wav.writeUInt32LE(32_000, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write("data", 36, "ascii");
  return wav;
}

function oggOpus(channelCount: number): Buffer {
  const buffer = Buffer.alloc(40);
  buffer.write("OggS", 0, "ascii");
  buffer.write("OpusHead", 12, "ascii");
  buffer[20] = 1;
  buffer[21] = channelCount;
  return buffer;
}

function flac(channelCount: number, bitsPerSample = 16): Buffer {
  const buffer = Buffer.alloc(42);
  buffer.write("fLaC", 0, "ascii");
  buffer[4] = 0x80;
  buffer.writeUIntBE(34, 5, 3);
  const bitsPerSampleMinusOne = bitsPerSample - 1;
  buffer[20] = ((channelCount - 1) << 1) | (bitsPerSampleMinusOne >> 4);
  buffer[21] = (bitsPerSampleMinusOne & 0x0f) << 4;
  return buffer;
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
    mocks.resolveNvidiaSpeechCatalogModel.mockResolvedValue(undefined);
  });

  it("uses hosted Parakeet CTC by default and forwards ASR customizations", async () => {
    mocks.postTranscriptionRequest.mockResolvedValue(okJson("hello NVIDIA"));

    const result = await transcribeNvidiaAudio(
      transcriptionRequest({
        query: {
          boostedWords: '["Nemotron","OpenClaw"]',
          boostedWordsScore: 1.5,
          wordTimeOffsets: true,
          automaticPunctuation: true,
          customConfiguration: "foo:bar",
          responseFormat: "text",
          response_format: "verbose_json",
          language: "fr-FR",
          model: "internal-model-id",
        },
      }),
    );

    expect(result).toEqual({ text: "hello NVIDIA", model: NVIDIA_DEFAULT_ASR_MODEL });
    expect(mocks.postTranscriptionRequest).toHaveBeenCalledTimes(1);
    const request = mocks.postTranscriptionRequest.mock.calls[0]?.[0];
    expect(request.url).toContain(
      "1598d209-5e27-4d3c-8079-4751568b1081.invocation.api.nvcf.nvidia.com",
    );
    const form = request.body as FormData;
    expect(form.getAll("boosted_lm_words")).toEqual(["Nemotron", "OpenClaw"]);
    expect(form.get("boosted_lm_score")).toBe("1.5");
    expect(form.get("word_time_offsets")).toBe("true");
    expect(form.get("enable_automatic_punctuation")).toBe("true");
    expect(form.get("custom_configuration")).toBe("foo:bar");
    expect(form.getAll("response_format")).toEqual(["json"]);
    expect(form.getAll("language")).toEqual(["en-US"]);
    expect(form.get("model")).toBeNull();
  });

  it("uses the validated catalog endpoint and default language for hosted ASR", async () => {
    mocks.resolveNvidiaSpeechCatalogModel.mockResolvedValue({
      id: "nvidia/parakeet-ctc-1.1b-asr",
      modality: "asr",
      status: "active",
      cloud: {
        transport: "http",
        baseUrl: "https://aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.invocation.api.nvcf.nvidia.com",
        defaultLanguage: "en-GB",
      },
    });
    mocks.postTranscriptionRequest.mockResolvedValue(okJson("catalog transcript"));

    await transcribeNvidiaAudio(transcriptionRequest());

    const request = mocks.postTranscriptionRequest.mock.calls[0]?.[0];
    expect(request.url).toBe(
      "https://aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.invocation.api.nvcf.nvidia.com/v1/audio/transcriptions",
    );
    expect((request.body as FormData).get("language")).toBe("en-GB");
  });

  it("uses an explicitly configured HTTP model and base URL", async () => {
    mocks.postTranscriptionRequest.mockResolvedValue(okJson("self-hosted transcript"));

    const result = await transcribeNvidiaAudio(
      transcriptionRequest({
        model: "nvidia/parakeet-tdt-0.6b-v2",
        baseUrl: "http://10.0.0.5:9000/v1",
        apiKey: "",
        auth: { kind: "none", source: "test-self-hosted" },
      }),
    );

    expect(result.model).toBe("nvidia/parakeet-tdt-0.6b-v2");
    expect(mocks.postTranscriptionRequest).toHaveBeenCalledTimes(1);
    expect(mocks.postTranscriptionRequest.mock.calls[0]?.[0]?.url).toBe(
      "http://10.0.0.5:9000/v1/audio/transcriptions",
    );
    expect(mocks.postTranscriptionRequest.mock.calls[0]?.[0]?.ssrfPolicy).toEqual({
      allowedOrigins: ["http://10.0.0.5:9000"],
    });
    const form = mocks.postTranscriptionRequest.mock.calls[0]?.[0]?.body as FormData;
    expect(form.get("model")).toBe("nvidia/parakeet-tdt-0.6b-v2");
    const headers = mocks.postTranscriptionRequest.mock.calls[0]?.[0]?.headers as Headers;
    expect(headers.has("authorization")).toBe(false);
  });

  it("never forwards a hosted ASR credential to a custom origin", async () => {
    mocks.postTranscriptionRequest.mockResolvedValue(okJson("custom transcript"));

    await transcribeNvidiaAudio(
      transcriptionRequest({
        baseUrl: "https://speech.example/v1",
        apiKey: "hosted-secret",
        auth: { kind: "api-key", apiKey: "hosted-secret", source: "test-hosted" },
      }),
    );

    const headers = mocks.postTranscriptionRequest.mock.calls[0]?.[0]?.headers as Headers;
    expect(headers.has("authorization")).toBe(false);
  });

  it("requires an API key for the hosted ASR endpoint", async () => {
    await expect(
      transcribeNvidiaAudio(
        transcriptionRequest({
          apiKey: "",
          auth: { kind: "none", source: "test-missing" },
        }),
      ),
    ).rejects.toThrow("API key missing for hosted ASR");
    expect(mocks.postTranscriptionRequest).not.toHaveBeenCalled();
  });

  it("recognizes the versioned hosted ASR URL", async () => {
    mocks.postTranscriptionRequest.mockResolvedValue(okJson("hosted transcript"));
    await transcribeNvidiaAudio(
      transcriptionRequest({
        baseUrl: "https://1598d209-5e27-4d3c-8079-4751568b1081.invocation.api.nvcf.nvidia.com/v1",
      }),
    );
    const versionedHeaders = mocks.postTranscriptionRequest.mock.calls[0]?.[0]?.headers as Headers;
    expect(versionedHeaders.get("authorization")).toBe("Bearer nvapi-test");
  });

  it("uses an explicit ASR base URL without falling back to a hosted endpoint", async () => {
    mocks.postTranscriptionRequest.mockResolvedValue({
      response: new Response('{"detail":"unavailable"}', { status: 503 }),
      release: vi.fn(),
    });

    await expect(
      transcribeNvidiaAudio(transcriptionRequest({ baseUrl: "https://speech.example/v1" })),
    ).rejects.toThrow("transcription failed");

    expect(mocks.postTranscriptionRequest).toHaveBeenCalledTimes(1);
    expect(mocks.postTranscriptionRequest.mock.calls[0]?.[0]?.url).toBe(
      "https://speech.example/v1/audio/transcriptions",
    );
  });

  it("transcodes unsupported inbound audio to mono Opus before upload", async () => {
    mocks.postTranscriptionRequest.mockResolvedValue(okJson("converted transcript"));

    await transcribeNvidiaAudio(
      transcriptionRequest({
        buffer: Buffer.from("mp3-audio"),
        fileName: "sample.mp3",
        mime: "audio/mpeg",
      }),
    );

    expect(mocks.transcodeAudioBufferToOpus).toHaveBeenCalledWith({
      audioBuffer: Buffer.from("mp3-audio"),
      inputFileName: "sample.mp3",
      outputFileName: "audio.opus",
      tempPrefix: "nvidia-asr-",
      timeoutMs: expect.any(Number),
      channels: 1,
    });
    const transcodeTimeoutMs = mocks.transcodeAudioBufferToOpus.mock.calls[0]?.[0]?.timeoutMs;
    expect(transcodeTimeoutMs).toBeGreaterThan(0);
    expect(transcodeTimeoutMs).toBeLessThanOrEqual(30_000);
    const form = mocks.postTranscriptionRequest.mock.calls[0]?.[0]?.body as FormData;
    const file = form.get("file") as File;
    expect(file.name).toBe("audio.opus");
    expect(file.type).toBe("audio/ogg");
  });

  it("transcodes stereo Ogg Opus but uploads mono Ogg Opus directly", async () => {
    mocks.postTranscriptionRequest.mockImplementation(async () => okJson("opus transcript"));

    await transcribeNvidiaAudio(
      transcriptionRequest({
        buffer: oggOpus(2),
        fileName: "stereo.opus",
        mime: "audio/ogg",
      }),
    );
    expect(mocks.transcodeAudioBufferToOpus).toHaveBeenCalledOnce();

    mocks.transcodeAudioBufferToOpus.mockClear();
    await transcribeNvidiaAudio(
      transcriptionRequest({
        buffer: oggOpus(1),
        fileName: "mono.opus",
        mime: "audio/ogg",
      }),
    );
    expect(mocks.transcodeAudioBufferToOpus).not.toHaveBeenCalled();
  });

  it("uploads mono FLAC directly but normalizes multichannel FLAC", async () => {
    mocks.postTranscriptionRequest.mockImplementation(async () => okJson("flac transcript"));

    await transcribeNvidiaAudio(
      transcriptionRequest({ buffer: flac(1), fileName: "mono.flac", mime: "audio/flac" }),
    );
    expect(mocks.transcodeAudioBufferToOpus).not.toHaveBeenCalled();

    await transcribeNvidiaAudio(
      transcriptionRequest({ buffer: flac(2), fileName: "stereo.flac", mime: "audio/flac" }),
    );
    expect(mocks.transcodeAudioBufferToOpus).toHaveBeenCalledOnce();

    mocks.transcodeAudioBufferToOpus.mockClear();
    await transcribeNvidiaAudio(
      transcriptionRequest({ buffer: flac(1, 24), fileName: "24-bit.flac", mime: "audio/flac" }),
    );
    expect(mocks.transcodeAudioBufferToOpus).toHaveBeenCalledOnce();
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
      baseUrl: "http://10.0.0.5:9000/v1/",
      model: "magpie-tts-multilingual",
      voice: "Magpie-Multilingual.EN-US.Aria",
      language: "en-US",
      sampleRateHz: 44_100,
      customDictionary: "tomato  pronunciation",
      customConfiguration: "key:value",
      timeoutMs: 30_000,
    });

    expect(result).toEqual(wav);
    const request = mocks.postMultipartRequest.mock.calls[0]?.[0];
    expect(request.url).toBe("http://10.0.0.5:9000/v1/audio/synthesize");
    expect(request.ssrfPolicy).toEqual({ allowedOrigins: ["http://10.0.0.5:9000"] });
    const form = request.body as FormData;
    expect(form.get("model")).toBe("magpie-tts-multilingual");
    expect(form.get("custom_dictionary")).toBe("tomato  pronunciation");
    expect(form.get("custom_configuration")).toBe("key:value");
    expect(form.get("encoding")).toBe("LINEAR_PCM");
  });

  it("uses the validated catalog endpoint for hosted Magpie", async () => {
    mocks.resolveNvidiaSpeechCatalogModel.mockResolvedValue({
      id: "nvidia/magpie-tts-multilingual",
      modality: "tts",
      status: "active",
      cloud: {
        transport: "http",
        baseUrl: "https://bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb.invocation.api.nvcf.nvidia.com",
      },
    });
    mocks.postMultipartRequest.mockResolvedValue({
      response: new Response(Buffer.from("RIFF-catalog-wav"), {
        status: 200,
        headers: { "content-type": "audio/wav" },
      }),
      release: vi.fn(),
    });

    await magpieSynthesize({
      text: "hello",
      apiKey: "nvapi-test",
      baseUrl: "https://877104f7-e885-42b9-8de8-f6e4c6303969.invocation.api.nvcf.nvidia.com",
      model: "magpie-tts-multilingual",
      voice: "Magpie-Multilingual.EN-US.Aria",
      language: "en-US",
      sampleRateHz: 44_100,
      timeoutMs: 30_000,
    });

    expect(mocks.postMultipartRequest.mock.calls[0]?.[0]?.url).toBe(
      "https://bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb.invocation.api.nvcf.nvidia.com/v1/audio/synthesize",
    );
  });

  it("keeps separate local ASR and TTS origins keyless in one configuration", async () => {
    const config = {
      tools: {
        media: {
          models: [
            {
              provider: "nvidia",
              model: "nvidia/parakeet-ctc-1.1b-asr",
              capabilities: ["audio"],
              baseUrl: "http://127.0.0.1:9000",
            },
          ],
        },
      },
      tts: {
        providers: {
          nvidia: {
            baseUrl: "http://127.0.0.1:9001",
            model: "magpie-tts-multilingual",
          },
        },
      },
    };
    mocks.postTranscriptionRequest.mockResolvedValue(okJson("local transcript"));
    mocks.postMultipartRequest.mockResolvedValue({
      response: new Response(Buffer.from("RIFF-local-wav"), {
        status: 200,
        headers: { "content-type": "audio/wav" },
      }),
      release: vi.fn(),
    });

    const asrConfig = config.tools.media.models[0];
    if (!asrConfig) {
      throw new Error("expected local ASR configuration");
    }
    await transcribeNvidiaAudio(
      transcriptionRequest({
        baseUrl: asrConfig.baseUrl,
        model: asrConfig.model,
        apiKey: "hosted-nvidia-secret",
        auth: { kind: "none", source: "nvidia-self-hosted" },
      }),
    );
    await magpieSynthesize({
      text: "hello",
      baseUrl: config.tts.providers.nvidia.baseUrl,
      model: config.tts.providers.nvidia.model,
      voice: "Magpie-Multilingual.EN-US.Aria",
      language: "en-US",
      sampleRateHz: 44_100,
      timeoutMs: 30_000,
    });

    const asrRequest = mocks.postTranscriptionRequest.mock.calls[0]?.[0];
    if (!asrRequest) {
      throw new Error("expected local ASR request");
    }
    expect(asrRequest.url).toBe("http://127.0.0.1:9000/v1/audio/transcriptions");
    expect((asrRequest.headers as Headers).has("authorization")).toBe(false);
    const ttsRequest = mocks.postMultipartRequest.mock.calls[0]?.[0];
    if (!ttsRequest) {
      throw new Error("expected local TTS request");
    }
    expect(ttsRequest.url).toBe("http://127.0.0.1:9001/v1/audio/synthesize");
    expect((ttsRequest.headers as Headers).has("authorization")).toBe(false);
  });

  it("rejects a successful non-audio Magpie response", async () => {
    mocks.postMultipartRequest.mockResolvedValue({
      response: new Response(JSON.stringify({ error: "not audio" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
      release: vi.fn(),
    });

    await expect(
      magpieSynthesize({
        text: "hello",
        baseUrl: "http://10.0.0.5:9000/v1",
        model: "magpie-tts-multilingual",
        voice: "Magpie-Multilingual.EN-US.Aria",
        language: "en-US",
        sampleRateHz: 44_100,
        timeoutMs: 30_000,
      }),
    ).rejects.toThrow("unexpected content type");
  });

  it("supports an explicit model-in-path endpoint without inferring its auth policy", async () => {
    mocks.postTranscriptionRequest.mockResolvedValue(okJson("custom transcript"));
    await transcribeNvidiaAudio(
      transcriptionRequest({
        baseUrl: "https://speech.example",
        model: "nvidia/parakeet-ctc",
        auth: { kind: "none", source: "explicit-request-auth" },
        apiKey: "",
        request: {
          auth: { mode: "authorization-bearer", token: "endpoint-secret" },
        },
        query: { routeStyle: "model-path", modelPath: "nvidia/parakeet-ctc" },
      }),
    );
    const request = mocks.postTranscriptionRequest.mock.calls[0]?.[0];
    expect(request.url).toBe("https://speech.example/v1/audio/nvidia/parakeet-ctc/transcriptions");
    expect((request.body as FormData).get("model")).toBeNull();
    expect((request.body as FormData).get("route_style")).toBeNull();
    expect((request.body as FormData).get("model_path")).toBeNull();
    expect((request.headers as Headers).get("authorization")).toBe("Bearer endpoint-secret");
  });

  it("streams Magpie PCM from synthesize_online as a bounded WAV stream", async () => {
    const release = vi.fn();
    mocks.postMultipartRequest.mockResolvedValue({
      response: new Response(new Uint8Array([1, 2, 3, 4]), {}),
      release,
    });
    const result = await magpieSynthesizeStream({
      text: "hello",
      apiKey: "nvapi-test",
      baseUrl: "http://10.0.0.5:9000/v1",
      model: "magpie-tts-multilingual",
      voice: "Magpie-Multilingual.EN-US.Aria",
      language: "en-US",
      sampleRateHz: 44_100,
      timeoutMs: 30_000,
    });
    const bytes = Buffer.from(await new Response(result.audioStream).arrayBuffer());
    expect(mocks.postMultipartRequest.mock.calls[0]?.[0]?.url).toBe(
      "http://10.0.0.5:9000/v1/audio/synthesize_online",
    );
    expect(bytes.subarray(0, 4).toString("ascii")).toBe("RIFF");
    expect(bytes.readUInt32LE(24)).toBe(44_100);
    expect([...bytes.subarray(44)]).toEqual([1, 2, 3, 4]);
    expect(release).toHaveBeenCalledOnce();
  });
});
