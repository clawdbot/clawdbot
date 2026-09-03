import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { replaceFileAtomic } from "openclaw/plugin-sdk/security-runtime";

export function buildPromotionMarker(candidateKey: string): string {
  return `<!-- openclaw-memory-promotion:${candidateKey} -->`;
}

export function extractPromotionKeys(content: string): string[] {
  // Source paths can contain spaces; the comment boundary terminates a key.
  return [...content.matchAll(/<!--\s*openclaw-memory-promotion:([^\n]*?)\s*-->/giu)]
    .map((match) => match[1]?.trim())
    .filter((key): key is string => Boolean(key));
}

export class MemoryWriteConflictError extends Error {
  constructor() {
    super("MEMORY.md changed before the dreaming write could commit");
    this.name = "MemoryWriteConflictError";
  }
}

export async function resolveMemoryWritePath(filePath: string): Promise<string> {
  try {
    return await fs.realpath(filePath);
  } catch (err) {
    const hasTrailingSeparator =
      filePath.endsWith(path.sep) ||
      (process.platform === "win32" && filePath.endsWith(path.posix.sep));
    if ((err as NodeJS.ErrnoException)?.code !== "ENOENT" || hasTrailingSeparator) {
      throw err;
    }
  }

  // Canonicalize each parent before applying a relative link target. Lexical
  // normalization would change `..` semantics when an earlier component is a symlink.
  const parentPath = await fs.realpath(path.dirname(filePath));
  const canonicalPath = path.join(parentPath, path.basename(filePath));
  let linkTarget: string;
  try {
    linkTarget = await fs.readlink(canonicalPath);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === "ENOENT" || code === "EINVAL") {
      return canonicalPath;
    }
    throw err;
  }
  const isWindowsRootRelative = process.platform === "win32" && /^[\\/](?![\\/])/.test(linkTarget);
  const targetPath = isWindowsRootRelative
    ? `${path.parse(parentPath).root.replace(/[\\/]$/, "")}${linkTarget}`
    : path.isAbsolute(linkTarget)
      ? linkTarget
      : `${parentPath}${parentPath.endsWith(path.sep) ? "" : path.sep}${linkTarget}`;
  return await resolveMemoryWritePath(targetPath);
}

export async function readMemoryContent(filePath: string): Promise<string> {
  return await fs.readFile(filePath, "utf-8").catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return "";
    }
    throw error;
  });
}

export function isAtomicReplacePermissionError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return code === "EACCES" || code === "EPERM" || code === "EEXIST" || code === "EROFS";
}

async function writeExistingMemoryInPlace(params: {
  filePath: string;
  expectedContent: string;
  content: string;
}): Promise<boolean> {
  if ((await readMemoryContent(params.filePath)) !== params.expectedContent) {
    throw new MemoryWriteConflictError();
  }
  let handle: Awaited<ReturnType<typeof fs.open>>;
  try {
    handle = await fs.open(params.filePath, "r+");
  } catch {
    return false;
  }
  try {
    await handle.writeFile(params.content, { encoding: "utf-8" });
    await handle.truncate(Buffer.byteLength(params.content));
    await handle.sync();
    return true;
  } catch (error) {
    const original = Buffer.from(params.expectedContent, "utf-8");
    try {
      let restored = 0;
      while (restored < original.length) {
        const { bytesWritten } = await handle.write(
          original,
          restored,
          original.length - restored,
          restored,
        );
        if (bytesWritten <= 0) {
          throw new Error("MEMORY.md restore write made no progress", { cause: error });
        }
        restored += bytesWritten;
      }
      await handle.truncate(original.length);
      await handle.sync();
    } catch (restoreError) {
      throw new Error(
        "MEMORY.md in-place write failed and restoring the original content also failed",
        { cause: restoreError },
      );
    }
    throw error;
  } finally {
    await handle.close();
  }
}

export function hashMemoryContent(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

export async function writeMemoryContent(params: {
  memoryPath: string;
  memoryWritePath: string;
  expectedHash?: string;
  expectedContent?: string;
  allowInPlaceFallback?: boolean;
  content: string;
}): Promise<void> {
  const memoryDirMode = (await fs.stat(path.dirname(params.memoryWritePath))).mode & 0o7777;
  try {
    await replaceFileAtomic({
      filePath: params.memoryWritePath,
      content: params.content,
      dirMode: memoryDirMode,
      mode: 0o600,
      preserveExistingMode: true,
      tempPrefix: `${path.basename(params.memoryPath)}.promotion`,
      syncTempFile: true,
      syncParentDir: true,
      throwOnCleanupError: true,
      beforeRename: async () => {
        if (
          params.expectedHash &&
          hashMemoryContent(await readMemoryContent(params.memoryWritePath)) !== params.expectedHash
        ) {
          throw new MemoryWriteConflictError();
        }
        // OpenClaw writers are serialized. The recoverable preimage covers the
        // accepted race with external editors between this check and rename.
      },
      fileSystem: {
        promises: {
          mkdir: fs.mkdir,
          chmod: fs.chmod,
          writeFile: fs.writeFile,
          rename: fs.rename,
          copyFile: fs.copyFile,
          unlink: fs.unlink,
          rm: fs.rm,
          open: fs.open,
          stat: fs.stat,
          lstat: fs.lstat,
        },
      },
    });
  } catch (error) {
    // Append-only promotion retains the shipped writable-file fallback when
    // directory ACLs block temp-file replacement; consolidation never uses it.
    if (
      !params.allowInPlaceFallback ||
      params.expectedContent === undefined ||
      !isAtomicReplacePermissionError(error) ||
      !(await writeExistingMemoryInPlace({
        filePath: params.memoryWritePath,
        expectedContent: params.expectedContent,
        content: params.content,
      }))
    ) {
      throw error;
    }
  }
}
