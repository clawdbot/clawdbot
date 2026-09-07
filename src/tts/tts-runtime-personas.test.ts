import { rmSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  activateSecretsRuntimeSnapshot,
  clearSecretsRuntimeSnapshot,
  prepareSecretsRuntimeSnapshot,
} from "../secrets/runtime.js";
import { discoverConfigSecretTargetsByIds } from "../secrets/target-registry.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import {
  clearRuntimeConfigSnapshot,
  createMockSpeechProvider,
  getTtsPersona,
  getTtsProvider,
  installSpeechProviders,
  isTtsProviderConfigured,
  maybeApplyTtsToPayload,
  prepareSynthesisMock,
  requireAttempt,
  requireFirstCallParam,
  requireFirstSynthesisRequest,
  requireRecord,
  resolveTtsConfig,
  setTtsMachinePrefsPathResolver,
  synthesizeMock,
  synthesizeSpeech,
  textToSpeechTelephony,
  transcodeAudioBufferMock,
  type OpenClawConfig,
  type ReplyPayload,
  type SpeechTelephonySynthesisRequest,
} from "./tts-runtime.test-support.js";

describe("TTS runtime persona behavior", () => {
  afterEach(() => {
    setTtsMachinePrefsPathResolver();
    clearRuntimeConfigSnapshot();
    clearSecretsRuntimeSnapshot();
    delete (Object.prototype as Record<string, unknown>).polluted;
    synthesizeMock.mockClear();
    prepareSynthesisMock.mockClear();
    transcodeAudioBufferMock.mockClear();
    installSpeechProviders([createMockSpeechProvider()]);
  });

  it("selects persona preferred provider before config fallback", () => {
    const cfg: OpenClawConfig = {
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
    const prefsPath = "/tmp/openclaw-speech-core-invalid-provider.json";
    setTtsMachinePrefsPathResolver(() => prefsPath);
    const cfg = {
      tts: {
        providers: { broken: {} },
      },
    } as OpenClawConfig;
    const config = resolveTtsConfig(cfg);

    expect(isTtsProviderConfigured(config, "broken", cfg)).toBe(false);
    expect(getTtsProvider(config, prefsPath)).toBe("");
  });

  it("merges active persona provider binding into synthesis config", async () => {
    setTtsMachinePrefsPathResolver(() => "/tmp/openclaw-speech-core-persona-merge.json");
    const cfg: OpenClawConfig = {
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
                voice: "persona-voice",
                style: "dry",
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
      expect(result.mediaUrl).toMatch(/voice---[a-f0-9-]+\.ogg$/);

      mediaDir = result.mediaUrl ? path.dirname(result.mediaUrl) : undefined;
    } finally {
      if (mediaDir) {
        rmSync(mediaDir, { recursive: true, force: true });
      }
    }
  });

  it.each(["base", "global", "agent"] as const)(
    "materializes %s TTS SecretRefs before selected-persona synthesis",
    async (scope) => {
      await withOpenClawTestState({ label: "tts-persona-secrets" }, async (state) => {
        const personaRef = {
          source: "env",
          provider: "default",
          id: "TEST_TTS_PERSONA_KEY",
        } as const;
        const expectedKey = scope === "base" ? "base-fixture-key" : "persona-fixture-key";
        const personas = {
          "reader.uk": {
            provider: "mock",
            providers: {
              mock: {
                voice: "persona-voice",
                ...(scope === "base" ? {} : { apiKey: personaRef }),
              },
            },
          },
        };
        const cfg: OpenClawConfig = {
          plugins: { enabled: false },
          tts: {
            auto: "off",
            provider: "mock",
            persona: "reader.uk",
            providers: {
              mock: {
                apiKey: { source: "env", provider: "default", id: "TEST_TTS_BASE_KEY" },
                model: "base-model",
              },
            },
            ...(scope === "agent" ? {} : { personas }),
          },
          ...(scope === "agent" ? { agents: { entries: { reader: { tts: { personas } } } } } : {}),
        };
        installSpeechProviders([
          createMockSpeechProvider("mock", {
            isConfigured: ({ providerConfig }) => providerConfig.apiKey === expectedKey,
          }),
        ]);
        const snapshot = await prepareSecretsRuntimeSnapshot({
          config: cfg,
          env: {
            TEST_TTS_BASE_KEY: "base-fixture-key",
            TEST_TTS_PERSONA_KEY: "persona-fixture-key",
          },
          agentDirs: [state.agentDir()],
          includeAuthStoreRefs: false,
          manifestRegistry: { plugins: [] },
        });
        const result = await synthesizeSpeech({
          text: "Read this fixture.",
          cfg: snapshot.config,
          agentId: scope === "agent" ? "reader" : undefined,
          prefsPath: state.path("tts-prefs.json"),
          disableFallback: true,
        });
        expect(result).toMatchObject({ success: true, audioBuffer: Buffer.from("voice") });
        expect(
          requireFirstSynthesisRequest("resolved persona synthesis").providerConfig,
        ).toMatchObject({
          apiKey: expectedKey,
          model: "base-model",
          voice: "persona-voice",
        });
        expect(snapshot.sourceConfig).toEqual(cfg);
        expect(snapshot.warnings).toEqual([]);
        const prefix = scope === "agent" ? "agents.entries.*.tts" : "tts";
        const targetId =
          scope === "base" ? "tts.providers.*.apiKey" : `${prefix}.personas.*.providers.*.apiKey`;
        const targets = discoverConfigSecretTargetsByIds(cfg, new Set([targetId]));
        expect(targets).toMatchObject([
          {
            providerId: "mock",
            path:
              scope === "base"
                ? "tts.providers.mock.apiKey"
                : `${scope === "agent" ? "agents.entries.reader.tts" : "tts"}.personas["reader.uk"].providers.mock.apiKey`,
          },
        ]);
      });
    },
  );

  it("keeps a missing persona SecretRef unavailable before any synthesis request", async () => {
    await withOpenClawTestState({ label: "tts-persona-unavailable" }, async (state) => {
      await import("./tts.js");
      const ref = {
        source: "env",
        provider: "default",
        id: "TEST_TTS_MISSING_PERSONA_KEY",
      } as const;
      const cfg: OpenClawConfig = {
        plugins: { enabled: false },
        tts: {
          provider: "mock",
          persona: "reader",
          providers: { mock: { apiKey: "other-fixture-key" } },
          personas: { reader: { providers: { mock: { apiKey: ref } } } },
        },
      };
      const snapshot = await prepareSecretsRuntimeSnapshot({
        config: cfg,
        env: {},
        agentDirs: [state.agentDir()],
        includeAuthStoreRefs: false,
        manifestRegistry: { plugins: [] },
        allowUnavailableSecretOwners: true,
      });
      activateSecretsRuntimeSnapshot(snapshot);
      await expect(
        synthesizeSpeech({
          text: "Do not use another credential.",
          cfg: snapshot.config,
          prefsPath: state.path("tts-prefs.json"),
          disableFallback: true,
        }),
      ).rejects.toMatchObject({ code: "SECRET_SURFACE_UNAVAILABLE", ownerId: "tts" });
      expect(snapshot.config.tts?.personas?.reader?.providers?.mock?.apiKey).toEqual(ref);
      expect(synthesizeMock).not.toHaveBeenCalled();
    });
  });

  it("does not mark skipped unregistered providers as missing persona bindings", async () => {
    const result = await synthesizeSpeech({
      text: "Use fallback provider.",
      cfg: {
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

    const text = "## Keep [telephony Markdown](https://example.com) raw!!!!!";
    const result = await textToSpeechTelephony({
      text,
      cfg: {
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
    expect(telephonyRequest.text).toBe(text);
    expect(telephonyRequest).not.toHaveProperty("target");
  });

  it("uses provider defaults when fallback policy allows missing persona bindings", async () => {
    await synthesizeSpeech({
      text: "Use neutral provider defaults.",
      cfg: {
        tts: {
          enabled: true,
          provider: "mock",
          persona: "alfred",
          personas: {
            alfred: {
              fallbackPolicy: "provider-defaults",
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

  it("preserves persona metadata by default when provider bindings are missing", async () => {
    await synthesizeSpeech({
      text: "Use persona prompt.",
      cfg: {
        tts: {
          enabled: true,
          provider: "mock",
          persona: "alfred",
          personas: {
            alfred: {
              label: "Alfred",
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

describe("TTS runtime per-agent config", () => {
  it("deep-merges the active agent TTS override over tts", () => {
    const cfg = {
      tts: {
        enabled: true,
        provider: "openai",
        providers: {
          openai: {
            apiKey: "example",
            voice: "coral",
            speed: 1,
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
    expect(openai.apiKey).toBe("example");
    expect(openai.voice).toBe("nova");
    expect(openai.speed).toBe(1);
  });

  it("composes per-agent TTS overrides with active persona bindings", async () => {
    const cfg = {
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
      expect(result.mediaUrl).toMatch(/voice---[a-f0-9-]+\.ogg$/);
      mediaDir = result.mediaUrl ? path.dirname(result.mediaUrl) : undefined;
    } finally {
      if (mediaDir) {
        rmSync(mediaDir, { recursive: true, force: true });
      }
    }
  });

  it("ignores prototype-pollution keys in agent TTS overrides", () => {
    const cfg = {
      tts: {
        provider: "openai",
        providers: {
          openai: {
            voice: "coral",
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
