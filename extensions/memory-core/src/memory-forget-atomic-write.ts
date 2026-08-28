// Atomic rewrite helpers for memory-core forget flows.
import fs from "node:fs/promises";
import path from "node:path";
import { replaceFileAtomic } from "openclaw/plugin-sdk/security-runtime";

export type MemoryFileRewrite = {
  absolutePath: string;
  content: string;
  remove: boolean;
};

/**
 * Apply a planned memory-file rewrite. Content rewrites go through a temp-file
 * plus atomic rename so a mid-write failure (ENOSPC, EFBIG, kill) cannot
 * truncate long-term memory after the index rows were already deleted.
 */
export async function applyMemoryFileRewrite(rewrite: MemoryFileRewrite): Promise<void> {
  if (rewrite.remove) {
    await fs.unlink(rewrite.absolutePath);
    return;
  }
  await replaceFileAtomic({
    filePath: rewrite.absolutePath,
    content: rewrite.content,
    preserveExistingMode: true,
    tempPrefix: `${path.basename(rewrite.absolutePath)}.forget`,
    syncTempFile: true,
    syncParentDir: true,
  });
}
