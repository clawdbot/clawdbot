import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import {
  canonicalPathFromExistingAncestor,
  FsSafeError,
  resolveAbsolutePathForWrite,
  root,
} from "openclaw/plugin-sdk/security-runtime";

const MAX_CONTENT_BYTES = 16 * 1024 * 1024; // 16 MB

type FileWriteParams = {
  path: string;
  contentBase64: string;
  overwrite: boolean;
  createParents: boolean;
  expectedSha256?: string;
  followSymlinks?: boolean;
  preflightOnly?: boolean;
};

type FileWriteSuccess = {
  ok: true;
  path: string;
  size: number;
  sha256: string;
  overwritten: boolean;
};

type FileWriteError = {
  ok: false;
  code: string;
  message: string;
  canonicalPath?: string;
};

type FileWriteResult = FileWriteSuccess | FileWriteError;

function sha256Hex(buf: Buffer): string {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

function err(code: string, message: string, canonicalPath?: string): FileWriteError {
  return { ok: false, code, message, ...(canonicalPath ? { canonicalPath } : {}) };
}

function symlinkRedirectError(error: FsSafeError): FileWriteError {
  const canonicalTarget =
    error.cause &&
    typeof error.cause === "object" &&
    "canonicalPath" in error.cause &&
    typeof error.cause.canonicalPath === "string"
      ? error.cause.canonicalPath
      : undefined;
  return err(
    "SYMLINK_REDIRECT",
    "path traverses a symlink; refusing because followSymlinks=false (set plugins.entries.file-transfer.config.nodes.<node>.followSymlinks=true to allow, or update allowWritePaths to the canonical path)",
    canonicalTarget,
  );
}

function writeFsSafeError(error: FsSafeError, targetPath: string): FileWriteError {
  if (error.code === "symlink") {
    return err(
      "SYMLINK_TARGET_DENIED",
      `path is a symlink; refusing to write through it: ${targetPath}`,
    );
  }
  if (error.code === "not-file") {
    return err("IS_DIRECTORY", `path resolves to a directory: ${targetPath}`);
  }
  if (error.code === "already-exists") {
    return err("EXISTS_NO_OVERWRITE", `file already exists and overwrite is false: ${targetPath}`);
  }
  return err("WRITE_ERROR", error.message, targetPath);
}

export async function handleFileWrite(
  params: Partial<FileWriteParams> & Record<string, unknown>,
): Promise<FileWriteResult> {
  const rawPath = typeof params?.path === "string" ? params.path : "";
  const hasContentBase64 = typeof params?.contentBase64 === "string";
  const contentBase64 = hasContentBase64 ? (params.contentBase64 as string) : "";
  const overwrite = params?.overwrite === true;
  const createParents = params?.createParents === true;
  const expectedSha256 =
    typeof params?.expectedSha256 === "string" ? params.expectedSha256 : undefined;
  const followSymlinks = params?.followSymlinks === true;
  const preflightOnly = params?.preflightOnly === true;

  // 1. Validate path: must be absolute, non-empty, no NUL byte
  if (!rawPath) {
    return err("INVALID_PATH", "path is required");
  }
  if (rawPath.includes("\0")) {
    return err("INVALID_PATH", "path must not contain NUL bytes");
  }
  if (!path.isAbsolute(rawPath)) {
    return err("INVALID_PATH", "path must be absolute");
  }
  if (!hasContentBase64) {
    return err("INVALID_BASE64", "contentBase64 is required");
  }

  // 2. Decode base64 → Buffer.
  //    Buffer.from(s, "base64") in Node never throws — it silently drops
  //    non-base64 characters and returns whatever it could decode. That
  //    means a typo or truncated input would land garbage on disk if we
  //    accepted whatever decoded. Defense: round-trip the decoded buffer
  //    back to base64 and compare against the input modulo padding/url
  //    variants. A mismatch means characters were silently dropped.
  const buf = Buffer.from(contentBase64, "base64");
  const reEncoded = buf.toString("base64");
  // Normalize: drop padding and convert base64url chars to standard so the
  // comparison tolerates both "=" / no-"=" inputs and "-_" base64url.
  const normalize = (s: string): string =>
    s.replace(/=+$/u, "").replace(/-/gu, "+").replace(/_/gu, "/");
  if (normalize(reEncoded) !== normalize(contentBase64)) {
    return err("INVALID_BASE64", "contentBase64 is not valid base64");
  }

  if (buf.length > MAX_CONTENT_BYTES) {
    return err(
      "FILE_TOO_LARGE",
      `decoded content is ${buf.length} bytes; maximum is ${MAX_CONTENT_BYTES} bytes (16 MB)`,
    );
  }

  let targetPath: string;
  let parentDir: string;
  let parentExists: boolean;
  try {
    const resolved = await resolveAbsolutePathForWrite(rawPath, {
      symlinks: followSymlinks ? "follow" : "reject",
    });
    targetPath = resolved.path;
    parentDir = resolved.parentDir;
    parentExists = resolved.parentExists;
  } catch (error) {
    if (error instanceof FsSafeError && error.code === "symlink") {
      return symlinkRedirectError(error);
    }
    throw error;
  }

  if (!parentExists) {
    if (!createParents) {
      return err("PARENT_NOT_FOUND", `parent directory does not exist: ${parentDir}`);
    }
    if (preflightOnly) {
      const computedSha256 = sha256Hex(buf);
      if (expectedSha256 && expectedSha256.toLowerCase() !== computedSha256) {
        return err(
          "INTEGRITY_FAILURE",
          `sha256 mismatch: expected ${expectedSha256.toLowerCase()}, got ${computedSha256}`,
          targetPath,
        );
      }
      return {
        ok: true,
        path: await canonicalPathFromExistingAncestor(targetPath),
        size: buf.length,
        sha256: computedSha256,
        overwritten: false,
      };
    }
    try {
      await fs.mkdir(parentDir, { recursive: true });
    } catch (mkdirErr) {
      const message = mkdirErr instanceof Error ? mkdirErr.message : String(mkdirErr);
      return err("WRITE_ERROR", `failed to create parent directories: ${message}`);
    }
  }

  try {
    await resolveAbsolutePathForWrite(targetPath, {
      symlinks: followSymlinks ? "follow" : "reject",
    });
  } catch (error) {
    if (error instanceof FsSafeError && error.code === "symlink") {
      return symlinkRedirectError(error);
    }
    throw error;
  }

  const targetFileName = path.basename(targetPath);
  const parentRoot = await root(parentDir);
  let overwritten = false;
  try {
    const existingLStat = await fs.lstat(targetPath);
    if (existingLStat.isSymbolicLink()) {
      return err(
        "SYMLINK_TARGET_DENIED",
        `path is a symlink; refusing to write through it: ${targetPath}`,
      );
    }
    if (existingLStat.isDirectory()) {
      return err("IS_DIRECTORY", `path resolves to a directory: ${targetPath}`);
    }
    if (!overwrite) {
      return err(
        "EXISTS_NO_OVERWRITE",
        `file already exists and overwrite is false: ${targetPath}`,
      );
    }
    overwritten = true;
  } catch (statErr: unknown) {
    const statErrorCode =
      statErr instanceof FsSafeError ? statErr.code : (statErr as NodeJS.ErrnoException).code;
    if (statErrorCode !== "not-found" && statErrorCode !== "ENOENT") {
      const message = statErr instanceof Error ? statErr.message : String(statErr);
      if (message.toLowerCase().includes("permission")) {
        return err("PERMISSION_DENIED", `permission denied: ${targetPath}`);
      }
      return err("WRITE_ERROR", `unexpected stat error: ${message}`);
    }
  }

  // 5. Hash the decoded buffer BEFORE touching disk. If the caller
  //    supplied expectedSha256 and it doesn't match, refuse outright so
  //    a bad caller hash with overwrite=true can't replace + delete the
  //    original. Computing from the buffer (not a re-read) is the right
  //    source of truth — the caller asked us to write THESE bytes.
  const computedSha256 = sha256Hex(buf);
  if (expectedSha256 && expectedSha256.toLowerCase() !== computedSha256) {
    return err(
      "INTEGRITY_FAILURE",
      `sha256 mismatch: expected ${expectedSha256.toLowerCase()}, got ${computedSha256}`,
      targetPath,
    );
  }

  if (preflightOnly) {
    return {
      ok: true,
      path: await canonicalPathFromExistingAncestor(targetPath),
      size: buf.length,
      sha256: computedSha256,
      overwritten,
    };
  }

  try {
    if (overwrite) {
      await parentRoot.write(targetFileName, buf);
    } else {
      await parentRoot.create(targetFileName, buf);
    }
  } catch (writeErr) {
    if (writeErr instanceof FsSafeError) {
      return writeFsSafeError(writeErr, targetPath);
    }
    const message = writeErr instanceof Error ? writeErr.message : String(writeErr);
    if (message.toLowerCase().includes("permission") || message.toLowerCase().includes("access")) {
      return err("PERMISSION_DENIED", `permission denied writing to: ${parentDir}`);
    }
    return err("WRITE_ERROR", `failed to write file: ${message}`);
  }

  let canonicalPath = targetPath;
  try {
    const opened = await parentRoot.open(targetFileName);
    canonicalPath = opened.realPath;
    await opened.handle.close().catch(() => undefined);
  } catch (openErr) {
    if (openErr instanceof FsSafeError) {
      return writeFsSafeError(openErr, targetPath);
    }
  }

  return {
    ok: true,
    path: canonicalPath,
    size: buf.length,
    sha256: computedSha256,
    overwritten,
  };
}
