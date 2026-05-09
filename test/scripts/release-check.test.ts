import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { writePackedBundledPluginActivationConfig } from "../../scripts/release-check.ts";

function requirePluginEntries(config: { plugins?: { entries?: Record<string, unknown> } }) {
  if (!config.plugins?.entries) {
    throw new Error("Expected plugin entries in packaged activation config");
  }
  return config.plugins.entries;
}

describe("release-check", () => {
  it("seeds packaged activation smoke with an included channel plugin", () => {
    const homeDir = mkdtempSync(join(tmpdir(), "openclaw-release-check-test-"));
    try {
      writePackedBundledPluginActivationConfig(homeDir);
      const config = JSON.parse(
        readFileSync(join(homeDir, ".openclaw", "openclaw.json"), "utf8"),
      ) as {
        channels?: Record<string, unknown>;
        plugins?: { entries?: Record<string, unknown> };
      };

      expect(config.channels).toHaveProperty("matrix");
      const pluginEntries = requirePluginEntries(config);
      expect(pluginEntries).toHaveProperty("matrix");
      expect(config.channels).not.toHaveProperty("feishu");
      expect(pluginEntries).not.toHaveProperty("feishu");
    } finally {
      rmSync(homeDir, { recursive: true, force: true });
    }
  });
});
