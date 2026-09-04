import { lstat, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import {
  isCanonicalTerminalUploadBase64,
  MAX_TERMINAL_UPLOAD_BASE64_LENGTH,
  MAX_TERMINAL_UPLOAD_BYTES,
  terminalUploadDecodedSize,
} from "../../packages/gateway-protocol/src/schema/terminal-constants.js";
import { logWarn } from "../logger.js";

const TERMINAL_UPLOAD_PREFIX = "openclaw-terminal-upload-";
const TERMINAL_UPLOAD_RETENTION_MS = 24 * 60 * 60 * 1000;
const TERMINAL_UPLOAD_CLEANUP_RETRY_MS = 60 * 60 * 1000;
const TERMINAL_UPLOAD_MAX_RETAINED_BYTES = 256 * 1024 * 1024;
const TERMINAL_UPLOAD_MAX_RETAINED_DIRECTORIES = 64;
const MAX_STAGED_NAME_BYTES = 180;
const PORTABLE_NAME_FORBIDDEN = new RegExp(String.raw`[\u0000-\u001f\u007f<>:"/\\|?*%!]`, "g");
const WINDOWS_RESERVED_NAME = /^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/iu;
const cleanupTimers = new Map<string, ReturnType<typeof setTimeout>>();
const cleanupRecoveryTimers = new Map<string, ReturnType<typeof setTimeout>>();
const stagingLocks = new Map<string, Promise<void>>();
let defaultCleanupPromise: Promise<void> | undefined;

type TerminalUploadRootOptions = {
  platform?: NodeJS.Platform;
  homeDir?: string;
  tempDir?: string;
};

type TerminalUploadLimits = {
  maxRetainedBytes?: number;
  maxRetainedDirectories?: number;
};

type TerminalUploadCleanupOptions = TerminalUploadLimits & {
  tempRoot?: string;
  retentionMs?: number;
  nowMs?: number;
};

type StagedUploadLimits = {
  maxRetainedBytes: number;
  maxRetainedDirectories: number;
};

type OwnedStagedUpload = {
  bytes: number;
  directory: string;
  mtimeMs: number;
};

/** Windows temp variables can point at a shared directory; inherit the user's profile ACL instead. */
function resolveTerminalUploadRoot(options?: TerminalUploadRootOptions): string {
  return (options?.platform ?? process.platform) === "win32"
    ? path.join(options?.homeDir ?? homedir(), ".openclaw", "tmp")
    : (options?.tempDir ?? tmpdir());
}

export type TerminalUploadFile = {
  name: string;
  contentBase64: string;
};

export type TerminalUploadResult = {
  path: string;
  size: number;
};

function truncateUtf8(value: string, maxBytes: number): string {
  let result = "";
  let bytes = 0;
  for (const character of value) {
    const nextBytes = Buffer.byteLength(character, "utf8");
    if (bytes + nextBytes > maxBytes) {
      break;
    }
    result += character;
    bytes += nextBytes;
  }
  return result;
}

function sanitizeTerminalUploadName(name: string): string {
  const basename = path.posix.basename(name.replaceAll("\\", "/"));
  const cleaned = basename
    .replace(PORTABLE_NAME_FORBIDDEN, "_")
    .trim()
    .replace(/[. ]+$/u, "");
  const portable = WINDOWS_RESERVED_NAME.test(cleaned) ? `_${cleaned}` : cleaned;
  const safe = portable && portable !== "." && portable !== ".." ? portable : "upload";
  return truncateUtf8(safe, MAX_STAGED_NAME_BYTES) || "upload";
}

function resolveStagedUploadLimits(options?: TerminalUploadLimits): StagedUploadLimits {
  return {
    maxRetainedBytes: options?.maxRetainedBytes ?? TERMINAL_UPLOAD_MAX_RETAINED_BYTES,
    maxRetainedDirectories:
      options?.maxRetainedDirectories ?? TERMINAL_UPLOAD_MAX_RETAINED_DIRECTORIES,
  };
}

async function readDirectoryBytes(directory: string): Promise<number> {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    // SAFETY: Node readdir rejects with ErrnoException; missing dirs contribute 0 bytes.
    // SAFETY: fs errors from readdir are ErrnoException; only ENOENT means the
    // staging directory is gone and counts as zero retained bytes.
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return 0;
    }
    throw error;
  }
  let totalBytes = 0;
  for (const entry of entries) {
    if (!entry.isFile()) {
      continue;
    }
    try {
      const stats = await lstat(path.join(directory, entry.name));
      totalBytes += stats.isFile() ? stats.size : 0;
    } catch (error) {
      // SAFETY: Node lstat rejects with ErrnoException; a vanished file contributes 0 bytes.
      // SAFETY: lstat of a just-listed file can race with unlink; ENOENT is the
      // only code that means the file is already gone.
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }
  }
  return totalBytes;
}

