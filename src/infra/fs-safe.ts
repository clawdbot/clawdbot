import "./fs-safe-defaults.js";
import { root as fsSafeRoot, type ReadResult } from "@openclaw/fs-safe/root";

export { FsSafeError, type FsSafeErrorCode } from "@openclaw/fs-safe/errors";
export {
  assertAbsolutePathInput,
  canonicalPathFromExistingAncestor,
  findExistingAncestor,
  resolveAbsolutePathForRead,
  resolveAbsolutePathForWrite,
  type AbsolutePathSymlinkPolicy,
  type ResolvedAbsolutePath,
  type ResolvedWritableAbsolutePath,
} from "@openclaw/fs-safe/advanced";
export { isPathInside } from "@openclaw/fs-safe/path";
export { pathExists, pathExistsSync } from "@openclaw/fs-safe/advanced";
export { readLocalFileFromRoots, resolveLocalPathFromRootsSync } from "@openclaw/fs-safe/advanced";
export {
  appendRegularFile,
  appendRegularFileSync,
  readRegularFile,
  readRegularFileSync,
  resolveRegularFileAppendFlags,
  statRegularFileSync,
} from "@openclaw/fs-safe/advanced";
export {
  openLocalFileSafely,
  readLocalFileSafely,
  resolveOpenedFileRealPathForHandle,
  root,
  type OpenResult,
  type ReadResult,
} from "@openclaw/fs-safe/root";
export { sanitizeUntrustedFileName } from "@openclaw/fs-safe/advanced";
export {
  readSecureFile,
  type SecureFileReadOptions,
  type SecureFileReadResult,
} from "@openclaw/fs-safe/secure-file";
export {
  walkDirectory,
  walkDirectorySync,
  type WalkDirectoryEntry,
  type WalkDirectoryOptions,
  type WalkDirectoryResult,
} from "@openclaw/fs-safe/walk";
export { withTimeout } from "@openclaw/fs-safe/advanced";
export {
  writeExternalFileWithinRoot,
  type ExternalFileWriteOptions,
  type ExternalFileWriteResult,
} from "@openclaw/fs-safe/output";

/** @deprecated Use root(rootDir).read(relativePath, options). */
export async function readFileWithinRoot(params: {
  rootDir: string;
  relativePath: string;
  rejectHardlinks?: boolean;
  nonBlockingRead?: boolean;
  allowSymlinkTargetWithinRoot?: boolean;
  maxBytes?: number;
}): Promise<ReadResult> {
  const root = await fsSafeRoot(params.rootDir);
  return await root.read(params.relativePath, {
    hardlinks: params.rejectHardlinks === false ? "allow" : "reject",
    maxBytes: params.maxBytes,
    nonBlockingRead: params.nonBlockingRead,
    symlinks: params.allowSymlinkTargetWithinRoot === true ? "follow-within-root" : "reject",
  });
}

/** @deprecated Use root(rootDir).write(relativePath, data, options). */
export async function writeFileWithinRoot(params: {
  rootDir: string;
  relativePath: string;
  data: string | Buffer;
  encoding?: BufferEncoding;
  mkdir?: boolean;
}): Promise<void> {
  const root = await fsSafeRoot(params.rootDir);
  await root.write(params.relativePath, params.data, {
    encoding: params.encoding,
    mkdir: params.mkdir,
  });
}
