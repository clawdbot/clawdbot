// Creates private fs-safe file stores.
import "./fs-safe-defaults.js";
import {
  fileStore,
  fileStoreSync,
  type FileStore,
  type FileStoreSync,
} from "@openclaw/fs-safe/store";
import { tightenPrivateDirRootSync } from "./private-dir-mode.js";

const PRIVATE_STORE_DIR_MODE = 0o700;

// fs-safe 0.8 no longer repairs existing store-root permissions; OpenClaw
// owns these directories, so tighten them once at store creation.
function tightenPrivateStoreRoot(rootDir: string): void {
  tightenPrivateDirRootSync(rootDir, PRIVATE_STORE_DIR_MODE);
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
