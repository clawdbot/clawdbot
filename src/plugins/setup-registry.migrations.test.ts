// Covers bundled config migrations through the plugin setup registry.
import path from "node:path";
import { describe, expect, test } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { runPluginSetupConfigMigrations } from "./setup-registry.js";

function runMigration(config: OpenClawConfig) {
  return runPluginSetupConfigMigrations({
    env: {
      ...process.env,
      OPENCLAW_BUNDLED_PLUGINS_DIR: path.resolve("extensions"),
    },
    config,
  });
}

describe("bundled setup config migrations", () => {
  test("preserves Voice Call canonical settings and converges through the bundled registry", () => {
    const current = {
      apiKey: { source: "env", provider: "default", id: "SYNTHETIC_VOICE_KEY" },
      model: "synthetic-current-model",
      silenceDurationMs: 900,
      vadThreshold: 0,
      keep: "current",
    };
    const config = {
      plugins: {
        entries: {
          "voice-call": {
            enabled: false,
            config: {
              responseSystemPrompt: "synthetic-preserved-instructions",
              streaming: {
                openaiApiKey: "synthetic-legacy-key",
                sttModel: "synthetic-legacy-model",
                silenceDurationMs: 700,
                vadThreshold: 0.4,
                providers: { openai: current },
              },
            },
          },
        },
      },
    } satisfies OpenClawConfig;
    const before = structuredClone(config);
    const result = runMigration(config);

    expect(result.config.plugins?.entries?.["voice-call"]).toEqual({
      enabled: false,
      config: expect.objectContaining({
        responseSystemPrompt: "synthetic-preserved-instructions",
        streaming: { provider: undefined, providers: { openai: current } },
      }),
    });
    expect(result.changes).toHaveLength(4);
    expect(result.changes.every((change) => change.includes("(kept "))).toBe(true);
    expect(config).toEqual(before);
    expect(runMigration(result.config)).toEqual({ config: result.config, changes: [] });
  });

  test("repairs Tencent TokenHub model defaults", () => {
    const result = runMigration({
      agents: {
        defaults: {
          model: { primary: "tencent-tokenhub/hy3-preview" },
          models: {
            "tencent-tokenhub/hy3-preview": {},
          },
        },
      },
    });

    expect(result.changes).toEqual([
      "Updated Tencent TokenHub agent model defaults to include tencent-tokenhub/hy3 and tencent-tokenhub/hy3-preview.",
      "Changed Tencent TokenHub primary default from tencent-tokenhub/hy3-preview to tencent-tokenhub/hy3.",
    ]);
    expect(result.config.agents?.defaults?.model).toEqual({
      primary: "tencent-tokenhub/hy3",
    });
    expect(Object.keys(result.config.agents?.defaults?.models ?? {}).toSorted()).toEqual([
      "tencent-tokenhub/hy3",
      "tencent-tokenhub/hy3-preview",
    ]);
  });

  test("rewrites legacy canvasHost into the surviving plugin-owned switch", () => {
    const result = runMigration({
      canvasHost: {
        enabled: false,
        root: "~/legacy-canvas",
        liveReload: false,
      },
    } as OpenClawConfig);

    expect(result.changes).toEqual([
      "Migrated canvasHost.enabled to plugins.entries.canvas.config.host.enabled.",
    ]);
    expect(result.config).toEqual({
      plugins: {
        entries: {
          canvas: {
            config: {
              host: {
                enabled: false,
              },
            },
          },
        },
      },
    });
  });
});
