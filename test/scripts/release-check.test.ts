import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { writePackedBundledPluginActivationConfig } from "../../scripts/release-check.ts";

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
      expect(config.plugins?.entries).toHaveProperty("matrix");
      expect(config.channels).not.toHaveProperty("feishu");
      expect(config.plugins?.entries).not.toHaveProperty("feishu");
    } finally {
      rmSync(homeDir, { recursive: true, force: true });
    }
  });
});
