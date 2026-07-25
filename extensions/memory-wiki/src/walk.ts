import {
  walkDirectory,
  type WalkDirectoryOptions,
  type WalkDirectoryResult,
} from "openclaw/plugin-sdk/infra-runtime";

const MEMORY_WIKI_WALK_MAX_DEPTH = 256;
const MEMORY_WIKI_WALK_MAX_ENTRIES = 50_000;

/** Run one bounded vault scan and fail instead of silently returning a partial corpus. */
export async function walkMemoryWikiDirectory(
  rootDir: string,
  options: Pick<WalkDirectoryOptions, "descend" | "include"> = {},
): Promise<WalkDirectoryResult> {
  const result = await walkDirectory(rootDir, {
    descend: options.descend,
    maxDepth: MEMORY_WIKI_WALK_MAX_DEPTH,
    maxEntries: MEMORY_WIKI_WALK_MAX_ENTRIES,
    symlinks: "skip",
  });
  const reachedDepthLimit = result.entries.some(
    (entry) => entry.kind === "directory" && entry.depth === MEMORY_WIKI_WALK_MAX_DEPTH,
  );
  if (result.truncated || reachedDepthLimit) {
    throw new Error(
      `Memory Wiki scan exceeded ${MEMORY_WIKI_WALK_MAX_ENTRIES} entries or ${MEMORY_WIKI_WALK_MAX_DEPTH} levels: ${rootDir}`,
    );
  }
  return options.include ? { ...result, entries: result.entries.filter(options.include) } : result;
}
