// Wraps fs-safe atomic replacement and move helpers for OpenClaw install flows.
import "./fs-safe-defaults.js";
import syncFs from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import {
  movePathWithCopyFallback as movePathWithCopyFallbackBase,
  replaceFileAtomic as replaceFileAtomicBase,
  replaceFileAtomicSync as replaceFileAtomicSyncBase,
  type MovePathWithCopyFallbackOptions as BaseMovePathWithCopyFallbackOptions,
  type ReplaceFileAtomicFileSystem,
  type ReplaceFileAtomicOptions,
  type ReplaceFileAtomicResult,
  type ReplaceFileAtomicSyncFileSystem,
  type ReplaceFileAtomicSyncOptions,
} from "@openclaw/fs-safe/atomic";

export { replaceDirectoryAtomic } from "@openclaw/fs-safe/atomic";

const defaultFileSystem = { promises: fs } satisfies ReplaceFileAtomicFileSystem;
const defaultSyncFileSystem = syncFs satisfies ReplaceFileAtomicSyncFileSystem;

export async function replaceFileAtomic(
  options: ReplaceFileAtomicOptions,
): Promise<ReplaceFileAtomicResult> {
  return await replaceFileAtomicBase(withFinalPathChmodSkipped(options));
}

export function replaceFileAtomicSync(
  options: ReplaceFileAtomicSyncOptions,
): ReplaceFileAtomicResult {
  return replaceFileAtomicSyncBase(withFinalPathChmodSkippedSync(options));
}

function withFinalPathChmodSkipped(options: ReplaceFileAtomicOptions): ReplaceFileAtomicOptions {
  const fileSystem = options.fileSystem ?? defaultFileSystem;
  const original = fileSystem.promises;
  let requestedMode: Promise<number> | undefined;
  const getRequestedMode = (): Promise<number> => {
    requestedMode ??= resolveMode(options, original);
    return requestedMode;
  };
  return {
    ...options,
    fileSystem: {
      promises: {
        ...original,
        chmod: async (target, mode) => {
          if (String(target) === options.filePath) {
            return;
          }
          await original.chmod(target, mode);
        },
        open: async (target, flags, mode) => {
          const handle = await original.open(target, flags, mode);
          if (String(target) === options.filePath) {
            try {
              await handle.chmod(await getRequestedMode());
            } catch (error) {
              await handle.close().catch(() => undefined);
              throw error;
            }
          }
          return handle;
        },
      },
    },
    beforeRename: async (params) => {
      await options.beforeRename?.(params);
      await setTempModeExactly(params.tempPath, await getRequestedMode(), original);
    },
  };
}

function withFinalPathChmodSkippedSync(
  options: ReplaceFileAtomicSyncOptions,
): ReplaceFileAtomicSyncOptions {
  const fileSystem = options.fileSystem ?? defaultSyncFileSystem;
  const mode = resolveModeSync(options, fileSystem);
  return {
    ...options,
    fileSystem: {
      ...fileSystem,
      chmodSync: (target, chmodMode) => {
        if (String(target) === options.filePath) {
          return;
        }
        fileSystem.chmodSync(target, chmodMode);
      },
      openSync: (target, flags, openMode) => {
        const fd = fileSystem.openSync(target, flags, openMode);
        if (String(target) === options.filePath) {
          try {
            syncFs.fchmodSync(fd, mode);
          } catch (error) {
            try {
              fileSystem.closeSync(fd);
            } catch {}
            throw error;
          }
        }
        return fd;
      },
    },
    beforeRename: (params) => {
      options.beforeRename?.(params);
      setTempModeExactlySync(params.tempPath, mode, fileSystem);
    },
  };
}

async function resolveMode(
  options: ReplaceFileAtomicOptions,
  fsModule: ReplaceFileAtomicFileSystem["promises"],
): Promise<number> {
  const defaultMode = options.mode ?? 0o600;
  if (!options.preserveExistingMode) {
    return defaultMode;
  }
  try {
    const stat = await fsModule.stat(options.filePath);
    return stat.mode;
  } catch (error) {
    if (isNotFoundError(error)) {
      return defaultMode;
    }
    throw error;
  }
}

function resolveModeSync(
  options: ReplaceFileAtomicSyncOptions,
  fsModule: ReplaceFileAtomicSyncFileSystem,
): number {
  const defaultMode = options.mode ?? 0o600;
  if (!options.preserveExistingMode) {
    return defaultMode;
  }
  try {
    return fsModule.statSync(options.filePath).mode;
  } catch (error) {
    if (isNotFoundError(error)) {
      return defaultMode;
    }
    throw error;
  }
}

async function setTempModeExactly(
  tempPath: string,
  mode: number,
  fsModule: ReplaceFileAtomicFileSystem["promises"],
): Promise<void> {
  const stat = await fsModule.lstat(tempPath);
  if ((stat.mode & 0o7777) === (mode & 0o7777)) {
    return;
  }
  const handle = await fsModule.open(tempPath, noFollowReadFlags());
  try {
    await handle.chmod(mode);
  } finally {
    await handle.close();
  }
}

function setTempModeExactlySync(
  tempPath: string,
  mode: number,
  fsModule: ReplaceFileAtomicSyncFileSystem,
): void {
  const stat = fsModule.lstatSync(tempPath);
  if ((stat.mode & 0o7777) === (mode & 0o7777)) {
    return;
  }
  const fd = fsModule.openSync(tempPath, noFollowReadFlags());
  try {
    syncFs.fchmodSync(fd, mode);
  } finally {
    fsModule.closeSync(fd);
  }
}

function isNotFoundError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}

function noFollowReadFlags(): number | string {
  const constants = syncFs.constants;
  if (!constants || typeof constants.O_RDONLY !== "number") {
    return "r";
  }
  return constants.O_RDONLY | (typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0);
}

/** Options for moving paths while optionally rejecting hardlinked source files. */
type MovePathWithCopyFallbackOptions = BaseMovePathWithCopyFallbackOptions & {
  sourceHardlinks?: "allow" | "reject";
};

/**
 * Moves a path using fs-safe's copy fallback, with an OpenClaw hardlink guard
 * for install/update flows that must not preserve package-manager links.
 */
export async function movePathWithCopyFallback(
  options: MovePathWithCopyFallbackOptions,
): Promise<void> {
  if (options.sourceHardlinks === "reject") {
    await assertNoHardlinkedSourceFiles(options.from);
  }
  await movePathWithCopyFallbackBase({ from: options.from, to: options.to });
}

async function assertNoHardlinkedSourceFiles(sourcePath: string): Promise<void> {
  const sourceStat = await fs.lstat(sourcePath);
  if (sourceStat.isFile() && sourceStat.nlink > 1) {
    throw new Error(`Hardlinked source file is not allowed: ${sourcePath}`);
  }
  if (!sourceStat.isDirectory()) {
    return;
  }

  const entries = await fs.readdir(sourcePath, { withFileTypes: true });
  await Promise.all(
    entries.map(async (entry) => {
      const entryPath = path.join(sourcePath, entry.name);
      if (entry.isDirectory()) {
        await assertNoHardlinkedSourceFiles(entryPath);
        return;
      }
      if (!entry.isFile()) {
        return;
      }
      const entryStat = await fs.lstat(entryPath);
      if (entryStat.nlink > 1) {
        throw new Error(`Hardlinked source file is not allowed: ${entryPath}`);
      }
    }),
  );
}
