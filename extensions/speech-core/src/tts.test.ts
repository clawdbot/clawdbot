import { rmSync } from "node:fs";
import path from "node:path";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-types";
import type { ReplyPayload } from "openclaw/plugin-sdk/reply-payload";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "openclaw/plugin-sdk/runtime-config-snapshot";
import type {
  SpeechProviderPlugin,
  SpeechProviderPrepareSynthesisContext,
  SpeechSynthesisRequest,
  SpeechTelephonySynthesisRequest,
} from "openclaw/plugin-sdk/speech-core";
import { afterEach, describe, expect, it, vi } from "vitest";

type MockSpeechSynthesisResult = Awaited<ReturnType<SpeechProviderPlugin["synthesize"]>>;

const synthesizeMock = vi.hoisted(() =>
  vi.fn(
    async (request: SpeechSynthesisRequest): Promise<MockSpeechSynthesisResult> => ({
      audioBuffer: Buffer.from("voice"),
      fileExtension: ".ogg",
      outputFormat: "ogg",
      voiceCompatible: request.target === "voice-note",
    }),
  ),
);
const prepareSynthesisMock = vi.hoisted(() =>
  vi.fn(async (_ctx: SpeechProviderPrepareSynthesisContext) => undefined),
);

const listSpeechProvidersMock = vi.hoisted(() => vi.fn());
const getSpeechProviderMock = vi.hoisted(() => vi.fn());
const transcodeAudioBufferMock = vi.hoisted(() =>
  // Default off: most tests rely on the synthesized buffer reaching the
  // channel unchanged. Tests that exercise the pre-transcode branch override
  // per-call via `transcodeAudioBufferMock.mockResolvedValueOnce(...)`.
  // Typed as the helper's full return shape so per-call overrides aren't
  // narrowed to the default's literal.
  vi.fn<
    () => Promise<
      | { ok: true; buffer: Buffer }
      | {
          ok: false;
          reason:
            | "platform-unsupported"
            | "invalid-extension"
            | "noop-same-container"
            | "no-recipe"
            | "transcoder-failed";
          detail?: string;
        }
    >
  >(async () => ({ ok: false, reason: "platform-unsupported" })),
);

vi.mock("./audio-transcode.js", () => ({
  transcodeAudioBuffer: transcodeAudioBufferMock,
}));

vi.mock("openclaw/plugin-sdk/channel-targets", () => ({
  normalizeChannelId: (channel: string | undefined) => channel?.trim().toLowerCase() ?? null,
  resolveChannelTtsVoiceDelivery: (channel: string | undefined) => {
    const normalized = channel?.trim().toLowerCase();
    if (normalized === "bluebubbles") {
      return {
        synthesisTarget: "audio-file",
        audioFileFormats: ["mp3", "caf", "audio/mpeg", "audio/x-caf"],
        preferAudioFileFormat: "caf",
      };
    }
    if (normalized === "feishu" || normalized === "whatsapp") {
      return { synthesisTarget: "voice-note", transcodesAudio: true };
    }
    if (normalized === "discord" || normalized === "matrix" || normalized === "telegram") {
      return { synthesisTarget: "voice-note" };
    }
    return undefined;
  },
}));

vi.mock("../api.js", async () => {
  const actual = await vi.importActual<typeof import("../api.js")>("../api.js");
  const mockProvider: SpeechProviderPlugin = {
    id: "mock",
    label: "Mock",
    autoSelectOrder: 1,
    isConfigured: () => true,
    prepareSynthesis: prepareSynthesisMock,
    synthesize: synthesizeMock,
  };
  listSpeechProvidersMock.mockImplementation(() => [mockProvider]);
  getSpeechProviderMock.mockImplementation((providerId: string) =>
    providerId === "mock" ? mockProvider : null,
  );
  return {
    ...actual,
    canonicalizeSpeechProviderId: (providerId: string | undefined) =>
      providerId?.trim().toLowerCase() || undefined,
    normalizeSpeechProviderId: (providerId: string | undefined) =>
      providerId?.trim().toLowerCase() || undefined,
    getSpeechProvider: getSpeechProviderMock,
    listSpeechProviders: listSpeechProvidersMock,
    scheduleCleanup: vi.fn(),
  };
});

const {
  _test,
  getTtsPersona,
  getTtsProvider,
  maybeApplyTtsToPayload,
  resolveTtsConfig,
  synthesizeSpeech,
  textToSpeechTelephony,
} = await import("./tts.js");

