import { root as fsRoot, type OpenResult } from "../infra/fs-safe.js";

/** Safely open a path beneath a trusted root while rejecting hardlinks and unsafe symlinks by default. */
export async function openFileWithinRoot(params: {
  rootDir: string;
  relativePath: string;
  rejectHardlinks?: boolean;
  nonBlockingRead?: boolean;
  allowSymlinkTargetWithinRoot?: boolean;
}): Promise<OpenResult> {
  const root = await fsRoot(params.rootDir);
  return await root.open(params.relativePath, {
    hardlinks: params.rejectHardlinks === false ? "allow" : "reject",
    nonBlockingRead: params.nonBlockingRead,
    symlinks: params.allowSymlinkTargetWithinRoot === true ? "follow-within-root" : "reject",
  });
}

/** Copy a source file into a path beneath a trusted root using fs-safe root policy. */
export async function writeFileFromPathWithinRoot(params: {
  rootDir: string;
  relativePath: string;
  sourcePath: string;
  mkdir?: boolean;
}): Promise<void> {
  const root = await fsRoot(params.rootDir);
  await root.copyIn(params.relativePath, params.sourcePath, {
    mkdir: params.mkdir,
    sourceHardlinks: "reject",
  });
}
