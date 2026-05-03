import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { copyA2uiAssets } from "../../scripts/canvas-a2ui-copy.js";
import { withTempDir } from "../test-utils/temp-dir.js";

const ORIGINAL_SKIP_MISSING = process.env.OPENCLAW_A2UI_SKIP_MISSING;
const ORIGINAL_SPARSE_PROFILE = process.env.OPENCLAW_SPARSE_PROFILE;

describe("canvas a2ui copy", () => {
  beforeEach(() => {
    delete process.env.OPENCLAW_A2UI_SKIP_MISSING;
    delete process.env.OPENCLAW_SPARSE_PROFILE;
  });

  afterEach(() => {
    if (ORIGINAL_SKIP_MISSING === undefined) {
      delete process.env.OPENCLAW_A2UI_SKIP_MISSING;
    } else {
      process.env.OPENCLAW_A2UI_SKIP_MISSING = ORIGINAL_SKIP_MISSING;
    }

    if (ORIGINAL_SPARSE_PROFILE === undefined) {
      delete process.env.OPENCLAW_SPARSE_PROFILE;
    } else {
      process.env.OPENCLAW_SPARSE_PROFILE = ORIGINAL_SPARSE_PROFILE;
    }
  });

  async function withA2uiFixture(run: (dir: string) => Promise<void>) {
    await withTempDir("openclaw-a2ui-", run);
  }

  it("throws a helpful error when assets are missing", async () => {
    await withA2uiFixture(async (dir) => {
      await expect(copyA2uiAssets({ srcDir: dir, outDir: path.join(dir, "out") })).rejects.toThrow(
        'Run "pnpm canvas:a2ui:bundle"',
      );
    });
  });

  it("skips missing assets when OPENCLAW_A2UI_SKIP_MISSING=1", async () => {
    await withA2uiFixture(async (dir) => {
      process.env.OPENCLAW_A2UI_SKIP_MISSING = "1";
      await expect(
        copyA2uiAssets({ srcDir: dir, outDir: path.join(dir, "out") }),
      ).resolves.toBeUndefined();
    });
  });

  it("skips missing assets when OPENCLAW_SPARSE_PROFILE is set", async () => {
    await withA2uiFixture(async (dir) => {
      process.env.OPENCLAW_SPARSE_PROFILE = "core";
      await expect(
        copyA2uiAssets({ srcDir: dir, outDir: path.join(dir, "out") }),
      ).resolves.toBeUndefined();
    });
  });

  it("copies bundled assets to dist", async () => {
    await withA2uiFixture(async (dir) => {
      const srcDir = path.join(dir, "src");
      const outDir = path.join(dir, "dist");
      await fs.mkdir(srcDir, { recursive: true });
      await fs.writeFile(path.join(srcDir, "index.html"), "<html></html>", "utf8");
      await fs.writeFile(path.join(srcDir, "a2ui.bundle.js"), "console.log(1);", "utf8");

      await copyA2uiAssets({ srcDir, outDir });

      await expect(fs.stat(path.join(outDir, "index.html"))).resolves.toBeTruthy();
      await expect(fs.stat(path.join(outDir, "a2ui.bundle.js"))).resolves.toBeTruthy();
    });
  });
});
