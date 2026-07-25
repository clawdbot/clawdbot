// Trajectory path helpers resolve storage paths for trajectory artifacts.

import path from "node:path";
import { parseSqliteSessionFileMarker } from "../config/sessions/sqlite-marker.js";
import { resolveHomeRelativePath } from "../infra/home-dir.js";
import { isPathInside } from "../infra/path-guards.js";

// Legacy trajectory path helpers. Active runtime capture writes SQLite rows;
// these paths remain for explicit legacy-file reads, export artifacts, and cleanup.
export const TRAJECTORY_RUNTIME_CAPTURE_MAX_BYTES = 10 * 1024 * 1024;
export const TRAJECTORY_RUNTIME_FILE_MAX_BYTES = 50 * 1024 * 1024;
export const TRAJECTORY_RUNTIME_EVENT_MAX_BYTES = 256 * 1024;
// Pointer JSON only records schema metadata and one runtime path.
export const TRAJECTORY_POINTER_FILE_MAX_BYTES = 64 * 1024;

export function safeTrajectorySessionFileName(sessionId: string): string {
  const safe = sessionId.replaceAll(/[^A-Za-z0-9_-]/g, "_").slice(0, 120);
  return /[A-Za-z0-9]/u.test(safe) ? safe : "session";
}

function resolveContainedPath(baseDir: string, fileName: string): string {
  const resolvedBase = path.resolve(baseDir);
  const resolvedFile = path.resolve(resolvedBase, fileName);
  if (resolvedFile === resolvedBase || !isPathInside(resolvedBase, resolvedFile)) {
    throw new Error("Trajectory file path escaped its configured directory");
  }
  return resolvedFile;
}

export function resolveTrajectoryFilePath(params: {
  env?: NodeJS.ProcessEnv;
  sessionFile?: string;
  sessionId: string;
}): string {
  const env = params.env ?? process.env;
  const dirOverride = env.OPENCLAW_TRAJECTORY_DIR?.trim();
  if (dirOverride) {
    return resolveContainedPath(
      resolveHomeRelativePath(dirOverride),
      `${safeTrajectorySessionFileName(params.sessionId)}.jsonl`,
    );
  }
  if (!params.sessionFile) {
    return path.join(
      process.cwd(),
      `${safeTrajectorySessionFileName(params.sessionId)}.trajectory.jsonl`,
    );
  }
  const sqliteMarker = parseSqliteSessionFileMarker(params.sessionFile);
  if (sqliteMarker) {
    return path.join(
      path.dirname(path.resolve(sqliteMarker.storePath)),
      "trajectory",
      `${safeTrajectorySessionFileName(sqliteMarker.sessionId)}.jsonl`,
    );
  }
  return params.sessionFile.endsWith(".jsonl")
    ? `${params.sessionFile.slice(0, -".jsonl".length)}.trajectory.jsonl`
    : `${params.sessionFile}.trajectory.jsonl`;
}

// Sidecar pointer naming contract used to discover runtime trace files from a
// persisted session file during support-bundle export.
export function resolveTrajectoryPointerFilePath(sessionFile: string): string {
  return sessionFile.endsWith(".jsonl")
    ? `${sessionFile.slice(0, -".jsonl".length)}.trajectory-path.json`
    : `${sessionFile}.trajectory-path.json`;
}
