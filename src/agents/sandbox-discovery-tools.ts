import fs from "node:fs/promises";
import path from "node:path";
import ignore, { type Ignore } from "ignore";
import { minimatch } from "minimatch";
import { isMissingPathError } from "../infra/errors.js";
import { readLocalFileSafely, root as fsRoot } from "../infra/fs-safe.js";
import { compileSafeRegexDetailed } from "../security/safe-regex.js";
import {
  addIgnoreFileContent,
  excludeIgnoreRulesSubtree,
  IGNORE_FILE_MAX_BYTES,
  IGNORE_FILE_NAMES,
} from "../shared/ignore-rules.js";
import { assertSandboxPath } from "./sandbox-paths.js";
import {
  assertSandboxDirectoryEntriesWithinBounds,
  createDescriptorAnchoredSandboxDirectoryListingSource,
  listSandboxDirectoryWithinBounds,
} from "./sandbox/fs-bridge.discovery.js";
import type {
  SandboxDirectoryListingSource,
  SandboxFsDirectoryEntry,
} from "./sandbox/fs-bridge.discovery.js";
import type { SandboxFsBridge } from "./sandbox/fs-bridge.types.js";
import type { FindOperations } from "./sessions/tools/find.js";
import type { GrepOperations } from "./sessions/tools/grep.js";
import type { LsOperations } from "./sessions/tools/ls.js";

type DiscoveryBridge = Pick<SandboxFsBridge, "readFile" | "stat"> &
  Partial<Pick<SandboxFsBridge, "resolvePath">> & {
    listDirectory: NonNullable<SandboxFsBridge["listDirectory"]>;
  };

type TraversalEntry = SandboxFsDirectoryEntry & {
  absolutePath: string;
  relativePath: string;
};

type GrepSearchMatch = {
  filePath: string;
  lineNumber: number;
  lineText?: string;
};

const SEARCH_FILE_MAX_BYTES = 4 * 1024 * 1024;
const IGNORE_CASE = false;
const LOCAL_DIRECTORY_READ_BUFFER_ENTRIES = 32;
const GREP_IGNORE_FILE_NAMES = [".gitignore", ".ignore", ".rgignore"] as const;
const HARD_EXCLUDED_DIRECTORY_NAMES = new Set([".git", "node_modules"]);

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new Error("Operation aborted");
  }
}

async function loadDirectoryIgnoreRules(params: {
  bridge: DiscoveryBridge;
  directoryPath: string;
  relativeDirectory: string;
  entries: readonly SandboxFsDirectoryEntry[];
  ignoreFileNames: readonly string[];
  matcher: Ignore;
  signal?: AbortSignal;
}): Promise<void> {
  for (const fileName of params.ignoreFileNames) {
    if (!params.entries.some((entry) => entry.name === fileName && entry.type === "file")) {
      continue;
    }
    const filePath = path.join(params.directoryPath, fileName);
    try {
      const stats = await params.bridge.stat({ filePath, signal: params.signal });
      if (!stats || stats.type !== "file") {
        continue;
      }
      if (stats.size > IGNORE_FILE_MAX_BYTES) {
        excludeIgnoreRulesSubtree(params.matcher, params.relativeDirectory, IGNORE_CASE);
        return;
      }
      const content = await params.bridge.readFile({
        filePath,
        signal: params.signal,
        maxBytes: IGNORE_FILE_MAX_BYTES,
      });
      if (
        !addIgnoreFileContent({
          matcher: params.matcher,
          content: content.toString("utf8"),
          relativeDir: params.relativeDirectory,
          ignoreCase: IGNORE_CASE,
        })
      ) {
        return;
      }
    } catch {
      throwIfAborted(params.signal);
      excludeIgnoreRulesSubtree(params.matcher, params.relativeDirectory, IGNORE_CASE);
      return;
    }
  }
}

function relativePathInsideRoot(rootPath: string, targetPath: string): string | undefined {
  const relativePath = path.relative(path.resolve(rootPath), path.resolve(targetPath));
  if (
    relativePath === ".." ||
    relativePath.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relativePath)
  ) {
    return undefined;
  }
  return relativePath.split(path.sep).join(path.posix.sep);
}

function isHardExcludedPath(relativePath: string): boolean {
  return relativePath
    .split(path.posix.sep)
    .some((segment) => HARD_EXCLUDED_DIRECTORY_NAMES.has(segment));
}

