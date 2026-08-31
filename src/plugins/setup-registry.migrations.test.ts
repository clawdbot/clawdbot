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
  test("repairs legacy empty MiniMax OAuth model catalogs", () => {
    const result = runMigration({
      agents: {
        defaults: {
          models: {
            "minimax-portal/MiniMax-M3": { alias: "minimax-m3" },
            "minimax-portal/MiniMax-M2.7": { alias: "minimax-m2.7" },
            "minimax-portal/MiniMax-M2.7-highspeed": { alias: "minimax-m2.7-highspeed" },
          },
        },
      },
      models: {
        providers: {
          "minimax-portal": {
            baseUrl: "https://api.minimax.io/anthropic",
            api: "anthropic-messages",
            authHeader: true,
            models: [],
          },
        },
      },
    });

    expect(result.changes).toEqual([
      "restored the MiniMax OAuth model catalog for a legacy empty provider entry",
    ]);
    expect(result.config.models?.providers?.["minimax-portal"]?.models).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "MiniMax-M3", contextWindow: 1_000_000 }),
      ]),
    );
  });

  test("preserves intentionally empty MiniMax OAuth model catalogs without legacy aliases", () => {
    const result = runMigration({
      models: {
        providers: {
          "minimax-portal": {
            baseUrl: "https://api.minimax.io/anthropic",
            api: "anthropic-messages",
            authHeader: true,
            models: [],
          },
        },
      },
    });

    expect(result.changes).toEqual([]);
    expect(result.config.models?.providers?.["minimax-portal"]?.models).toEqual([]);
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
