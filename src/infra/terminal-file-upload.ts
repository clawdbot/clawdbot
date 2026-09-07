import {
  lstat,
  lutimes,
  mkdir,
  mkdtemp,
  opendir,
  realpath,
  rm,
  rmdir,
  writeFile,
} from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { asNullableRecord } from "@openclaw/normalization-core/record-coerce";
import {
  isCanonicalTerminalUploadBase64,
  MAX_TERMINAL_UPLOAD_BASE64_LENGTH,
  MAX_TERMINAL_UPLOAD_BYTES,
  TERMINAL_UPLOAD_RETENTION_MS,
  terminalUploadDecodedSize,
} from "../../packages/gateway-protocol/src/schema/terminal-constants.js";
import { logWarn } from "../logger.js";
import { BoundedSerialQueue } from "../shared/bounded-serial-queue.js";
import { getFileLockProcessStartTime } from "../shared/pid-alive.js";
import { hasErrnoCode } from "./errno.js";
import { createFileLockManager } from "./file-lock-manager.js";
import { isLockOwnerDefinitelyStale } from "./stale-lock-file.js";
import { resolvePreferredOpenClawTmpDir } from "./tmp-openclaw-dir.js";

const TERMINAL_UPLOAD_PREFIX = "openclaw-terminal-upload-";
const TERMINAL_UPLOAD_CLEANUP_RETRY_MS = 60 * 60 * 1000;
const MAX_RETAINED_BYTES = 256 * 1024 * 1024;
const MAX_RETAINED_DIRECTORIES = 64;
const MAX_STAGED_NAME_BYTES = 180;
const PORTABLE_NAME_FORBIDDEN = new RegExp(String.raw`[\u0000-\u001f\u007f<>:"/\\|?*%!]`, "g");
const WINDOWS_RESERVED_NAME = /^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/iu;
const uploadLocks = createFileLockManager("openclaw.terminal-upload");
const pendingUploadLockReleases = new Map<string, () => Promise<void>>();
const uploadQueue = new BoundedSerialQueue({
  maxPendingCount: MAX_RETAINED_DIRECTORIES,
  maxPendingWeight: Math.ceil(MAX_RETAINED_BYTES / 3) * 4,
});

type CleanupState = {
  retentionMs: number;
  // One deadline per observed upload, including legacy inventories above the admission limit.
  deadlines: Map<string, { dev: bigint; ino: bigint; expiresAt: number }>;
  timer?: ReturnType<typeof setTimeout>;
  nextAt?: number;
};

const cleanupRoots = new Map<string, CleanupState>();
const cleanupRecoveries = new Map<string, Promise<void>>();

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
  const cleaned = basename
    .replace(PORTABLE_NAME_FORBIDDEN, "_")
    .trim()
    .replace(/[. ]+$/u, "");
  const portable = WINDOWS_RESERVED_NAME.test(cleaned) ? `_${cleaned}` : cleaned;
  const safe = portable && portable !== "." && portable !== ".." ? portable : "upload";
  return truncateUtf8(safe, MAX_STAGED_NAME_BYTES) || "upload";
}

function validateTerminalUpload(contentBase64: string): number {
  if (
    contentBase64.length > MAX_TERMINAL_UPLOAD_BASE64_LENGTH ||
    terminalUploadDecodedSize(contentBase64) > MAX_TERMINAL_UPLOAD_BYTES
  ) {
    throw new Error(`terminal upload exceeds ${MAX_TERMINAL_UPLOAD_BYTES} bytes`);
  }
  if (!isCanonicalTerminalUploadBase64(contentBase64)) {
    throw new Error("invalid terminal upload encoding");
  }
  return terminalUploadDecodedSize(contentBase64);
}

function stagingLimitError(): Error {
  return new Error(
    "terminal upload staging limit reached (256 MiB or 64 files). " +
      "Move or remove staged files, then retry, or wait for the 24-hour cleanup.",
  );
}

function cleanupState(root: string, retentionMs?: number): CleanupState {
  let state = cleanupRoots.get(root);
  if (!state) {
    state = { retentionMs: retentionMs ?? TERMINAL_UPLOAD_RETENTION_MS, deadlines: new Map() };
    cleanupRoots.set(root, state);
  } else if (retentionMs !== undefined) {
    state.retentionMs = retentionMs;
  }
  return state;
}

