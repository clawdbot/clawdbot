import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  invokeTalkSpeakDirect,
  type TalkSpeakTestPayload,
  withSpeechProviders,
} from "./talk.test-helpers.js";

const synthesizeSpeechMock = vi.hoisted(() =>
  vi.fn<typeof import("../tts/tts.js").synthesizeSpeech>(async () => ({
    success: true,
    audioBuffer: Buffer.from([7, 8, 9]),
    provider: "acme",
    outputFormat: "mp3",
    fileExtension: ".mp3",
    voiceCompatible: false,
  })),
);

vi.mock("../tts/tts.js", () => ({
  synthesizeSpeech: synthesizeSpeechMock,
}));

type SpeechProvider = Parameters<typeof withSpeechProviders>[0][number]["provider"];

const ALIAS_STUB_VOICE_ID = "VoiceAlias1234567890";

async function setTalkConfig(talk: Record<string, unknown>) {
  const { setRuntimeConfigSnapshot } = await import("../config/config.js");
  const config = {
    commands: {
      ownerDisplaySecret: "openclaw-test-owner-display-secret",
    },
    talk,
  };
  setRuntimeConfigSnapshot(config, config);
}

async function setAcmeTalkConfig() {
  await setTalkConfig({
    provider: "acme",
    providers: {
      acme: {
        voiceId: "plugin-voice",
      },
    },
  });
}

async function setElevenLabsTalkConfig() {
  await setTalkConfig({
    provider: "elevenlabs",
    providers: {
      elevenlabs: {
        voiceId: "stub-default-voice",
        voiceAliases: {
          Clawd: ALIAS_STUB_VOICE_ID,
        },
      },
    },
  });
}

async function setEmptyTalkConfig() {
  await setTalkConfig({});
}

async function withAcmeSpeechProvider(
  synthesize: SpeechProvider["synthesize"],
  run: () => Promise<void>,
) {
  await withSpeechProviders(
    [
      {
        pluginId: "acme-plugin",
        source: "test",
        provider: {
          id: "acme",
          label: "Acme Speech",
          isConfigured: () => true,
          synthesize,
        },
      },
    ],
    run,
  );
}

