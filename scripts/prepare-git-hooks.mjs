// Configures this checkout's Git hooks path during package prepare when git
// and the hooks directory are available.
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const DEFAULT_PACKAGE_ROOT = join(scriptDir, "..");

function getMissingGitReason(error) {
  if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
    return "missing-git";
  }
  return null;
}

function runGit(spawn, gitBin, args, cwd, stdio) {
  return spawn(gitBin, args, {
    cwd,
    encoding: "utf8",
    stdio,
  });
}

/**
 * Installs the repo-local hooks path and returns a structured reason if skipped.
 */
export function configurePrepareGitHooks(params = {}) {
  const cwd = params.cwd ?? DEFAULT_PACKAGE_ROOT;
  const exists = params.existsSync ?? existsSync;
  const gitBin = params.gitBin ?? "git";
  const spawn = params.spawnSync ?? spawnSync;
  const warn = params.warn ?? console.warn;

  if (!exists(join(cwd, "git-hooks"))) {
    return { configured: false, reason: "missing-hooks-dir" };
  }

  const worktree = runGit(spawn, gitBin, ["rev-parse", "--is-inside-work-tree"], cwd, [
    "ignore",
    "pipe",
    "ignore",
  ]);
  const missingGitReason = getMissingGitReason(worktree.error);
  if (missingGitReason) {
    return { configured: false, reason: missingGitReason };
  }
  if (worktree.status !== 0 || String(worktree.stdout ?? "").trim() !== "true") {
    return { configured: false, reason: "not-worktree" };
  }

  const configured = runGit(spawn, gitBin, ["config", "core.hooksPath", "git-hooks"], cwd, [
    "ignore",
    "ignore",
    "pipe",
  ]);
  const configMissingGitReason = getMissingGitReason(configured.error);
  if (configMissingGitReason) {
    return { configured: false, reason: configMissingGitReason };
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
