import fs from "node:fs";
import path from "node:path";
import type { CommandRunner } from "./update-runner-types.js";

/** Resolve the canonical identity of an update checkout/install root. */
export function resolveUpdateInstallRoot(root: string): string {
  try {
    return fs.realpathSync.native(root);
  } catch {
    return path.resolve(root);
  }
}

export function updateInstallRootsMatch(left: string, right: string): boolean {
  return resolveUpdateInstallRoot(left) === resolveUpdateInstallRoot(right);
}

export async function resolveGitRoot(
  runCommand: CommandRunner,
  candidates: string[],
  timeoutMs: number,
  packageRoot?: string | null,
): Promise<string | null> {
  for (const dir of candidates) {
    const result = await runCommand(["git", "-C", dir, "rev-parse", "--show-toplevel"], {
      timeoutMs,
    }).catch(() => null);
    const root = result?.code === 0 ? result.stdout.trim() : "";
    // A launcher may live inside an unrelated checkout (for example nvm).
    // Keep probing until the Git root owns the discovered OpenClaw package.
    if (root && (!packageRoot || updateInstallRootsMatch(root, packageRoot))) {
      return root;
    }
  }
  return null;
}
