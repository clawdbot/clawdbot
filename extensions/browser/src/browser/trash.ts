/**
 * Trash helpers for Browser-owned files constrained to user and OpenClaw temp
 * roots.
 */
import os from "node:os";
import { movePathToTrash as movePathToTrashWithAllowedRoots } from "openclaw/plugin-sdk/browser-config";
import { resolvePreferredOpenClawTmpDir } from "openclaw/plugin-sdk/temp-path";

/** Moves a path to trash only when it lives under allowed Browser roots. */
export async function movePathToTrash(targetPath: string): Promise<string> {
  return await movePathToTrashWithAllowedRoots(targetPath, {
    allowedRoots: [os.homedir(), resolvePreferredOpenClawTmpDir()],
  });
}