const nativeVoiceNoteChannels = [
  "bluebubbles",
  "discord",
  "feishu",
  "matrix",
  "telegram",
  "whatsapp",
] as const;

function createMockSpeechProvider(
  id = "mock",
  options: Partial<SpeechProviderPlugin> = {},
): SpeechProviderPlugin {
  return {
    id,
    label: id,
    autoSelectOrder: id === "mock" ? 1 : 2,
    isConfigured: () => true,
    prepareSynthesis: prepareSynthesisMock,
    synthesize: synthesizeMock,
    ...options,
  };
}

function installSpeechProviders(providers: SpeechProviderPlugin[]): void {
  listSpeechProvidersMock.mockImplementation(() => providers);
  getSpeechProviderMock.mockImplementation(
    (providerId: string) => providers.find((provider) => provider.id === providerId) ?? null,
  );
}

function createTtsConfig(prefsName: string): OpenClawConfig {
  return {
    messages: {
      tts: {
        enabled: true,
        provider: "mock",
        prefsPath: `/tmp/${prefsName}.json`,
      },
    },
  };
}

async function expectTtsPayloadResult(params: {
  channel: string;
  prefsName: string;
  text: string;
  target: "voice-note" | "audio-file";
  audioAsVoice: true | undefined;
  providerResult?: MockSpeechSynthesisResult;
  mediaExtension?: string;
}) {
  if (params.providerResult) {
    synthesizeMock.mockResolvedValueOnce(params.providerResult);
  }
  const cfg = createTtsConfig(params.prefsName);
  let mediaDir: string | undefined;
  try {
    const result = await maybeApplyTtsToPayload({
      payload: { text: params.text },
      cfg,
      channel: params.channel,
      kind: "final",
    });

    expect(synthesizeMock).toHaveBeenCalledWith(expect.objectContaining({ target: params.target }));
    expect(result.audioAsVoice).toBe(params.audioAsVoice);
    expect(result.mediaUrl).toMatch(new RegExp(`voice-\\d+\\.${params.mediaExtension ?? "ogg"}$`));
    expect(result.spokenText).toBe(params.text);

    mediaDir = result.mediaUrl ? path.dirname(result.mediaUrl) : undefined;
  } finally {
    if (mediaDir) {
      rmSync(mediaDir, { recursive: true, force: true });
    }
  }
}

