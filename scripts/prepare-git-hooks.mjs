// Configures this checkout's Git hooks path during package prepare when git
// and the hooks directory are available.
import { spawnSync } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const DEFAULT_PACKAGE_ROOT = join(scriptDir, "..");
const PUBLICATION_PREFLIGHT_MARKER = "publication-preflight.enabled";

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
  const install = params.install === true;
  const exists = params.existsSync ?? existsSync;
  const gitBin = params.gitBin ?? "git";
  const spawn = params.spawnSync ?? spawnSync;
  const warn = params.warn ?? console.warn;
  const writeFile = params.writeFileSync ?? writeFileSync;

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

  // Preserve automatic installation of the repository's maintained hooks,
  // including pre-commit. The optional pre-push gate checks this worktree-local
  // opt-in before it performs any publication validation.
  if (install) {
    const marker = runGit(
      spawn,
      gitBin,
      ["rev-parse", "--git-path", PUBLICATION_PREFLIGHT_MARKER],
      cwd,
      ["ignore", "pipe", "pipe"],
    );
    const enableMissingGitReason = getMissingGitReason(marker.error);
    if (enableMissingGitReason) {
      return { configured: true, reason: enableMissingGitReason };
    }
    const markerPath = String(marker.stdout ?? "").trim();
    if (marker.status !== 0 || !markerPath) {
      const stderr = String(marker.stderr ?? "").trim();
      warn(
        `[prepare] configured git hooks but could not enable publication preflight${stderr ? `: ${stderr}` : ""}`,
      );
      return { configured: true, reason: "preflight-enable-failed" };
    }
    try {
      writeFile(resolve(cwd, markerPath), "enabled\n", { encoding: "utf8", mode: 0o600 });
    } catch (error) {
      warn(
        `[prepare] configured git hooks but could not enable publication preflight: ${error instanceof Error ? error.message : String(error)}`,
      );
      return { configured: true, reason: "preflight-enable-failed" };
    }
  }

  return { configured: true, reason: "configured" };
}

if (basename(process.argv[1] ?? "") === "prepare-git-hooks.mjs") {
  configurePrepareGitHooks({
    install: process.argv.includes("--install") || process.env.OPENCLAW_INSTALL_GIT_HOOKS === "1",
  });
}
