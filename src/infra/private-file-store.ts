// Creates private fs-safe file stores.
import "./fs-safe-defaults.js";
import fsSync from "node:fs";
import {
  fileStore,
  fileStoreSync,
  type FileStore,
  type FileStoreSync,
} from "@openclaw/fs-safe/store";

const PRIVATE_STORE_DIR_MODE = 0o700;

// fs-safe 0.8 no longer repairs existing store-root permissions; OpenClaw
// owns these directories, so tighten them once at store creation. The root is
// opened no-follow and chmodded through the pinned descriptor, so a swapped or
// symlinked root is never mutated — fs-safe rejects those itself.
function tightenPrivateStoreRoot(rootDir: string): void {
  if (process.platform === "win32") {
    return;
  }
  let fd: number | undefined;
  try {
    fd = fsSync.openSync(
      rootDir,
      fsSync.constants.O_RDONLY | fsSync.constants.O_NOFOLLOW | fsSync.constants.O_DIRECTORY,
    );
    const stat = fsSync.fstatSync(fd);
    if ((stat.mode & 0o777) !== PRIVATE_STORE_DIR_MODE) {
      fsSync.fchmodSync(fd, PRIVATE_STORE_DIR_MODE);
    }
  } catch {
    // Missing, symlinked, or non-directory roots are created or rejected by fs-safe.
  } finally {
    if (fd !== undefined) {
      try {
        fsSync.closeSync(fd);
      } catch {
        // Best-effort close; the descriptor carries no further state.
      }
    }
  }
}

/** Create an async private file store rooted at `rootDir`. */
export function privateFileStore(rootDir: string): FileStore {
  tightenPrivateStoreRoot(rootDir);
  return fileStore({ rootDir, private: true });
}

type PrivateFileStoreSync = FileStoreSync;

/** Create a sync private file store rooted at `rootDir`. */
export function privateFileStoreSync(rootDir: string): PrivateFileStoreSync {
  tightenPrivateStoreRoot(rootDir);
  return fileStoreSync({ rootDir, private: true });
}
