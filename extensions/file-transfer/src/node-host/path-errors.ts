// File Transfer plugin module implements path errors behavior.
import fs from "node:fs/promises";
import path from "node:path";
import { FsSafeError, resolveAbsolutePathForRead } from "openclaw/plugin-sdk/security-runtime";

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
  { ok: true } | { ok: false; code: Code | "IS_FILE"; message: string; canonicalPath: string }
> {
  let stats: Awaited<ReturnType<typeof fs.stat>>;
  try {
    stats = await fs.stat(canonicalPath);
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
  return { ok: true };
}