describe("speech-core native voice-note routing", () => {
  afterEach(() => {
    clearRuntimeConfigSnapshot();
    synthesizeMock.mockClear();
    prepareSynthesisMock.mockClear();
    transcodeAudioBufferMock.mockClear();
    installSpeechProviders([createMockSpeechProvider()]);
  });

  it("resolves voice delivery support from channel capabilities", () => {
    for (const channel of nativeVoiceNoteChannels) {
      expect(_test.supportsNativeVoiceNoteTts(channel)).toBe(true);
      expect(_test.supportsNativeVoiceNoteTts(channel.toUpperCase())).toBe(true);
    }
    expect(_test.supportsNativeVoiceNoteTts("slack")).toBe(false);
    expect(_test.supportsNativeVoiceNoteTts(undefined)).toBe(false);
  });

  it("marks Discord auto TTS replies as native voice messages", async () => {
    await expectTtsPayloadResult({
      channel: "discord",
      prefsName: "openclaw-speech-core-tts-test",
      text: "This Discord reply should be delivered as a native voice note.",
      target: "voice-note",
      audioAsVoice: true,
    });
  });

  it("keeps BlueBubbles synthesis on mp3 audio-file output but delivers it as a voice memo", async () => {
    await expectTtsPayloadResult({
      channel: "bluebubbles",
      prefsName: "openclaw-speech-core-tts-bluebubbles-mp3-test",
      text: "This BlueBubbles reply should be delivered as an iMessage voice memo.",
      target: "audio-file",
      audioAsVoice: true,
      mediaExtension: "mp3",
      providerResult: {
        audioBuffer: Buffer.from("mp3"),
        outputFormat: "mp3",
        fileExtension: ".mp3",
        voiceCompatible: false,
      },
    });
  });

  it("does not mark unsupported BlueBubbles audio-file output as a voice memo", async () => {
    await expectTtsPayloadResult({
      channel: "bluebubbles",
      prefsName: "openclaw-speech-core-tts-bluebubbles-ogg-test",
      text: "This BlueBubbles reply should stay a regular audio attachment.",
      target: "audio-file",
      audioAsVoice: undefined,
    });
  });

  it("pre-transcodes BlueBubbles synthesized mp3 to opus-in-CAF when the host can satisfy preferAudioFileFormat", async () => {
    transcodeAudioBufferMock.mockResolvedValueOnce({
      ok: true,
      buffer: Buffer.from("transcoded-caf"),
    });
    await expectTtsPayloadResult({
      channel: "bluebubbles",
      prefsName: "openclaw-speech-core-tts-bluebubbles-caf-transcode-test",
      text: "This BlueBubbles reply should be pre-transcoded to a native voice-memo CAF.",
      target: "audio-file",
      audioAsVoice: true,
      mediaExtension: "caf",
      providerResult: {
        audioBuffer: Buffer.from("mp3"),
        outputFormat: "mp3",
        fileExtension: ".mp3",
        voiceCompatible: false,
      },
    });
    expect(transcodeAudioBufferMock).toHaveBeenCalledWith(
      expect.objectContaining({ sourceExtension: "mp3", targetExtension: "caf" }),
    );
  });

  it("falls back to the original mp3 buffer when the host transcoder fails", async () => {
    transcodeAudioBufferMock.mockResolvedValueOnce({
      ok: false,
      reason: "transcoder-failed",
      detail: "exit-1",
    });
    // Even though the transcode failed, the original mp3 still satisfies
    // BlueBubbles' audioFileFormats list, so the channel still flips
    // audioAsVoice. The user gets the v2026.4.26 PCM-CAF behavior (a voice
    // memo bubble, possibly with bad duration) instead of a regression — and
    // the failure is logged via the call site in tts.ts so it isn't silent.
    await expectTtsPayloadResult({
      channel: "bluebubbles",
      prefsName: "openclaw-speech-core-tts-bluebubbles-caf-fallback-test",
      text: "This BlueBubbles reply should fall back to the original mp3.",
      target: "audio-file",
      audioAsVoice: true,
      mediaExtension: "mp3",
      providerResult: {
        audioBuffer: Buffer.from("mp3"),
        outputFormat: "mp3",
        fileExtension: ".mp3",
        voiceCompatible: false,
      },
    });
  });

  it("uses the active runtime snapshot when source config still contains TTS SecretRefs", async () => {
    const sourceConfig = {
      messages: {
        tts: {
          enabled: true,
          provider: "mock",
          providers: {
            mock: {
              apiKey: { source: "exec", provider: "mockexec", id: "minimax/tts/apiKey" },
            },
          },
        },
      },
    } as unknown as OpenClawConfig;
    const runtimeConfig = {
      messages: {
        tts: {
          enabled: true,
          provider: "mock",
          providers: {
            mock: {
              apiKey: "resolved-minimax-key",
            },
          },
        },
      },
    } as unknown as OpenClawConfig;
    installSpeechProviders([
      createMockSpeechProvider("mock", {
        isConfigured: ({ providerConfig }) => providerConfig.apiKey === "resolved-minimax-key",
        resolveConfig: ({ rawConfig }) => {
          const providers = rawConfig.providers as Record<string, { apiKey?: unknown }> | undefined;
          return {
            apiKey: providers?.mock?.apiKey,
          };
        },
      }),
    ]);
    setRuntimeConfigSnapshot(runtimeConfig, sourceConfig);

    const result = await synthesizeSpeech({
      text: "Runtime snapshot TTS SecretRef",
      cfg: sourceConfig,
      disableFallback: true,
    });

    expect(result.success).toBe(true);
    expect(synthesizeMock).toHaveBeenCalledWith(
      expect.objectContaining({
        cfg: runtimeConfig,
        providerConfig: expect.objectContaining({
          apiKey: "resolved-minimax-key",
        }),
      }),
    );
  });

  it.each(["feishu", "whatsapp"] as const)(
    "marks %s voice-note TTS for channel-side transcoding when provider returns mp3",
    async (channel) => {
      expect(_test.supportsTranscodedVoiceNoteTts(channel)).toBe(true);
      await expectTtsPayloadResult({
        channel,
        prefsName: `openclaw-speech-core-tts-${channel}-mp3-test`,
        text: `This ${channel} reply should be transcoded by the channel.`,
        target: "voice-note",
        audioAsVoice: true,
        mediaExtension: "mp3",
        providerResult: {
          audioBuffer: Buffer.from("mp3"),
          outputFormat: "mp3",
          fileExtension: ".mp3",
          voiceCompatible: false,
        },
      });
    },
  );

  it("keeps non-native voice-note channels as regular audio files", async () => {
    await expectTtsPayloadResult({
      channel: "slack",
      prefsName: "openclaw-speech-core-tts-slack-test",
      text: "Slack replies should be delivered as regular audio attachments.",
      target: "audio-file",
      audioAsVoice: undefined,
    });
  });

  it("synthesizes explicitly tagged short hidden TTS text", async () => {
    const cfg = createTtsConfig("openclaw-speech-core-short-hidden-tts-test");
    let mediaDir: string | undefined;
    try {
      const result = await maybeApplyTtsToPayload({
        payload: {
          text: "[[tts:text]]hello[[/tts:text]]",
          audioAsVoice: true,
        },
        cfg,
        channel: "telegram",
        kind: "final",
      });

      expect(synthesizeMock).toHaveBeenCalledWith(expect.objectContaining({ text: "hello" }));
      expect(result.mediaUrl).toMatch(/voice-\d+\.ogg$/);
      expect(result.audioAsVoice).toBe(true);
      expect(result.text).toBeUndefined();
      mediaDir = result.mediaUrl ? path.dirname(result.mediaUrl) : undefined;
    } finally {
      if (mediaDir) {
        rmSync(mediaDir, { recursive: true, force: true });
      }
    }
  });

  it("keeps skipping untagged short TTS text", async () => {
    const cfg = createTtsConfig("openclaw-speech-core-short-plain-tts-test");
    const result = await maybeApplyTtsToPayload({
      payload: {
        text: "hello",
        audioAsVoice: true,
      },
      cfg,
      channel: "telegram",
      kind: "final",
    });

    expect(synthesizeMock).not.toHaveBeenCalled();
    expect(result).toEqual({
      text: "hello",
      audioAsVoice: true,
    });
  });

  it("keeps skipping explicit tagged TTS text that strips to empty markdown", async () => {
    const cfg = createTtsConfig("openclaw-speech-core-empty-hidden-tts-test");
    const result = await maybeApplyTtsToPayload({
      payload: {
        text: "[[tts:text]]***[[/tts:text]]",
        audioAsVoice: true,
      },
      cfg,
      channel: "telegram",
      kind: "final",
    });

    expect(synthesizeMock).not.toHaveBeenCalled();
    expect(result).toEqual({
      audioAsVoice: true,
    });
  });

  it("selects persona preferred provider before config fallback", () => {
    const cfg: OpenClawConfig = {
      messages: {
        tts: {
          enabled: true,
          provider: "other",
          persona: "alfred",
          personas: {
            alfred: {
              label: "Alfred",
              provider: "mock",
              providers: {
                mock: {
                  voice: "Algieba",
                },
              },
            },
          },
        },
      },
    };
    const config = resolveTtsConfig(cfg);
    const prefsPath = "/tmp/openclaw-speech-core-persona-provider.json";

    expect(getTtsPersona(config, prefsPath)?.id).toBe("alfred");
    expect(getTtsProvider(config, prefsPath)).toBe("mock");
  });

  it("merges active persona provider binding into synthesis config", async () => {
    const cfg: OpenClawConfig = {
      messages: {
        tts: {
          enabled: true,
          provider: "mock",
          prefsPath: "/tmp/openclaw-speech-core-persona-merge.json",
          providers: {
            mock: {
              model: "base-model",
              voice: "base-voice",
            },
          },
          persona: "alfred",
          personas: {
            alfred: {
              provider: "mock",
              providers: {
                mock: {
                  voice: "persona-voice",
                  style: "dry",
                },
              },
            },
          },
        },
      },
    };

    const payload: ReplyPayload = {
      text: "This reply should use persona-specific provider configuration.",
    };

    let mediaDir: string | undefined;
    try {
      const result = await maybeApplyTtsToPayload({
        payload,
        cfg,
        channel: "slack",
        kind: "final",
      });

      expect(synthesizeMock).toHaveBeenCalledWith(
        expect.objectContaining({
          providerConfig: expect.objectContaining({
            model: "base-model",
            voice: "persona-voice",
            style: "dry",
          }),
        }),
      );
      expect(result.mediaUrl).toMatch(/voice-\d+\.ogg$/);

      mediaDir = result.mediaUrl ? path.dirname(result.mediaUrl) : undefined;
    } finally {
      if (mediaDir) {
        rmSync(mediaDir, { recursive: true, force: true });
      }
    }
  });

  it("does not mark skipped unregistered providers as missing persona bindings", async () => {
    const result = await synthesizeSpeech({
      text: "Use fallback provider.",
      cfg: {
        messages: {
          tts: {
            enabled: true,
            provider: "missing",
            persona: "alfred",
            personas: {
              alfred: {
                providers: {
                  missing: {
                    voice: "configured-but-unregistered",
                  },
                },
              },
            },
          },
        },
      },
    });

    expect(result.success).toBe(true);
    expect(result.attempts?.[0]).toMatchObject({
      provider: "missing",
      outcome: "skipped",
      reasonCode: "no_provider_registered",
      persona: "alfred",
    });
    expect(result.attempts?.[0]).not.toHaveProperty("personaBinding");
  });

  it("does not mark skipped telephony providers as missing persona bindings", async () => {
    const result = await textToSpeechTelephony({
      text: "Use telephony provider.",
      cfg: {
        messages: {
          tts: {
            enabled: true,
            provider: "mock",
            persona: "alfred",
            personas: {
              alfred: {
                providers: {
                  mock: {
                    voice: "persona-voice",
                  },
                },
              },
            },
          },
        },
      },
    });

    expect(result.success).toBe(false);
    expect(result.attempts?.[0]).toMatchObject({
      provider: "mock",
      outcome: "skipped",
      reasonCode: "unsupported_for_telephony",
      persona: "alfred",
    });
    expect(result.attempts?.[0]).not.toHaveProperty("personaBinding");
  });

  it("passes directive overrides to telephony synthesis providers", async () => {
    const synthesizeTelephony = vi.fn(async (_request: SpeechTelephonySynthesisRequest) => ({
      audioBuffer: Buffer.from("voice"),
      outputFormat: "pcm",
      sampleRate: 24000,
    }));
    installSpeechProviders([
      createMockSpeechProvider("mock", {
        synthesizeTelephony,
      }),
    ]);

    const result = await textToSpeechTelephony({
      text: "Use a directed telephony voice.",
      cfg: {
        messages: {
          tts: {
            enabled: true,
            provider: "mock",
            providers: {
              mock: {
                modelId: "telephony-model",
                voiceId: "default-voice",
              },
            },
          },
        },
      },
      overrides: {
        providerOverrides: {
          mock: {
            voice: "directed-voice",
          },
        },
      },
    });

    expect(result.success).toBe(true);
    expect(result.providerModel).toBe("telephony-model");
    expect(result.providerVoice).toBe("directed-voice");
    expect(synthesizeTelephony).toHaveBeenCalledWith(
      expect.objectContaining({
        providerOverrides: {
          voice: "directed-voice",
        },
      }),
    );
  });

  it("uses provider defaults when fallback policy allows missing persona bindings", async () => {
    await synthesizeSpeech({
      text: "Use neutral provider defaults.",
      cfg: {
        messages: {
          tts: {
            enabled: true,
            provider: "mock",
            persona: "alfred",
            personas: {
              alfred: {
                fallbackPolicy: "provider-defaults",
                prompt: {
                  profile: "A precise butler.",
                },
              },
            },
          },
        },
      },
    });

    expect(prepareSynthesisMock).toHaveBeenCalledWith(
      expect.objectContaining({
        persona: undefined,
        personaProviderConfig: undefined,
      }),
    );
  });

  it("preserves persona prompts by default when provider bindings are missing", async () => {
    await synthesizeSpeech({
      text: "Use persona prompt.",
      cfg: {
        messages: {
          tts: {
            enabled: true,
            provider: "mock",
            persona: "alfred",
            personas: {
              alfred: {
                prompt: {
                  profile: "A precise butler.",
                },
              },
            },
          },
        },
      },
    });

    expect(prepareSynthesisMock).toHaveBeenCalledWith(
      expect.objectContaining({
        persona: expect.objectContaining({ id: "alfred" }),
        personaProviderConfig: undefined,
      }),
    );
  });

  it("skips unbound providers under fail policy while allowing bound fallbacks", async () => {
    installSpeechProviders([
      createMockSpeechProvider("mock", { autoSelectOrder: 1 }),
      createMockSpeechProvider("fallback", { autoSelectOrder: 2 }),
    ]);

    const result = await synthesizeSpeech({
      text: "Use the first persona-bound provider.",
      cfg: {
        messages: {
          tts: {
            enabled: true,
            provider: "mock",
            persona: "alfred",
            personas: {
              alfred: {
                fallbackPolicy: "fail",
                providers: {
                  fallback: {
                    voice: "fallback-voice",
                  },
                },
              },
            },
          },
        },
      },
    });

    expect(result.success).toBe(true);
    expect(result.provider).toBe("fallback");
    expect(result.fallbackFrom).toBe("mock");
    expect(result.attempts?.[0]).toMatchObject({
      provider: "mock",
      outcome: "skipped",
      reasonCode: "not_configured",
      persona: "alfred",
      personaBinding: "missing",
      error: "mock: persona alfred has no provider binding",
    });
    expect(result.attempts?.[1]).toMatchObject({
      provider: "fallback",
      outcome: "success",
      persona: "alfred",
      personaBinding: "applied",
    });
  });
});