async function readOwnedStagedUploads(tempRoot: string): Promise<OwnedStagedUpload[]> {
  let entries;
  try {
    entries = await readdir(tempRoot, { withFileTypes: true });
  } catch (error) {
    // SAFETY: Node readdir rejects with ErrnoException; a missing temp root has no uploads.
    // SAFETY: fs errors from readdir are ErrnoException; ENOENT means the
    // staging root does not exist yet, so there are no owned uploads.
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw error;
  }
  const uploads = await Promise.all(
    entries
      .filter((entry) => entry.isDirectory() && entry.name.startsWith(TERMINAL_UPLOAD_PREFIX))
      .map(async (entry): Promise<OwnedStagedUpload | null> => {
        const directory = path.join(tempRoot, entry.name);
        try {
          const stats = await lstat(directory);
          if (!stats.isDirectory()) {
            return null;
          }
          if (typeof process.getuid === "function" && stats.uid !== process.getuid()) {
            return null;
          }
          return {
            bytes: await readDirectoryBytes(directory),
            directory,
            mtimeMs: stats.mtimeMs,
          };
        } catch (error) {
          // SAFETY: Node lstat rejects with ErrnoException; a vanished staging dir is not owned.
          // SAFETY: lstat/readdir of a just-listed staging dir can race with
          // prune; ENOENT means that upload is already gone.
          if ((error as NodeJS.ErrnoException).code === "ENOENT") {
            return null;
          }
          throw error;
        }
      }),
  );
  return uploads.filter((upload): upload is OwnedStagedUpload => upload !== null);
}

async function withStagingLock<T>(tempRoot: string, task: () => Promise<T>): Promise<T> {
  const previous = stagingLocks.get(tempRoot) ?? Promise.resolve();
  let release = () => {};
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = previous.then(() => current);
  stagingLocks.set(tempRoot, tail);
  try {
    await previous;
    return await task();
  } finally {
    release();
    if (stagingLocks.get(tempRoot) === tail) {
      stagingLocks.delete(tempRoot);
    }
  }
}

function decodeTerminalUpload(contentBase64: string): Buffer {
  if (
    contentBase64.length > MAX_TERMINAL_UPLOAD_BASE64_LENGTH ||
    terminalUploadDecodedSize(contentBase64) > MAX_TERMINAL_UPLOAD_BYTES
  ) {
    throw new Error(`terminal upload exceeds ${MAX_TERMINAL_UPLOAD_BYTES} bytes`);
  }
  if (!isCanonicalTerminalUploadBase64(contentBase64)) {
    throw new Error("invalid terminal upload encoding");
  }
  const bytes = Buffer.from(contentBase64, "base64");
  if (bytes.length > MAX_TERMINAL_UPLOAD_BYTES) {
    throw new Error(`terminal upload exceeds ${MAX_TERMINAL_UPLOAD_BYTES} bytes`);
  }
  if (bytes.toString("base64") !== contentBase64) {
    throw new Error("invalid terminal upload encoding");
  }
  return bytes;
}

async function removeTerminalUploadDirectory(directory: string): Promise<void> {
  const timer = cleanupTimers.get(directory);
  if (timer) {
    clearTimeout(timer);
    cleanupTimers.delete(directory);
  }
  try {
    await rm(directory, { recursive: true, force: true });
  } catch (error) {
    logWarn(`terminal-upload: cleanup failed; retrying: ${String(error)}`);
    scheduleTerminalUploadCleanup(directory, TERMINAL_UPLOAD_CLEANUP_RETRY_MS);
  }
}

function scheduleTerminalUploadCleanup(directory: string, afterMs: number): void {
  if (cleanupTimers.has(directory)) {
    return;
  }
  const timer = setTimeout(
    () => {
      cleanupTimers.delete(directory);
      void removeTerminalUploadDirectory(directory);
    },
    Math.max(0, afterMs),
  );
  cleanupTimers.set(directory, timer);
  timer.unref?.();
}

/** Restores cleanup timers for staged uploads left by a previous process. */
async function recoverTerminalUploadCleanup(options?: TerminalUploadCleanupOptions): Promise<void> {
  const tempRoot = options?.tempRoot ?? resolveTerminalUploadRoot();
  const retentionMs = options?.retentionMs ?? TERMINAL_UPLOAD_RETENTION_MS;
  const nowMs = options?.nowMs ?? Date.now();
  const limits = resolveStagedUploadLimits(options);
  const retained: OwnedStagedUpload[] = [];
  let uploads: OwnedStagedUpload[];
  try {
    uploads = await readOwnedStagedUploads(tempRoot);
  } catch (error) {
    logWarn(`terminal-upload: recovery scan failed: ${String(error)}`);
    throw error;
  }
  for (const upload of uploads) {
    const remainingMs = retentionMs - Math.max(0, nowMs - upload.mtimeMs);
    if (remainingMs <= 0) {
      await removeTerminalUploadDirectory(upload.directory);
    } else {
      retained.push(upload);
    }
  }

  // A restarted process has no surviving operator request that can still own these
  // copies, so oldest-first eviction safely restores the bounded retention budget.
  retained.sort((left, right) => left.mtimeMs - right.mtimeMs);
  let totalBytes = retained.reduce((total, upload) => total + upload.bytes, 0);
  while (retained.length > limits.maxRetainedDirectories || totalBytes > limits.maxRetainedBytes) {
    const oldest = retained.shift();
    if (!oldest) {
      break;
    }
    totalBytes -= oldest.bytes;
    await removeTerminalUploadDirectory(oldest.directory);
  }
  for (const upload of retained) {
    const remainingMs = retentionMs - Math.max(0, nowMs - upload.mtimeMs);
    scheduleTerminalUploadCleanup(upload.directory, remainingMs);
  }
}

