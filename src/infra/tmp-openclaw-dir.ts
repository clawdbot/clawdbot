import fs from "node:fs";
import { tmpdir as getOsTmpDir } from "node:os";
import path from "node:path";

export const POSIX_OPENCLAW_TMP_DIR = "/tmp/openclaw";

type ResolvePreferredOpenClawTmpDirOptions = {
  accessSync?: (path: string, mode?: number) => void;
  chmodSync?: (path: string, mode: number) => void;
  lstatSync?: (path: string) => {
    isDirectory(): boolean;
    isSymbolicLink(): boolean;
    mode?: number;
    uid?: number;
  };
  mkdirSync?: (path: string, opts: { recursive: boolean; mode?: number }) => void;
  getuid?: () => number | undefined;
  tmpdir?: () => string;
  warn?: (message: string) => void;
};

type MaybeNodeError = { code?: string };

function isNodeErrorWithCode(err: unknown, code: string): err is MaybeNodeError {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as MaybeNodeError).code === code
  );
}

type ResolvePreferredOpenClawTmpDirInternalOptions = ResolvePreferredOpenClawTmpDirOptions & {
  /** Test seam for the host platform; defaults to `process.platform`. */
  platform?: NodeJS.Platform;
};

export function resolvePreferredOpenClawTmpDir(
  options: ResolvePreferredOpenClawTmpDirInternalOptions = {},
): string {
  // Evaluated here (not at module load) so this file is safe to import in browser bundles.
  const TMP_DIR_ACCESS_MODE = fs.constants.W_OK | fs.constants.X_OK;
  const accessSync = options.accessSync ?? fs.accessSync;
  const chmodSync = options.chmodSync ?? fs.chmodSync;
  const lstatSync = options.lstatSync ?? fs.lstatSync;
  const mkdirSync = options.mkdirSync ?? fs.mkdirSync;
  const warn = options.warn ?? ((message: string) => console.warn(message));
  const getuid =
    options.getuid ??
    (() => {
      try {
        return typeof process.getuid === "function" ? process.getuid() : undefined;
      } catch {
        return undefined;
      }
    });
  const tmpdir = typeof options.tmpdir === "function" ? options.tmpdir : getOsTmpDir;
  const platform = options.platform ?? process.platform;
  const uid = getuid();

  const isSecureDirForUser = (st: { mode?: number; uid?: number }): boolean => {
    if (uid === undefined) {
      return true;
    }
    if (typeof st.uid === "number" && st.uid !== uid) {
      return false;
    }
    // Avoid group/other writable dirs when running on multi-user hosts.
    if (typeof st.mode === "number" && (st.mode & 0o022) !== 0) {
      return false;
    }
    return true;
  };

  const fallback = (): string => {
    const base = tmpdir();
    const suffix = uid === undefined ? "openclaw" : `openclaw-${uid}`;
    // Use the platform-specific joiner so Windows fallbacks stay in pure
    // backslash form even when the host process is non-Windows (e.g. when
    // tests inject `platform: "win32"` on a Linux runner).
    const joiner = platform === "win32" ? path.win32.join : path.join;
    return joiner(base, suffix);
  };

  const isTrustedTmpDir = (st: {
    isDirectory(): boolean;
    isSymbolicLink(): boolean;
    mode?: number;
    uid?: number;
  }): boolean => {
    return st.isDirectory() && !st.isSymbolicLink() && isSecureDirForUser(st);
  };

  const resolveDirState = (candidatePath: string): "available" | "missing" | "invalid" => {
    try {
      const candidate = lstatSync(candidatePath);
      if (!isTrustedTmpDir(candidate)) {
        return "invalid";
      }
      accessSync(candidatePath, TMP_DIR_ACCESS_MODE);
      return "available";
    } catch (err) {
      if (isNodeErrorWithCode(err, "ENOENT")) {
        return "missing";
      }
      return "invalid";
    }
  };

  const tryRepairWritableBits = (candidatePath: string): boolean => {
    try {
      const st = lstatSync(candidatePath);
      if (!st.isDirectory() || st.isSymbolicLink()) {
        return false;
      }
      if (uid !== undefined && typeof st.uid === "number" && st.uid !== uid) {
        return false;
      }
      if (typeof st.mode !== "number") {
        return false;
      }
      if ((st.mode & 0o022) === 0) {
        return resolveDirState(candidatePath) === "available";
      }
      try {
        chmodSync(candidatePath, 0o700);
      } catch (chmodErr) {
        if (
          isNodeErrorWithCode(chmodErr, "EPERM") ||
          isNodeErrorWithCode(chmodErr, "EACCES") ||
          isNodeErrorWithCode(chmodErr, "ENOENT")
        ) {
          return resolveDirState(candidatePath) === "available";
        }
        throw chmodErr;
      }
      warn(`[openclaw] tightened permissions on temp dir: ${candidatePath}`);
      return resolveDirState(candidatePath) === "available";
    } catch {
      return false;
    }
  };

  const ensureTrustedFallbackDir = (): string => {
    const fallbackPath = fallback();
    const state = resolveDirState(fallbackPath);
    if (state === "available") {
      return fallbackPath;
    }
    if (state === "invalid") {
      if (tryRepairWritableBits(fallbackPath)) {
        return fallbackPath;
      }
      throw new Error(`Unsafe fallback OpenClaw temp dir: ${fallbackPath}`);
    }
    try {
      mkdirSync(fallbackPath, { recursive: true, mode: 0o700 });
      chmodSync(fallbackPath, 0o700);
    } catch {
      throw new Error(`Unable to create fallback OpenClaw temp dir: ${fallbackPath}`);
    }
    if (resolveDirState(fallbackPath) !== "available" && !tryRepairWritableBits(fallbackPath)) {
      throw new Error(`Unsafe fallback OpenClaw temp dir: ${fallbackPath}`);
    }
    return fallbackPath;
  };

  // On Windows, Node resolves the POSIX path `/tmp` to `C:\tmp` (relative to
  // the current drive root). Many Windows hosts have `C:\tmp` because Git,
  // MSYS2, and other Unix-compat tools create it; the existing logic then
  // happily writes logs and TTS files to `C:\tmp\openclaw\` while every
  // other code path expects `%TEMP%\openclaw\`. Skip the POSIX preferred
  // path entirely on Windows so the function falls through to the
  // os.tmpdir() fallback (#60713).
  if (platform === "win32") {
    return ensureTrustedFallbackDir();
  }

  const existingPreferredState = resolveDirState(POSIX_OPENCLAW_TMP_DIR);
  if (existingPreferredState === "available") {
    return POSIX_OPENCLAW_TMP_DIR;
  }
  if (existingPreferredState === "invalid") {
    if (tryRepairWritableBits(POSIX_OPENCLAW_TMP_DIR)) {
      return POSIX_OPENCLAW_TMP_DIR;
    }
    return ensureTrustedFallbackDir();
  }

  try {
    accessSync("/tmp", TMP_DIR_ACCESS_MODE);
    // Create with a safe default; subsequent callers expect it exists.
    mkdirSync(POSIX_OPENCLAW_TMP_DIR, { recursive: true, mode: 0o700 });
    chmodSync(POSIX_OPENCLAW_TMP_DIR, 0o700);
    if (
      resolveDirState(POSIX_OPENCLAW_TMP_DIR) !== "available" &&
      !tryRepairWritableBits(POSIX_OPENCLAW_TMP_DIR)
    ) {
      return ensureTrustedFallbackDir();
    }
    return POSIX_OPENCLAW_TMP_DIR;
  } catch {
    return ensureTrustedFallbackDir();
  }
}
