import { execFileSync } from "node:child_process";

function resolvesCommit(root: string, ref: string) {
  try {
    execFileSync("git", ["rev-parse", "--verify", ref + "^{commit}"], {
      cwd: root,
      stdio: "ignore",
    });
    return true;
  } catch {
    return false;
  }
}

export function resolveRatchetBase(root: string, options: { base?: string; staged: boolean }) {
  const resolved =
    options.base ??
    (options.staged ? ["HEAD"] : ["origin/main", "HEAD"]).find((ref) => resolvesCommit(root, ref));
  if (!resolved || options.staged) {
    return resolved ?? null;
  }

  // Branches own their grandfathered debt from the fork. Comparing against a
  // moving base tip turns unrelated cleanup there into a local expansion.
  try {
    return execFileSync("git", ["merge-base", "HEAD", resolved], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return resolved;
  }
}
