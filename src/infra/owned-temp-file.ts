import "./fs-safe-defaults.js";
import fs from "node:fs/promises";
import path from "node:path";
import { withTempFile } from "@openclaw/fs-safe/advanced";
import { FsSafeError } from "@openclaw/fs-safe/errors";
import { root } from "@openclaw/fs-safe/root";

async function inspectDirectory(dir: string) {
  const stat = await fs.lstat(dir, { bigint: true });
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    (process.platform === "win32" && (stat.dev === 0n || stat.ino === 0n))
  ) {
    throw new FsSafeError("path-mismatch", "temporary output directory identity is unavailable");
  }
  return { dev: stat.dev, ino: stat.ino, realPath: await fs.realpath(dir) };
}

async function guardDirectory(dir: string) {
  const expected = await inspectDirectory(dir);
  return async () => {
    const current = await inspectDirectory(dir);
    if (
      current.dev !== expected.dev ||
      current.ino !== expected.ino ||
      current.realPath !== expected.realPath
    ) {
      throw new FsSafeError("path-mismatch", "temporary output directory changed during write");
    }
  };
}

// Capture cleanup ownership before a producer can leave partial output. Root.move
// guards aliases; the lifetime guards also retain exact Windows directory IDs.
export async function writeOwnedTempFile<T>(
  tempPath: string,
  write: (filePath: string) => Promise<T>,
): Promise<T> {
  const parent = path.dirname(tempPath);
  const assertParent = await guardDirectory(parent);
  const targetRoot = await root(parent);
  return await withTempFile(
    {
      rootDir: targetRoot.rootReal,
      prefix: "openclaw-output",
      fileName: path.basename(tempPath),
    },
    async (filePath) => {
      const assertWorkspace = await guardDirectory(path.dirname(filePath));
      const result = await write(filePath);
      await assertWorkspace();
      await assertParent();
      await targetRoot.move(path.relative(targetRoot.rootReal, filePath), path.basename(tempPath));
      return result;
    },
  );
}
