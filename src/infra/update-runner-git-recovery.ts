import { runCommandWithTimeout } from "../process/exec.js";
import { verifyGitUpdateRecovery } from "./update-git-runtime.js";
import type { UpdateRecovery } from "./update-recovery.js";

export async function readCurrentGitUpdateRecovery(root: string): Promise<UpdateRecovery> {
  const head = await runCommandWithTimeout(["git", "-C", root, "rev-parse", "HEAD"], {
    cwd: root,
    timeoutMs: 5000,
  }).catch(() => null);
  return verifyGitUpdateRecovery({ root, sha: head?.code === 0 ? head.stdout.trim() : null });
}
