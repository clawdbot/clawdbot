import path from "node:path";
import { describe, expect, test } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { runPluginSetupConfigMigrations } from "./setup-registry.js";

describe("Canvas setup config migration", () => {
  test("rewrites legacy canvasHost into plugin-owned config", () => {
    const result = runPluginSetupConfigMigrations({
      env: {
        ...process.env,
        OPENCLAW_BUNDLED_PLUGINS_DIR: path.resolve("extensions"),
      },
      config: {
        canvasHost: {
          enabled: false,
          root: "~/legacy-canvas",
          liveReload: false,
        },
      } as OpenClawConfig,
    });

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
