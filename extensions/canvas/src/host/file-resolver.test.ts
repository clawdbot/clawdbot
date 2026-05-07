import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createTrackedTempDirs } from "../../../../src/test-utils/tracked-temp-dirs.js";
import { normalizeUrlPath, resolveFileWithinRoot } from "./file-resolver.js";

const tempDirs = createTrackedTempDirs();

afterEach(async () => {
  await tempDirs.cleanup();
});

describe("resolveFileWithinRoot", () => {
  it("normalizes URL paths", () => {
    expect(normalizeUrlPath("/nested/../file.txt")).toBe("/file.txt");
    expect(normalizeUrlPath("plain.txt")).toBe("/plain.txt");
  });

  it("opens directory index files through the fs-safe root", async () => {
    const root = await tempDirs.make("openclaw-canvas-resolver-");
    await fs.mkdir(path.join(root, "docs"), { recursive: true });
    await fs.writeFile(path.join(root, "docs", "index.html"), "<h1>docs</h1>");

    const result = await resolveFileWithinRoot(root, "/docs");
    expect(result).not.toBeNull();
    try {
      await expect(result?.handle.readFile({ encoding: "utf8" })).resolves.toBe("<h1>docs</h1>");
    } finally {
      await result?.handle.close().catch(() => {});
    }
  });

  it("rejects traversal paths", async () => {
    const root = await tempDirs.make("openclaw-canvas-resolver-");

    await expect(resolveFileWithinRoot(root, "/../outside.txt")).resolves.toBeNull();
  });

  it.runIf(process.platform !== "win32")("rejects symlink entries", async () => {
    const root = await tempDirs.make("openclaw-canvas-resolver-");
    const outside = await tempDirs.make("openclaw-canvas-resolver-outside-");
    const target = path.join(outside, "outside.html");
    const link = path.join(root, "link.html");
    await fs.writeFile(target, "outside");
    await fs.symlink(target, link);

    await expect(resolveFileWithinRoot(root, "/link.html")).resolves.toBeNull();
  });
});
