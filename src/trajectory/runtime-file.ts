// Trajectory runtime file helpers create and append trajectory log files.
import fsp from "node:fs/promises";
import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { readRegularFile } from "../infra/regular-file.js";
import {
  TRAJECTORY_POINTER_FILE_MAX_BYTES,
  resolveTrajectoryFilePath,
  resolveTrajectoryPointerFilePath,
  safeTrajectorySessionFileName,
} from "./paths.js";

// Runtime trajectory file discovery for exporters. Pointer files are treated as
// advisory only and must resolve to regular non-symlink files before use.
export async function isRegularNonSymlinkFile(filePath: string): Promise<boolean> {
  try {
    const linkStat = await fsp.lstat(filePath);
    if (linkStat.isSymbolicLink() || !linkStat.isFile()) {
      return false;
    }
    const stat = await fsp.stat(filePath);
    return stat.isFile() && stat.dev === linkStat.dev && stat.ino === linkStat.ino;
  } catch {
    return false;
  }
}

async function readRuntimePointerFile(
  sessionFile: string,
  sessionId: string,
): Promise<string | undefined> {
  const pointerPath = resolveTrajectoryPointerFilePath(sessionFile);
  try {
    const { buffer } = await readRegularFile({
      filePath: pointerPath,
      maxBytes: TRAJECTORY_POINTER_FILE_MAX_BYTES,
    });
    const parsed = JSON.parse(buffer.toString("utf8")) as unknown;
    if (!isRecord(parsed)) {
      return undefined;
    }
    if (parsed.sessionId !== sessionId || typeof parsed.runtimeFile !== "string") {
      return undefined;
    }
    const runtimeFile = path.resolve(parsed.runtimeFile);
    const safeRuntimeFileName = `${safeTrajectorySessionFileName(sessionId)}.jsonl`;
    const defaultRuntimeFile = path.resolve(
      resolveTrajectoryFilePath({
        env: {},
        sessionFile,
        sessionId,
      }),
    );
    // Accept the default sibling path or a runtime-dir file with the sanitized
    // session basename; reject arbitrary pointers from stale or edited sidecars.
    if (runtimeFile !== defaultRuntimeFile && path.basename(runtimeFile) !== safeRuntimeFileName) {
      return undefined;
    }
    return runtimeFile;
  } catch {
    return undefined;
  }
}

export async function resolveTrajectoryRuntimeFile(params: {
  runtimeFile?: string;
  sessionFile: string;
  sessionId: string;
}): Promise<string | undefined> {
  if (params.runtimeFile) {
    return params.runtimeFile;
  }
  const candidates = [
    await readRuntimePointerFile(params.sessionFile, params.sessionId),
    resolveTrajectoryFilePath({
      env: {},
      sessionFile: params.sessionFile,
      sessionId: params.sessionId,
    }),
    resolveTrajectoryFilePath({
      sessionFile: params.sessionFile,
      sessionId: params.sessionId,
    }),
  ].filter((candidate): candidate is string => Boolean(candidate));
  for (const candidate of candidates) {
    if (await isRegularNonSymlinkFile(candidate)) {
      return candidate;
    }
  }
  return undefined;
}
