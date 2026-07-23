// Elevenlabs proxy tests cover the trusted-env-proxy egress mode across the TTS
// synth/stream endpoints and voice discovery, so voice features keep working in
// HTTP-proxy-required environments where direct egress is blocked.
import { afterEach, describe, expect, it, vi } from "vitest";

const fetchWithSsrFGuardMock = vi.hoisted(() => vi.fn());

vi.mock("openclaw/plugin-sdk/ssrf-runtime", () => ({
  fetchWithSsrFGuard: async (params: {
    url: string;
    init?: RequestInit;
    timeoutMs?: number;
  }): Promise<{ response: Response; release: () => Promise<void> }> => {
    fetchWithSsrFGuardMock(params);
    return {
      response: await globalThis.fetch(params.url, params.init),
      release: vi.fn(async () => {}),
    };
  },
  ssrfPolicyFromHttpBaseUrlAllowedHostname: () => undefined,
}));

vi.mock("./config-api.js", () => ({
  resolveElevenLabsApiKeyWithProfileFallback: () => null,
}));

import { buildElevenLabsSpeechProvider } from "./speech-provider.js";
import { elevenLabsTTS, elevenLabsTTSStream } from "./tts.js";

const originalFetch = globalThis.fetch;

function createTtsRequest() {
  return {
    text: "hello",
    apiKey: "xi-test",
    baseUrl: "https://api.elevenlabs.io",
    voiceId: "pMsXgVXv3BLzUgSXRplE",
    modelId: "eleven_multilingual_v2",
    outputFormat: "mp3_44100_128",
    voiceSettings: {
      stability: 0.5,
      similarityBoost: 0.75,
      style: 0,
      useSpeakerBoost: true,
      speed: 1,
    },
    timeoutMs: 5_000,
  };
}

afterEach(() => {
  globalThis.fetch = originalFetch;
  fetchWithSsrFGuardMock.mockReset();
  vi.restoreAllMocks();
});

describe("elevenlabs trusted-env-proxy egress mode", () => {
  it("routes buffered TTS synthesis through the trusted env proxy", async () => {
    globalThis.fetch = vi.fn(
      async () => new Response(Buffer.from("mp3")),
    ) as unknown as typeof fetch;

    await elevenLabsTTS(createTtsRequest());

    expect(fetchWithSsrFGuardMock).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: "trusted_env_proxy",
        url: "https://api.elevenlabs.io/v1/text-to-speech/pMsXgVXv3BLzUgSXRplE?output_format=mp3_44100_128",
      }),
    );
  });

  it("routes streamed TTS synthesis through the trusted env proxy", async () => {
    globalThis.fetch = vi.fn(
      async () => new Response(new Uint8Array([1, 2, 3])),
    ) as unknown as typeof fetch;

    const { release } = await elevenLabsTTSStream(createTtsRequest());
    await release();

    expect(fetchWithSsrFGuardMock).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: "trusted_env_proxy",
        url: "https://api.elevenlabs.io/v1/text-to-speech/pMsXgVXv3BLzUgSXRplE/stream?output_format=mp3_44100_128",
      }),
    );
  });

  it("routes voice discovery through the trusted env proxy", async () => {
    globalThis.fetch = vi.fn(async () => Response.json({ voices: [] })) as unknown as typeof fetch;
    const provider = buildElevenLabsSpeechProvider();

    await provider.listVoices?.({
      providerConfig: { apiKey: "xi-test" },
      timeoutMs: 30_000,
    });

    expect(fetchWithSsrFGuardMock).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: "trusted_env_proxy",
        url: "https://api.elevenlabs.io/v1/voices",
      }),
    );
  });
});
