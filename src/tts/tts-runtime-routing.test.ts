import { rmSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CODE_HEAVY_SPOKEN_FALLBACK,
  MAX_TIMER_TIMEOUT_MS,
  buildTtsSystemPromptHint,
  clearRuntimeConfigSnapshot,
  createMockSpeechProvider,
  createTtsConfig,
  expectTtsPayloadResult,
  installSpeechProviders,
  listSpeechVoices,
  nativeVoiceNoteChannels,
  prefsPathFor,
  prepareSynthesisMock,
  prepareTtsRequest,
  requireFirstCallParam,
  requireFirstSynthesisRequest,
  requireRecord,
  resolveTtsConfig,
  resolveTtsPrefsPath,
  setRuntimeConfigSnapshot,
  setTtsMachinePrefsPathResolver,
  synthesizeMock,
  synthesizeSpeech,
  testApi,
  textToSpeech,
  textToSpeechCore,
  transcodeAudioBufferMock,
  type OpenClawConfig,
  type SpeechListVoicesRequest,
  type TtsConfig,
} from "./tts-runtime.test-support.js";

describe("TTS runtime native voice-note routing", () => {
  afterEach(() => {
    setTtsMachinePrefsPathResolver();
    clearRuntimeConfigSnapshot();
    delete (Object.prototype as Record<string, unknown>).polluted;
    synthesizeMock.mockClear();
    prepareSynthesisMock.mockClear();
    transcodeAudioBufferMock.mockClear();
    installSpeechProviders([createMockSpeechProvider()]);
  });

  it("prefers the environment preference path over migrated machine state", () => {
    const previousEnvPath = process.env.OPENCLAW_TTS_PREFS;
    const envPath = prefsPathFor("env-override");
    setTtsMachinePrefsPathResolver(() => prefsPathFor("machine-state"));
    process.env.OPENCLAW_TTS_PREFS = envPath;
    try {
      expect(resolveTtsPrefsPath(resolveTtsConfig({}))).toBe(envPath);
    } finally {
      if (previousEnvPath === undefined) {
        delete process.env.OPENCLAW_TTS_PREFS;
      } else {
        process.env.OPENCLAW_TTS_PREFS = previousEnvPath;
      }
    }
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

  it("uses structured speech guidance for message-tool-only replies", () => {
    const hint = buildTtsSystemPromptHint(
      createTtsConfig("openclaw-speech-core-structured-tts-hint-test"),
      undefined,
      { messageToolOnly: true },
    );

    expect(hint).toContain("message(action=send) with voiceText");
    expect(hint).toContain("voiceProvider/voiceId");
    expect(hint).not.toContain("[[tts:");
  });

  it("prepares deep-merged surface config and directive inputs", () => {
    const cfg: OpenClawConfig = {
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
    expect(prepared.cfg.tts?.providers?.mock).toEqual({
      model: "base-model",
      voice: "surface-voice",
      voiceSettings: { stability: 0.4, speed: 1.1 },
    });
    expect(prepared.cfg.tts?.modelOverrides?.allowProvider).toBe(true);
    expect(prepared.directives).toEqual({
      cleanedText: "Hello  caller",
      hasDirective: true,
      overrides: {
        ttsText: "Speak this instead",
      },
      ttsText: "Speak this instead",
      warnings: [],
    });
    expect(cfg.tts?.providers?.mock).toEqual({
      model: "base-model",
      voiceSettings: { stability: 0.4 },
    });
  });

  it("sanitizes blocked override keys while preparing TTS config", () => {
    const prepared = prepareTtsRequest({
      cfg: {
        tts: {
          provider: "mock",
          providers: { mock: { model: "base-model" } },
        },
      },
      override: JSON.parse(
        '{"__proto__":{"polluted":"top"},"providers":{"mock":{"voice":"safe","__proto__":{"polluted":"nested"}}}}',
      ) as TtsConfig,
      text: "[[tts:text]]Speak this instead[[/tts:text]]",
    });

    expect((Object.prototype as Record<string, unknown>).polluted).toBeUndefined();
    expect(prepared.cfg.tts).not.toHaveProperty("polluted");
    expect(prepared.cfg.tts?.providers?.mock).toEqual({
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
      tts: {
        enabled: true,
        provider: "mock",
        providers: {
          mock: {
            apiKey: { source: "exec", provider: "mockexec", id: "minimax/tts/apiKey" },
          },
        },
      },
    } as unknown as OpenClawConfig;
    const runtimeConfig = {
      tts: {
        enabled: true,
        provider: "mock",
        providers: {
          mock: {
            apiKey: "test-key",
          },
        },
      },
    } as unknown as OpenClawConfig;
    installSpeechProviders([
      createMockSpeechProvider("mock", {
        isConfigured: ({ providerConfig }) => providerConfig.apiKey === "test-key",
        resolveConfig: ({ rawConfig }) => {
          const providers = rawConfig.providers as Record<string, { apiKey?: unknown }> | undefined;
          return providers?.mock ?? {};
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
    expect(providerConfig.apiKey).toBe("test-key");
  });

  it("uses provider default TTS timeout when the call and config omit timeoutMs", async () => {
    installSpeechProviders([createMockSpeechProvider("mock", { defaultTimeoutMs: 600_000 })]);

    const result = await synthesizeSpeech({
      text: "Use provider timeout.",
      cfg: {
        tts: {
          enabled: true,
          provider: "mock",
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

  it("returns a normal TTS failure when audio persistence rejects", async () => {
    const result = await textToSpeechCore(
      {
        text: "Store this synthesized reply.",
        cfg: createTtsConfig("openclaw-speech-core-persistence-failure-test"),
      },
      async () => {
        throw new Error("Media exceeds configured limit");
      },
    );

    expect(result).toMatchObject({
      success: false,
      error: "TTS audio persistence failed",
      provider: "mock",
    });
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
        tts: {
          enabled: true,
          provider: "mock",
          timeoutMs: 45_000,
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
        tts: {
          enabled: true,
          provider: "mock",
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
        tts: {
          enabled: true,
          provider: "mock",
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
        tts: {
          enabled: true,
          provider: "mock",
          timeoutMs: 45_000,
        },
      } as OpenClawConfig,
      disableFallback: true,
    });

    const request = requireFirstSynthesisRequest("configured timeout synthesis request");
    expect(request.timeoutMs).toBe(45_000);
  });
});
