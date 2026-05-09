import type { OpenClawConfig } from "openclaw/plugin-sdk/config-types";
import { describe, expect, test } from "vitest";
import { migrateLegacyCanvasHostConfig } from "./config-migration.js";

describe("migrateLegacyCanvasHostConfig", () => {
  test("moves legacy canvasHost into the Canvas plugin config", () => {
    const result = migrateLegacyCanvasHostConfig({
      canvasHost: {
        enabled: false,
        root: "~/canvas",
        liveReload: false,
      },
    } as OpenClawConfig);

    if (!result) {
      throw new Error("expected Canvas config migration result");
    }
    expect(result.changes).toEqual(["migrated canvasHost to plugins.entries.canvas.config.host"]);
    expect(result.config).toEqual({
      plugins: {
        entries: {
          canvas: {
            config: {
              host: {
                enabled: false,
                root: "~/canvas",
                liveReload: false,
              },
            },
          },
        },
      },
    });
  });

  test("preserves plugin-owned Canvas host values when both shapes exist", () => {
    const result = migrateLegacyCanvasHostConfig({
      canvasHost: {
        enabled: false,
        root: "~/legacy-canvas",
        liveReload: false,
      },
      plugins: {
        entries: {
          canvas: {
            enabled: true,
            config: {
              host: {
                root: "~/plugin-canvas",
              },
            },
          },
        },
      },
    } as OpenClawConfig);

    if (!result) {
      throw new Error("expected Canvas config migration result");
    }
    expect(result.config).toEqual({
      plugins: {
        entries: {
          canvas: {
            enabled: true,
            config: {
              host: {
                enabled: false,
                root: "~/plugin-canvas",
                liveReload: false,
              },
            },
          },
        },
      },
    });
  });

  test("ignores configs without legacy canvasHost", () => {
    expect(migrateLegacyCanvasHostConfig({} as OpenClawConfig)).toBeNull();
  });
});
