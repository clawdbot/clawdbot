// Voice Call tests cover setup-time config migration behavior.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { migrateVoiceCallLegacyConfigInput } from "./config-migration.js";
import { VoiceCallConfigSchema } from "./config.js";

describe("voice-call config migration", () => {
  it("declares the setup entry needed to migrate installed packages", () => {
    const packageJson: unknown = JSON.parse(
      readFileSync(new URL("../package.json", import.meta.url), "utf8"),
    );
    expect(packageJson).toMatchObject({ openclaw: { setupEntry: "./setup-api.ts" } });
  });

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

  it.each([
    { label: "legacy-only", current: undefined },
    {
      label: "all canonical fields",
      current: {
        apiKey: "synthetic-current-key",
        model: "synthetic-current-model",
        silenceDurationMs: 900,
        vadThreshold: 0.8,
        keep: { setting: "current" },
      },
    },
    {
      label: "partial canonical fields and a SecretRef",
      current: {
        apiKey: { source: "env", provider: "default", id: "SYNTHETIC_VOICE_KEY" },
        vadThreshold: 0,
        keep: "current",
      },
    },
    {
      label: "explicit empty and zero canonical fields",
      current: { apiKey: "", model: "", silenceDurationMs: 0, vadThreshold: 0 },
    },
  ] satisfies Array<{ label: string; current: Record<string, unknown> | undefined }>)(
    "fills only missing streaming provider fields with $label",
    ({ current }) => {
      const value = {
        streaming: {
          enabled: true,
          sttProvider: "openai",
          openaiApiKey: "synthetic-legacy-key",
          sttModel: "synthetic-legacy-model",
          silenceDurationMs: 700,
          vadThreshold: 0.4,
          providers: { openai: current, other: { keep: "other-provider" } },
        },
      };
      const before = structuredClone(value);
      const migration = migrateVoiceCallLegacyConfigInput({ value });

      expect(migration.config.streaming).toEqual({
        enabled: true,
        provider: "openai",
        providers: {
          other: { keep: "other-provider" },
          openai: {
            apiKey: "synthetic-legacy-key",
            model: "synthetic-legacy-model",
            silenceDurationMs: 700,
            vadThreshold: 0.4,
            ...current,
          },
        },
      });
      const prefix = "plugins.entries.voice-call.config.streaming";
      expect(migration.changes).toEqual([
        `Moved ${prefix}.sttProvider → ${prefix}.provider.`,
        ...(
          [
            ["openaiApiKey", "apiKey"],
            ["sttModel", "model"],
            ["silenceDurationMs", "silenceDurationMs"],
            ["vadThreshold", "vadThreshold"],
          ] as const
        ).map(([legacy, canonical]) => {
          const target = `${prefix}.providers.openai.${canonical}`;
          return current?.[canonical] !== undefined
            ? `Removed ${prefix}.${legacy} (kept ${target}).`
            : `Moved ${prefix}.${legacy} → ${target}.`;
        }),
      ]);
      expect(value).toEqual(before);
      expect(VoiceCallConfigSchema.safeParse(migration.config).success).toBe(true);
      expect(migrateVoiceCallLegacyConfigInput({ value: migration.config })).toEqual({
        config: migration.config,
        changes: [],
      });
    },
  );

  it("reports removal of legacy selectors while retaining canonical settings", () => {
    const migration = migrateVoiceCallLegacyConfigInput({
      value: {
        fromNumber: "+15550005678",
        twilio: { from: "+15550001234", accountSid: "synthetic-account" },
        streaming: { provider: "other", sttProvider: "openai" },
      },
      configPathPrefix: "voice-config",
    });

    expect(migration.config).toMatchObject({
      fromNumber: "+15550005678",
      twilio: { accountSid: "synthetic-account" },
      streaming: { provider: "other" },
    });
    expect(migration.config.twilio).not.toHaveProperty("from");
    expect(migration.config.streaming).not.toHaveProperty("sttProvider");
    expect(migration.changes).toEqual([
      "Removed voice-config.twilio.from (kept voice-config.fromNumber).",
      "Removed voice-config.streaming.sttProvider (kept voice-config.streaming.provider).",
    ]);
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
