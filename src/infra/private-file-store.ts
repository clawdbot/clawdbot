import "./fs-safe-defaults.js";
import {
  fileStore,
  fileStoreSync,
  type FileStore,
  type FileStoreSync,
} from "@openclaw/fs-safe/store";

export type PrivateFileStore = FileStore;

export function privateFileStore(rootDir: string): FileStore {
  return fileStore({ rootDir, private: true });
}

export type PrivateFileStoreSync = FileStoreSync;

export function privateFileStoreSync(rootDir: string): PrivateFileStoreSync {
  return fileStoreSync({ rootDir, private: true });
}
