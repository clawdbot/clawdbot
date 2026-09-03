import {
  walkRootDirectory,
  type RootWalkEntry,
  type RootWalkOptions,
} from "openclaw/plugin-sdk/root-walk";

const MEMORY_WIKI_WALK_MAX_DEPTH = 128;
const MEMORY_WIKI_WALK_MAX_ENTRIES = 20_000;
const MEMORY_WIKI_REPOSITORY_OR_DEPENDENCY_DIRECTORIES = new Set([".git", "node_modules"]);

type MemoryWikiWalkLimits = {
  maxDepth?: number;
  maxEntries?: number;
  entryFilter?: RootWalkOptions["entryFilter"];
  onDirectoryError?: RootWalkOptions["onDirectoryError"];
};

export function foldMemoryWikiDirectoryName(segment: string): string {
  return segment.replace(/[A-Z]/gu, (character) => character.toLowerCase());
}

export function isMemoryWikiRepositoryOrDependencyPath(relativePath: string): boolean {
  return relativePath
    .split(/[\\/]/)
    .some((segment) =>
      MEMORY_WIKI_REPOSITORY_OR_DEPENDENCY_DIRECTORIES.has(foldMemoryWikiDirectoryName(segment)),
    );
}

export function isMemoryWikiRepositoryOrDependencyDirectory(entry: RootWalkEntry): boolean {
  return entry.kind === "directory" && isMemoryWikiRepositoryOrDependencyPath(entry.relativePath);
}

export async function walkMemoryWikiDirectory(
  rootDir: string,
  relativePath: string,
  limits: MemoryWikiWalkLimits = {},
): Promise<RootWalkEntry[]> {
  const entries: RootWalkEntry[] = [];
  try {
    for await (const entry of walkRootDirectory(rootDir, relativePath, {
      maxDepth: limits.maxDepth ?? MEMORY_WIKI_WALK_MAX_DEPTH,
      maxEntries: limits.maxEntries ?? MEMORY_WIKI_WALK_MAX_ENTRIES,
      symlinkPolicy: "skip",
      limitBehavior: "throw",
      ...(limits.entryFilter ? { entryFilter: limits.entryFilter } : {}),
      ...(limits.onDirectoryError ? { onDirectoryError: limits.onDirectoryError } : {}),
    })) {
      entries.push(entry);
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "not-file" || code === "not-found") {
      return [];
    }
    throw error;
  }
  return entries;
}
