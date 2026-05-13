import {
  describeImageWithModel,
  describeImagesWithModel,
} from "openclaw/plugin-sdk/media-understanding";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  openrouterMediaUnderstandingProvider,
  transcribeOpenRouterAudio,
} from "./media-understanding-provider.js";

const { assertOkOrThrowHttpErrorMock, postJsonRequestMock, resolveProviderHttpRequestConfigMock } =
  vi.hoisted(() => ({
    assertOkOrThrowHttpErrorMock: vi.fn(async () => {}),
    postJsonRequestMock: vi.fn(),
    resolveProviderHttpRequestConfigMock: vi.fn((params: Record<string, unknown>) => ({
      baseUrl: params.baseUrl ?? params.defaultBaseUrl ?? "https://openrouter.ai/api/v1",
      allowPrivateNetwork: false,
      headers: new Headers(params.defaultHeaders as HeadersInit | undefined),
      dispatcherPolicy: undefined,
    })),
  }));

vi.mock("openclaw/plugin-sdk/provider-http", () => ({
  assertOkOrThrowHttpError: assertOkOrThrowHttpErrorMock,
  postJsonRequest: postJsonRequestMock,
  requireTranscriptionText: (value: string | undefined, message: string) => {
    const text = value?.trim();
    if (!text) {
      throw new Error(message);
    }
    return text;
  },
  resolveProviderHttpRequestConfig: resolveProviderHttpRequestConfigMock,
}));

function firstPostJsonRequest(): { body?: unknown; headers?: Headers } {
  const [request] = postJsonRequestMock.mock.calls[0] ?? [];
  if (!request || typeof request !== "object") {
    throw new Error("expected first OpenRouter JSON request");
  }
  return request as { body?: unknown; headers?: Headers };
}

