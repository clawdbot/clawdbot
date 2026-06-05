// Voice Call tests cover config compat plugin behavior.
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

    const streaming = normalized.streaming as
      | {
          enabled?: boolean;
          provider?: string;
          providers?: {
            openai?: {
              apiKey?: string;
              model?: string;
              silenceDurationMs?: number;
              vadThreshold?: number;
            };
          };
          openaiApiKey?: unknown;
          sttModel?: unknown;
        }
      | undefined;
    expect(streaming?.enabled).toBe(true);
    expect(streaming?.provider).toBe("openai");
    expect(streaming?.providers?.openai).toEqual({
      apiKey: "sk-test",
      model: "gpt-4o-transcribe",
      silenceDurationMs: 700,
      vadThreshold: 0.4,
    });
    expect(streaming?.openaiApiKey).toBeUndefined();
    expect(streaming?.sttModel).toBeUndefined();
  });

  it("removes legacy realtime agentContext system prompt toggle", () => {
    const normalized = normalizeVoiceCallLegacyConfigInput({
      realtime: {
        agentContext: {
          enabled: true,
          includeSystemPrompt: false,
          includeWorkspaceFiles: true,
        },
      },
    });

    const agentContext = (
      normalized.realtime as
        | {
            agentContext?: {
              enabled?: boolean;
              includeSystemPrompt?: unknown;
              includeWorkspaceFiles?: boolean;
            };
          }
        | undefined
    )?.agentContext;

    expect(agentContext).toEqual({
      enabled: true,
      includeWorkspaceFiles: true,
    });
  });

  it("does not migrate non-finite legacy streaming numbers", () => {
    const migration = migrateVoiceCallLegacyConfigInput({
      value: {
        streaming: {
          silenceDurationMs: Number.NaN,
          vadThreshold: Number.POSITIVE_INFINITY,
        },
      },
      configPathPrefix: "plugins.entries.voice-call.config",
    });
    const streaming = migration.config.streaming as
      | {
          providers?: {
            openai?: {
              silenceDurationMs?: number;
              vadThreshold?: number;
            };
          };
        }
      | undefined;

    expect(streaming?.providers?.openai).toBeUndefined();
    expect(migration.changes).toEqual([
      "Removed invalid plugins.entries.voice-call.config.streaming.silenceDurationMs.",
      "Removed invalid plugins.entries.voice-call.config.streaming.vadThreshold.",
    ]);
    expect(migration.issues.map((issue) => issue.path)).toEqual([
      "streaming.silenceDurationMs",
      "streaming.vadThreshold",
    ]);
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
      realtime: {
        agentContext: {
          includeSystemPrompt: true,
        },
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
      {
        path: "realtime.agentContext.includeSystemPrompt",
        replacement: "realtime.agentContext",
        message:
          "Remove realtime.agentContext.includeSystemPrompt; realtime context now uses the generated agent prompt.",
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
      "[voice-call] plugins.entries.voice-call.config.realtime.agentContext.includeSystemPrompt: Remove realtime.agentContext.includeSystemPrompt; realtime context now uses the generated agent prompt.",
    ]);
  });

  it("returns doctor migration change lines", () => {
    const migration = migrateVoiceCallLegacyConfigInput({
      value: {
        provider: "log",
        streaming: {
          sttProvider: "openai",
        },
        realtime: {
          agentContext: {
            includeSystemPrompt: true,
          },
        },
      },
      configPathPrefix: "plugins.entries.voice-call.config",
    });

    expect(migration.changes).toEqual([
      'Moved plugins.entries.voice-call.config.provider "log" → "mock".',
      "Moved plugins.entries.voice-call.config.streaming.sttProvider → plugins.entries.voice-call.config.streaming.provider.",
      "Removed plugins.entries.voice-call.config.realtime.agentContext.includeSystemPrompt.",
    ]);
  });
});
