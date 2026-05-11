import fs from "node:fs/promises";
import path from "node:path";
import { resolvePreferredOpenClawTmpDir, withTempWorkspace } from "openclaw/plugin-sdk/temp-path";
import { describe, expect, it } from "vitest";
import { normalizeUrlPath, resolveFileWithinRoot } from "./file-resolver.js";

type ResolvedFile = NonNullable<Awaited<ReturnType<typeof resolveFileWithinRoot>>>;

async function withCanvasTemp<T>(prefix: string, run: (dir: string) => Promise<T>): Promise<T> {
  return await withTempWorkspace(
    { rootDir: resolvePreferredOpenClawTmpDir(), prefix },
    async ({ dir }) => await run(dir),
  );
}

function expectResolvedFile(
  result: Awaited<ReturnType<typeof resolveFileWithinRoot>>,
): ResolvedFile {
  if (result === null) {
    throw new Error("Expected resolved file within root");
  }
  expect(typeof result.handle.close).toBe("function");
  expect(typeof result.handle.readFile).toBe("function");
  return result;
}

describe("resolveFileWithinRoot", () => {
  it("normalizes URL paths", () => {
    expect(normalizeUrlPath("/nested/../file.txt")).toBe("/file.txt");
    expect(normalizeUrlPath("plain.txt")).toBe("/plain.txt");
  });

  it("opens directory index files through the fs-safe root", async () => {
    await withCanvasTemp("openclaw-canvas-resolver-", async (root) => {
      await fs.mkdir(path.join(root, "docs"), { recursive: true });
      await fs.writeFile(path.join(root, "docs", "index.html"), "<h1>docs</h1>");

      const result = await resolveFileWithinRoot(root, "/docs");
      const resolved = expectResolvedFile(result);
      try {
        await expect(resolved.handle.readFile({ encoding: "utf8" })).resolves.toBe("<h1>docs</h1>");
      } finally {
        await resolved.handle.close().catch(() => {});
      }
    });
  });

  it("rejects traversal paths", async () => {
    await withCanvasTemp("openclaw-canvas-resolver-", async (root) => {
      await expect(resolveFileWithinRoot(root, "/../outside.txt")).resolves.toBeNull();
    });
  });

  it.runIf(process.platform !== "win32")("rejects symlink entries", async () => {
    await withCanvasTemp("openclaw-canvas-resolver-", async (root) => {
      await withCanvasTemp("openclaw-canvas-resolver-outside-", async (outside) => {
        const target = path.join(outside, "outside.html");
        const link = path.join(root, "link.html");
        await fs.writeFile(target, "outside");
        await fs.symlink(target, link);

        await expect(resolveFileWithinRoot(root, "/link.html")).resolves.toBeNull();
      });
    });
  });
});