async function loadAncestorIgnoreRules(params: {
  bridge: DiscoveryBridge;
  ignoreFileNames: readonly string[];
  matcher: Ignore;
  matcherRootPath: string;
  searchRelativePath: string;
  signal?: AbortSignal;
}): Promise<void> {
  let directoryPath = params.matcherRootPath;
  let relativeDirectory = "";
  for (const segment of params.searchRelativePath.split("/").filter(Boolean)) {
    throwIfAborted(params.signal);
    const entries = await params.bridge.listDirectory({
      filePath: directoryPath,
      signal: params.signal,
    });
    assertSandboxDirectoryEntriesWithinBounds(entries);
    await loadDirectoryIgnoreRules({
      bridge: params.bridge,
      directoryPath,
      relativeDirectory,
      entries,
      ignoreFileNames: params.ignoreFileNames,
      matcher: params.matcher,
      signal: params.signal,
    });
    directoryPath = path.join(directoryPath, segment);
    relativeDirectory = relativeDirectory ? path.posix.join(relativeDirectory, segment) : segment;
  }
}

async function traverseDirectory(params: {
  bridge: DiscoveryBridge;
  ignoreFileNames: readonly string[];
  matcherRootPath?: string;
  rootPath: string;
  matcher: Ignore;
  signal?: AbortSignal;
  visit: (entry: TraversalEntry) => Promise<boolean> | boolean;
}): Promise<void> {
  const matcherRootPath = params.matcherRootPath ?? params.rootPath;
  const resolveMatcherPath = (filePath: string) =>
    params.bridge.resolvePath?.({ filePath }).containerPath ?? filePath;
  const searchRelativePath =
    relativePathInsideRoot(
      resolveMatcherPath(matcherRootPath),
      resolveMatcherPath(params.rootPath),
    ) ?? "";
  if (isHardExcludedPath(searchRelativePath)) {
    return;
  }
  if (searchRelativePath) {
    await loadAncestorIgnoreRules({
      bridge: params.bridge,
      ignoreFileNames: params.ignoreFileNames,
      matcher: params.matcher,
      matcherRootPath,
      searchRelativePath,
      signal: params.signal,
    });
  }
  const visitDirectory = async (
    directoryPath: string,
    relativeDirectory: string,
    matcherRelativeDirectory: string,
  ): Promise<boolean> => {
    throwIfAborted(params.signal);
    const entries = await params.bridge.listDirectory({
      filePath: directoryPath,
      signal: params.signal,
    });
    assertSandboxDirectoryEntriesWithinBounds(entries);
    await loadDirectoryIgnoreRules({
      bridge: params.bridge,
      directoryPath,
      relativeDirectory: matcherRelativeDirectory,
      entries,
      ignoreFileNames: params.ignoreFileNames,
      matcher: params.matcher,
      signal: params.signal,
    });
    for (const entry of entries.toSorted((a, b) => a.name.localeCompare(b.name))) {
      throwIfAborted(params.signal);
      const relativePath = relativeDirectory
        ? path.posix.join(relativeDirectory, entry.name)
        : entry.name;
      const matcherRelativePath = matcherRelativeDirectory
        ? path.posix.join(matcherRelativeDirectory, entry.name)
        : entry.name;
      if (isHardExcludedPath(matcherRelativePath)) {
        continue;
      }
      const ignorePath =
        entry.type === "directory" ? `${matcherRelativePath}/` : matcherRelativePath;
      if (params.matcher.ignores(ignorePath)) {
        continue;
      }
      const absolutePath = path.join(directoryPath, entry.name);
      if (!(await params.visit({ ...entry, absolutePath, relativePath }))) {
        return false;
      }
      if (
        entry.type === "directory" &&
        !(await visitDirectory(absolutePath, relativePath, matcherRelativePath))
      ) {
        return false;
      }
    }
    return true;
  };

  await visitDirectory(params.rootPath, "", searchRelativePath);
}

function createTraversalMatcher(): Ignore {
  return ignore({ ignorecase: IGNORE_CASE });
}

async function readSearchFile(
  bridge: DiscoveryBridge,
  filePath: string,
  signal?: AbortSignal,
): Promise<string | null> {
  try {
    const buffer = await bridge.readFile({
      filePath,
      signal,
      maxBytes: SEARCH_FILE_MAX_BYTES,
    });
    return buffer.includes(0) ? null : buffer.toString("utf8");
  } catch {
    throwIfAborted(signal);
    return null;
  }
}

function splitSearchLines(content: string): string[] {
  const normalized = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  if (!normalized) {
    return [];
  }
  const lines = normalized.split("\n");
  if (normalized.endsWith("\n")) {
    lines.pop();
  }
  return lines;
}

function matchesGlob(filePath: string, glob?: string): boolean {
  return (
    !glob ||
    minimatch(filePath, glob, {
      dot: true,
      matchBase: !glob.includes("/"),
    })
  );
}