function scheduleCleanup(root: string, state: CleanupState, at: number): void {
  if (state.timer && state.nextAt !== undefined && state.nextAt <= at) {
    return;
  }
  if (state.timer) {
    clearTimeout(state.timer);
  }
  state.nextAt = at;
  state.timer = setTimeout(
    () => {
      state.timer = undefined;
      state.nextAt = undefined;
      void ensureTerminalUploadCleanup({ tempRoot: root, retentionMs: state.retentionMs });
    },
    Math.max(0, at - Date.now()),
  );
  state.timer.unref?.();
}

async function withUploadLock<T>(
  root: string,
  run: (assertHeld: () => Promise<void>) => Promise<T>,
): Promise<T> {
  const uid = typeof process.getuid === "function" ? process.getuid() : "user";
  const privateRoot = resolvePreferredOpenClawTmpDir({
    preferredDir: path.join(root, `.openclaw-terminal-staging-${uid}`),
    tmpdir: () => root,
  });
  const lockDirectory = path.join(privateRoot, "terminal-upload-lock");
  await mkdir(lockDirectory, { recursive: true, mode: 0o700 });
  await pendingUploadLockReleases.get(root)?.();
  const staleOwner = ({ payload }: { payload: unknown }) =>
    isLockOwnerDefinitelyStale({ payload: asNullableRecord(payload) });
  const lock = await uploadLocks
    .acquire(path.join(lockDirectory, "admission"), {
      retry: { retries: 40, factor: 1.2, minTimeout: 10, maxTimeout: 100 },
      staleRecovery: "remove-if-unchanged",
      payload: () => ({
        pid: process.pid,
        createdAt: new Date().toISOString(),
        starttime: getFileLockProcessStartTime(process.pid),
      }),
      shouldReclaim: staleOwner,
      shouldRemoveStaleLock: staleOwner,
    })
    .catch((error: unknown) => {
      if (hasErrnoCode(error, "file_lock_timeout") || hasErrnoCode(error, "file_lock_stale")) {
        const relativeLockDirectory = path.relative(root, lockDirectory);
        const recoveryLocation =
          process.platform === "win32"
            ? `${path.join(".openclaw", "tmp", relativeLockDirectory)} under the home directory of the account running this terminal's Gateway or node host`
            : `${relativeLockDirectory} under the system temporary directory used by this terminal's Gateway or node-host process`;
        throw new Error(
          "terminal upload staging is busy; retry after other uploads finish. " +
            `If it stays blocked after a crash, locate ${recoveryLocation}. ` +
            "Stop all Gateway and node-host processes using that staging root, " +
            "remove only this lock directory, then restart them.",
          { cause: error },
        );
      }
      throw error;
    });
  try {
    return await run(async () => {
      if (!(await lock.verifyStillHeld())) {
        throw new Error("terminal upload staging ownership changed; retry the upload");
      }
    });
  } finally {
    // A failed release retains fs-safe's held entry. Only finished callbacks
    // publish a retry, so recovery can never release an active upload or scan.
    const release = async () => {
      await lock.release();
      if (pendingUploadLockReleases.get(root) === release) {
        pendingUploadLockReleases.delete(root);
      }
    };
    pendingUploadLockReleases.set(root, release);
    await release();
  }
}

async function removeTerminalUploadDirectory(directory: string): Promise<boolean> {
  try {
    await rm(directory, { recursive: true, force: true });
    return true;
  } catch (error) {
    logWarn(`terminal-upload: cleanup failed; retrying: ${String(error)}`);
    return false;
  }
}

