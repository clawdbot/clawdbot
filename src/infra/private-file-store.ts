// Creates private fs-safe file stores.
import "./fs-safe-defaults.js";
import {
  fileStore,
  fileStoreSync,
  type FileStore,
  type FileStoreSync,
} from "@openclaw/fs-safe/store";

// Private stores create owner-only files under a caller-provided root.
export type PrivateFileStore = FileStore;

/** Create an async private file store rooted at `rootDir`. */
export function privateFileStore(rootDir: string): FileStore {
  return fileStore({ rootDir, private: true });
}

type PrivateFileStoreSync = FileStoreSync;

/** Create a sync private file store rooted at `rootDir`. */
export function privateFileStoreSync(rootDir: string): PrivateFileStoreSync {
  return fileStoreSync({ rootDir, private: true });
}
