import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { describe, expect, it } from "vitest";
import {
  legacyConfigRules,
  migrateGoogleMeetLegacyRealtimeProvider,
  normalizeCompatibilityConfig,
} from "./config-compat.js";

describe("google-meet config compatibility", () => {
  it("detects legacy Google realtime provider config", () => {
    expect(
      legacyConfigRules[0]?.match({
        provider: "google",
        model: "gemini-2.5-flash-native-audio-preview-12-2025",
      }),
    ).toBe(true);
  });

  it("migrates legacy Google bidi provider intent to scoped realtime providers", () => {
    const config = {
      plugins: {
        entries: {
          "google-meet": {
            enabled: true,
            config: {
              defaultMode: "agent",
              realtime: {
                provider: "google",
                model: "gemini-2.5-flash-native-audio-preview-12-2025",
                providers: {
                  google: {
                    voice: "Kore",
                  },
                },
              },
            },
          },
        },
      },
    } as OpenClawConfig;

    const migration = migrateGoogleMeetLegacyRealtimeProvider(config);

    expect(migration?.changes).toEqual([
      'Moved Google Meet legacy realtime.provider="google" intent to realtime.voiceProvider="google" and realtime.transcriptionProvider="openai".',
    ]);
    expect(
      (
        migration?.config.plugins?.entries?.["google-meet"] as {
          config?: { realtime?: Record<string, unknown> };
        }
      ).config?.realtime,
    ).toEqual({
      provider: "openai",
      transcriptionProvider: "openai",
      voiceProvider: "google",
      model: "gemini-2.5-flash-native-audio-preview-12-2025",
      providers: {
        google: {
          voice: "Kore",
        },
      },
    });
  });

  it("leaves fully scoped provider configs alone", () => {
    const config = {
      plugins: {
        entries: {
          "google-meet": {
            config: {
              realtime: {
                provider: "google",
                transcriptionProvider: "custom-stt",
                voiceProvider: "custom-voice",
              },
            },
          },
        },
      },
    } as OpenClawConfig;

    const migration = normalizeCompatibilityConfig({ cfg: config });

    expect(migration.changes).toStrictEqual([]);
    expect(
      (
        migration.config.plugins?.entries?.["google-meet"] as {
          config?: { realtime?: Record<string, unknown> };
        }
      ).config?.realtime,
    ).toEqual({
      provider: "google",
      transcriptionProvider: "custom-stt",
      voiceProvider: "custom-voice",
    });
  });
});
