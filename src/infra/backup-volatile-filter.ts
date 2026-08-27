// Filters volatile files from backup manifests.
import path from "node:path";

/**
 * Paths that are known to change during a live backup and commonly trigger
 * tar EOF errors. These files are actively appended to (logs, sockets, pid
 * markers) while `tar.c()` is reading them, which races with the size recorded
 * at `lstat()` time.
 *
 * Skipping them is safe: they are either recreated on startup, are transient
 * by nature, or have durable equivalents elsewhere in state. Snapshotting a
 * partial tail of a live log has no restoration value.
 */

const STATE_TRANSIENT_EXTENSIONS = new Set([".sock", ".pid", ".tmp"]);
const CHROMIUM_SINGLETON_FILES = new Set(["SingletonCookie", "SingletonLock", "SingletonSocket"]);
const SQLITE_REINDEX_TRANSIENT_PATH_PATTERN =
  /(?:^|\/)(?:[^/]+\.sqlite\.reindex-lock\.sqlite|[^/]+\.sqlite\.(?:backup|memory-reindex|tmp)-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:-wal|-shm|-journal)?$/iu;

function normalizePosix(input: string): string {
  if (!input) {
    return input;
  }
  // Swap Windows-style separators, then collapse `.`/`..` segments so ancestry
  // checks cannot be bypassed by a path that traverses out of the anchor.
  return path.posix.normalize(input.replaceAll("\\", "/"));
}

function isUnder(childPosix: string, parentPosix: string): boolean {
  if (!parentPosix) {
    return false;
  }
  const p = parentPosix.endsWith("/") ? parentPosix : `${parentPosix}/`;
  return childPosix === parentPosix || childPosix.startsWith(p);
}

function hasExtension(filePosix: string, extensions: readonly string[]): boolean {
  const ext = path.posix.extname(filePosix).toLowerCase();
  return extensions.includes(ext);
}

function hasExtensionInSet(filePosix: string, extensions: ReadonlySet<string>): boolean {
  return extensions.has(path.posix.extname(filePosix).toLowerCase());
}

export function isTransientSqliteBackupPath(filePath: string): boolean {
  const normalizedPath = normalizePosix(filePath);
  return SQLITE_REINDEX_TRANSIENT_PATH_PATTERN.test(normalizedPath);
}

function isAgentSessionTranscriptPath(filePosix: string, stateDirPosix: string): boolean {
  const agentsRoot = path.posix.join(stateDirPosix, "agents");
  if (!isUnder(filePosix, agentsRoot)) {
    return false;
  }
  const relative = path.posix.relative(agentsRoot, filePosix);
  const parts = relative.split("/").filter(Boolean);
  return parts.length >= 3 && parts[1] === "sessions";
}

function isManagedBrowserSingletonPath(filePosix: string, stateDirPosix: string): boolean {
  const browserRoot = path.posix.join(stateDirPosix, "browser");
  if (!isUnder(filePosix, browserRoot)) {
    return false;
  }
  const parts = path.posix.relative(browserRoot, filePosix).split("/").filter(Boolean);
  return (
    parts.length === 3 && parts[1] === "user-data" && CHROMIUM_SINGLETON_FILES.has(parts[2] ?? "")
  );
}

function filePathCandidates(input: string): string[] {
  const normalized = normalizePosix(input);
  if (normalized.startsWith("/") || /^[A-Za-z]:\//u.test(normalized)) {
    return [normalized];
  }
  // node-tar may pass absolute input paths to filters without the leading
  // slash, even when the source list used absolute paths.
  return [normalized, normalizePosix(`/${normalized}`)];
}

type VolatileFilterPlan = {
  /** Canonical state directories the filter should treat as volatile anchors. */
  stateDirs: string[];
};

/**
 * Returns true if the given absolute path should be skipped during backup
 * because it is a live-mutation target.
 *
 * Rules:
 *   - `{stateDir}/sessions/**`/`*.{jsonl,log}` (legacy)
 *   - `{stateDir}/agents/<agentId>/sessions/**`/`*.{jsonl,log}`
 *   - `{stateDir}/cron/runs/**`/`*.{jsonl,log}`
 *   - `{stateDir}/logs/**`/`*.{jsonl,log}`
 *   - `{stateDir}/{delivery-queue,session-delivery-queue}/**`/`*.{json,delivered,tmp}`
 *   - `{stateDir}/browser/<profile>/user-data/Singleton{Cookie,Lock,Socket}`
 *   - `{stateDir}/sandbox/skills-workspaces/**`
 *   - `{stateDir}/**`/`*.{sock,pid,tmp}`
 */
export function isVolatileBackupPath(absolutePath: string, plan: VolatileFilterPlan): boolean {
  if (!absolutePath) {
    return false;
  }
  const candidates = filePathCandidates(absolutePath);

  for (const stateDir of plan.stateDirs) {
    if (!stateDir) {
      continue;
    }
    const stateDirPosix = normalizePosix(stateDir);

    for (const filePosix of candidates) {
      if (isManagedBrowserSingletonPath(filePosix, stateDirPosix)) {
        return true;
      }

      const sandboxSkillsRoot = path.posix.join(stateDirPosix, "sandbox", "skills-workspaces");
      if (isUnder(filePosix, sandboxSkillsRoot)) {
        return true;
      }

      // Rebuildable, manifest-verified bundles bridge already-open Control UI
      // documents across updates; restoring them would only copy stale package bytes.
      const controlUiAssetCacheRoot = path.posix.join(stateDirPosix, "cache", "control-ui-assets");
      if (isUnder(filePosix, controlUiAssetCacheRoot)) {
        return true;
      }

      const sessionsRoot = path.posix.join(stateDirPosix, "sessions");
      if (isUnder(filePosix, sessionsRoot) && hasExtension(filePosix, [".jsonl", ".log"])) {
        return true;
      }

      if (
        isAgentSessionTranscriptPath(filePosix, stateDirPosix) &&
        hasExtension(filePosix, [".jsonl", ".log"])
      ) {
        return true;
      }

      const cronRunsRoot = path.posix.join(stateDirPosix, "cron", "runs");
      if (isUnder(filePosix, cronRunsRoot) && hasExtension(filePosix, [".jsonl", ".log"])) {
        return true;
      }

      const logsRoot = path.posix.join(stateDirPosix, "logs");
      if (isUnder(filePosix, logsRoot) && hasExtension(filePosix, [".jsonl", ".log"])) {
        return true;
      }

      for (const queueDir of ["delivery-queue", "session-delivery-queue"]) {
        const queueRoot = path.posix.join(stateDirPosix, queueDir);
        if (
          isUnder(filePosix, queueRoot) &&
          hasExtension(filePosix, [".json", ".delivered", ".tmp"])
        ) {
          return true;
        }
      }

      if (
        isUnder(filePosix, stateDirPosix) &&
        hasExtensionInSet(filePosix, STATE_TRANSIENT_EXTENSIONS)
      ) {
        return true;
      }
    }
  }

  return false;
}
