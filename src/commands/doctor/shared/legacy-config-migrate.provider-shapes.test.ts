import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../../config/types.js";
import { LEGACY_CONFIG_MIGRATIONS_RUNTIME_TTS } from "./legacy-config-migrations.runtime.tts.js";

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

    expect(res.changes).toContain(
      "Moved messages.tts.elevenlabs → messages.tts.providers.elevenlabs.",
    );
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

    expect(res.changes).toContain('Moved messages.tts.provider "edge" → "microsoft".');
    expect(res.changes).toContain(
      "Moved messages.tts.providers.edge → messages.tts.providers.microsoft.",
    );
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

    expect(res.changes).toContain(
      "Moved plugins.entries.voice-call.config.tts.openai → plugins.entries.voice-call.config.tts.providers.openai.",
    );
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

    expect(res.changes).toContain(
      'Moved plugins.entries.voice-call.config.tts.provider "edge" → "microsoft".',
    );
    expect(res.changes).toContain(
      "Moved plugins.entries.voice-call.config.tts.providers.edge → plugins.entries.voice-call.config.tts.providers.microsoft.",
    );
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

    expect(res.changes).toEqual([]);
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
    expect(res.changes).toEqual([]);
  });
});
