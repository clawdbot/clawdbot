// Verifies channel config loading surfaces visible plugin settings.
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadChannelConfigSurfaceModule } from "../../scripts/load-channel-config-surface.ts";
import { withTempDir } from "../test-helpers/temp-dir.js";

function createDemoModule(repoRoot: string, filename: string, source: string): string {
  const packageRoot = path.join(repoRoot, "extensions", "demo");
  const modulePath = path.join(packageRoot, "src", filename);
  fs.mkdirSync(path.dirname(modulePath), { recursive: true });
  fs.writeFileSync(
    path.join(packageRoot, "package.json"),
    JSON.stringify({ name: "@openclaw/demo", type: "module" }),
    "utf8",
  );
  fs.writeFileSync(modulePath, source, "utf8");
  return modulePath;
}

describe("loadChannelConfigSurfaceModule", () => {
  it("loads TypeScript through plugin SDK aliases", async () => {
    await withTempDir({ prefix: "openclaw-config-surface-" }, async (repoRoot) => {
      const modulePath = createDemoModule(
        repoRoot,
        "config-schema.ts",
        `
          import { buildJsonChannelConfigSchema } from "openclaw/plugin-sdk/channel-config-schema";

          const label: string = "OK";
          export const DemoChannelConfigSchema = buildJsonChannelConfigSchema(
            { type: "object", additionalProperties: false, properties: {} },
            { uiHints: { ok: { label } } },
          );
        `,
      );

      await expect(loadChannelConfigSurfaceModule(modulePath)).resolves.toMatchObject({
        schema: { type: "object", additionalProperties: false, properties: {} },
        uiHints: { ok: { label: "OK" } },
      });
    });
  });

  it("wraps a raw config schema loaded natively", async () => {
    await withTempDir({ prefix: "openclaw-config-surface-" }, async (repoRoot) => {
      const modulePath = createDemoModule(
        repoRoot,
        "config-schema.mjs",
        `
          export const DemoConfigSchema = {
            toJSONSchema: () => ({
              type: "object",
              properties: { count: { type: "number" } },
            }),
            safeParse: (value) => ({ success: true, data: value }),
          };
        `,
      );

      await expect(loadChannelConfigSurfaceModule(modulePath)).resolves.toMatchObject({
        schema: { type: "object", properties: { count: { type: "number" } } },
      });
    });
  });

  it("returns null without a config schema export", async () => {
    await withTempDir({ prefix: "openclaw-config-surface-" }, async (repoRoot) => {
      const modulePath = createDemoModule(
        repoRoot,
        "config-schema.mjs",
        "export const unrelated = true;",
      );

      await expect(loadChannelConfigSurfaceModule(modulePath)).resolves.toBeNull();
    });
  });

  it("rejects invalid module source", async () => {
    await withTempDir({ prefix: "openclaw-config-surface-" }, async (repoRoot) => {
      const modulePath = createDemoModule(repoRoot, "config-schema.ts", "export const = ;");

      await expect(loadChannelConfigSurfaceModule(modulePath)).rejects.toThrow();
    });
  });
});