function cleanupRecoveryRoot(options?: { tempRoot?: string }): string {
  return options?.tempRoot ?? resolveTerminalUploadRoot();
}

function clearTerminalUploadCleanupRetry(tempRoot: string): void {
  const timer = cleanupRecoveryTimers.get(tempRoot);
  if (!timer) {
    return;
  }
  clearTimeout(timer);
  cleanupRecoveryTimers.delete(tempRoot);
}

function scheduleTerminalUploadCleanupRetry(options?: TerminalUploadCleanupOptions): void {
  const tempRoot = cleanupRecoveryRoot(options);
  if (cleanupRecoveryTimers.has(tempRoot)) {
    return;
  }
  const timer = setTimeout(() => {
    cleanupRecoveryTimers.delete(tempRoot);
    void ensureTerminalUploadCleanup(
      options
        ? {
            tempRoot,
            retentionMs: options.retentionMs,
            maxRetainedBytes: options.maxRetainedBytes,
            maxRetainedDirectories: options.maxRetainedDirectories,
          }
        : undefined,
    );
  }, TERMINAL_UPLOAD_CLEANUP_RETRY_MS);
  cleanupRecoveryTimers.set(tempRoot, timer);
  timer.unref?.();
}

async function runTerminalUploadCleanupRecovery(
  options?: TerminalUploadCleanupOptions,
): Promise<void> {
  const tempRoot = cleanupRecoveryRoot(options);
  try {
    await recoverTerminalUploadCleanup(options);
    clearTerminalUploadCleanupRetry(tempRoot);
  } catch {
    scheduleTerminalUploadCleanupRetry(options);
  }
}

/** Starts one process-wide recovery scan and retries transient scan failures. */
export function ensureTerminalUploadCleanup(options?: TerminalUploadCleanupOptions): Promise<void> {
  if (options) {
    return runTerminalUploadCleanupRecovery(options);
  }
  if (defaultCleanupPromise) {
    return defaultCleanupPromise;
  }
  defaultCleanupPromise = runTerminalUploadCleanupRecovery().finally(() => {
    if (cleanupRecoveryTimers.has(cleanupRecoveryRoot())) {
      defaultCleanupPromise = undefined;
    }
  });
  return defaultCleanupPromise;
}

/** Stages one browser-selected file in a private, expiring temporary directory. */
export async function stageTerminalUpload(
  file: TerminalUploadFile,
  options?: TerminalUploadRootOptions &
    TerminalUploadLimits & { tempRoot?: string; cleanupAfterMs?: number },
): Promise<TerminalUploadResult> {
  if (!options?.tempRoot) {
    await ensureTerminalUploadCleanup();
  }
  const bytes = decodeTerminalUpload(file.contentBase64);
  const platform = options?.platform ?? process.platform;
  const tempRoot = options?.tempRoot ?? resolveTerminalUploadRoot(options);
  const limits = resolveStagedUploadLimits(options);
  if (platform === "win32" && !options?.tempRoot) {
    // The user profile supplies the restrictive DACL; this mode protects POSIX-compatible hosts.
    await mkdir(tempRoot, { recursive: true, mode: 0o700 });
  }
  return await withStagingLock(tempRoot, async () => {
    const retained = await readOwnedStagedUploads(tempRoot);
    const retainedBytes = retained.reduce((total, upload) => total + upload.bytes, 0);
    if (
      retained.length >= limits.maxRetainedDirectories ||
      retainedBytes + bytes.length > limits.maxRetainedBytes
    ) {
      throw new Error("terminal upload staging limit reached");
    }
    const directory = await mkdtemp(path.join(tempRoot, TERMINAL_UPLOAD_PREFIX));
    const targetPath = path.join(directory, sanitizeTerminalUploadName(file.name));
    try {
      await writeFile(targetPath, bytes, { flag: "wx", mode: 0o600 });
    } catch (error) {
      await removeTerminalUploadDirectory(directory);
      throw error;
    }
    scheduleTerminalUploadCleanup(
      directory,
      options?.cleanupAfterMs ?? TERMINAL_UPLOAD_RETENTION_MS,
    );
    return { path: targetPath, size: bytes.length };
  });
}