describe("openrouter media understanding provider", () => {
  afterEach(() => {
    assertOkOrThrowHttpErrorMock.mockClear();
    postJsonRequestMock.mockReset();
    resolveProviderHttpRequestConfigMock.mockClear();
  });

  it("declares image and audio capabilities with defaults", () => {
    expect(openrouterMediaUnderstandingProvider).toEqual({
      id: "openrouter",
      capabilities: ["image", "audio"],
      defaultModels: {
        image: "auto",
        audio: "openai/whisper-large-v3-turbo",
      },
      autoPriority: { audio: 35 },
      describeImage: describeImageWithModel,
      describeImages: describeImagesWithModel,
      transcribeAudio: transcribeOpenRouterAudio,
    });
  });

  it("sends JSON STT payload to OpenRouter transcriptions endpoint", async () => {
    const release = vi.fn(async () => {});
    postJsonRequestMock.mockResolvedValue({
      response: new Response(JSON.stringify({ text: "hello world" }), { status: 200 }),
      release,
    });

    const result = await transcribeOpenRouterAudio({
      buffer: Buffer.from("audio-bytes"),
      fileName: "voice.oga",
      mime: "audio/ogg",
      apiKey: "sk-openrouter",
      timeoutMs: 12_000,
      language: " en ",
      fetchFn: fetch,
    });

    expect(result).toEqual({
      text: "hello world",
      model: "openai/whisper-large-v3-turbo",
    });
    expect(resolveProviderHttpRequestConfigMock).toHaveBeenCalledWith({
      baseUrl: undefined,
      defaultBaseUrl: "https://openrouter.ai/api/v1",
      headers: undefined,
      request: undefined,
      defaultHeaders: {
        Authorization: "Bearer sk-openrouter",
        "Content-Type": "application/json",
        "HTTP-Referer": "https://openclaw.ai",
        "X-OpenRouter-Title": "OpenClaw",
      },
      provider: "openrouter",
      api: "openrouter-stt",
      capability: "audio",
      transport: "media-understanding",
    });
    expect(postJsonRequestMock).toHaveBeenCalledWith({
      url: "https://openrouter.ai/api/v1/audio/transcriptions",
      headers: expect.any(Headers),
      body: {
        model: "openai/whisper-large-v3-turbo",
        input_audio: {
          data: Buffer.from("audio-bytes").toString("base64"),
          format: "ogg",
        },
        language: "en",
      },
      timeoutMs: 12_000,
      fetchFn: fetch,
      allowPrivateNetwork: false,
      dispatcherPolicy: undefined,
      auditContext: "openrouter stt",
    });
    const headers = firstPostJsonRequest().headers;
    if (!headers) {
      throw new Error("expected OpenRouter request headers");
    }
    expect(headers.get("authorization")).toBe("Bearer sk-openrouter");
    expect(headers.get("http-referer")).toBe("https://openclaw.ai");
    expect(headers.get("x-openrouter-title")).toBe("OpenClaw");
    expect(release).toHaveBeenCalledOnce();
  });

  it("accepts temperature via provider query options", async () => {
    const release = vi.fn(async () => {});
    postJsonRequestMock.mockResolvedValue({
      response: new Response(JSON.stringify({ text: "ok" }), { status: 200 }),
      release,
    });

    await transcribeOpenRouterAudio({
      buffer: Buffer.from("audio"),
      fileName: "voice.webm",
      apiKey: "sk-openrouter",
      timeoutMs: 5_000,
      query: { temperature: 0.2 },
      fetchFn: fetch,
    });

    expect(firstPostJsonRequest().body).toEqual({
      model: "openai/whisper-large-v3-turbo",
      input_audio: {
        data: Buffer.from("audio").toString("base64"),
        format: "webm",
      },
      temperature: 0.2,
    });
  });

  it("falls back to filename extension when mime is missing", async () => {
    const release = vi.fn(async () => {});
    postJsonRequestMock.mockResolvedValue({
      response: new Response(JSON.stringify({ text: "ok" }), { status: 200 }),
      release,
    });

    await transcribeOpenRouterAudio({
      buffer: Buffer.from("audio"),
      fileName: "voice.opus",
      apiKey: "sk-openrouter",
      timeoutMs: 5_000,
      fetchFn: fetch,
    });

    expect(firstPostJsonRequest().body).toEqual({
      model: "openai/whisper-large-v3-turbo",
      input_audio: {
        data: Buffer.from("audio").toString("base64"),
        format: "ogg",
      },
    });
  });

  it("maps mp4 filename extension to m4a when mime is missing", async () => {
    const release = vi.fn(async () => {});
    postJsonRequestMock.mockResolvedValue({
      response: new Response(JSON.stringify({ text: "ok" }), { status: 200 }),
      release,
    });

    await transcribeOpenRouterAudio({
      buffer: Buffer.from("audio"),
      fileName: "voice.mp4",
      apiKey: "sk-openrouter",
      timeoutMs: 5_000,
      fetchFn: fetch,
    });

    expect(firstPostJsonRequest().body).toEqual({
      model: "openai/whisper-large-v3-turbo",
      input_audio: {
        data: Buffer.from("audio").toString("base64"),
        format: "m4a",
      },
    });
  });

  it("normalizes parameterized mime for extensionless filenames", async () => {
    const release = vi.fn(async () => {});
    postJsonRequestMock.mockResolvedValue({
      response: new Response(JSON.stringify({ text: "ok" }), { status: 200 }),
      release,
    });

    await transcribeOpenRouterAudio({
      buffer: Buffer.from("audio"),
      fileName: "media-1",
      mime: " Audio/Ogg; codecs=opus ",
      apiKey: "sk-openrouter",
      timeoutMs: 5_000,
      fetchFn: fetch,
    });

    expect(firstPostJsonRequest().body).toEqual({
      model: "openai/whisper-large-v3-turbo",
      input_audio: {
        data: Buffer.from("audio").toString("base64"),
        format: "ogg",
      },
    });
  });

  it("throws when format cannot be resolved", async () => {
    await expect(
      transcribeOpenRouterAudio({
        buffer: Buffer.from("audio"),
        fileName: "voice.bin",
        mime: "application/octet-stream",
        apiKey: "sk-openrouter",
        timeoutMs: 5_000,
        fetchFn: fetch,
      }),
    ).rejects.toThrow("OpenRouter STT could not resolve audio format");
    expect(postJsonRequestMock).not.toHaveBeenCalled();
  });

  it("throws when provider response omits text", async () => {
    const release = vi.fn(async () => {});
    postJsonRequestMock.mockResolvedValue({
      response: new Response(JSON.stringify({}), { status: 200 }),
      release,
    });

    await expect(
      transcribeOpenRouterAudio({
        buffer: Buffer.from("audio"),
        fileName: "voice.mp3",
        apiKey: "sk-openrouter",
        timeoutMs: 5_000,
        fetchFn: fetch,
      }),
    ).rejects.toThrow("OpenRouter transcription response missing text");
  });
});
