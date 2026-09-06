// Initializes this checkout's Git hooks path without replacing an existing selection.
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const DEFAULT_PACKAGE_ROOT = join(scriptDir, "..");

/**
 * Initializes an unset hooks path and returns a structured reason if skipped.
 */
export function configurePrepareGitHooks(params = {}) {
  const cwd = params.cwd ?? DEFAULT_PACKAGE_ROOT;
  const exists = params.existsSync ?? existsSync;
  const gitBin = params.gitBin ?? "git";
  const spawn = params.spawnSync ?? spawnSync;
  const warn = params.warn ?? console.warn;
  const runGit = (args) =>
    spawn(gitBin, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

  if (!exists(join(cwd, "git-hooks"))) {
    return { configured: false, reason: "missing-hooks-dir" };
  }

  const worktree = runGit(["rev-parse", "--is-inside-work-tree"]);
  if (worktree.error?.code === "ENOENT") {
    return { configured: false, reason: "missing-git" };
  }
  if (worktree.status !== 0 || String(worktree.stdout ?? "").trim() !== "true") {
    return { configured: false, reason: "not-worktree" };
  }

  // Inherited and explicitly empty selections already have an owner.
  const existing = runGit(["config", "--get", "core.hooksPath"]);
  if (existing.status === 0) {
    return { configured: false, reason: "already-configured" };
  }
  // Git refuses a shared write when multiple checkouts lack private worktree config.
  const configured =
    existing.status === 1
      ? runGit(["config", "--worktree", "core.hooksPath", "git-hooks"])
      : existing;
  if (configured.error?.code === "ENOENT") {
    return { configured: false, reason: "missing-git" };
  }
  if (configured.status !== 0) {
    const stderr = String(configured.stderr ?? "").trim();
    warn(`[prepare] could not configure git hooks${stderr ? `: ${stderr}` : ""}`);
    return { configured: false, reason: "config-failed" };
  }

  return { configured: true, reason: "configured" };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  configurePrepareGitHooks();
}
