/**
 * Removes a materialized subagent attachment directory within its canonical workspace root.
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { privateFileStore } from "../../infra/private-file-store.js";

const SUBAGENT_ATTACHMENT_CLEANUP_MAX_DEPTH = 8;
const SUBAGENT_ATTACHMENT_CLEANUP_MAX_ENTRIES = 128;

export async function cleanupMaterializedSubagentAttachments(params: {
  workspaceDir: string;
  relDir: string;
}): Promise<void> {
  const root = await privateFileStore(await fs.realpath(params.workspaceDir)).root();
  let entriesRemaining = SUBAGENT_ATTACHMENT_CLEANUP_MAX_ENTRIES;

  const removeTree = async (relativeDir: string, depth: number): Promise<void> => {
    if (depth > SUBAGENT_ATTACHMENT_CLEANUP_MAX_DEPTH) {
      throw new Error("attachment cleanup directory depth exceeded");
    }
    const entries = await root.list(relativeDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entriesRemaining-- <= 0) {
        throw new Error("attachment cleanup entry count exceeded");
      }
      const child = path.posix.join(relativeDir, entry.name);
      if (entry.isDirectory && !entry.isSymbolicLink) {
        await removeTree(child, depth + 1);
      } else {
        await root.remove(child);
      }
    }
    await root.remove(relativeDir);
  };

  // Each operation is workspace-root-relative. Do not replace this with fs.rm:
  // a sandbox-controlled attachment parent can be a symlink outside the workspace.
  await removeTree(params.relDir, 0);
}
