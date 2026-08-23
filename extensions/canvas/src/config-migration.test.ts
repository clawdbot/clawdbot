import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { describe, expect, it } from "vitest";
import { migrateCanvasHostConfig } from "./config-migration.js";

describe("migrateCanvasHostConfig", () => {
  it("keeps only enabled from the legacy root host config", () => {
    const result = migrateCanvasHostConfig({
      canvasHost: { enabled: false, root: "~/canvas", port: 18793, liveReload: true },
    } as OpenClawConfig);

    expect(result).toEqual({
      config: {
        plugins: {
          entries: { canvas: { config: { host: { enabled: false } } } },
        },
      },
      changes: ["Migrated canvasHost.enabled to plugins.entries.canvas.config.host.enabled."],
    });
  });

  it("strips retired plugin host keys and preserves explicit plugin enablement", () => {
    const host = { enabled: true, root: "~/current", port: 18793, liveReload: false };
    const config = {
      canvasHost: { enabled: false, root: "~/legacy" },
      plugins: {
        entries: {
          canvas: {
            enabled: true,
            config: {
              host,
            },
          },
        },
      },
    } as OpenClawConfig;

    const result = migrateCanvasHostConfig(config);

    expect(result?.config).toEqual({
      plugins: {
        entries: {
          canvas: { enabled: true, config: { host: { enabled: true } } },
        },
      },
    });
    expect(result?.changes).toEqual([
      "Migrated canvasHost.enabled to plugins.entries.canvas.config.host.enabled.",
      "Removed retired Canvas host config: plugins.entries.canvas.config.host.root, plugins.entries.canvas.config.host.port, plugins.entries.canvas.config.host.liveReload.",
    ]);
    expect(host).toEqual({
      enabled: true,
      root: "~/current",
      port: 18793,
      liveReload: false,
    });
  });

  it("removes an empty retired host object without creating replacement config", () => {
    expect(
      migrateCanvasHostConfig({
        plugins: { entries: { canvas: { config: { host: { root: "~/canvas" } } } } },
      }),
    ).toEqual({
      config: { plugins: { entries: { canvas: { config: {} } } } },
      changes: ["Removed retired Canvas host config: plugins.entries.canvas.config.host.root."],
    });
  });

  it("is idempotent for canonical or absent config", () => {
    expect(migrateCanvasHostConfig({} as OpenClawConfig)).toBeNull();
    expect(
      migrateCanvasHostConfig({
        plugins: { entries: { canvas: { config: { host: { enabled: true } } } } },
      }),
    ).toBeNull();
  });
});
