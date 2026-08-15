// Fail-closed output-root guard shared by build and postbuild mutators.
import fs from "node:fs";

/**
 * Throws when a generated output root is a symbolic link. readdir/rm through a
 * symlinked root rewrites the link target — observed deleting a live gateway
 * build tree — so recursive cleanup and replacement must fail closed here.
 */
export function assertRealOutputRoot(rootPath, params = {}) {
  const fsImpl = params.fs ?? fs;
  let stat;
  try {
    stat = fsImpl.lstatSync(rootPath);
  } catch (error) {
    // Missing roots are normal on a first build; the build recreates them.
    if (error?.code === "ENOENT") {
      return;
    }
    throw error;
  }
  if (!stat.isSymbolicLink()) {
    return;
  }
  throw new Error(
    `Build output root "${rootPath}" is a symbolic link; refusing to mutate it. ` +
      `Remove the symlink or replace it with a real directory before building.`,
  );
}