describe("gateway talk runtime", () => {
  beforeEach(() => {
    synthesizeSpeechMock.mockReset();
    synthesizeSpeechMock.mockResolvedValue({
      success: true,
      audioBuffer: Buffer.from([7, 8, 9]),
      provider: "acme",
      outputFormat: "mp3",
      fileExtension: ".mp3",
      voiceCompatible: false,
    });
  });

  it("allows extension speech providers through the talk setup", async () => {
    await setAcmeTalkConfig();

    await withSpeechProviders(
      [
        {
          pluginId: "acme-plugin",
          source: "test",
          provider: {
            id: "acme",
            label: "Acme Speech",
            isConfigured: () => true,
            resolveTalkConfig: ({ talkProviderConfig }) => ({
              ...talkProviderConfig,
              resolvedBy: "acme-test-provider",
            }),
            synthesize: async () => {
              throw new Error("synthesize should be mocked at the handler boundary");
            },
          },
        },
      ],
      async () => {
        const res = await invokeTalkSpeakDirect({
          text: "Hello from talk mode.",
        });
        expect(res?.ok, JSON.stringify(res?.error)).toBe(true);
        expect(synthesizeSpeechMock).toHaveBeenCalledWith(
          expect.objectContaining({
            text: "Hello from talk mode.",
            overrides: { provider: "acme" },
            disableFallback: true,
            cfg: expect.objectContaining({
              messages: expect.objectContaining({
                tts: expect.objectContaining({
                  provider: "acme",
                  providers: expect.objectContaining({
                    acme: expect.objectContaining({
                      resolvedBy: "acme-test-provider",
                      voiceId: "plugin-voice",
                    }),
                  }),
                }),
              }),
            }),
          }),
        );
      },
    );
  });

  it("allows extension speech providers through talk.speak", async () => {
    await setAcmeTalkConfig();

    await withAcmeSpeechProvider(
      async () => ({
        audioBuffer: Buffer.from([7, 8, 9]),
        outputFormat: "mp3",
        fileExtension: ".mp3",
        voiceCompatible: false,
      }),
      async () => {
        const res = await invokeTalkSpeakDirect({
          text: "Hello from talk mode.",
        });
        expect(res?.ok, JSON.stringify(res?.error)).toBe(true);
        expect((res?.payload as TalkSpeakTestPayload | undefined)?.provider).toBe("acme");
        expect((res?.payload as TalkSpeakTestPayload | undefined)?.audioBase64).toBe(
          Buffer.from([7, 8, 9]).toString("base64"),
        );
      },
    );
  });

  it("resolves talk voice aliases case-insensitively and forwards provider overrides", async () => {
    await setElevenLabsTalkConfig();

    await withSpeechProviders(
      [
        {
          pluginId: "elevenlabs-test",
          source: "test",
          provider: {
            id: "elevenlabs",
            label: "ElevenLabs",
            isConfigured: () => true,
            resolveTalkOverrides: ({ params }) => ({
              ...(typeof params.voiceId === "string" && params.voiceId.trim().length > 0
                ? { voiceId: params.voiceId.trim() }
                : {}),
              ...(typeof params.outputFormat === "string" && params.outputFormat.trim().length > 0
                ? { outputFormat: params.outputFormat.trim() }
                : {}),
              ...(typeof params.latencyTier === "number"
                ? { latencyTier: params.latencyTier }
                : {}),
            }),
            synthesize: async () => {
              throw new Error("synthesize should be mocked at the handler boundary");
            },
          },
        },
      ],
      async () => {
        synthesizeSpeechMock.mockResolvedValue({
          success: true,
          audioBuffer: Buffer.from([4, 5, 6]),
          provider: "elevenlabs",
          outputFormat: "pcm_44100",
          fileExtension: ".pcm",
          voiceCompatible: false,
        });

        const res = await invokeTalkSpeakDirect({
          text: "Hello from talk mode.",
          voiceId: "clawd",
          outputFormat: "pcm_44100",
          latencyTier: 3,
        });

        expect(res?.ok, JSON.stringify(res?.error)).toBe(true);
        expect((res?.payload as TalkSpeakTestPayload | undefined)?.provider).toBe("elevenlabs");
        expect((res?.payload as TalkSpeakTestPayload | undefined)?.outputFormat).toBe("pcm_44100");
        expect((res?.payload as TalkSpeakTestPayload | undefined)?.audioBase64).toBe(
          Buffer.from([4, 5, 6]).toString("base64"),
        );
        expect(synthesizeSpeechMock).toHaveBeenCalledWith(
          expect.objectContaining({
            text: "Hello from talk mode.",
            overrides: {
              provider: "elevenlabs",
              providerOverrides: {
                elevenlabs: {
                  voiceId: ALIAS_STUB_VOICE_ID,
                  outputFormat: "pcm_44100",
                  latencyTier: 3,
                },
              },
            },
            disableFallback: true,
          }),
        );
      },
    );
  });

  it("returns fallback-eligible details when talk provider is not configured", async () => {
    await setEmptyTalkConfig();

    const res = await invokeTalkSpeakDirect({ text: "Hello from talk mode." });
    expect(res?.ok).toBe(false);
    expect(res?.error?.message).toContain("talk provider not configured");
    expect((res?.error as { details?: unknown } | undefined)?.details).toEqual({
      reason: "talk_unconfigured",
      fallbackEligible: true,
    });
  });

  it("returns synthesis_failed details when the provider rejects synthesis", async () => {
    await setAcmeTalkConfig();

    await withAcmeSpeechProvider(
      async () => ({}) as never,
      async () => {
        synthesizeSpeechMock.mockResolvedValue({
          success: false,
          error: "provider failed",
        });
        const res = await invokeTalkSpeakDirect({ text: "Hello from talk mode." });
        expect(res?.ok).toBe(false);
        expect(res?.error?.details).toEqual({
          reason: "synthesis_failed",
          fallbackEligible: false,
        });
      },
    );
  });

  it("rejects empty audio results as invalid_audio_result", async () => {
    await setAcmeTalkConfig();

    await withAcmeSpeechProvider(
      async () => ({}) as never,
      async () => {
        synthesizeSpeechMock.mockResolvedValue({
          success: true,
          audioBuffer: Buffer.alloc(0),
          provider: "acme",
          outputFormat: "mp3",
          fileExtension: ".mp3",
          voiceCompatible: false,
        });
        const res = await invokeTalkSpeakDirect({ text: "Hello from talk mode." });
        expect(res?.ok).toBe(false);
        expect(res?.error?.details).toEqual({
          reason: "invalid_audio_result",
          fallbackEligible: false,
        });
      },
    );
  });
});
