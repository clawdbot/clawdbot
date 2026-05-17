import { describe, expect, it } from "vitest";
import { collectBundledPluginSources } from "../../scripts/lib/bundled-plugin-source-utils.mjs";
import { expectNoNodeFsScans } from "../../src/test-utils/fs-scan-assertions.js";

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
    const payload = expectNoNodeFsScans<{
      channels: number;
      sources: number;
    }>(`
      const utils = await import("./scripts/lib/bundled-plugin-source-utils.mjs");
      const sources = utils.collectBundledPluginSources({
        repoRoot: process.cwd(),
        requirePackageJson: true,
      });
      return {
        channels: sources.filter(
          (source) => Array.isArray(source.manifest?.channels) && source.manifest.channels.length > 0,
        ).length,
        sources: sources.length,
      };
    `);
    expect(payload.sources).toBeGreaterThan(0);
    expect(payload.channels).toBeGreaterThan(0);
  });
});