async function readUploadBytes(
  directory: string,
  remaining: number,
): Promise<{ bytes: number; empty: boolean }> {
  let bytes = 0;
  let empty = true;
  const entries = await opendir(directory);
  for await (const entry of entries) {
    empty = false;
    if (!entry.isFile() && !entry.isDirectory()) {
      continue;
    }
    const child = path.join(directory, entry.name);
    let stats;
    try {
      stats = await lstat(child);
    } catch (error) {
      if (hasErrnoCode(error, "ENOENT")) {
        continue;
      }
      throw error;
    }
    if (stats.isFile()) {
      bytes += stats.size;
    } else if (stats.isDirectory()) {
      bytes += (await readUploadBytes(child, remaining - bytes)).bytes;
    }
    if (bytes > remaining) {
      break;
    }
  }
  return { bytes, empty };
}

/** Disk is authoritative across processes, restarts, and files moved by an operator. */
async function scanUploads(
  root: string,
  state: CleanupState,
  assertHeld: () => Promise<void>,
  options: { nowMs?: number; incomingBytes?: number } = {},
): Promise<{ bytes: number; directories: number }> {
  const nowMs = options.nowMs ?? Date.now();
  const unseen = new Set(state.deadlines.keys());
  let bytes = 0;
  let directories = 0;
  let nextAt = Infinity;
  try {
    const entries = await opendir(root);
    for await (const entry of entries) {
      if (!entry.isDirectory() || !entry.name.startsWith(TERMINAL_UPLOAD_PREFIX)) {
        continue;
      }
      const directory = path.join(root, entry.name);
      let stats;
      try {
        stats = await lstat(directory, { bigint: true });
      } catch (error) {
        if (hasErrnoCode(error, "ENOENT")) {
          continue;
        }
        throw error;
      }
      if (
        !stats.isDirectory() ||
        (typeof process.getuid === "function" && stats.uid !== BigInt(process.getuid()))
      ) {
        continue;
      }
      unseen.delete(directory);
      let deadline = state.deadlines.get(directory);
      if (!deadline || deadline.dev !== stats.dev || deadline.ino !== stats.ino) {
        // Keep fractional milliseconds so recovery cannot expire an upload early.
        const mtimeMs =
          Number(stats.mtimeNs / 1_000_000n) + Number(stats.mtimeNs % 1_000_000n) / 1_000_000;
        if (mtimeMs > nowMs) {
          // Persist the clamp so another process cannot extend a future-dated upload.
          await assertHeld();
          await lutimes(directory, stats.atime, new Date(nowMs));
        }
        deadline = {
          dev: stats.dev,
          ino: stats.ino,
          expiresAt: Math.min(mtimeMs, nowMs) + state.retentionMs,
        };
        state.deadlines.set(directory, deadline);
      }
      const { expiresAt } = deadline;
      if (expiresAt <= nowMs) {
        await assertHeld();
        if (await removeTerminalUploadDirectory(directory)) {
          state.deadlines.delete(directory);
          continue;
        }
      }
      if (options.incomingBytes !== undefined) {
        if (bytes + options.incomingBytes <= MAX_RETAINED_BYTES) {
          const usage = await readUploadBytes(
            directory,
            MAX_RETAINED_BYTES - options.incomingBytes - bytes,
          );
          if (usage.empty) {
            // rmdir is atomic and cannot remove a file that appeared after a move.
            await assertHeld();
            try {
              await rmdir(directory);
              state.deadlines.delete(directory);
              continue;
            } catch (error) {
              if (hasErrnoCode(error, "ENOENT")) {
                state.deadlines.delete(directory);
                continue;
              }
              throw error;
            }
          }
          bytes += usage.bytes;
        }
        directories += 1;
      }
      nextAt = Math.min(
        nextAt,
        expiresAt <= nowMs ? nowMs + TERMINAL_UPLOAD_CLEANUP_RETRY_MS : expiresAt,
      );
    }
    for (const directory of unseen) {
      state.deadlines.delete(directory);
    }
  } catch (error) {
    nextAt = Math.min(nextAt, Date.now() + TERMINAL_UPLOAD_CLEANUP_RETRY_MS);
    throw error;
  } finally {
    if (Number.isFinite(nextAt)) {
      scheduleCleanup(root, state, nextAt);
    } else {
      if (state.timer) {
        clearTimeout(state.timer);
      }
      state.timer = undefined;
      state.nextAt = undefined;
      cleanupRoots.delete(root);
    }
  }
  return { bytes, directories };
}