describe("speech-core per-agent TTS config", () => {
  it("deep-merges the active agent TTS override over messages.tts", () => {
    const cfg = {
      messages: {
        tts: {
          enabled: true,
          provider: "openai",
          providers: {
            openai: {
              apiKey: "${OPENAI_API_KEY}",
              voice: "coral",
              speed: 1,
            },
          },
        },
      },
      agents: {
        list: [
          {
            id: "reader",
            tts: {
              provider: "openai",
              providers: {
                openai: {
                  voice: "nova",
                },
              },
            },
          },
        ],
      },
    } satisfies OpenClawConfig;

    const resolved = resolveTtsConfig(cfg, "reader");

    expect(resolved.rawConfig).toMatchObject({
      enabled: true,
      provider: "openai",
      providers: {
        openai: {
          apiKey: "${OPENAI_API_KEY}",
          voice: "nova",
          speed: 1,
        },
      },
    });
  });

  it("composes per-agent TTS overrides with active persona bindings", async () => {
    const cfg = {
      messages: {
        tts: {
          enabled: true,
          provider: "mock",
          providers: {
            mock: {
              model: "base-model",
              voice: "base-voice",
            },
          },
          persona: "alfred",
          personas: {
            alfred: {
              provider: "mock",
              providers: {
                mock: {
                  voice: "alfred-voice",
                },
              },
            },
            jarvis: {
              provider: "mock",
              providers: {
                mock: {
                  style: "jarvis-style",
                },
              },
            },
          },
        },
      },
      agents: {
        list: [
          {
            id: "reader",
            tts: {
              persona: "jarvis",
              providers: {
                mock: {
                  voice: "agent-voice",
                },
              },
            },
          },
        ],
      },
    } satisfies OpenClawConfig;

    let mediaDir: string | undefined;
    try {
      const result = await maybeApplyTtsToPayload({
        payload: { text: "This agent reply should use the composed persona config." },
        cfg,
        channel: "slack",
        kind: "final",
        agentId: "reader",
      });

      expect(synthesizeMock).toHaveBeenCalledWith(
        expect.objectContaining({
          providerConfig: expect.objectContaining({
            model: "base-model",
            voice: "agent-voice",
            style: "jarvis-style",
          }),
        }),
      );
      expect(result.mediaUrl).toMatch(/voice-\d+\.ogg$/);
      mediaDir = result.mediaUrl ? path.dirname(result.mediaUrl) : undefined;
    } finally {
      if (mediaDir) {
        rmSync(mediaDir, { recursive: true, force: true });
      }
    }
  });

  it("ignores prototype-pollution keys in agent TTS overrides", () => {
    const cfg = {
      messages: {
        tts: {
          provider: "openai",
          providers: {
            openai: {
              voice: "coral",
            },
          },
        },
      },
      agents: {
        list: [
          {
            id: "reader",
            tts: JSON.parse(
              '{"providers":{"openai":{"voice":"nova","__proto__":{"polluted":true}}}}',
            ),
          },
        ],
      },
    } as OpenClawConfig;

    const resolved = resolveTtsConfig(cfg, "reader");

    expect(resolved.rawConfig?.providers?.openai).toEqual({ voice: "nova" });
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});