function createLineMatcher(params: {
  pattern: string;
  literal?: boolean;
  ignoreCase?: boolean;
}): (line: string) => boolean {
  if (params.literal) {
    const needle = params.ignoreCase ? params.pattern.toLocaleLowerCase() : params.pattern;
    return params.ignoreCase
      ? (line) => line.toLocaleLowerCase().includes(needle)
      : (line) => line.includes(needle);
  }
  const flags = params.ignoreCase ? "iu" : "u";
  const safety = compileSafeRegexDetailed(params.pattern, flags);
  if (!safety.regex) {
    throw new Error(`Unsafe or invalid grep regex (${safety.reason})`);
  }
  const expression = new RegExp(params.pattern, flags);
  return (line) => expression.test(line);
}

export function createSandboxDiscoveryOperations(
  bridge: DiscoveryBridge,
  discoveryOptions: { rootPath?: string } = {},
): {
  find: FindOperations;
  grep: GrepOperations;
  ls: LsOperations;
} {
  const stat = async (absolutePath: string, signal?: AbortSignal) =>
    await bridge.stat({ filePath: absolutePath, signal });

  return {
    find: {
      exists: async (absolutePath, options) => (await stat(absolutePath, options?.signal)) !== null,
      isDirectory: async (absolutePath, options) => {
        const stats = await stat(absolutePath, options?.signal);
        if (!stats) {
          throw new Error(`Path not found: ${absolutePath}`);
        }
        return stats.type === "directory";
      },
      glob: async (pattern, searchPath, options) => {
        const rootStats = await stat(searchPath, options.signal);
        if (!rootStats) {
          return [];
        }
        if (rootStats.type !== "directory") {
          return minimatch(path.basename(searchPath), pattern, { dot: true }) ? [searchPath] : [];
        }
        const results: string[] = [];
        await traverseDirectory({
          bridge,
          ignoreFileNames: IGNORE_FILE_NAMES,
          matcherRootPath: discoveryOptions.rootPath,
          rootPath: searchPath,
          matcher: createTraversalMatcher().add(options.ignore),
          signal: options.signal,
          visit: (entry) => {
            if (
              minimatch(entry.relativePath, pattern, {
                dot: true,
                matchBase: !pattern.includes("/"),
              })
            ) {
              results.push(entry.absolutePath);
            }
            return results.length < options.limit;
          },
        });
        return results;
      },
    },
    grep: {
      isDirectory: async (absolutePath, options) => {
        const stats = await stat(absolutePath, options?.signal);
        if (!stats) {
          throw new Error(`Path not found: ${absolutePath}`);
        }
        return stats.type === "directory";
      },
      readFile: async (absolutePath, options) =>
        (await readSearchFile(bridge, absolutePath, options?.signal)) ?? "",
      search: async ({ searchPath, pattern, glob, ignoreCase, literal, limit, signal }) => {
        const matches: GrepSearchMatch[] = [];
        const lineMatches = createLineMatcher({ pattern, literal, ignoreCase });
        const scanFile = async (filePath: string, relativePath: string): Promise<boolean> => {
          if (!matchesGlob(relativePath, glob)) {
            return true;
          }
          const content = await readSearchFile(bridge, filePath, signal);
          if (content === null) {
            return true;
          }
          const lines = splitSearchLines(content);
          for (let index = 0; index < lines.length; index++) {
            const line = lines[index] ?? "";
            if (lineMatches(line)) {
              matches.push({ filePath, lineNumber: index + 1, lineText: line });
              if (matches.length >= limit) {
                return false;
              }
            }
          }
          return true;
        };

        const rootStats = await stat(searchPath, signal);
        if (!rootStats) {
          throw new Error(`Path not found: ${searchPath}`);
        }
        if (rootStats.type === "file") {
          await scanFile(searchPath, path.basename(searchPath));
          return matches;
        }
        await traverseDirectory({
          bridge,
          ignoreFileNames: GREP_IGNORE_FILE_NAMES,
          matcherRootPath: discoveryOptions.rootPath,
          rootPath: searchPath,
          matcher: createTraversalMatcher(),
          signal,
          visit: async (entry) =>
            entry.type !== "file" || (await scanFile(entry.absolutePath, entry.relativePath)),
        });
        return matches;
      },
    },
    ls: {
      exists: async (absolutePath, options) => (await stat(absolutePath, options?.signal)) !== null,
      stat: async (absolutePath, options) => {
        const stats = await stat(absolutePath, options?.signal);
        if (!stats) {
          throw new Error(`Path not found: ${absolutePath}`);
        }
        return { isDirectory: () => stats.type === "directory" };
      },
      readdir: async (absolutePath, options) => {
        const entries = await bridge.listDirectory({
          filePath: absolutePath,
          signal: options?.signal,
        });
        assertSandboxDirectoryEntriesWithinBounds(entries);
        return entries.map((entry) => ({
          name: entry.name,
          isDirectory: entry.type === "directory",
        }));
      },
    },
  };
}

