import "./fs-safe-defaults.js";
import fs from "node:fs/promises";
import path from "node:path";
import {
  movePathWithCopyFallback as movePathWithCopyFallbackBase,
  replaceFileAtomic as replaceFileAtomicBase,
  type MovePathWithCopyFallbackOptions as BaseMovePathWithCopyFallbackOptions,
} from "@openclaw/fs-safe/atomic";

export {
  replaceDirectoryAtomic,
  replaceFileAtomicSync,
  type ReplaceDirectoryAtomicOptions,
  type ReplaceFileAtomicFileSystem,
  type ReplaceFileAtomicOptions,
  type ReplaceFileAtomicResult,
  type ReplaceFileAtomicSyncFileSystem,
  type ReplaceFileAtomicSyncOptions,
} from "@openclaw/fs-safe/atomic";

export const replaceFileAtomic = replaceFileAtomicBase;

export type MovePathWithCopyFallbackOptions = BaseMovePathWithCopyFallbackOptions & {
  sourceHardlinks?: "allow" | "reject";
};

export async function movePathWithCopyFallback(
  options: MovePathWithCopyFallbackOptions,
): Promise<void> {
  if (options.sourceHardlinks === "reject") {
    await assertNoHardlinkedSourceFiles(options.from);
  }
  await movePathWithCopyFallbackBase({ from: options.from, to: options.to });
}

async function assertNoHardlinkedSourceFiles(sourcePath: string): Promise<void> {
  const sourceStat = await fs.lstat(sourcePath);
  if (sourceStat.isFile() && sourceStat.nlink > 1) {
    throw new Error(`Hardlinked source file is not allowed: ${sourcePath}`);
  }
  if (!sourceStat.isDirectory()) {
    return;
  }

  const entries = await fs.readdir(sourcePath, { withFileTypes: true });
  await Promise.all(
    entries.map(async (entry) => {
      const entryPath = path.join(sourcePath, entry.name);
      if (entry.isDirectory()) {
        await assertNoHardlinkedSourceFiles(entryPath);
        return;
      }
      if (!entry.isFile()) {
        return;
      }
      const entryStat = await fs.lstat(entryPath);
      if (entryStat.nlink > 1) {
        throw new Error(`Hardlinked source file is not allowed: ${entryPath}`);
      }
    }),
  );
}
