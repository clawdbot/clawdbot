// Bundled Plugin Source Utils tests cover bundled plugin source utils script behavior.
import { describe, expect, it } from "vitest";
import { expectNoNodeFsScans } from "../../src/test-utils/fs-scan-assertions.js";

describe("scripts/lib/bundled-plugin-source-utils.mts", () => {
  it("discovers repo bundled plugin sources without scanning extension directories", () => {
    const payload = expectNoNodeFsScans<{
      channels: number;
      sources: number;
    }>(`
      const utils = await import("./scripts/lib/bundled-plugin-source-utils.mts");
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
