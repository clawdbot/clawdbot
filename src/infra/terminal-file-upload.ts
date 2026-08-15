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
const MAX_STAGED_NAME_BYTES = 180;
const PORTABLE_NAME_FORBIDDEN = new Set(["<", ">", ":", '"', "/", "\\", "|", "?", "*", "%", "!"]);
const WINDOWS_RESERVED_NAME = /^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/iu;
const cleanupTimers = new Map<string, ReturnType<typeof setTimeout>>();
const cleanupRecoveryTimers = new Map<string, ReturnType<typeof setTimeout>>();
let defaultCleanupPromise: Promise<void> | undefined;

type TerminalUploadRootOptions = {
  platform?: NodeJS.Platform;
  homeDir?: string;
  tempDir?: string;
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
  const cleaned = Array.from(basename, (char) => {
    const codePoint = char.codePointAt(0) ?? 0;
    return codePoint <= 0x1f || codePoint === 0x7f || PORTABLE_NAME_FORBIDDEN.has(char)
      ? "_"
      : char;
  })
    .join("")
    .trim()
    .replace(/[. ]+$/u, "");
  const portable = WINDOWS_RESERVED_NAME.test(cleaned) ? `_${cleaned}` : cleaned;
  const safe = portable && portable !== "." && portable !== ".." ? portable : "upload";
  return truncateUtf8(safe, MAX_STAGED_NAME_BYTES) || "upload";
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
async function recoverTerminalUploadCleanup(options?: {
  tempRoot?: string;
  retentionMs?: number;
  nowMs?: number;
}): Promise<void> {
  const tempRoot = options?.tempRoot ?? resolveTerminalUploadRoot();
  const retentionMs = options?.retentionMs ?? TERMINAL_UPLOAD_RETENTION_MS;
  const nowMs = options?.nowMs ?? Date.now();
  let entries;
  try {
    entries = await readdir(tempRoot, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      logWarn(`terminal-upload: recovery scan failed: ${String(error)}`);
      throw error;
    }
    return;
  }
  await Promise.all(
    entries
      .filter((entry) => entry.isDirectory() && entry.name.startsWith(TERMINAL_UPLOAD_PREFIX))
      .map(async (entry) => {
        const directory = path.join(tempRoot, entry.name);
        try {
          const stats = await lstat(directory);
          if (!stats.isDirectory()) {
            return;
          }
          if (typeof process.getuid === "function" && stats.uid !== process.getuid()) {
            return;
          }
          const remainingMs = retentionMs - Math.max(0, nowMs - stats.mtimeMs);
          if (remainingMs <= 0) {
            await removeTerminalUploadDirectory(directory);
          } else {
            scheduleTerminalUploadCleanup(directory, remainingMs);
          }
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
            logWarn(`terminal-upload: recovery failed: ${String(error)}`);
            throw error;
          }
        }
      }),
  );
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

function scheduleTerminalUploadCleanupRetry(options?: {
  tempRoot?: string;
  retentionMs?: number;
}): void {
  const tempRoot = cleanupRecoveryRoot(options);
  if (cleanupRecoveryTimers.has(tempRoot)) {
    return;
  }
  const timer = setTimeout(() => {
    cleanupRecoveryTimers.delete(tempRoot);
    void ensureTerminalUploadCleanup(
      options ? { tempRoot, retentionMs: options.retentionMs } : undefined,
    );
  }, TERMINAL_UPLOAD_CLEANUP_RETRY_MS);
  cleanupRecoveryTimers.set(tempRoot, timer);
  timer.unref?.();
}

async function runTerminalUploadCleanupRecovery(options?: {
  tempRoot?: string;
  retentionMs?: number;
  nowMs?: number;
}): Promise<void> {
  const tempRoot = cleanupRecoveryRoot(options);
  try {
    await recoverTerminalUploadCleanup(options);
    clearTerminalUploadCleanupRetry(tempRoot);
  } catch {
    scheduleTerminalUploadCleanupRetry(options);
  }
}

/** Starts one process-wide recovery scan and retries transient scan failures. */
export function ensureTerminalUploadCleanup(options?: {
  tempRoot?: string;
  retentionMs?: number;
  nowMs?: number;
}): Promise<void> {
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
  options?: TerminalUploadRootOptions & { tempRoot?: string; cleanupAfterMs?: number },
): Promise<TerminalUploadResult> {
  if (!options?.tempRoot) {
    void ensureTerminalUploadCleanup();
  }
  const bytes = decodeTerminalUpload(file.contentBase64);
  const platform = options?.platform ?? process.platform;
  const tempRoot = options?.tempRoot ?? resolveTerminalUploadRoot(options);
  if (platform === "win32" && !options?.tempRoot) {
    // The user profile supplies the restrictive DACL; this mode protects POSIX-compatible hosts.
    await mkdir(tempRoot, { recursive: true, mode: 0o700 });
  }
  const directory = await mkdtemp(path.join(tempRoot, TERMINAL_UPLOAD_PREFIX));
  const targetPath = path.join(directory, sanitizeTerminalUploadName(file.name));
  try {
    await writeFile(targetPath, bytes, { flag: "wx", mode: 0o600 });
  } catch (error) {
    await removeTerminalUploadDirectory(directory);
    throw error;
  }
  scheduleTerminalUploadCleanup(directory, options?.cleanupAfterMs ?? TERMINAL_UPLOAD_RETENTION_MS);
  return { path: targetPath, size: bytes.length };
}
