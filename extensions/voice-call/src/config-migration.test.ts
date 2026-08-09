// Voice Call tests cover setup-time config migration behavior.
import { describe, expect, it } from "vitest";
import { migrateVoiceCallLegacyConfigInput } from "./config-migration.js";

describe("voice-call config migration", () => {
  it("maps deprecated provider and twilio.from fields into canonical config", () => {
    const migration = migrateVoiceCallLegacyConfigInput({
      value: {
        enabled: true,
        provider: "log",
        twilio: {
          from: "+15550001234",
        },
      },
    });

    expect(migration.config.provider).toBe("mock");
    expect(migration.config.fromNumber).toBe("+15550001234");
  });

  it("moves legacy streaming OpenAI fields into streaming.providers.openai", () => {
    const migration = migrateVoiceCallLegacyConfigInput({
      value: {
        streaming: {
          enabled: true,
          sttProvider: "openai",
          openaiApiKey: "test",
          sttModel: "gpt-4o-transcribe",
          silenceDurationMs: 700,
          vadThreshold: 0.4,
        },
      },
    });

    const streaming = migration.config.streaming as
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
      apiKey: "test",
      model: "gpt-4o-transcribe",
      silenceDurationMs: 700,
      vadThreshold: 0.4,
    });
    expect(streaming?.openaiApiKey).toBeUndefined();
    expect(streaming?.sttModel).toBeUndefined();
  });

  it("removes legacy realtime agentContext system prompt toggle", () => {
    const migration = migrateVoiceCallLegacyConfigInput({
      value: {
        realtime: {
          agentContext: {
            enabled: true,
            includeSystemPrompt: false,
            includeWorkspaceFiles: true,
          },
        },
      },
    });

    const agentContext = (
      migration.config.realtime as
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
