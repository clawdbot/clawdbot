import { describe, expect, it } from "vitest";
import {
  VOICE_CALL_LEGACY_CONFIG_REMOVAL_VERSION,
  collectVoiceCallLegacyConfigIssues,
  formatVoiceCallLegacyConfigWarnings,
  migrateVoiceCallLegacyConfigInput,
  normalizeVoiceCallLegacyConfigInput,
  parseVoiceCallPluginConfig,
} from "./config-compat.js";

describe("voice-call config compatibility", () => {
  it("maps deprecated provider and twilio.from fields into canonical config", () => {
    const parsed = parseVoiceCallPluginConfig({
      enabled: true,
      provider: "log",
      twilio: {
        from: "+15550001234",
      },
    });

    expect(parsed.provider).toBe("mock");
    expect(parsed.fromNumber).toBe("+15550001234");
  });

  it("moves legacy streaming OpenAI fields into streaming.providers.openai", () => {
    const normalized = normalizeVoiceCallLegacyConfigInput({
      streaming: {
        enabled: true,
        sttProvider: "openai",
        openaiApiKey: "sk-test", // pragma: allowlist secret
        sttModel: "gpt-4o-transcribe",
        silenceDurationMs: 700,
        vadThreshold: 0.4,
      },
    });

    expect(normalized).toMatchObject({
      streaming: {
        enabled: true,
        provider: "openai",
        providers: {
          openai: {
            apiKey: "sk-test",
            model: "gpt-4o-transcribe",
            silenceDurationMs: 700,
            vadThreshold: 0.4,
          },
        },
      },
    });
    expect((normalized.streaming as Record<string, unknown>).openaiApiKey).toBeUndefined();
    expect((normalized.streaming as Record<string, unknown>).sttModel).toBeUndefined();
  });

  it("reports doctor-oriented legacy issues and warnings", () => {
    const raw = {
      provider: "log",
      twilio: {
        from: "+15550001234",
      },
      streaming: {
        sttProvider: "openai",
        openaiApiKey: "sk-test", // pragma: allowlist secret
      },
    };

    expect(collectVoiceCallLegacyConfigIssues(raw)).toEqual([
      {
        path: "provider",
        replacement: "provider",
        message: 'Replace provider "log" with "mock".',
      },
      {
        path: "twilio.from",
        replacement: "fromNumber",
        message: "Move twilio.from to fromNumber.",
      },
      {
        path: "streaming.sttProvider",
        replacement: "streaming.provider",
        message: "Move streaming.sttProvider to streaming.provider.",
      },
      {
        path: "streaming.openaiApiKey",
        replacement: "streaming.providers.openai.apiKey",
        message: "Move streaming.openaiApiKey to streaming.providers.openai.apiKey.",
      },
    ]);
    expect(
      formatVoiceCallLegacyConfigWarnings({
        value: raw,
        configPathPrefix: "plugins.entries.voice-call.config",
        doctorFixCommand: "openclaw doctor --fix",
      }),
    ).toEqual([
      `[voice-call] legacy config keys detected under plugins.entries.voice-call.config; runtime loading will not rewrite them, and support for the legacy shape will be removed in ${VOICE_CALL_LEGACY_CONFIG_REMOVAL_VERSION}. Run "openclaw doctor --fix".`,
      '[voice-call] plugins.entries.voice-call.config.provider: Replace provider "log" with "mock".',
      "[voice-call] plugins.entries.voice-call.config.twilio.from: Move twilio.from to fromNumber.",
      "[voice-call] plugins.entries.voice-call.config.streaming.sttProvider: Move streaming.sttProvider to streaming.provider.",
      "[voice-call] plugins.entries.voice-call.config.streaming.openaiApiKey: Move streaming.openaiApiKey to streaming.providers.openai.apiKey.",
    ]);
  });

  it("returns doctor migration change lines", () => {
    const migration = migrateVoiceCallLegacyConfigInput({
      value: {
        provider: "log",
        streaming: {
          sttProvider: "openai",
        },
      },
      configPathPrefix: "plugins.entries.voice-call.config",
    });

    expect(migration.changes).toEqual([
      'Moved plugins.entries.voice-call.config.provider "log" → "mock".',
      "Moved plugins.entries.voice-call.config.streaming.sttProvider → plugins.entries.voice-call.config.streaming.provider.",
    ]);
  });
});