function createHostDirectoryListingSource(): SandboxDirectoryListingSource {
  return {
    async *entries(directoryPath, options) {
      options.signal?.throwIfAborted();
      const directory = await fs.opendir(directoryPath, {
        bufferSize: LOCAL_DIRECTORY_READ_BUFFER_ENTRIES,
      });
      try {
        while (true) {
          options.signal?.throwIfAborted();
          const entry = await directory.read();
          options.signal?.throwIfAborted();
          if (!entry) {
            return;
          }
          yield {
            name: entry.name,
            isDirectory: entry.isDirectory(),
            isFile: entry.isFile(),
          };
        }
      } finally {
        await directory.close();
      }
    },
  };
}

export function createHostDiscoveryOperations(rootPath: string): {
  find: FindOperations;
  grep: GrepOperations;
  ls: LsOperations;
} {
  const defaultRoot = path.resolve(rootPath);
  const resolveHostPath = (filePath: string, cwd?: string) =>
    path.resolve(cwd ?? defaultRoot, filePath);
  const directorySource = createHostDirectoryListingSource();
  const bridge: DiscoveryBridge = {
    readFile: async ({ filePath, cwd, signal, maxBytes }) => {
      signal?.throwIfAborted();
      const result = await readLocalFileSafely({
        filePath: resolveHostPath(filePath, cwd),
        maxBytes: maxBytes ?? SEARCH_FILE_MAX_BYTES,
      });
      signal?.throwIfAborted();
      return result.buffer;
    },
    stat: async ({ filePath, cwd, signal }) => {
      try {
        signal?.throwIfAborted();
        const stats = await fs.stat(resolveHostPath(filePath, cwd));
        signal?.throwIfAborted();
        return {
          type: stats.isDirectory() ? "directory" : stats.isFile() ? "file" : "other",
          size: stats.size,
          mtimeMs: stats.mtimeMs,
        };
      } catch (error) {
        if (isMissingPathError(error)) {
          return null;
        }
        throw error;
      }
    },
    listDirectory: async ({ filePath, cwd, signal }) =>
      await listSandboxDirectoryWithinBounds({
        source: directorySource,
        relativePath: resolveHostPath(filePath, cwd),
        signal,
      }),
  };

  return createSandboxDiscoveryOperations(bridge, { rootPath: defaultRoot });
}

export function createHostWorkspaceDiscoveryOperations(rootPath: string): {
  find: FindOperations;
  grep: GrepOperations;
  ls: LsOperations;
} {
  const workspaceRoot = path.resolve(rootPath);
  let rootPromise: ReturnType<typeof fsRoot> | undefined;
  const getRoot = () => (rootPromise ??= fsRoot(workspaceRoot));
  const resolveRelativePath = async (filePath: string, cwd?: string): Promise<string> => {
    const resolved = await assertSandboxPath({
      filePath,
      cwd: cwd ?? workspaceRoot,
      root: workspaceRoot,
    });
    const [safeRoot, canonicalPath] = await Promise.all([
      getRoot(),
      fs.realpath(resolved.resolved),
    ]);
    const relativePath = path.relative(safeRoot.rootReal, canonicalPath);
    return relativePath === "." ? "" : relativePath;
  };

  const bridge: DiscoveryBridge = {
    readFile: async ({ filePath, cwd, signal, maxBytes }) => {
      signal?.throwIfAborted();
      const relativePath = await resolveRelativePath(filePath, cwd);
      const result = await (
        await getRoot()
      ).read(relativePath, {
        hardlinks: "reject",
        maxBytes,
        symlinks: "follow-within-root",
      });
      signal?.throwIfAborted();
      return result.buffer;
    },
    stat: async ({ filePath, cwd, signal }) => {
      try {
        signal?.throwIfAborted();
        const relativePath = await resolveRelativePath(filePath, cwd);
        const stats = await (await getRoot()).stat(relativePath);
        signal?.throwIfAborted();
        return {
          type: stats.isDirectory ? "directory" : stats.isFile ? "file" : "other",
          size: stats.size,
          mtimeMs: stats.mtimeMs,
        };
      } catch (error) {
        if (isMissingPathError(error)) {
          return null;
        }
        throw error;
      }
    },
    listDirectory: async ({ filePath, cwd, signal }) => {
      const relativePath = await resolveRelativePath(filePath, cwd);
      const root = await getRoot();
      return await listSandboxDirectoryWithinBounds({
        source: createDescriptorAnchoredSandboxDirectoryListingSource(root),
        relativePath,
        signal,
      });
    },
  };

  return createSandboxDiscoveryOperations(bridge, { rootPath: workspaceRoot });
}
