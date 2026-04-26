import fs from "node:fs";
import path from "node:path";
import { resolveHomeRelativePath } from "../infra/home-dir.js";

export const TRAJECTORY_RUNTIME_FILE_MAX_BYTES = 50 * 1024 * 1024;
export const TRAJECTORY_RUNTIME_EVENT_MAX_BYTES = 256 * 1024;

type TrajectoryPointerOpenFlagConstants = Pick<
  typeof fs.constants,
  "O_CREAT" | "O_TRUNC" | "O_WRONLY"
> &
  Partial<Pick<typeof fs.constants, "O_NOFOLLOW">>;

export function safeTrajectorySessionFileName(sessionId: string): string {
  const safe = sessionId.replaceAll(/[^A-Za-z0-9_-]/g, "_").slice(0, 120);
  return /[A-Za-z0-9]/u.test(safe) ? safe : "session";
}

export function resolveTrajectoryPointerOpenFlags(
  constants: TrajectoryPointerOpenFlagConstants = fs.constants,
): number {
  const noFollow = constants.O_NOFOLLOW;
  return (
    constants.O_CREAT |
    constants.O_TRUNC |
    constants.O_WRONLY |
    (typeof noFollow === "number" ? noFollow : 0)
  );
}

function resolveContainedPath(baseDir: string, fileName: string): string {
  const resolvedBase = path.resolve(baseDir);
  const resolvedFile = path.resolve(resolvedBase, fileName);
  const relative = path.relative(resolvedBase, resolvedFile);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
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
  return params.sessionFile.endsWith(".jsonl")
    ? `${params.sessionFile.slice(0, -".jsonl".length)}.trajectory.jsonl`
    : `${params.sessionFile}.trajectory.jsonl`;
}

export function resolveTrajectoryPointerFilePath(sessionFile: string): string {
  return sessionFile.endsWith(".jsonl")
    ? `${sessionFile.slice(0, -".jsonl".length)}.trajectory-path.json`
    : `${sessionFile}.trajectory-path.json`;
}
