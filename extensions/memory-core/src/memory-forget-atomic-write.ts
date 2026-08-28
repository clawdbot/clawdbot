// Atomic rewrite helpers for memory-core forget flows.
import fs from "node:fs/promises";
import path from "node:path";
import { replaceFileAtomic } from "openclaw/plugin-sdk/security-runtime";
import {
  isAtomicReplacePermissionError,
  MemoryWriteConflictError,
  readMemoryContent,
  writeExistingMemoryInPlace,
} from "./short-term-promotion-memory-write.js";

export type MemoryFileRewrite = {
  absolutePath: string;
  content: string;
  remove: boolean;
  expectedContent?: string;
};

/**
 * Apply a planned memory-file rewrite. Content rewrites go through a temp-file
 * plus atomic rename so a mid-write failure (ENOSPC, EFBIG, kill) cannot
 * truncate long-term memory after the index rows were already deleted. The
 * preimage is re-checked before the rename commits, mirroring the sibling
 * promotion writer's accepted race with external editors.
 *
 * When directory ACLs block the temp-file replacement but the target file
 * itself is writable, keep the shipped writable-file behavior by falling back
 * to the same checked, restore-on-failure in-place write the sibling promotion
 * writer uses.
 */
export async function applyMemoryFileRewrite(rewrite: MemoryFileRewrite): Promise<void> {
  if (rewrite.remove) {
    await fs.unlink(rewrite.absolutePath);
    return;
  }
  // Preserve the parent directory's current mode; the atomic helper would
  // otherwise chmod it to its own default on every forget rewrite.
  const dirMode = (await fs.stat(path.dirname(rewrite.absolutePath))).mode & 0o7777;
  try {
    await replaceFileAtomic({
      filePath: rewrite.absolutePath,
      content: rewrite.content,
      dirMode,
      preserveExistingMode: true,
      tempPrefix: `${path.basename(rewrite.absolutePath)}.forget`,
      syncTempFile: true,
      syncParentDir: true,
      beforeRename: async () => {
        if (
          rewrite.expectedContent !== undefined &&
          (await readMemoryContent(rewrite.absolutePath)) !== rewrite.expectedContent
        ) {
          throw new MemoryWriteConflictError(
            `${path.basename(rewrite.absolutePath)} changed before the memory forget rewrite could commit`,
          );
        }
      },
    });
  } catch (error) {
    if (
      rewrite.expectedContent === undefined ||
      !isAtomicReplacePermissionError(error) ||
      !(await writeExistingMemoryInPlace({
        filePath: rewrite.absolutePath,
        expectedContent: rewrite.expectedContent,
        content: rewrite.content,
        conflictMessage: `${path.basename(rewrite.absolutePath)} changed before the memory forget rewrite could commit`,
      }))
    ) {
      throw error;
    }
  }
}
