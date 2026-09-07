import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import {
  canvasConfigSchema,
  isCanvasHostEnabled,
  parseCanvasPluginConfig,
  resolveCanvasHostConfig,
} from "./config.js";

describe("Canvas presenter config", () => {
  const originalSkipCanvasHost = process.env.OPENCLAW_SKIP_CANVAS_HOST;

  afterEach(() => {
    if (originalSkipCanvasHost === undefined) {
      delete process.env.OPENCLAW_SKIP_CANVAS_HOST;
    } else {
      process.env.OPENCLAW_SKIP_CANVAS_HOST = originalSkipCanvasHost;
    }
  });

  it("keeps the single host enablement switch manifest-owned", () => {
    const manifest = JSON.parse(
      readFileSync(new URL("../openclaw.plugin.json", import.meta.url), "utf8"),
    ) as { uiHints?: Record<string, Record<string, unknown>> };

    expect(canvasConfigSchema).not.toHaveProperty("uiHints");
    expect(manifest.uiHints).toEqual({
      host: {
        label: "Widget Presenter",
        help: "Controls hosted widget document and renderer routes.",
        advanced: true,
      },
      "host.enabled": {
        label: "Widget Presenter Enabled",
        advanced: true,
      },
    });
  });

  it("parses and resolves only host.enabled", () => {
    expect(
      parseCanvasPluginConfig({
        host: { enabled: false, root: "~/canvas", port: 18793, liveReload: true },
      }),
    ).toEqual({ host: { enabled: false } });
    expect(
      resolveCanvasHostConfig({
        config: {
          plugins: { entries: { canvas: { config: { host: { enabled: false } } } } },
        },
      }),
    ).toEqual({ enabled: false });
  });

  it("uses host.enabled as the route gate", () => {
    expect(isCanvasHostEnabled()).toBe(true);
    expect(
      isCanvasHostEnabled({
        plugins: { entries: { canvas: { config: { host: { enabled: false } } } } },
      }),
    ).toBe(false);
  });

  it("honors the internal skip-host test switch", () => {
    process.env.OPENCLAW_SKIP_CANVAS_HOST = "1";
    expect(isCanvasHostEnabled()).toBe(false);
  });
});
