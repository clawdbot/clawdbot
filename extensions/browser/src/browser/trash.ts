/**
 * Trash helpers for data under the Browser-owned config subtree.
 */
import path from "node:path";
import { movePathToTrash as movePathToTrashWithAllowedRoots } from "openclaw/plugin-sdk/browser-config";
import { CONFIG_DIR } from "../utils.js";

/** Moves a path to trash only when it lives under allowed Browser roots. */
export async function movePathToTrash(targetPath: string): Promise<string> {
  return await movePathToTrashWithAllowedRoots(targetPath, {
    // Managed browser data follows OPENCLAW_STATE_DIR/OPENCLAW_CONFIG_PATH, which
    // may intentionally live outside the OS home. Limit authority to Browser's
    // owned subtree; fs-safe also checks target identity, realpaths, and symlinks.
    allowedRoots: [path.join(CONFIG_DIR, "browser")],
  });
}
