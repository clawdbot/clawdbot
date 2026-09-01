import fs from "node:fs/promises";
import path from "node:path";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { withTempHome } from "openclaw/plugin-sdk/test-env";
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

  it("retains an unresolved source root for a later resolved repair", () => {
    const config: OpenClawConfig = {
      plugins: { entries: { canvas: { config: { host: { root: "${CANVAS_MIGRATION_ROOT}" } } } } },
    };
    expect(migrateCanvasHostConfig(config)).toBeNull();
  });

  it("moves an unresolved older root into the pending plugin setting", () => {
    const root = "${CANVAS_MIGRATION_ROOT}";
    const result = migrateCanvasHostConfig({ canvasHost: { root } } as OpenClawConfig);
    expect(result?.config).toEqual({
      plugins: { entries: { canvas: { config: { host: { root } } } } },
    });
    expect(migrateCanvasHostConfig(result!.config)).toBeNull();
  });

  it.each(["inherited", "empty", "replaced"] as const)(
    "preserves the shipped root precedence when the plugin root is %s",
    async (scenario) => {
      await withTempHome(async (home) => {
        const legacyRoot = path.join(home, "legacy-canvas");
        const document = path.join(legacyRoot, "documents", "cv_existing");
        await fs.mkdir(document, { recursive: true });
        await fs.writeFile(path.join(document, "index.html"), "legacy");
        const root = scenario === "empty" ? "" : path.join(home, "unused-canvas");
        const result = migrateCanvasHostConfig({
          canvasHost: { enabled: false, root: legacyRoot },
          plugins: {
            entries: {
              canvas: {
                config: {
                  host: {
                    enabled: true,
                    ...(scenario === "inherited" ? {} : { root }),
                  },
                },
              },
            },
          },
        } as OpenClawConfig);
        expect(result?.config.plugins?.entries?.canvas?.config?.host).toEqual({
          enabled: true,
          ...(scenario === "inherited" ? { root: legacyRoot } : {}),
        });
        expect(result?.config).not.toHaveProperty("canvasHost");
        await expect(fs.readFile(path.join(document, "index.html"), "utf8")).resolves.toBe(
          "legacy",
        );
      });
    },
  );
});
