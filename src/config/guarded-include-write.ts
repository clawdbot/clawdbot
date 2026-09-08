// Commit prelocked include mutations without an await between authority and rename.
import fs from "node:fs";
import path from "node:path";
import { openRootFileSync } from "../infra/boundary-file-read.js";
import { isMissingPathError } from "../infra/errors.js";
import { assertNoSymlinkParentsSync, sameFileIdentity } from "../infra/fs-safe-advanced.js";
import { replaceFileAtomicSync } from "../infra/replace-file.js";
import { isPathInside } from "../security/scan-paths.js";
import { hashConfigIncludeRaw } from "./includes.js";
import { ConfigMutationConflictError } from "./mutation-conflict.js";

export function prepareGuardedIncludeWrite(params: {
  rootPath: string;
  filePath: string;
  assertCurrent: () => void;
}): (content: string, expectedHash: string) => void {
  const rootPath = path.resolve(params.rootPath);
  const filePath = path.resolve(params.filePath);
  if (filePath === rootPath || !isPathInside(rootPath, filePath)) {
    throw new ConfigMutationConflictError("included config escaped its approved root");
  }
  params.assertCurrent();
  assertNoSymlinkParentsSync({
    rootDir: rootPath,
    targetPath: path.dirname(filePath),
    requireDirectories: true,
  });
  const directories: { path: string; identity: fs.Stats }[] = [];
  for (let current = path.dirname(filePath); ; current = path.dirname(current)) {
    const identity = fs.lstatSync(current);
    if (!identity.isDirectory() || fs.realpathSync(current) !== current) {
      throw new ConfigMutationConflictError("included config directory changed");
    }
    directories.push({ path: current, identity });
    if (current === rootPath) {
      break;
    }
  }
  const assertDirectories = () => {
    params.assertCurrent();
    for (const directory of directories) {
      const current = fs.lstatSync(directory.path);
      if (
        !current.isDirectory() ||
        !sameFileIdentity(current, directory.identity) ||
        fs.realpathSync(directory.path) !== directory.path
      ) {
        throw new ConfigMutationConflictError("included config directory changed");
      }
    }
  };
  const assertSource = (expectedHash: string) => {
    assertDirectories();
    let raw: string | null = null;
    // lstat distinguishes absence from a dangling link; the contained open also
    // rejects hardlinks and directory/file substitutions before reading bytes.
    try {
      fs.lstatSync(filePath);
      const opened = openRootFileSync({
        absolutePath: filePath,
        rootPath,
        rootRealPath: rootPath,
        boundaryLabel: "guarded config include",
        rejectHardlinks: true,
        rejectSymlinks: true,
      });
      if (!opened.ok) {
        throw new ConfigMutationConflictError("included config target changed");
      }
      try {
        raw = fs.readFileSync(opened.fd, "utf8");
      } finally {
        fs.closeSync(opened.fd);
      }
    } catch (error) {
      if (!isMissingPathError(error)) {
        throw error;
      }
    }
    if (hashConfigIncludeRaw(raw) !== expectedHash) {
      throw new ConfigMutationConflictError("included config changed while preparing write");
    }
    params.assertCurrent();
  };
  return (content, expectedHash) => {
    assertSource(expectedHash);
    const parentMode = fs.lstatSync(path.dirname(filePath)).mode & 0o7777;
    replaceFileAtomicSync({
      filePath,
      content,
      mode: 0o600,
      dirMode: parentMode,
      destinationHardlinks: "reject",
      copyFallbackOnPermissionError: false,
      syncTempFile: true,
      syncParentDir: true,
      beforeRename: () => assertSource(expectedHash),
      fileSystem: {
        ...fs,
        renameSync(source, destination) {
          assertSource(expectedHash);
          fs.renameSync(source, destination);
        },
      },
    });
  };
}
