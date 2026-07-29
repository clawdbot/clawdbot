// Legacy provider-shape migration tests cover doctor repair of old provider config shapes.
import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../../config/types.js";
import { LEGACY_CONFIG_MIGRATIONS_RUNTIME_TTS } from "./legacy-config-migrations.runtime.tts.js";
import { normalizeLegacyTalkConfig } from "./legacy-talk-config-normalizer.js";

function migrateLegacyConfig(raw: unknown): {
  config: OpenClawConfig | null;
  changes: string[];
} {
  if (!raw || typeof raw !== "object") {
    return { config: null, changes: [] };
  }
  const next = structuredClone(raw) as Record<string, unknown>;
  const changes: string[] = [];
  for (const migration of LEGACY_CONFIG_MIGRATIONS_RUNTIME_TTS) {
    migration.apply(next, changes);
  }
  if (changes.length === 0) {
    return { config: null, changes };
  }
  return { config: next as OpenClawConfig | null, changes };
}

describe("legacy migrate provider-shaped config", () => {
  it("moves legacy realtime Talk selectors into talk.realtime without treating speech config as runtime fallback", () => {
    const changes: string[] = [];
    const migrated = normalizeLegacyTalkConfig(
      {
        talk: {
          provider: "openai",
          providers: {
            openai: {
              apiKey: "test-key",
              custom: true,
            },
          },
          mode: "realtime",
          transport: "gateway-relay",
          brain: "agent-consult",
          model: "gpt-realtime",
          voice: "alloy",
        } as never,
      },
      changes,
    );

    expect(changes).toStrictEqual([
      "Normalized talk.provider/providers shape (trimmed provider ids and merged missing compatibility fields).",
      "Moved legacy realtime Talk provider/model fields into talk.realtime.",
    ]);
    expect(migrated.talk).toEqual({
      provider: "openai",
      providers: {
        openai: {
          apiKey: "test-key",
          custom: true,
        },
      },
      realtime: {
        provider: "openai",
        providers: {
          openai: {
            apiKey: "test-key",
            custom: true,
          },
        },
        mode: "realtime",
        transport: "gateway-relay",
        brain: "agent-consult",
        model: "gpt-realtime",
        speakerVoice: "alloy",
      },
    });
  });

  it("does not copy plain Talk speech provider config into talk.realtime", () => {
    const changes: string[] = [];
    const migrated = normalizeLegacyTalkConfig(
      {
        talk: {
          provider: "elevenlabs",
          providers: {
            elevenlabs: {
              voiceId: "voice-1",
            },
          },
        },
      },
      changes,
    );

    expect(changes).toStrictEqual([]);
    expect(migrated.talk).toEqual({
      provider: "elevenlabs",
      providers: {
        elevenlabs: {
          voiceId: "voice-1",
        },
      },
    });
  });

  it("preserves an existing realtime speaker voice without triggering provider repair", () => {
    const input = {
      talk: {
        provider: "elevenlabs",
        providers: {
          elevenlabs: {
            voiceId: "voice-1",
          },
        },
        realtime: {
          provider: "openai",
          providers: {
            openai: {
              model: "gpt-realtime",
            },
          },
          model: "gpt-realtime",
          speakerVoice: "cedar",
          mode: "realtime",
          transport: "gateway-relay",
          brain: "agent-consult",
        },
      },
    } as unknown as OpenClawConfig;
    const changes: string[] = [];

    const migrated = normalizeLegacyTalkConfig(input, changes);

    expect(changes).toStrictEqual([]);
    expect(migrated.talk).toEqual({
      provider: "elevenlabs",
      providers: {
        elevenlabs: {
          voiceId: "voice-1",
        },
      },
      realtime: {
        provider: "openai",
        providers: {
          openai: {
            model: "gpt-realtime",
          },
        },
        model: "gpt-realtime",
        speakerVoice: "cedar",
        mode: "realtime",
        transport: "gateway-relay",
        brain: "agent-consult",
      },
    });
  });

  it("moves messages.tts to top-level tts before normalizing provider keys", () => {
    const res = migrateLegacyConfig({
      messages: {
        tts: {
          provider: "elevenlabs",
          elevenlabs: {
            apiKey: "test-key",
            voiceId: "voice-1",
          },
        },
      },
    });

    expect(res.changes).toStrictEqual([
      "Moved messages.tts to top-level tts.",
      "Moved tts.elevenlabs → tts.providers.elevenlabs.",
      "Moved tts.providers.elevenlabs.voiceId → tts.providers.elevenlabs.speakerVoiceId.",
    ]);
    expect(res.config?.tts).toEqual({
      provider: "elevenlabs",
      providers: {
        elevenlabs: {
          apiKey: "test-key",
          speakerVoiceId: "voice-1",
        },
      },
    });
  });

  it("routes legacy messages.tts.realtime voice to talk.realtime.speakerVoice", () => {
    const res = migrateLegacyConfig({
      messages: {
        tts: {
          provider: "openai",
          realtime: { voice: "cedar" },
        },
      },
    });

    expect(res.changes).toStrictEqual([
      "Moved messages.tts.realtime voice → talk.realtime.speakerVoice.",
      "Moved messages.tts to top-level tts.",
    ]);
    expect(res.config?.tts).toEqual({ provider: "openai" });
    expect(res.config?.talk?.realtime?.speakerVoice).toBe("cedar");
  });

  it("drops legacy messages.tts.realtime when talk.realtime.speakerVoice is set", () => {
    const res = migrateLegacyConfig({
      talk: { realtime: { speakerVoice: "marin" } },
      messages: {
        tts: {
          provider: "openai",
          realtime: { voice: "cedar" },
        },
      },
    });

    expect(res.changes).toStrictEqual([
      "Removed messages.tts.realtime (talk.realtime already configured).",
      "Moved messages.tts to top-level tts.",
    ]);
    expect(res.config?.tts).toEqual({ provider: "openai" });
    expect(res.config?.talk?.realtime?.speakerVoice).toBe("marin");
  });

  it("keeps canonical top-level tts values while filling missing legacy settings", () => {
    const res = migrateLegacyConfig({
      tts: {
        provider: "openai",
        providers: { openai: { model: "canonical-model" } },
      },
      messages: {
        tts: {
          provider: "elevenlabs",
          auto: "always",
          providers: { openai: { speakerVoice: "coral" } },
        },
      },
    });

    expect(res.changes).toStrictEqual(["Moved messages.tts to top-level tts."]);
    expect(res.config?.tts).toEqual({
      provider: "openai",
      auto: "always",
      providers: { openai: { model: "canonical-model", speakerVoice: "coral" } },
    });
    expect(res.config?.messages).toEqual({});
  });

  it("removes invalid messages.tts values", () => {
    const res = migrateLegacyConfig({ messages: { tts: true } });

    expect(res.changes).toStrictEqual(["Removed messages.tts (invalid value)."]);
    expect(res.config?.messages).toEqual({});
    expect(res.config?.tts).toBeUndefined();
  });

  it("moves legacy edge provider aliases into microsoft tts config", () => {
    const res = migrateLegacyConfig({
      messages: {
        tts: {
          provider: "edge",
          providers: {
            edge: {
              voice: "en-US-AvaNeural",
              rate: "+8%",
            },
            microsoft: {
              lang: "en-US",
              rate: "+4%",
            },
          },
        },
      },
    });

    expect(res.changes).toStrictEqual([
      "Moved messages.tts to top-level tts.",
      'Moved tts.provider "edge" → "microsoft".',
      "Moved tts.providers.edge → tts.providers.microsoft.",
      "Moved tts.providers.microsoft.voice → tts.providers.microsoft.speakerVoice.",
    ]);
    expect(res.config?.tts).toEqual({
      provider: "microsoft",
      providers: {
        microsoft: {
          lang: "en-US",
          rate: "+4%",
          speakerVoice: "en-US-AvaNeural",
        },
      },
    });
  });

  it("moves legacy TTS speaker selection fields to speakerVoice and speakerVoiceId", () => {
    const res = migrateLegacyConfig({
      messages: {
        tts: {
          provider: "openai",
          openai: {
            voice: "alloy",
          },
          providers: {
            elevenlabs: {
              voiceId: "voice-1",
            },
          },
          personas: {
            narrator: {
              providers: {
                google: {
                  voiceName: "Kore",
                },
              },
            },
          },
        },
      },
      agents: {
        defaults: {
          tts: {
            providers: {
              openai: {
                voice: "cedar",
                speakerVoice: "marin",
              },
            },
          },
        },
        list: [
          {
            id: "voice-agent",
            tts: {
              providers: {
                openai: {
                  voice: "cedar",
                },
              },
            },
          },
        ],
      },
      channels: {
        discord: {
          tts: {
            providers: {
              microsoft: {
                voice: "en-US-AvaNeural",
              },
            },
          },
          voice: {
            tts: {
              providers: {
                openai: {
                  voice: "verse",
                },
              },
            },
          },
          accounts: {
            primary: {
              tts: {
                providers: {
                  gradium: {
                    voiceId: "voice-2",
                    speakerVoiceId: "voice-current",
                  },
                },
              },
              voice: {
                tts: {
                  providers: {
                    openai: {
                      voiceId: "nested-voice",
                    },
                  },
                },
              },
            },
          },
        },
      },
      plugins: {
        entries: {
          "voice-call": {
            config: {
              tts: {
                providers: {
                  xai: {
                    voiceId: "eve",
                  },
                },
              },
            },
          },
        },
      },
    });

    expect(res.changes).toStrictEqual([
      "Moved messages.tts to top-level tts.",
      "Moved tts.openai → tts.providers.openai.",
      "Moved tts.providers.elevenlabs.voiceId → tts.providers.elevenlabs.speakerVoiceId.",
      "Moved tts.providers.openai.voice → tts.providers.openai.speakerVoice.",
      "Moved tts.personas.narrator.providers.google.voiceName → tts.personas.narrator.providers.google.speakerVoice.",
      "Moved agents.list[0].tts.providers.openai.voice → agents.list[0].tts.providers.openai.speakerVoice.",
      "Moved channels.discord.voice.tts.providers.openai.voice → channels.discord.voice.tts.providers.openai.speakerVoice.",
      "Moved channels.discord.accounts.primary.voice.tts.providers.openai.voiceId → channels.discord.accounts.primary.voice.tts.providers.openai.speakerVoiceId.",
      "Moved plugins.entries.voice-call.config.tts.providers.xai.voiceId → plugins.entries.voice-call.config.tts.providers.xai.speakerVoiceId.",
    ]);
    expect(res.config?.tts).toEqual({
      provider: "openai",
      providers: {
        elevenlabs: {
          speakerVoiceId: "voice-1",
        },
        openai: {
          speakerVoice: "alloy",
        },
      },
      personas: {
        narrator: {
          providers: {
            google: {
              speakerVoice: "Kore",
            },
          },
        },
      },
    });
    const migratedConfig = res.config as
      | {
          agents?: {
            defaults?: { tts?: Record<string, unknown> };
            list?: Array<{ id?: string; tts?: Record<string, unknown> }>;
          };
          channels?: {
            discord?: {
              tts?: Record<string, unknown>;
              voice?: { tts?: Record<string, unknown> };
              accounts?: {
                primary?: {
                  tts?: Record<string, unknown>;
                  voice?: { tts?: Record<string, unknown> };
                };
              };
            };
          };
          plugins?: {
            entries?: Record<string, { config?: { tts?: Record<string, unknown> } }>;
          };
        }
      | undefined;
    expect(migratedConfig?.agents?.defaults?.tts).toEqual({
      providers: {
        openai: {
          voice: "cedar",
          speakerVoice: "marin",
        },
      },
    });
    expect(migratedConfig?.agents?.list?.[0]).toEqual({
      id: "voice-agent",
      tts: {
        providers: {
          openai: {
            speakerVoice: "cedar",
          },
        },
      },
    });
    expect(migratedConfig?.channels?.discord?.tts).toEqual({
      providers: {
        microsoft: {
          voice: "en-US-AvaNeural",
        },
      },
    });
    expect(migratedConfig?.channels?.discord?.voice?.tts).toEqual({
      providers: {
        openai: {
          speakerVoice: "verse",
        },
      },
    });
    expect(migratedConfig?.channels?.discord?.accounts?.primary?.tts).toEqual({
      providers: {
        gradium: {
          voiceId: "voice-2",
          speakerVoiceId: "voice-current",
        },
      },
    });
    expect(migratedConfig?.channels?.discord?.accounts?.primary?.voice?.tts).toEqual({
      providers: {
        openai: {
          speakerVoiceId: "nested-voice",
        },
      },
    });
    expect(migratedConfig?.plugins?.entries?.["voice-call"]?.config?.tts).toEqual({
      providers: {
        xai: {
          speakerVoiceId: "eve",
        },
      },
    });
  });

  it("moves legacy tts enabled toggles to auto mode in known config locations", () => {
    const res = migrateLegacyConfig({
      messages: {
        tts: {
          enabled: true,
        },
      },
      agents: {
        defaults: {
          tts: {
            enabled: false,
          },
        },
        list: [
          {
            id: "voice-agent",
            tts: {
              enabled: true,
              auto: "tagged",
            },
          },
        ],
      },
      channels: {
        discord: {
          tts: {
            enabled: true,
          },
          voice: {
            tts: {
              enabled: false,
            },
          },
          accounts: {
            primary: {
              tts: {
                enabled: false,
              },
              voice: {
                tts: {
                  enabled: true,
                },
              },
            },
          },
        },
        feishu: {
          tts: {
            enabled: true,
          },
          accounts: {
            english: {
              tts: {
                enabled: false,
              },
            },
          },
        },
      },
      plugins: {
        entries: {
          "voice-call": {
            config: {
              tts: {
                enabled: true,
              },
            },
          },
        },
      },
    });

    expect(res.changes).toEqual([
      "Moved messages.tts to top-level tts.",
      'Moved tts.enabled → tts.auto "always".',
      "Removed agents.list[0].tts.enabled because agents.list[0].tts.auto is already set.",
      'Moved channels.discord.voice.tts.enabled → channels.discord.voice.tts.auto "off".',
      'Moved channels.discord.accounts.primary.voice.tts.enabled → channels.discord.accounts.primary.voice.tts.auto "always".',
      'Moved channels.feishu.tts.enabled → channels.feishu.tts.auto "always".',
      'Moved channels.feishu.accounts.english.tts.enabled → channels.feishu.accounts.english.tts.auto "off".',
      'Moved plugins.entries.voice-call.config.tts.enabled → plugins.entries.voice-call.config.tts.auto "always".',
    ]);
    const migratedConfig = res.config as
      | {
          tts?: { auto?: unknown };
          agents?: {
            defaults?: { tts?: { enabled?: unknown; auto?: unknown } };
            list?: Array<{ id?: string; tts?: { auto?: unknown } }>;
          };
          channels?: {
            discord?: {
              tts?: { enabled?: unknown; auto?: unknown };
              voice?: { tts?: { auto?: unknown } };
              accounts?: {
                primary?: {
                  tts?: { enabled?: unknown; auto?: unknown };
                  voice?: { tts?: { auto?: unknown } };
                };
              };
            };
            feishu?: {
              tts?: { auto?: unknown };
              accounts?: { english?: { tts?: { auto?: unknown } } };
            };
          };
          plugins?: {
            entries?: Record<string, { config?: { tts?: { auto?: unknown } } }>;
          };
        }
      | undefined;
    expect(migratedConfig?.tts?.auto).toBe("always");
    expect(migratedConfig?.agents?.defaults?.tts).toEqual({ enabled: false });
    expect(migratedConfig?.agents?.list?.[0]).toEqual({
      id: "voice-agent",
      tts: { auto: "tagged" },
    });
    expect(migratedConfig?.channels?.discord?.tts).toEqual({ enabled: true });
    expect(migratedConfig?.channels?.discord?.voice?.tts?.auto).toBe("off");
    expect(migratedConfig?.channels?.discord?.accounts?.primary?.tts).toEqual({
      enabled: false,
    });
    expect(migratedConfig?.channels?.discord?.accounts?.primary?.voice?.tts?.auto).toBe("always");
    expect(migratedConfig?.channels?.feishu?.tts?.auto).toBe("always");
    expect(migratedConfig?.channels?.feishu?.accounts?.english?.tts?.auto).toBe("off");
    expect(migratedConfig?.plugins?.entries?.["voice-call"]?.config?.tts?.auto).toBe("always");
  });

  it("moves plugins.entries.voice-call.config.tts.<provider> keys into providers", () => {
    const res = migrateLegacyConfig({
      plugins: {
        entries: {
          "voice-call": {
            config: {
              tts: {
                provider: "openai",
                openai: {
                  model: "gpt-4o-mini-tts",
                  voice: "alloy",
                },
              },
            },
          },
        },
      },
    });

    expect(res.changes).toStrictEqual([
      "Moved plugins.entries.voice-call.config.tts.openai → plugins.entries.voice-call.config.tts.providers.openai.",
      "Moved plugins.entries.voice-call.config.tts.providers.openai.voice → plugins.entries.voice-call.config.tts.providers.openai.speakerVoice.",
    ]);
    const voiceCallTts = (
      res.config?.plugins?.entries as
        | Record<string, { config?: { tts?: Record<string, unknown> } }>
        | undefined
    )?.["voice-call"]?.config?.tts;
    expect(voiceCallTts).toEqual({
      provider: "openai",
      providers: {
        openai: {
          model: "gpt-4o-mini-tts",
          speakerVoice: "alloy",
        },
      },
    });
  });

  it("moves voice-call legacy edge provider aliases into microsoft tts config", () => {
    const res = migrateLegacyConfig({
      plugins: {
        entries: {
          "voice-call": {
            config: {
              tts: {
                provider: "edge",
                providers: {
                  edge: {
                    voice: "en-US-AvaNeural",
                  },
                },
              },
            },
          },
        },
      },
    });

    expect(res.changes).toStrictEqual([
      'Moved plugins.entries.voice-call.config.tts.provider "edge" → "microsoft".',
      "Moved plugins.entries.voice-call.config.tts.providers.edge → plugins.entries.voice-call.config.tts.providers.microsoft.",
      "Moved plugins.entries.voice-call.config.tts.providers.microsoft.voice → plugins.entries.voice-call.config.tts.providers.microsoft.speakerVoice.",
    ]);
    const voiceCallTts = (
      res.config?.plugins?.entries as
        | Record<string, { config?: { tts?: Record<string, unknown> } }>
        | undefined
    )?.["voice-call"]?.config?.tts;
    expect(voiceCallTts).toEqual({
      provider: "microsoft",
      providers: {
        microsoft: {
          speakerVoice: "en-US-AvaNeural",
        },
      },
    });
  });

  it("does not migrate legacy tts provider keys for unknown plugin ids", () => {
    const res = migrateLegacyConfig({
      plugins: {
        entries: {
          "third-party-plugin": {
            config: {
              tts: {
                provider: "openai",
                openai: {
                  model: "custom-tts",
                },
              },
            },
          },
        },
      },
    });

    expect(res.changes).toStrictEqual([]);
    expect(res.config).toBeNull();
  });

  it("does not migrate extension-owned talk legacy fields during config-load migration", () => {
    const res = migrateLegacyConfig({
      talk: {
        voiceId: "voice-1",
        modelId: "eleven_v3",
        outputFormat: "pcm_44100",
        apiKey: "test-key",
      },
    });

    expect(res.config).toBeNull();
    expect(res.changes).toStrictEqual([]);
  });
});
