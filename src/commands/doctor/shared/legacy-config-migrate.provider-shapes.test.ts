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
        voice: "alloy",
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

  it("moves messages.tts.<provider> keys into messages.tts.providers", () => {
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
      "Moved messages.tts.elevenlabs → messages.tts.providers.elevenlabs.",
    ]);
    expect(res.config?.messages?.tts).toEqual({
      provider: "elevenlabs",
      providers: {
        elevenlabs: {
          apiKey: "test-key",
          voiceId: "voice-1",
        },
      },
    });
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
      'Moved messages.tts.provider "edge" → "microsoft".',
      "Moved messages.tts.providers.edge → messages.tts.providers.microsoft.",
    ]);
    expect(res.config?.messages?.tts).toEqual({
      provider: "microsoft",
      providers: {
        microsoft: {
          lang: "en-US",
          rate: "+4%",
          voice: "en-US-AvaNeural",
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
          accounts: {
            primary: {
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
      'Moved messages.tts.enabled → messages.tts.auto "always".',
      'Moved agents.defaults.tts.enabled → agents.defaults.tts.auto "off".',
      "Removed agents.list[0].tts.enabled because agents.list[0].tts.auto is already set.",
      'Moved channels.discord.tts.enabled → channels.discord.tts.auto "always".',
      'Moved channels.discord.accounts.primary.tts.enabled → channels.discord.accounts.primary.tts.auto "off".',
      'Moved plugins.entries.voice-call.config.tts.enabled → plugins.entries.voice-call.config.tts.auto "always".',
    ]);
    const migratedConfig = res.config as
      | {
          messages?: { tts?: { auto?: unknown } };
          agents?: {
            defaults?: { tts?: { auto?: unknown } };
            list?: Array<{ id?: string; tts?: { auto?: unknown } }>;
          };
          channels?: {
            discord?: {
              tts?: { auto?: unknown };
              accounts?: { primary?: { tts?: { auto?: unknown } } };
            };
          };
          plugins?: {
            entries?: Record<string, { config?: { tts?: { auto?: unknown } } }>;
          };
        }
      | undefined;
    expect(migratedConfig?.messages?.tts?.auto).toBe("always");
    expect(migratedConfig?.agents?.defaults?.tts?.auto).toBe("off");
    expect(migratedConfig?.agents?.list?.[0]).toEqual({
      id: "voice-agent",
      tts: { auto: "tagged" },
    });
    expect(migratedConfig?.channels?.discord?.tts?.auto).toBe("always");
    expect(migratedConfig?.channels?.discord?.accounts?.primary?.tts?.auto).toBe("off");
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
          voice: "alloy",
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
          voice: "en-US-AvaNeural",
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
