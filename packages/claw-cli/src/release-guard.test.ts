import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("standalone Claw CLI publication guard", () => {
  it("remains private and excluded from the OpenClaw npm release selector", async () => {
    const manifest = JSON.parse(
      await readFile(resolve("packages/claw-cli/package.json"), "utf8"),
    ) as {
      private?: boolean;
      version?: string;
      publishConfig?: unknown;
      openclaw?: { release?: { publishToNpm?: boolean } };
    };

    expect(manifest.private).toBe(true);
    expect(manifest.version).toBe("0.0.0-private");
    expect(manifest.publishConfig).toBeUndefined();
    expect(manifest.openclaw?.release?.publishToNpm).not.toBe(true);
  });
});
