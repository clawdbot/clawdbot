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
// owns these directories, so tighten them once at store creation. Symlinked
// or non-directory roots are left for fs-safe to reject.
function tightenPrivateStoreRoot(rootDir: string): void {
  if (process.platform === "win32") {
    return;
  }
  try {
    const stat = fsSync.lstatSync(rootDir);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      return;
    }
    if ((stat.mode & 0o777) !== PRIVATE_STORE_DIR_MODE) {
      fsSync.chmodSync(rootDir, PRIVATE_STORE_DIR_MODE);
    }
  } catch {
    // Missing roots are created by fs-safe at the private dir mode.
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
