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

  test("rewrites legacy canvasHost into plugin-owned config", () => {
    const result = runMigration({
      canvasHost: {
        enabled: false,
        root: "~/legacy-canvas",
        liveReload: false,
      },
    } as OpenClawConfig);

    expect(result.changes).toEqual(["migrated canvasHost to plugins.entries.canvas.config.host"]);
    expect(result.config).toEqual({
      plugins: {
        entries: {
          canvas: {
            config: {
              host: {
                enabled: false,
                root: "~/legacy-canvas",
                liveReload: false,
              },
            },
          },
        },
      },
    });
  });
});
