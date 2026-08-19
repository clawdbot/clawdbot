// Canvas tests cover config plugin behavior.
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import {
  canvasConfigSchema,
  isCanvasHostEnabled,
  isCanvasPluginEnabled,
  parseCanvasPluginConfig,
  resolveCanvasHostConfig,
} from "./config.js";

describe("Canvas plugin config", () => {
  const originalSkipCanvasHost = process.env.OPENCLAW_SKIP_CANVAS_HOST;

  afterEach(() => {
    if (originalSkipCanvasHost === undefined) {
      delete process.env.OPENCLAW_SKIP_CANVAS_HOST;
    } else {
      process.env.OPENCLAW_SKIP_CANVAS_HOST = originalSkipCanvasHost;
    }
  });

  it("keeps host config presentation metadata manifest-owned", () => {
    const manifest = JSON.parse(
      readFileSync(new URL("../openclaw.plugin.json", import.meta.url), "utf8"),
    ) as { uiHints?: Record<string, Record<string, unknown>> };

    expect(canvasConfigSchema).not.toHaveProperty("uiHints");
    expect(manifest.uiHints).toEqual({
      host: {
        label: "Canvas Host",
        help: "Serves local Canvas and A2UI files for paired nodes.",
        advanced: true,
      },
      "host.enabled": {
        label: "Canvas Host Enabled",
        advanced: true,
      },
      "host.root": {
        label: "Canvas Host Root Directory",
        help: "Directory to serve. Defaults to the OpenClaw state canvas directory.",
        advanced: true,
      },
      "host.port": {
        label: "Canvas Host Port",
        advanced: true,
      },
      "host.liveReload": {
        label: "Canvas Host Live Reload",
        advanced: true,
      },
    });
  });

  it("parses host config from the plugin entry", () => {
    expect(
      parseCanvasPluginConfig({
        host: {
          enabled: false,
          root: "~/canvas",
          port: 18793,
          liveReload: false,
          ignored: true,
        },
      }),
    ).toEqual({
      host: {
        enabled: false,
        root: "~/canvas",
        port: 18793,
        liveReload: false,
      },
    });
  });

  it("resolves host config from the plugin entry only", () => {
    expect(
      resolveCanvasHostConfig({
        config: {
          plugins: {
            entries: {
              canvas: {
                config: {
                  host: {
                    enabled: false,
                    root: "/plugin",
                    liveReload: false,
                  },
                },
              },
            },
          },
        },
      }),
    ).toEqual({
      enabled: false,
      root: "/plugin",
      liveReload: false,
    });
  });

  it("disables the host when the bundled Canvas plugin is disabled", () => {
    const config = {
      plugins: {
        entries: {
          canvas: {
            enabled: false,
          },
        },
      },
    };
    expect(isCanvasPluginEnabled(config)).toBe(false);
    expect(isCanvasHostEnabled(config)).toBe(false);
  });

  it("honors truthy skip-canvas env values before host registration", () => {
    for (const value of ["1", "true", " yes ", "ON"]) {
      process.env.OPENCLAW_SKIP_CANVAS_HOST = value;
      expect(isCanvasHostEnabled()).toBe(false);
    }
  });
});
