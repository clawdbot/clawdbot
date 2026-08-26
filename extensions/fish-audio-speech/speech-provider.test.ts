// Fish Audio tests cover config, request mapping, streaming, discovery, and target formats.
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { buildFishAudioSpeechProvider } from "./speech-provider.js";

const fetchWithSsrFGuardMock = vi.hoisted(() => vi.fn());

vi.mock("openclaw/plugin-sdk/ssrf-runtime", () => ({
  fetchWithSsrFGuard: async (params: { url: string; init?: RequestInit; timeoutMs?: number }) => {
    fetchWithSsrFGuardMock(params);
    return {
      response: await globalThis.fetch(params.url, params.init),
      release: vi.fn(async () => {}),
    };
  },
  ssrfPolicyFromHttpBaseUrlAllowedHostname: () => undefined,
}));

function requestBody(init?: RequestInit): Record<string, unknown> {
  if (typeof init?.body !== "string") {
    throw new Error("expected Fish Audio JSON request body");
  }
  return JSON.parse(init.body) as Record<string, unknown>;
}

describe("Fish Audio speech provider", () => {
  const originalFetch = globalThis.fetch;

  afterAll(() => {
    vi.doUnmock("openclaw/plugin-sdk/ssrf-runtime");
    vi.resetModules();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    fetchWithSsrFGuardMock.mockClear();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("exposes S2.1 free as the default without requiring a voice id", () => {
    vi.stubEnv("FISH_API_KEY", "fish-test");
    const provider = buildFishAudioSpeechProvider();
    expect(provider.defaultModel).toBe("s2.1-pro");
    expect(provider.models).toEqual(["s2.1-pro-free", "s2.1-pro", "s2-pro", "s1"]);
    expect(provider.isConfigured({ providerConfig: {}, timeoutMs: 1_000 })).toBe(true);
  });

  it("maps hosted synthesis and preserves Fish expression tags", async () => {
    globalThis.fetch = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe("https://api.fish.audio/v1/tts");
      expect(new Headers(init?.headers).get("model")).toBe("s2.1-pro");
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer fish-test");
      expect(requestBody(init)).toEqual({
        text: "[whisper] Keep this quiet. [excited] Now celebrate!",
        format: "mp3",
        reference_id: "voice-123",
        sample_rate: 44100,
        latency: "normal",
        prosody: { speed: 1.1 },
        temperature: 0.6,
        top_p: 0.8,
        normalize: false,
      });
      return new Response(new Uint8Array([1, 2, 3]), {
        headers: { "content-type": "audio/mpeg" },
      });
    }) as unknown as typeof fetch;
    const provider = buildFishAudioSpeechProvider();
    const result = await provider.synthesize({
      text: "[whisper] Keep this quiet. [excited] Now celebrate!",
      cfg: {} as never,
      providerConfig: {
        apiKey: "fish-test",
        model: "s2.1-pro",
        speakerVoiceId: "voice-123",
        latency: "normal",
        speed: 1.1,
        temperature: 0.6,
        topP: 0.8,
        normalize: false,
      },
      target: "audio-file",
      timeoutMs: 12_345,
    });
    expect(result).toMatchObject({
      audioBuffer: Buffer.from([1, 2, 3]),
      outputFormat: "mp3",
      fileExtension: ".mp3",
      voiceCompatible: false,
    });
    expect(fetchWithSsrFGuardMock).toHaveBeenCalledWith(
      expect.objectContaining({ timeoutMs: 12_345, auditContext: "fish-audio.tts" }),
    );
  });

  it("uses native Opus for streamed voice notes and releases the response", async () => {
    globalThis.fetch = vi.fn(async (_url: string, init?: RequestInit) => {
      expect(requestBody(init)).toMatchObject({ format: "opus", sample_rate: 48000 });
      return new Response(new Uint8Array([4, 5, 6]), {
        headers: { "content-type": "audio/opus" },
      });
    }) as unknown as typeof fetch;
    const provider = buildFishAudioSpeechProvider();
    const result = await provider.streamSynthesize?.({
      text: "hello",
      cfg: {} as never,
      providerConfig: { apiKey: "fish-test" },
      target: "voice-note",
      timeoutMs: 1_000,
    });
    expect(result).toMatchObject({
      outputFormat: "opus",
      fileExtension: ".opus",
      voiceCompatible: true,
    });
    const bytes = new Uint8Array(await new Response(result?.audioStream).arrayBuffer());
    expect([...bytes]).toEqual([4, 5, 6]);
    await result?.release?.();
  });

  it("requests raw 8 kHz PCM for telephony", async () => {
    globalThis.fetch = vi.fn(async (_url: string, init?: RequestInit) => {
      expect(requestBody(init)).toMatchObject({ format: "pcm", sample_rate: 8000 });
      return new Response(new Uint8Array([7, 8]));
    }) as unknown as typeof fetch;
    const provider = buildFishAudioSpeechProvider();
    const result = await provider.synthesizeTelephony?.({
      text: "hello",
      cfg: {} as never,
      providerConfig: { apiKey: "fish-test" },
      timeoutMs: 1_000,
    });
    expect(result).toEqual({
      audioBuffer: Buffer.from([7, 8]),
      outputFormat: "pcm",
      sampleRate: 8000,
    });
  });

  it("lists all owned pages then one public page with deduplication", async () => {
    globalThis.fetch = vi.fn(async (url: string) => {
      const parsed = new URL(url);
      const self = parsed.searchParams.get("self") === "true";
      const page = Number(parsed.searchParams.get("page_number"));
      if (self && page === 1) {
        return Response.json({
          total: 101,
          items: Array.from({ length: 100 }, (_, index) => ({
            _id: `own-${index}`,
            title: `Own ${index}`,
          })),
        });
      }
      if (self) {
        return Response.json({ total: 101, items: [{ _id: "own-100", title: "Own 100" }] });
      }
      return Response.json({
        items: [
          { _id: "own-0", title: "Duplicate" },
          { _id: "public-1", title: "Public", languages: ["en"], tags: ["warm"] },
        ],
      });
    }) as unknown as typeof fetch;
    const provider = buildFishAudioSpeechProvider();
    const voices = await provider.listVoices?.({
      providerConfig: { apiKey: "fish-test" },
      timeoutMs: 9_000,
    });
    expect(voices).toHaveLength(102);
    expect(voices?.at(-1)).toMatchObject({ id: "public-1", locale: "en", personalities: ["warm"] });
    expect(fetchWithSsrFGuardMock).toHaveBeenCalledTimes(3);
  });

  it("fails closed on blank credentials before network access", async () => {
    vi.stubEnv("FISH_API_KEY", "   ");
    vi.stubEnv("FISH_AUDIO_API_KEY", "   ");
    const provider = buildFishAudioSpeechProvider();
    const providerConfig = { apiKey: "   " };
    expect(provider.isConfigured({ providerConfig, timeoutMs: 1_000 })).toBe(false);
    await expect(
      provider.synthesize({
        text: "hello",
        cfg: {} as never,
        providerConfig,
        target: "audio-file",
        timeoutMs: 1_000,
      }),
    ).rejects.toThrow("Fish Audio API key missing");
    expect(fetchWithSsrFGuardMock).not.toHaveBeenCalled();
  });
});