async function runTerminalUploadCleanupRecovery(options?: {
  tempRoot?: string;
  retentionMs?: number;
  nowMs?: number;
}): Promise<void> {
  const requestedRoot = options?.tempRoot ?? resolveTerminalUploadRoot();
  let root = path.resolve(requestedRoot);
  try {
    root = await realpath(root);
    await withUploadLock(root, async (assertHeld) => {
      await scanUploads(root, cleanupState(root, options?.retentionMs), assertHeld, options);
    });
  } catch (error) {
    if (hasErrnoCode(error, "ENOENT")) {
      return;
    }
    logWarn(`terminal-upload: recovery failed; retrying: ${String(error)}`);
    scheduleCleanup(
      root,
      cleanupState(root, options?.retentionMs),
      Date.now() + TERMINAL_UPLOAD_CLEANUP_RETRY_MS,
    );
  }
}

/** Recovers existing uploads with a streaming scan and one cleanup timer per root. */
export function ensureTerminalUploadCleanup(options?: {
  tempRoot?: string;
  retentionMs?: number;
  nowMs?: number;
}): Promise<void> {
  const root = path.resolve(options?.tempRoot ?? resolveTerminalUploadRoot());
  const existing = cleanupRecoveries.get(root);
  if (existing) {
    return existing;
  }
  const recovery = runTerminalUploadCleanupRecovery(options).finally(() => {
    cleanupRecoveries.delete(root);
  });
  cleanupRecoveries.set(root, recovery);
  return recovery;
}

/** Stages one browser-selected file in a private, expiring temporary directory. */
export async function stageTerminalUpload(
  file: TerminalUploadFile,
  options?: TerminalUploadRootOptions & { tempRoot?: string; cleanupAfterMs?: number },
): Promise<TerminalUploadResult> {
  const { name, contentBase64 } = file;
  const size = validateTerminalUpload(contentBase64);
  const admitted = uploadQueue.enqueue(
    async () => {
      const tempRoot = options?.tempRoot ?? resolveTerminalUploadRoot(options);
      if ((options?.platform ?? process.platform) === "win32" && !options?.tempRoot) {
        // The user profile supplies the restrictive DACL, including for the root lock.
        await mkdir(tempRoot, { recursive: true, mode: 0o700 });
      }
      const root = await realpath(tempRoot);
      return await withUploadLock(root, async (assertHeld) => {
        const state = cleanupState(root);
        const retained = await scanUploads(root, state, assertHeld, { incomingBytes: size });
        if (
          retained.directories >= MAX_RETAINED_DIRECTORIES ||
          retained.bytes + size > MAX_RETAINED_BYTES
        ) {
          throw stagingLimitError();
        }
        await assertHeld();
        const directory = await mkdtemp(path.join(root, TERMINAL_UPLOAD_PREFIX));
        const targetPath = path.join(directory, sanitizeTerminalUploadName(name));
        let identity: { dev: bigint; ino: bigint } | undefined;
        try {
          const { dev, ino } = await lstat(directory, { bigint: true });
          identity = { dev, ino };
          await assertHeld();
          await writeFile(targetPath, Buffer.from(contentBase64, "base64"), {
            flag: "wx",
            mode: 0o600,
          });
          const expiresAt = Date.now() + (options?.cleanupAfterMs ?? TERMINAL_UPLOAD_RETENTION_MS);
          state.deadlines.set(directory, { ...identity, expiresAt });
          cleanupRoots.set(root, state);
          scheduleCleanup(root, state, expiresAt);
          return { path: targetPath, size };
        } catch (error) {
          if (!(await removeTerminalUploadDirectory(directory))) {
            const retryAt = Date.now() + TERMINAL_UPLOAD_CLEANUP_RETRY_MS;
            if (identity) {
              state.deadlines.set(directory, { ...identity, expiresAt: retryAt });
            }
            cleanupRoots.set(root, state);
            scheduleCleanup(root, state, retryAt);
          }
          throw error;
        }
      });
    },
    { weight: contentBase64.length, sealOnOverflow: false },
  );
  if (!admitted.accepted) {
    throw new Error("terminal upload staging is busy; retry after current uploads finish");
  }
  return await admitted.completion;
}
