/**
 * Maps bootstrap context files into the attempt workspace.
 */
import path from "node:path";
import type { EmbeddedContextFile } from "../../embedded-agent-helpers.js";

function isRelativePathInsideOrEqual(relativePath: string): boolean {
  // `path.relative` returns "" for the workspace root; reject parent escapes and absolute paths.
  return (
    relativePath === "" ||
    (relativePath !== ".." &&
      !relativePath.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relativePath))
  );
}

/**
 * Rewrites injected context file paths when a bootstrap assembled in one
 * workspace is replayed in another. Files outside the source workspace keep
 * their original absolute path to avoid manufacturing unsafe relative paths.
 */
export function remapInjectedContextFilesToWorkspace(params: {
  files: EmbeddedContextFile[];
  sourceWorkspaceDir: string;
  targetWorkspaceDir: string;
}): EmbeddedContextFile[] {
  if (params.sourceWorkspaceDir === params.targetWorkspaceDir) {
    return params.files;
  }
  return params.files.map((file) => {
    const relative = path.relative(params.sourceWorkspaceDir, file.path);
    // Only files that were inside the source workspace can be safely projected
    // into the target workspace.
    const canRemap = isRelativePathInsideOrEqual(relative);
    return canRemap
      ? {
          ...file,
          path:
            relative === ""
              ? params.targetWorkspaceDir
              : path.join(params.targetWorkspaceDir, relative),
        }
      : file;
  });
}
