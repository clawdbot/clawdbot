import os from "node:os";
import { movePathToTrash as movePathToTrashWithAllowedRoots } from "openclaw/plugin-sdk/browser-config";
import { resolvePreferredOpenClawTmpDir } from "openclaw/plugin-sdk/temp-path";

export async function movePathToTrash(targetPath: string): Promise<string> {
  return await movePathToTrashWithAllowedRoots(targetPath, {
    allowedRoots: [os.homedir(), resolvePreferredOpenClawTmpDir()],
  });
}
