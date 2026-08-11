import path from "node:path";
import { canonicalPathFromExistingAncestor } from "../infra/fs-safe.js";

/** Denies legacy memory-file mutations while scoped memory is in enforced read-only mode. */
export type MemoryFileMutationGuard = {
  assertCanMutate: (absolutePath: string) => Promise<void>;
};

export function createMemoryFileMutationGuard(params: {
  mutationRoot: string;
}): MemoryFileMutationGuard {
  const mutationRoot = path.resolve(params.mutationRoot);
  return {
    assertCanMutate: async (absolutePath) => {
      const relativePath = await resolveControlledMemoryRelativePath({
        mutationRoot,
        absolutePath,
      });
      if (relativePath !== undefined) {
        // This must not disclose the target: controlled names can themselves reveal memory state.
        throw new Error("Legacy memory file mutations are unavailable for this agent.");
      }
    },
  };
}

async function resolveControlledMemoryRelativePath(params: {
  mutationRoot: string;
  absolutePath: string;
}): Promise<string | undefined> {
  const targetPath = path.resolve(params.absolutePath);
  let canonicalRoot = params.mutationRoot;
  let canonicalTarget = targetPath;
  try {
    const [root, targetParent] = await Promise.all([
      canonicalPathFromExistingAncestor(params.mutationRoot),
      canonicalPathFromExistingAncestor(path.dirname(targetPath)),
    ]);
    canonicalRoot = root;
    canonicalTarget = path.join(targetParent, path.basename(targetPath));
  } catch {
    // The caller's existing containment guard owns malformed/missing roots. A lexical comparison
    // still rejects a controlled path before any mkdir or write can make it durable.
  }
  const relative = path.relative(canonicalRoot, canonicalTarget);
  if (
    !relative ||
    path.isAbsolute(relative) ||
    relative === ".." ||
    relative.startsWith(`..${path.sep}`)
  ) {
    return undefined;
  }
  const normalized = relative.replaceAll(path.sep, "/").toLowerCase();
  return normalized === "memory.md" ||
    normalized === "user.md" ||
    normalized === "memory" ||
    normalized.startsWith("memory/")
    ? normalized
    : undefined;
}
