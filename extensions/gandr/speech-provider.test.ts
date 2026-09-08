// Gandr tests cover speech provider plugin behavior on the shared factory.
import { requireFirstPostJsonRequest } from "openclaw/plugin-sdk/test-fixtures";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { GANDR_AUTO_SELECT_ORDER, buildGandrSpeechProvider } from "./speech-provider.js";
import { GANDR_MAX_INPUT_CHARS, GANDR_PCM_SAMPLE_RATE_HERTZ } from "./tts.js";

const { assertOkOrThrowHttpErrorMock, postJsonRequestMock, resolveProviderHttpRequestConfigMock } =
  vi.hoisted(() => ({
    assertOkOrThrowHttpErrorMock: vi.fn(async () => {}),
    postJsonRequestMock: vi.fn(),
    resolveProviderHttpRequestConfigMock: vi.fn((params: Record<string, unknown>) => ({
      baseUrl: params.baseUrl ?? params.defaultBaseUrl ?? "https://tts.gandr.ai/v1",
      allowPrivateNetwork: false,
      headers: new Headers(params.defaultHeaders as HeadersInit | undefined),
      dispatcherPolicy: undefined,
    })),
  }));

vi.mock("openclaw/plugin-sdk/provider-http", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/provider-http")>()),
  assertOkOrThrowHttpError: assertOkOrThrowHttpErrorMock,
  postJsonRequest: postJsonRequestMock,
  resolveProviderHttpRequestConfig: resolveProviderHttpRequestConfigMock,
}));

afterAll(() => {
  vi.doUnmock("openclaw/plugin-sdk/provider-http");
  vi.resetModules();
});

function mockAudioResponse(bytes: number[]) {
  const release = vi.fn(async () => {});
  postJsonRequestMock.mockResolvedValue({
    response: new Response(new Uint8Array(bytes), { status: 200 }),
    release,
  });
  return release;
}

describe("gandr speech provider", () => {
  afterEach(() => {
    assertOkOrThrowHttpErrorMock.mockClear();
    postJsonRequestMock.mockReset();
    resolveProviderHttpRequestConfigMock.mockClear();
    vi.unstubAllEnvs();
  });

  it("sorts after every existing automatic provider choice", () => {
    // Local CLI is the last bundled provider at 1000; a configured Gandr must not
    // outrank an existing automatic choice.
    const provider = buildGandrSpeechProvider();
    const existing = { id: "tts-local-cli", autoSelectOrder: 1000 };
    const ordered = [provider, existing].toSorted(
      (left, right) => (left.autoSelectOrder ?? 0) - (right.autoSelectOrder ?? 0),
    );
    expect(GANDR_AUTO_SELECT_ORDER).toBeGreaterThan(1000);
    expect(ordered.map((entry) => entry.id)).toEqual(["tts-local-cli", "gandr"]);
  });

  it("normalizes provider-owned speech config with Gandr defaults", () => {
    const provider = buildGandrSpeechProvider();
    const resolved = provider.resolveConfig?.({
      cfg: {} as never,
      timeoutMs: 30_000,
      rawConfig: {
        providers: {
          gandr: {
            apiKey: "gnd_test",
            baseUrl: "https://example.test/v1/",
            voiceId: "gandr-ava",
            responseFormat: " WAV ",
          },
        },
      },
    });

    expect(resolved).toEqual({
      apiKey: "gnd_test",
      baseUrl: "https://example.test/v1",
      model: "tts-1",
      voice: "gandr-ava",
      speed: undefined,
      responseFormat: "wav",
    });
  });

  it("synthesizes attachments through the shared OpenAI-compatible transport", async () => {
    const release = mockAudioResponse([1, 2, 3]);
    const provider = buildGandrSpeechProvider();
    const result = await provider.synthesize({
      text: "hello",
      cfg: {} as never,
      providerConfig: { apiKey: "gnd_test" },
      target: "audio-file",
      timeoutMs: 12_345,
    });

    expect(resolveProviderHttpRequestConfigMock.mock.calls).toEqual([
      [
        {
          baseUrl: "https://tts.gandr.ai/v1",
          defaultBaseUrl: "https://tts.gandr.ai/v1",
          allowPrivateNetwork: false,
          defaultHeaders: {
            Authorization: "Bearer gnd_test",
            "Content-Type": "application/json",
          },
          provider: "gandr",
          capability: "audio",
          transport: "http",
        },
      ],
    ]);
    const postRequest = requireFirstPostJsonRequest(postJsonRequestMock, "Gandr speech request");
    expect(Reflect.get(postRequest ?? {}, "url")).toBe("https://tts.gandr.ai/v1/audio/speech");
    expect(Reflect.get(postRequest ?? {}, "timeoutMs")).toBe(12_345);
    expect(Reflect.get(postRequest ?? {}, "body")).toEqual({
      model: "tts-1",
      input: "hello",
      voice: "gandr-mia",
      response_format: "mp3",
    });
    expect(result.audioBuffer).toEqual(Buffer.from([1, 2, 3]));
    expect(result.outputFormat).toBe("mp3");
    expect(result.fileExtension).toBe(".mp3");
    expect(result.voiceCompatible).toBe(false);
    expect(release).toHaveBeenCalledOnce();
  });

  it("pins headerless PCM for telephony and reports the sample rate", async () => {
    mockAudioResponse([4, 5, 6]);
    const provider = buildGandrSpeechProvider();
    const result = await provider.synthesizeTelephony?.({
      text: "hello",
      cfg: {} as never,
      providerConfig: { apiKey: "gnd_test", responseFormat: "wav", voiceId: "gandr-leo" },
      timeoutMs: 5_000,
    });

    const postRequest = requireFirstPostJsonRequest(postJsonRequestMock, "Gandr telephony request");
    expect(Reflect.get(postRequest ?? {}, "body")).toEqual({
      model: "tts-1",
      input: "hello",
      voice: "gandr-leo",
      response_format: "pcm",
    });
    expect(result).toEqual({
      audioBuffer: Buffer.from([4, 5, 6]),
      outputFormat: "pcm",
      sampleRate: GANDR_PCM_SAMPLE_RATE_HERTZ,
    });
  });

  it("rejects input above the per-request character cap before any request", async () => {
    const provider = buildGandrSpeechProvider();
    const ctx = {
      cfg: {} as never,
      providerConfig: { apiKey: "gnd_test" },
      target: "audio-file" as const,
      timeoutMs: 5_000,
    };

    expect(() =>
      provider.prepareSynthesis?.({ ...ctx, text: "a".repeat(GANDR_MAX_INPUT_CHARS + 1) }),
    ).toThrow("Gandr TTS input too long: 2001 chars (limit: 2000 chars)");
    expect(provider.prepareSynthesis?.({ ...ctx, text: "a".repeat(GANDR_MAX_INPUT_CHARS) })).toBe(
      undefined,
    );
    expect(postJsonRequestMock).not.toHaveBeenCalled();
  });

  it("uses GANDR_API_KEY when provider config omits apiKey", () => {
    vi.stubEnv("GANDR_API_KEY", "gnd_env");
    const provider = buildGandrSpeechProvider();

    expect(
      provider.isConfigured({
        cfg: {} as never,
        providerConfig: {},
        timeoutMs: 30_000,
      }),
    ).toBe(true);
  });

  it("lists the stock voice catalog", async () => {
    const provider = buildGandrSpeechProvider();
    const voices = await provider.listVoices?.({ cfg: {} as never, timeoutMs: 1_000 });
    expect(voices?.map((voice) => voice.id)).toContain("gandr-mia");
    expect(voices).toHaveLength(6);
  });
});
