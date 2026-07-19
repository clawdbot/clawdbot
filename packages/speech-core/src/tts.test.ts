// Speech Core tests cover tts behavior.
import { realpathSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { OpenClawConfig, TtsConfig } from "openclaw/plugin-sdk/config-contracts";
import { MAX_TIMER_TIMEOUT_MS } from "openclaw/plugin-sdk/number-runtime";
import type { ReplyPayload } from "openclaw/plugin-sdk/reply-payload";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "openclaw/plugin-sdk/runtime-config-snapshot";
import type {
  SpeechListVoicesRequest,
  SpeechProviderPlugin,
  SpeechProviderPrepareSynthesisContext,
  SpeechSynthesisRequest,
  SpeechTelephonySynthesisRequest,
} from "openclaw/plugin-sdk/speech-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CODE_HEAVY_SPOKEN_FALLBACK } from "./speech-text.js";

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

vi.mock("openclaw/plugin-sdk/media-runtime", () => ({
  transcodeAudioBuffer: transcodeAudioBufferMock,
}));

vi.mock("openclaw/plugin-sdk/channel-targets", () => ({
  normalizeChannelId: (channel: string | undefined) => channel?.trim().toLowerCase() ?? null,
  resolveChannelTtsVoiceDelivery: (channel: string | undefined) => {
    const normalized = channel?.trim().toLowerCase();
    if (normalized === "voice-memo-chat") {
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

vi.mock("openclaw/plugin-sdk/speech-core", async () => {
  const actual = await vi.importActual("openclaw/plugin-sdk/speech-core");
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
  testApi,
  buildTtsSystemPromptHint,
  getTtsPersona,
  getTtsProvider,
  isTtsProviderConfigured,
  listSpeechVoices,
  maybeApplyTtsToPayload,
  prepareTtsRequest,
  resolveTtsConfig,
  setSummarizationEnabled,
  setTtsMaxLength,
  synthesizeSpeech,
  textToSpeech,
  textToSpeechTelephony,
} = await import("../runtime-api.js");

const nativeVoiceNoteChannels = ["discord", "feishu", "matrix", "telegram", "whatsapp"] as const;

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

// macOS os.tmpdir() is a /var -> /private/var symlink and fs-safe rejects
// symlinked store roots; resolve the canonical dir before writing prefs.
const PREFS_TMP_DIR = realpathSync(os.tmpdir());

function prefsPathFor(prefsName: string): string {
  return path.join(PREFS_TMP_DIR, `${prefsName}.json`);
}

function createTtsConfig(prefsName: string): OpenClawConfig {
  return {
    messages: {
      tts: {
        enabled: true,
        provider: "mock",
        prefsPath: prefsPathFor(prefsName),
      },
    },
  };
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`expected ${label} to be a record`);
  }
  return value as Record<string, unknown>;
}

function requireFirstCallParam(calls: ReadonlyArray<readonly unknown[]>, label: string) {
  const call = calls[0];
  if (!call) {
    throw new Error(`expected ${label} call`);
  }
  return call[0];
}

function requireFirstSynthesisRequest(label: string): Record<string, unknown> {
  return requireRecord(requireFirstCallParam(synthesizeMock.mock.calls, label), label);
}

function requireAttempt(attempts: unknown[] | undefined, index: number) {
  if (!attempts) {
    throw new Error("expected synthesis attempts");
  }
  return requireRecord(attempts[index], `synthesis attempt ${index}`);
}

async function expectTtsPayloadResult(params: {
  channel: string;
  prefsName: string;
  text: string;
  target: "voice-note" | "audio-file";
  audioAsVoice: true | undefined;
  providerResult?: MockSpeechSynthesisResult;
  mediaExtension?: string;
  kind?: "tool" | "block" | "final";
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
      kind: params.kind ?? "final",
    });

    expect(synthesizeMock).toHaveBeenCalled();
    const request = requireRecord(
      synthesizeMock.mock.calls.at(-1)?.[0],
      "latest synthesis request",
    );
    expect(request.target).toBe(params.target);
    expect(result.audioAsVoice).toBe(params.audioAsVoice);
    expect(result.mediaUrl).toMatch(new RegExp(`voice-\\d+\\.${params.mediaExtension ?? "ogg"}$`));
    expect(result.spokenText).toBe(params.text);
    expect(result.ttsSupplement).toEqual({ spokenText: params.text });
    expect((result as { trustedLocalMedia?: boolean }).trustedLocalMedia).toBe(true);

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
    delete (Object.prototype as Record<string, unknown>).polluted;
    synthesizeMock.mockClear();
    prepareSynthesisMock.mockClear();
    transcodeAudioBufferMock.mockClear();
    installSpeechProviders([createMockSpeechProvider()]);
  });

  it("resolves voice delivery support from channel capabilities", () => {
    for (const channel of nativeVoiceNoteChannels) {
      expect(testApi.supportsNativeVoiceNoteTts(channel)).toBe(true);
      expect(testApi.supportsNativeVoiceNoteTts(channel.toUpperCase())).toBe(true);
    }
    expect(testApi.supportsNativeVoiceNoteTts("slack")).toBe(false);
    expect(testApi.supportsNativeVoiceNoteTts(undefined)).toBe(false);
  });

  it("tells generic TTS guidance to defer to MEMORY voice-delivery instructions", () => {
    const hint = buildTtsSystemPromptHint(createTtsConfig("openclaw-speech-core-tts-hint-test"));

    expect(hint).toContain("Voice (TTS) is enabled.");
    expect(hint).toContain(
      "If workspace context (especially MEMORY.md) tells you not to use [[tts:...]] or to use a local/non-tagged voice workflow, follow that workspace instruction instead.",
    );
    expect(hint).toContain(
      "Use [[tts:...]] and optional [[tts:text]]...[[/tts:text]] to control voice/expressiveness.",
    );
  });

  it("prepares deep-merged surface config and directive inputs", () => {
    const cfg: OpenClawConfig = {
      messages: {
        tts: {
          provider: "mock",
          modelOverrides: { allowProvider: false },
          providers: {
            mock: {
              model: "base-model",
              voiceSettings: { stability: 0.4 },
            },
          },
        },
      },
    };

    const prepared = prepareTtsRequest({
      cfg,
      override: {
        modelOverrides: { allowProvider: true },
        providers: {
          mock: {
            voice: "surface-voice",
            voiceSettings: { speed: 1.1 },
          },
        },
      },
      text: "Hello [[tts:text]]Speak this instead[[/tts:text]] caller",
    });

    expect(prepared.cfg).not.toBe(cfg);
    expect(prepared.cfg.messages?.tts?.providers?.mock).toEqual({
      model: "base-model",
      voice: "surface-voice",
      voiceSettings: { stability: 0.4, speed: 1.1 },
    });
    expect(prepared.cfg.messages?.tts?.modelOverrides?.allowProvider).toBe(true);
    expect(prepared.directives).toEqual({
      cleanedText: "Hello  caller",
      hasDirective: true,
      overrides: {
        ttsText: "Speak this instead",
      },
      ttsText: "Speak this instead",
      warnings: [],
    });
    expect(cfg.messages?.tts?.providers?.mock).toEqual({
      model: "base-model",
      voiceSettings: { stability: 0.4 },
    });
  });

  it("sanitizes blocked override keys while preparing TTS config", () => {
    const prepared = prepareTtsRequest({
      cfg: {
        messages: {
          tts: {
            provider: "mock",
            providers: { mock: { model: "base-model" } },
          },
        },
      },
      override: JSON.parse(
        '{"__proto__":{"polluted":"top"},"providers":{"mock":{"voice":"safe","__proto__":{"polluted":"nested"}}}}',
      ) as TtsConfig,
      text: "[[tts:text]]Speak this instead[[/tts:text]]",
    });

    expect((Object.prototype as Record<string, unknown>).polluted).toBeUndefined();
    expect(prepared.cfg.messages?.tts).not.toHaveProperty("polluted");
    expect(prepared.cfg.messages?.tts?.providers?.mock).toEqual({
      model: "base-model",
      voice: "safe",
    });
    expect(prepared.directives.cleanedText).toBe("");
    expect(prepared.directives.ttsText).toBe("Speak this instead");
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

  it("keeps compatible audio-file synthesis deliverable as a voice memo", async () => {
    await expectTtsPayloadResult({
      channel: "voice-memo-chat",
      prefsName: "openclaw-speech-core-tts-voice-memo-mp3-test",
      text: "This reply should be delivered as a native voice memo.",
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

  it("does not mark unsupported audio-file output as a voice memo", async () => {
    await expectTtsPayloadResult({
      channel: "voice-memo-chat",
      prefsName: "openclaw-speech-core-tts-voice-memo-ogg-test",
      text: "This reply should stay a regular audio attachment.",
      target: "audio-file",
      audioAsVoice: undefined,
    });
  });

  it("pre-transcodes synthesized mp3 to opus-in-CAF when the host can satisfy preferAudioFileFormat", async () => {
    transcodeAudioBufferMock.mockResolvedValueOnce({
      ok: true,
      buffer: Buffer.from("transcoded-caf"),
    });
    await expectTtsPayloadResult({
      channel: "voice-memo-chat",
      prefsName: "openclaw-speech-core-tts-voice-memo-caf-transcode-test",
      text: "This reply should be pre-transcoded to a native voice-memo CAF.",
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
    expect(transcodeAudioBufferMock).toHaveBeenCalledOnce();
    const transcodeRequest = requireRecord(
      requireFirstCallParam(transcodeAudioBufferMock.mock.calls as unknown[][], "transcode"),
      "transcode request",
    );
    expect(transcodeRequest.sourceExtension).toBe("mp3");
    expect(transcodeRequest.targetExtension).toBe("caf");
  });

  it("falls back to the original mp3 buffer when the host transcoder fails", async () => {
    transcodeAudioBufferMock.mockResolvedValueOnce({
      ok: false,
      reason: "transcoder-failed",
      detail: "exit-1",
    });
    // Even though the transcode failed, the original mp3 still satisfies the
    // channel audioFileFormats list, so the channel still flips audioAsVoice.
    // The user gets a voice memo bubble, possibly with bad duration, instead
    // of a regression. The failure is logged via the call site in tts.ts.
    await expectTtsPayloadResult({
      channel: "voice-memo-chat",
      prefsName: "openclaw-speech-core-tts-voice-memo-caf-fallback-test",
      text: "This reply should fall back to the original mp3.",
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
    expect(synthesizeMock).toHaveBeenCalled();
    const request = requireFirstSynthesisRequest("runtime snapshot synthesis request");
    expect(request.cfg).toBe(runtimeConfig);
    const providerConfig = requireRecord(request.providerConfig, "provider config");
    expect(providerConfig.apiKey).toBe("resolved-minimax-key");
  });

  it("uses provider default TTS timeout when the call and config omit timeoutMs", async () => {
    installSpeechProviders([createMockSpeechProvider("mock", { defaultTimeoutMs: 600_000 })]);

    const result = await synthesizeSpeech({
      text: "Use provider timeout.",
      cfg: {
        messages: {
          tts: {
            enabled: true,
            provider: "mock",
          },
        },
      } as OpenClawConfig,
      disableFallback: true,
    });

    expect(result.success).toBe(true);
    const request = requireFirstSynthesisRequest("provider default timeout synthesis request");
    expect(request.timeoutMs).toBe(600_000);
  });

  it("normalizes non-streaming synthesis text before calling the provider", async () => {
    const result = await synthesizeSpeech({
      text: "## Update\n\nRead the [guide](https://example.com/guide)!!!!!",
      cfg: createTtsConfig("openclaw-speech-core-talk-markdown-test"),
      disableFallback: true,
    });

    expect(result.success).toBe(true);
    const request = requireFirstSynthesisRequest("normalized talk synthesis request");
    expect(request.text).toBe("Update\n\nRead the guide!");
  });

  it("speaks stripped code through the explicit textToSpeech conversion path", async () => {
    let mediaDir: string | undefined;
    try {
      const result = await textToSpeech({
        text: "```ts\nconst answer = 42;\n```",
        cfg: createTtsConfig("openclaw-speech-core-code-convert-test"),
      });

      expect(result.success).toBe(true);
      const request = requireFirstSynthesisRequest("explicit code conversion request");
      expect(request.text).toBe("const answer = 42;");
      expect(request.text).not.toBe(CODE_HEAVY_SPOKEN_FALLBACK);
      mediaDir = result.audioPath ? path.dirname(result.audioPath) : undefined;
    } finally {
      if (mediaDir) {
        rmSync(mediaDir, { recursive: true, force: true });
      }
    }
  });

  it("resolves the configured timeout for voice listing", async () => {
    const listVoicesMock = vi.fn(async (_request: SpeechListVoicesRequest) => []);
    installSpeechProviders([
      createMockSpeechProvider("mock", {
        defaultTimeoutMs: 60_000,
        listVoices: listVoicesMock,
      }),
    ]);

    await listSpeechVoices({
      provider: "mock",
      cfg: {
        messages: {
          tts: {
            enabled: true,
            provider: "mock",
            timeoutMs: 45_000,
          },
        },
      } as OpenClawConfig,
    });

    expect(listVoicesMock).toHaveBeenCalledWith(expect.objectContaining({ timeoutMs: 45_000 }));
  });

  it("caps oversized provider default TTS timeouts before synthesis", async () => {
    installSpeechProviders([
      createMockSpeechProvider("mock", { defaultTimeoutMs: Number.MAX_SAFE_INTEGER }),
    ]);

    const result = await synthesizeSpeech({
      text: "Use capped provider timeout.",
      cfg: {
        messages: {
          tts: {
            enabled: true,
            provider: "mock",
          },
        },
      } as OpenClawConfig,
      disableFallback: true,
    });

    expect(result.success).toBe(true);
    const request = requireFirstSynthesisRequest("provider default capped timeout request");
    expect(request.timeoutMs).toBe(MAX_TIMER_TIMEOUT_MS);
  });

  it("ignores nonpositive provider default TTS timeouts", async () => {
    installSpeechProviders([createMockSpeechProvider("mock", { defaultTimeoutMs: 0 })]);

    const result = await synthesizeSpeech({
      text: "Use fallback timeout.",
      cfg: {
        messages: {
          tts: {
            enabled: true,
            provider: "mock",
          },
        },
      } as OpenClawConfig,
      disableFallback: true,
    });

    expect(result.success).toBe(true);
    const request = requireFirstSynthesisRequest("provider default fallback timeout request");
    expect(request.timeoutMs).toBe(30_000);
  });

  it("keeps explicit TTS config timeout ahead of provider default timeout", async () => {
    installSpeechProviders([createMockSpeechProvider("mock", { defaultTimeoutMs: 600_000 })]);

    await synthesizeSpeech({
      text: "Use configured timeout.",
      cfg: {
        messages: {
          tts: {
            enabled: true,
            provider: "mock",
            timeoutMs: 45_000,
          },
        },
      } as OpenClawConfig,
      disableFallback: true,
    });

    const request = requireFirstSynthesisRequest("configured timeout synthesis request");
    expect(request.timeoutMs).toBe(45_000);
  });

  it("caps oversized voice model TTS timeouts before synthesis", async () => {
    installSpeechProviders([
      createMockSpeechProvider("mock", { autoSelectOrder: 1, models: ["mock-tts"] }),
    ]);

    const result = await synthesizeSpeech({
      text: "Use capped explicit timeout.",
      cfg: {
        agents: {
          defaults: {
            voiceModel: { primary: "mock/mock-tts", timeoutMs: Number.MAX_SAFE_INTEGER },
          },
        },
        messages: {
          tts: {
            enabled: true,
            provider: "mock",
          },
        },
      } as OpenClawConfig,
      disableFallback: true,
    });

    expect(result.success).toBe(true);
    const request = requireFirstSynthesisRequest("voice model capped timeout request");
    expect(request.timeoutMs).toBe(MAX_TIMER_TIMEOUT_MS);
  });

  it("uses agents.defaults.voiceModel as the default speech provider and model", async () => {
    installSpeechProviders([
      createMockSpeechProvider("mock", { autoSelectOrder: 1 }),
      createMockSpeechProvider("openai", {
        autoSelectOrder: 10,
        models: ["gpt-4o-mini-tts"],
        resolveConfig: ({ rawConfig }) => {
          const providers = requireRecord(rawConfig.providers, "raw provider configs");
          return {
            model: "provider-default-model",
            modelId: "provider-default-model",
            ...requireRecord(providers.openai, "raw openai provider config"),
          };
        },
      }),
    ]);

    const result = await synthesizeSpeech({
      text: "Use configured voice model.",
      cfg: {
        agents: {
          defaults: {
            voiceModel: { primary: "openai/gpt-4o-mini-tts", timeoutMs: 12_345 },
          },
        },
        messages: {
          tts: {
            enabled: true,
            prefsPath: "/tmp/openclaw-speech-core-voice-model-default-test.json",
          },
        },
      } as OpenClawConfig,
      disableFallback: true,
    });

    expect(result.success).toBe(true);
    expect(result.provider).toBe("openai");
    expect(result.providerModel).toBe("gpt-4o-mini-tts");
    const request = requireFirstSynthesisRequest("voice model synthesis request");
    expect(request.providerConfig).toMatchObject({
      model: "gpt-4o-mini-tts",
      modelId: "gpt-4o-mini-tts",
    });
    expect(request.timeoutMs).toBe(12_345);
  });

  it("keeps explicit provider model aliases ahead of voiceModel defaults", async () => {
    installSpeechProviders([
      createMockSpeechProvider("openrouter", {
        models: ["explicit-model", "default-model"],
        resolveConfig: ({ rawConfig }) => {
          const providers = requireRecord(rawConfig.providers, "raw provider configs");
          return requireRecord(providers.openrouter, "raw openrouter provider config");
        },
      }),
    ]);

    const result = await synthesizeSpeech({
      text: "Prefer explicit model alias.",
      cfg: {
        agents: {
          defaults: {
            voiceModel: { primary: "openrouter/default-model" },
          },
        },
        messages: {
          tts: {
            enabled: true,
            provider: "openrouter",
            prefsPath: "/tmp/openclaw-speech-core-explicit-model-alias-test.json",
            providers: {
              openrouter: {
                modelId: "explicit-model",
              },
            },
          },
        },
      } as OpenClawConfig,
      disableFallback: true,
    });

    expect(result.success).toBe(true);
    const request = requireFirstSynthesisRequest("explicit model alias synthesis request");
    const providerConfig = requireRecord(request.providerConfig, "provider config");
    expect(providerConfig).toMatchObject({
      modelId: "explicit-model",
    });
    expect(providerConfig.model).toBeUndefined();
  });

  it("tries voiceModel fallbacks before auto-selected speech providers", async () => {
    installSpeechProviders([
      createMockSpeechProvider("mock", { autoSelectOrder: 1 }),
      createMockSpeechProvider("openai", {
        autoSelectOrder: 10,
        models: ["gpt-4o-mini-tts"],
        isConfigured: () => false,
      }),
      createMockSpeechProvider("elevenlabs", {
        autoSelectOrder: 99,
        models: ["eleven_multilingual_v2"],
      }),
    ]);

    const result = await synthesizeSpeech({
      text: "Use configured voice model fallback.",
      cfg: {
        agents: {
          defaults: {
            voiceModel: {
              primary: "openai/gpt-4o-mini-tts",
              fallbacks: ["elevenlabs/eleven_multilingual_v2"],
            },
          },
        },
        messages: {
          tts: {
            enabled: true,
            prefsPath: "/tmp/openclaw-speech-core-voice-model-fallback-test.json",
          },
        },
      } as OpenClawConfig,
    });

    expect(result.success).toBe(true);
    expect(result.provider).toBe("elevenlabs");
    expect(result.fallbackFrom).toBe("openai");
    expect(result.providerModel).toBe("eleven_multilingual_v2");
  });

  it("tries same-provider voiceModel fallbacks as separate model attempts", async () => {
    const synthesize = vi.fn(async (request: SpeechSynthesisRequest) => {
      if (request.providerConfig.model === "bad-tts") {
        throw new Error("unavailable model");
      }
      return {
        audioBuffer: Buffer.from("voice"),
        fileExtension: ".ogg",
        outputFormat: "ogg",
        voiceCompatible: request.target === "voice-note",
      };
    });
    installSpeechProviders([
      createMockSpeechProvider("openai", {
        autoSelectOrder: 10,
        models: ["bad-tts", "good-tts"],
        synthesize,
      }),
    ]);

    const result = await synthesizeSpeech({
      text: "Use same-provider fallback model.",
      cfg: {
        agents: {
          defaults: {
            voiceModel: {
              primary: "openai/bad-tts",
              fallbacks: ["openai/good-tts"],
            },
          },
        },
        messages: {
          tts: {
            enabled: true,
            prefsPath: "/tmp/openclaw-speech-core-same-provider-voice-model-fallback-test.json",
          },
        },
      } as OpenClawConfig,
    });

    expect(result.success).toBe(true);
    expect(result.provider).toBe("openai");
    expect(result.providerModel).toBe("good-tts");
    expect(result.attemptedProviders).toEqual(["openai", "openai"]);
    expect(synthesize.mock.calls.map(([request]) => request.providerConfig.model)).toEqual([
      "bad-tts",
      "good-tts",
    ]);
  });

  it("ignores voiceModel refs that are not speech models", async () => {
    installSpeechProviders([
      createMockSpeechProvider("openai", {
        autoSelectOrder: 10,
        defaultModel: "gpt-4o-mini-tts",
        models: ["gpt-4o-mini-tts"],
        resolveConfig: ({ rawConfig }) => {
          const providers = requireRecord(rawConfig.providers, "raw provider configs");
          return {
            model: "gpt-4o-mini-tts",
            modelId: "gpt-4o-mini-tts",
            ...requireRecord(providers.openai, "raw openai provider config"),
          };
        },
      }),
    ]);

    const result = await synthesizeSpeech({
      text: "Use speech provider default for unsupported realtime model.",
      cfg: {
        agents: {
          defaults: {
            voiceModel: { primary: "openai/gpt-realtime-2" },
          },
        },
        messages: {
          tts: {
            enabled: true,
            provider: "openai",
            prefsPath: "/tmp/openclaw-speech-core-realtime-voice-model-ignored-test.json",
          },
        },
      } as OpenClawConfig,
      disableFallback: true,
    });

    expect(result.success).toBe(true);
    expect(result.provider).toBe("openai");
    expect(result.providerModel).toBe("gpt-4o-mini-tts");
    const request = requireFirstSynthesisRequest("speech model fallback request");
    expect(request.providerConfig).toMatchObject({
      model: "gpt-4o-mini-tts",
      modelId: "gpt-4o-mini-tts",
    });
  });

  it("uses the first speech-supported voiceModel fallback as the default provider", async () => {
    installSpeechProviders([
      createMockSpeechProvider("openai", {
        autoSelectOrder: 1,
        models: ["gpt-4o-mini-tts"],
      }),
      createMockSpeechProvider("elevenlabs", {
        autoSelectOrder: 99,
        models: ["eleven_multilingual_v2"],
      }),
    ]);

    const result = await synthesizeSpeech({
      text: "Use first speech-supported voice model.",
      cfg: {
        agents: {
          defaults: {
            voiceModel: {
              primary: "openai/gpt-realtime-2",
              fallbacks: ["elevenlabs/eleven_multilingual_v2"],
            },
          },
        },
        messages: {
          tts: {
            enabled: true,
            prefsPath: "/tmp/openclaw-speech-core-supported-voice-model-provider-test.json",
          },
        },
      } as OpenClawConfig,
    });

    expect(result.success).toBe(true);
    expect(result.provider).toBe("elevenlabs");
    expect(result.providerModel).toBe("eleven_multilingual_v2");
    expect(result.attemptedProviders).toEqual(["elevenlabs"]);
  });

  it("maps speakerVoice provider config to provider-compatible voice fields", async () => {
    const result = await synthesizeSpeech({
      text: "Use the configured speaker.",
      cfg: {
        messages: {
          tts: {
            enabled: true,
            provider: "mock",
            providers: {
              mock: {
                speakerVoice: "cedar",
                speakerVoiceId: "voice-123",
                voice: "legacy-voice",
                voiceName: "legacy-name",
                voiceId: "legacy-id",
              },
            },
          },
        },
      } as OpenClawConfig,
      disableFallback: true,
    });

    expect(result.success).toBe(true);
    expect(result.providerVoice).toBe("voice-123");
    const request = requireFirstSynthesisRequest("speaker voice synthesis request");
    expect(request.providerConfig).toMatchObject({
      speakerVoice: "cedar",
      voice: "cedar",
      voiceName: "cedar",
      speakerVoiceId: "voice-123",
      voiceId: "voice-123",
    });
  });

  it("preserves alias-keyed provider config when resolving canonical providers", async () => {
    installSpeechProviders([
      createMockSpeechProvider("xiaomi", {
        aliases: ["mimo"],
        resolveConfig: ({ rawConfig }) => {
          const providers = requireRecord(rawConfig.providers, "raw provider configs");
          return requireRecord(providers.xiaomi ?? providers.mimo, "raw xiaomi provider config");
        },
      }),
    ]);

    const result = await synthesizeSpeech({
      text: "Use alias provider config.",
      cfg: {
        messages: {
          tts: {
            enabled: true,
            provider: "xiaomi",
            providers: {
              mimo: { apiKey: "mimo-key" },
            },
          },
        },
      } as OpenClawConfig,
      disableFallback: true,
    });

    expect(result.success).toBe(true);
    const request = requireFirstSynthesisRequest("alias provider synthesis request");
    expect(request.providerConfig).toMatchObject({ apiKey: "mimo-key" });
  });

  it("maps speakerVoice persona provider config to provider-compatible voice fields", async () => {
    const result = await synthesizeSpeech({
      text: "Use the persona speaker.",
      cfg: {
        messages: {
          tts: {
            enabled: true,
            provider: "mock",
            persona: "narrator",
            personas: {
              narrator: {
                providers: {
                  mock: {
                    speakerVoice: "marin",
                  },
                },
              },
            },
          },
        },
      } as OpenClawConfig,
      disableFallback: true,
    });

    expect(result.success).toBe(true);
    expect(result.providerVoice).toBe("marin");
    const request = requireFirstSynthesisRequest("persona speaker voice synthesis request");
    expect(request.providerConfig).toMatchObject({
      speakerVoice: "marin",
      voice: "marin",
      voiceName: "marin",
    });
  });

  it.each(["feishu", "whatsapp"] as const)(
    "marks %s voice-note TTS for channel-side transcoding when provider returns mp3",
    async (channel) => {
      expect(testApi.supportsTranscodedVoiceNoteTts(channel)).toBe(true);
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

  it("normalizes voice-note Markdown once before synthesis", async () => {
    const text =
      'This short explanation keeps the fenced literal below from becoming code-heavy.\n\n```md\nconst literal = "[x](y)";\n```';
    let mediaDir: string | undefined;
    try {
      const result = await maybeApplyTtsToPayload({
        payload: { text },
        cfg: createTtsConfig("openclaw-speech-core-once-normalized-markdown-test"),
        channel: "telegram",
        kind: "final",
      });

      const request = requireFirstSynthesisRequest("once-normalized voice-note synthesis request");
      expect(request.text).toBe(
        'This short explanation keeps the fenced literal below from becoming code-heavy.\n\nconst literal = "[x](y)";',
      );
      expect(result.text).toBe(text);
      mediaDir = result.mediaUrl ? path.dirname(result.mediaUrl) : undefined;
    } finally {
      if (mediaDir) {
        rmSync(mediaDir, { recursive: true, force: true });
      }
    }
  });

  it("skips channel auto-TTS audio for code-heavy replies", async () => {
    const text = "```ts\nexport function answer() {\n  return 42;\n}\n```";
    const result = await maybeApplyTtsToPayload({
      payload: { text },
      cfg: createTtsConfig("openclaw-speech-core-code-heavy-voice-note-test"),
      channel: "telegram",
      kind: "final",
    });

    expect(synthesizeMock).not.toHaveBeenCalled();
    expect(result).toEqual({ text });
  });

  it("synthesizes code-heavy explicitly tagged hidden TTS text", async () => {
    const cfg = createTtsConfig("openclaw-speech-core-code-heavy-hidden-tts-test");
    let mediaDir: string | undefined;
    try {
      const result = await maybeApplyTtsToPayload({
        payload: {
          text: '[[tts:text]]```ts\nconst detailedAnswer = "this code should still be spoken";\n```[[/tts:text]]',
          audioAsVoice: true,
        },
        cfg,
        channel: "telegram",
        kind: "final",
      });

      expect(synthesizeMock).toHaveBeenCalled();
      const request = requireFirstSynthesisRequest("code-heavy hidden TTS request");
      expect(request.text).toBe('const detailedAnswer = "this code should still be spoken";');
      expect(result.text).toBeUndefined();
      mediaDir = result.mediaUrl ? path.dirname(result.mediaUrl) : undefined;
    } finally {
      if (mediaDir) {
        rmSync(mediaDir, { recursive: true, force: true });
      }
    }
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

      expect(synthesizeMock).toHaveBeenCalled();
      const request = requireFirstSynthesisRequest("hidden TTS request");
      expect(request.text).toBe("hello");
      expect(result.mediaUrl).toMatch(/voice-\d+\.ogg$/);
      expect(result.audioAsVoice).toBe(true);
      expect(result.text).toBeUndefined();
      expect(result.ttsSupplement).toBeUndefined();
      mediaDir = result.mediaUrl ? path.dirname(result.mediaUrl) : undefined;
    } finally {
      if (mediaDir) {
        rmSync(mediaDir, { recursive: true, force: true });
      }
    }
  });

  it("truncates long TTS text on a UTF-16 boundary", async () => {
    const prefsName = "openclaw-speech-core-utf16-truncate-test";
    const prefsPath = prefsPathFor(prefsName);
    const cfg = createTtsConfig(prefsName);
    setTtsMaxLength(prefsPath, 11);
    setSummarizationEnabled(prefsPath, false);
    let mediaDir: string | undefined;
    try {
      const result = await maybeApplyTtsToPayload({
        payload: { text: `${"a".repeat(7)}😀tail long enough for TTS` },
        cfg,
        channel: "telegram",
        kind: "final",
      });

      expect(synthesizeMock).toHaveBeenCalled();
      const request = requireFirstSynthesisRequest("utf16 truncated TTS request");
      const spokenText = String(request.text);
      expect(spokenText).toBe(`${"a".repeat(7)}...`);
      expect(result.spokenText).toBe(spokenText);
      mediaDir = result.mediaUrl ? path.dirname(result.mediaUrl) : undefined;
    } finally {
      rmSync(prefsPath, { force: true });
      if (mediaDir) {
        rmSync(mediaDir, { recursive: true, force: true });
      }
    }
  });

  it("skips block delivery kind in final mode (accumulated final tail synthesizes instead)", async () => {
    synthesizeMock.mockClear();
    const cfg = createTtsConfig("openclaw-speech-core-block-kind-tts-test");
    const result = await maybeApplyTtsToPayload({
      payload: { text: "WebChat block stream chunks defer TTS to the final tail." },
      cfg,
      channel: "webchat",
      kind: "block",
    });

    expect(synthesizeMock).not.toHaveBeenCalled();
    expect((result as { trustedLocalMedia?: boolean }).trustedLocalMedia).toBeUndefined();
    expect(result.text).toBe("WebChat block stream chunks defer TTS to the final tail.");
  });

  it("skips tool delivery kind in final mode", async () => {
    synthesizeMock.mockClear();
    const cfg = createTtsConfig("openclaw-speech-core-tool-kind-tts-test");
    const result = await maybeApplyTtsToPayload({
      payload: { text: "Intermediate tool output should not be spoken." },
      cfg,
      channel: "webchat",
      kind: "tool",
    });

    expect(synthesizeMock).not.toHaveBeenCalled();
    expect((result as { trustedLocalMedia?: boolean }).trustedLocalMedia).toBeUndefined();
    expect(result.text).toBe("Intermediate tool output should not be spoken.");
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

  it("skips auto TTS for legacy final media directives", async () => {
    synthesizeMock.mockClear();
    const cfg = createTtsConfig("openclaw-speech-core-media-directive-tts-test");
    const result = await maybeApplyTtsToPayload({
      payload: { text: "Here is the render.\nMEDIA:/tmp/render.png" },
      cfg,
      channel: "telegram",
      kind: "final",
    });

    expect(synthesizeMock).not.toHaveBeenCalled();
    expect(result).toEqual({ text: "Here is the render.\nMEDIA:/tmp/render.png" });
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

  it("treats provider configuration errors as unconfigured", () => {
    installSpeechProviders([
      createMockSpeechProvider("broken", {
        resolveConfig: () => {
          throw new Error("invalid provider URL");
        },
      }),
    ]);
    const cfg = {
      messages: {
        tts: {
          providers: { broken: {} },
          prefsPath: "/tmp/openclaw-speech-core-invalid-provider.json",
        },
      },
    } as OpenClawConfig;
    const config = resolveTtsConfig(cfg);

    expect(isTtsProviderConfigured(config, "broken", cfg)).toBe(false);
    expect(getTtsProvider(config, config.prefsPath ?? "")).toBe("");
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

      expect(synthesizeMock).toHaveBeenCalled();
      const request = requireFirstSynthesisRequest("persona synthesis request");
      const providerConfig = requireRecord(request.providerConfig, "persona provider config");
      expect(providerConfig.model).toBe("base-model");
      expect(providerConfig.voice).toBe("persona-voice");
      expect(providerConfig.style).toBe("dry");
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
    const attempt = requireAttempt(result.attempts, 0);
    expect(attempt.provider).toBe("missing");
    expect(attempt.outcome).toBe("skipped");
    expect(attempt.reasonCode).toBe("no_provider_registered");
    expect(attempt.persona).toBe("alfred");
    expect(attempt).not.toHaveProperty("personaBinding");
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
    const attempt = requireAttempt(result.attempts, 0);
    expect(attempt.provider).toBe("mock");
    expect(attempt.outcome).toBe("skipped");
    expect(attempt.reasonCode).toBe("unsupported_for_telephony");
    expect(attempt.persona).toBe("alfred");
    expect(attempt).not.toHaveProperty("personaBinding");
  });

  it("passes directive overrides to telephony synthesis providers", async () => {
    const synthesizeTelephonyMock = vi.fn(async (_request: SpeechTelephonySynthesisRequest) => ({
      audioBuffer: Buffer.from("voice"),
      outputFormat: "pcm",
      sampleRate: 24_000,
    }));
    installSpeechProviders([
      createMockSpeechProvider("mock", {
        synthesizeTelephony: synthesizeTelephonyMock,
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
            speakerVoice: "directed-voice",
            speed: 1.5,
          },
        },
      },
    });

    expect(result.success).toBe(true);
    expect(result.providerModel).toBe("telephony-model");
    expect(result.providerVoice).toBe("directed-voice");
    expect(synthesizeTelephonyMock).toHaveBeenCalledOnce();
    const telephonyRequest = requireRecord(
      requireFirstCallParam(synthesizeTelephonyMock.mock.calls, "telephony synthesis"),
      "telephony synthesis request",
    );
    expect(telephonyRequest.providerOverrides).toEqual({
      speakerVoice: "directed-voice",
      speed: 1.5,
    });
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

    expect(prepareSynthesisMock).toHaveBeenCalledOnce();
    const prepareContext = requireRecord(
      requireFirstCallParam(prepareSynthesisMock.mock.calls, "prepare synthesis"),
      "prepare synthesis context",
    );
    expect(prepareContext.persona).toBeUndefined();
    expect(prepareContext.personaProviderConfig).toBeUndefined();
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

    expect(prepareSynthesisMock).toHaveBeenCalledOnce();
    const prepareContext = requireRecord(
      requireFirstCallParam(prepareSynthesisMock.mock.calls, "prepare synthesis"),
      "prepare synthesis context",
    );
    const persona = requireRecord(prepareContext.persona, "prepare synthesis persona");
    expect(persona.id).toBe("alfred");
    expect(prepareContext.personaProviderConfig).toBeUndefined();
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
    const skippedAttempt = requireAttempt(result.attempts, 0);
    expect(skippedAttempt.provider).toBe("mock");
    expect(skippedAttempt.outcome).toBe("skipped");
    expect(skippedAttempt.reasonCode).toBe("not_configured");
    expect(skippedAttempt.persona).toBe("alfred");
    expect(skippedAttempt.personaBinding).toBe("missing");
    expect(skippedAttempt.error).toBe("mock: persona alfred has no provider binding");
    const successAttempt = requireAttempt(result.attempts, 1);
    expect(successAttempt.provider).toBe("fallback");
    expect(successAttempt.outcome).toBe("success");
    expect(successAttempt.persona).toBe("alfred");
    expect(successAttempt.personaBinding).toBe("applied");
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

    const rawConfig = requireRecord(resolved.rawConfig, "resolved raw TTS config");
    expect(rawConfig.enabled).toBe(true);
    expect(rawConfig.provider).toBe("openai");
    const providers = requireRecord(rawConfig.providers, "resolved raw TTS providers");
    const openai = requireRecord(providers.openai, "resolved OpenAI TTS provider config");
    expect(openai.apiKey).toBe("${OPENAI_API_KEY}");
    expect(openai.voice).toBe("nova");
    expect(openai.speed).toBe(1);
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

      expect(synthesizeMock).toHaveBeenCalled();
      const request = requireFirstSynthesisRequest("agent persona synthesis request");
      const providerConfig = requireRecord(request.providerConfig, "agent persona provider config");
      expect(providerConfig.model).toBe("base-model");
      expect(providerConfig.voice).toBe("agent-voice");
      expect(providerConfig.style).toBe("jarvis-style");
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
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
