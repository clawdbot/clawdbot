// File Transfer plugin module implements path errors behavior.
import type { BigIntStats } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { FsSafeError, resolveAbsolutePathForRead } from "openclaw/plugin-sdk/security-runtime";
import { fileIdentity, readPathBinding, type FileIdentity } from "../shared/path-binding.js";

type InvalidPathResult = {
  ok: false;
  code: "INVALID_PATH";
  message: string;
};

const SYMLINK_REJECTED_MESSAGE =
  "path traverses a symlink; refusing because followSymlinks=false (set plugins.entries.file-transfer.config.nodes.<node>.followSymlinks=true to allow, or update allowReadPaths to the canonical path)";

type FsSafeReadErrorCode = "INVALID_PATH" | "NOT_FOUND" | "SYMLINK_REDIRECT";

export function classifyFsSafeReadError(err: unknown): FsSafeReadErrorCode | undefined {
  if (!(err instanceof FsSafeError)) {
    return undefined;
  }
  if (err.code === "not-found") {
    return "NOT_FOUND";
  }
  if (err.code === "symlink") {
    return "SYMLINK_REDIRECT";
  }
  if (err.code === "invalid-path") {
    return "INVALID_PATH";
  }
  return undefined;
}

export function readAbsolutePath(input: unknown): string | InvalidPathResult {
  if (typeof input !== "string" || input.length === 0) {
    return { ok: false, code: "INVALID_PATH", message: "path required" };
  }
  if (input.includes("\0")) {
    return { ok: false, code: "INVALID_PATH", message: "path contains NUL byte" };
  }
  if (!path.isAbsolute(input)) {
    return { ok: false, code: "INVALID_PATH", message: "path must be absolute" };
  }
  return input;
}

export function rejectCanonicalPathChange(expected: unknown, actual: string) {
  if (typeof expected !== "string" || expected === actual) {
    return undefined;
  }
  return {
    ok: false as const,
    code: "CANONICAL_PATH_CHANGED" as const,
    message: "canonical path differs from the authorized target",
    canonicalPath: actual,
  };
}

function canonicalPathFromFsSafeError(err: unknown): string | undefined {
  if (!(err instanceof FsSafeError) || !err.cause || typeof err.cause !== "object") {
    return undefined;
  }
  return "canonicalPath" in err.cause && typeof err.cause.canonicalPath === "string"
    ? err.cause.canonicalPath
    : undefined;
}

export async function resolveCanonicalReadPath<Code extends string>(input: {
  classifyError: (err: unknown) => Code;
  followSymlinks: boolean;
  notFoundMessage: string;
  requestedPath: string;
}): Promise<string | { ok: false; code: Code; message: string; canonicalPath?: string }> {
  try {
    return (
      await resolveAbsolutePathForRead(input.requestedPath, {
        symlinks: input.followSymlinks ? "follow" : "reject",
      })
    ).canonicalPath;
  } catch (err) {
    const code = input.classifyError(err);
    const canonicalPath = canonicalPathFromFsSafeError(err);
    return {
      ok: false,
      code,
      message:
        code === "NOT_FOUND"
          ? input.notFoundMessage
          : code === "SYMLINK_REDIRECT"
            ? SYMLINK_REJECTED_MESSAGE
            : `realpath failed: ${String(err)}`,
      ...(canonicalPath ? { canonicalPath } : {}),
    };
  }
}

export async function statRequiredDirectory<Code extends string>(
  canonicalPath: string,
  classifyError: (err: unknown) => Code,
): Promise<
  | { ok: true; identity: FileIdentity }
  | { ok: false; code: Code | "IS_FILE"; message: string; canonicalPath: string }
> {
  let stats: BigIntStats;
  try {
    stats = await fs.stat(canonicalPath, { bigint: true });
  } catch (err) {
    const code = classifyError(err);
    return {
      ok: false,
      code,
      message: `stat failed: ${String(err)}`,
      canonicalPath,
    };
  }

  if (!stats.isDirectory()) {
    return {
      ok: false,
      code: "IS_FILE",
      message: "path is not a directory",
      canonicalPath,
    };
  }
  return { ok: true, identity: fileIdentity(stats) };
}

export async function resolveBoundReadDirectory<Code extends string>(input: {
  requestedPath: string;
  followSymlinks: boolean;
  classifyError: (err: unknown) => Code;
  notFoundMessage: string;
  expectedCanonicalPath?: unknown;
  expectedBinding?: unknown;
}): Promise<
  | { ok: true; canonicalPath: string; identity: FileIdentity }
  | {
      ok: false;
      code: Code | "IS_FILE" | "CANONICAL_PATH_CHANGED";
      message: string;
      canonicalPath?: string;
    }
> {
  const canonicalPath = await resolveCanonicalReadPath(input);
  if (typeof canonicalPath !== "string") {
    return canonicalPath;
  }
  const canonicalPathChange = rejectCanonicalPathChange(input.expectedCanonicalPath, canonicalPath);
  if (canonicalPathChange) {
    return canonicalPathChange;
  }
  const directory = await statRequiredDirectory(canonicalPath, input.classifyError);
  if (!directory.ok) {
    return directory;
  }
  const expectedBinding = readPathBinding(input.expectedBinding);
  if (
    input.expectedBinding !== undefined &&
    (expectedBinding?.kind !== "existing" ||
      expectedBinding.device !== directory.identity.device ||
      expectedBinding.inode !== directory.identity.inode)
  ) {
    return {
      ok: false,
      code: "CANONICAL_PATH_CHANGED",
      message: "filesystem identity differs from the authorized target",
      canonicalPath,
    };
  }
  return { ...directory, canonicalPath };
}
