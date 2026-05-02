import { afterEach, describe, expect, it, vi } from "vitest";
import { buildElevenLabsSpeechProvider, isValidVoiceId } from "./speech-provider.js";

vi.mock("openclaw/plugin-sdk/ssrf-runtime", () => ({
  fetchWithSsrFGuard: async ({
    url,
    init,
  }: {
    url: string;
    init?: RequestInit;
  }): Promise<{ response: Response; release: () => Promise<void> }> => ({
    response: await globalThis.fetch(url, init),
    release: vi.fn(async () => {}),
  }),
  ssrfPolicyFromHttpBaseUrlAllowedHostname: () => undefined,
}));

function parseRequestBody(init: RequestInit | undefined): Record<string, unknown> {
  if (typeof init?.body !== "string") {
    throw new Error("expected string request body");
  }
  const body: unknown = JSON.parse(init.body);
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new Error("expected ElevenLabs request body");
  }
  return body as Record<string, unknown>;
}

describe("elevenlabs speech provider", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("exposes the current ElevenLabs TTS model catalog", () => {
    const provider = buildElevenLabsSpeechProvider();

    expect(provider.models).toEqual(
      expect.arrayContaining(["eleven_v3", "eleven_multilingual_v2"]),
    );
  });

  it("validates ElevenLabs voice ID length and character rules", () => {
    const cases = [
      { value: "pMsXgVXv3BLzUgSXRplE", expected: true },
      { value: "21m00Tcm4TlvDq8ikWAM", expected: true },
      { value: "VoiceAlias1234567890", expected: true },
      { value: "a1b2c3d4e5", expected: true },
      { value: "a".repeat(40), expected: true },
      { value: "", expected: false },
      { value: "abc", expected: false },
      { value: "123456789", expected: false },
      { value: "a".repeat(41), expected: false },
      { value: "a".repeat(100), expected: false },
      { value: "pMsXgVXv3BLz-gSXRplE", expected: false },
      { value: "pMsXgVXv3BLz_gSXRplE", expected: false },
      { value: "pMsXgVXv3BLz gSXRplE", expected: false },
      { value: "../../../etc/passwd", expected: false },
      { value: "voice?param=value", expected: false },
    ] as const;
    for (const testCase of cases) {
      expect(isValidVoiceId(testCase.value), testCase.value).toBe(testCase.expected);
    }
  });

  it("applies provider overrides to telephony synthesis", async () => {
    const provider = buildElevenLabsSpeechProvider();
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toContain("/v1/text-to-speech/21m00Tcm4TlvDq8ikWAM");
      expect(url).toContain("output_format=pcm_22050");
      const body = parseRequestBody(init);
      expect(body).toMatchObject({
        text: "hello",
        model_id: "eleven_v3",
        seed: 123,
        apply_text_normalization: "on",
        language_code: "en",
        voice_settings: expect.objectContaining({
          speed: 1.2,
        }),
      });
      return new Response(new Uint8Array([1, 2, 3]), { status: 200 });
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const result = await provider.synthesizeTelephony?.({
      text: "hello",
      cfg: {} as never,
      providerConfig: {
        apiKey: "xi-test",
        voiceId: "pMsXgVXv3BLzUgSXRplE",
        modelId: "eleven_multilingual_v2",
      },
      providerOverrides: {
        voiceId: "21m00Tcm4TlvDq8ikWAM",
        modelId: "eleven_v3",
        seed: 123,
        applyTextNormalization: "on",
        languageCode: "en",
        voiceSettings: {
          speed: 1.2,
        },
      },
      timeoutMs: 1_000,
    });

    expect(result?.outputFormat).toBe("pcm_22050");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
