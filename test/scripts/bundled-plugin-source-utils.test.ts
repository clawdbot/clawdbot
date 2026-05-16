import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { collectBundledPluginSources } from "../../scripts/lib/bundled-plugin-source-utils.mjs";

describe("scripts/lib/bundled-plugin-source-utils.mjs", () => {
  it("collects bundled plugin sources with package metadata", () => {
    const sources = collectBundledPluginSources({
      repoRoot: process.cwd(),
      requirePackageJson: true,
    });

    expect(sources.some((source) => source.dirName === "telegram")).toBe(true);
    expect(sources.every((source) => source.packageJsonPath)).toBe(true);
    expect(sources).toEqual(
      [...sources].toSorted((left, right) => left.dirName.localeCompare(right.dirName)),
    );
  });

  it("discovers repo bundled plugin sources without scanning extension directories", () => {
    const output = execFileSync(
      process.execPath,
      [
        "--input-type=module",
        "--eval",
        `
          import fs from "node:fs";
          import { syncBuiltinESMExports } from "node:module";
          const counts = { existsSync: 0, readdirSync: 0 };
          const originalExistsSync = fs.existsSync;
          const originalReaddirSync = fs.readdirSync;
          fs.existsSync = (...args) => {
            counts.existsSync += 1;
            return originalExistsSync(...args);
          };
          fs.readdirSync = (...args) => {
            counts.readdirSync += 1;
            return originalReaddirSync(...args);
          };
          syncBuiltinESMExports();
          const utils = await import("./scripts/lib/bundled-plugin-source-utils.mjs");
          const sources = utils.collectBundledPluginSources({
            repoRoot: process.cwd(),
            requirePackageJson: true,
          });
          console.log(JSON.stringify({
            channels: sources.filter((source) => Array.isArray(source.manifest?.channels) && source.manifest.channels.length > 0).length,
            counts,
            sources: sources.length,
          }));
        `,
      ],
      {
        cwd: process.cwd(),
        encoding: "utf8",
      },
    );

    const payload = JSON.parse(output) as {
      channels: number;
      counts: { existsSync: number; readdirSync: number };
      sources: number;
    };
    expect(payload.sources).toBeGreaterThan(0);
    expect(payload.channels).toBeGreaterThan(0);
    expect(payload.counts).toEqual({ existsSync: 0, readdirSync: 0 });
  });
});
