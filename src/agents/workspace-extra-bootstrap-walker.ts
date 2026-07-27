/**
 * Async, event-loop-friendly glob walker for extra bootstrap file patterns.
 *
 * Split out of `workspace.ts` so the bootstrap reader stays small: this module
 * owns the workspace directory traversal that resolves `**\/AGENTS.md`-style
 * patterns without blocking the loop during embedded_run bootstrap-context. It
 * mirrors Node `fs.glob`'s dot-directory and symlink semantics while yielding
 * periodically, applies a Minimatch matcher with partial-match pruning, and
 * exposes only the entry points `workspace.ts` needs.
 */
import syncFs from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { setImmediate as yieldImmediate } from "node:timers/promises";
import { Minimatch } from "minimatch";
import { isPathInside } from "../infra/path-guards.js";

const EXTRA_BOOTSTRAP_GLOB_YIELD_INTERVAL = 256;

export function hasGlobPattern(pattern: string): boolean {
  // Keep square brackets literal here; workspace paths commonly contain them.
  return /[?*{}]/u.test(pattern);
}

function normalizeWorkspacePatternPath(value: string): string {
  return value
    .replaceAll(path.sep, "/")
    .replaceAll("\\", "/")
    .replace(/^\.\/+/u, "");
}

function resolveGlobWalkRoot(pattern: string): string {
  const normalized = normalizeWorkspacePatternPath(pattern);
  const globIndex = normalized.search(/[?*{}]/u);
  if (globIndex === -1) {
    return normalized;
  }
  const slashIndex = normalized.lastIndexOf("/", globIndex);
  return slashIndex === -1 ? "." : normalized.slice(0, slashIndex) || ".";
}

// Mirror Node fs.glob's default dot behavior while walking: `*` and `**` never
// match a path segment that begins with ".", so a dot directory can only hold a
// match when the pattern explicitly names a literal-dot segment at the aligned
// depth. Returns whether `dirSegments` can be a prefix of some path the pattern
// matches; used to prune dot-directory subtrees (`.git`, `.openclaw`, …) the
// glob could never reach. matchesGlob applies the dot rule per single segment,
// so the only extra rule here is that `**` cannot consume a leading-dot segment.
function globPrefixCanDescend(dirSegments: string[], patternSegments: string[]): boolean {
  const dirLength = dirSegments.length;
  const patternLength = patternSegments.length;
  const match = (dirIndex: number, patternIndex: number): boolean => {
    if (dirIndex === dirLength) {
      // Whole directory path consumed; deeper entries may still match.
      return true;
    }
    if (patternIndex === patternLength) {
      // Pattern exhausted but directory segments remain — no descendant matches.
      return false;
    }
    // dirIndex < dirLength and patternIndex < patternLength are guaranteed by the
    // equality guards above, so both indexed reads are in-bounds.
    const segment = dirSegments[dirIndex]!;
    const patternSegment = patternSegments[patternIndex]!;
    if (patternSegment === "**") {
      if (match(dirIndex, patternIndex + 1)) {
        return true;
      }
      // `**` skips over directory levels but never a leading-dot segment.
      return !segment.startsWith(".") && match(dirIndex + 1, patternIndex);
    }
    if (!path.matchesGlob(segment, patternSegment)) {
      return false;
    }
    return match(dirIndex + 1, patternIndex + 1);
  };
  return match(0, 0);
}

// A path segment is "literal" for symlink-descent purposes when its aligned
// pattern segment carries no glob metacharacters. Index alignment only holds
// while no earlier `**` is present, because `**` matches a variable number of
// segments; once a `**` precedes the depth, the symlink was reached through a
// wildcard and must stay terminal — fs.glob never follows a wildcard-reached
// symlink even when a later literal segment names it (`**/wl/AGENTS.md` yields
// nothing for a `wl` symlink).
function patternSegmentIsLiteralAtDepth(depth: number, patternSegments: string[]): boolean {
  if (depth < 0 || depth >= patternSegments.length) {
    return false;
  }
  for (let index = 0; index < depth; index += 1) {
    if (patternSegments[index] === "**") {
      return false;
    }
  }
  // depth is within [0, patternSegments.length) after the guard above.
  return !hasGlobPattern(patternSegments[depth]!);
}

// Ancestor chain node for the active descent path. Only symlinks can create
// cycles, so we carry each directory's canonical realpath forward to refuse
// re-entering a directory already on the path (`a/loop -> a`).
type WalkFrame = { relativeDir: string; realpath: string; parent: WalkFrame | null };

// Decide whether a literal-named directory symlink should be descended, mirroring
// fs.glob which follows literal-named directory symlinks. Returns a child frame
// when the link resolves to a directory that stays inside the workspace and is
// not already an ancestor on the current path; otherwise null so the caller
// keeps the symlink as a terminal leaf candidate.
async function resolveSymlinkDescent(
  workspaceDir: string,
  workspaceRealpath: string,
  childRelativePath: string,
  parent: WalkFrame,
): Promise<WalkFrame | null> {
  const childAbs = path.resolve(workspaceDir, childRelativePath);
  let stat: syncFs.Stats;
  try {
    // fs.stat follows the link; only directory targets are descended.
    stat = await fs.stat(childAbs);
  } catch {
    return null;
  }
  if (!stat.isDirectory()) {
    return null;
  }
  let targetRealpath: string;
  try {
    targetRealpath = await fs.realpath(childAbs);
  } catch {
    return null;
  }
  // Containment: the canonical target must stay within the workspace root, or the
  // walk would escape the workspace via the link.
  const relToRoot = path.relative(workspaceRealpath, targetRealpath);
  if (relToRoot.startsWith("..") || path.isAbsolute(relToRoot)) {
    return null;
  }
  // Cycle guard: refuse to re-enter a directory already on the descent path so an
  // ancestor-pointing symlink cannot loop. This diverges from fs.glob (which
  // follows such a link once) to guarantee termination.
  for (let frame: WalkFrame | null = parent; frame; frame = frame.parent) {
    if (frame.realpath === targetRealpath) {
      return null;
    }
  }
  return { relativeDir: childRelativePath, realpath: targetRealpath, parent };
}

async function* walkWorkspaceFiles(
  workspaceDir: string,
  initialRelativeDir: string,
  strictRead: boolean,
  matcher: Minimatch,
  normalizedPattern: string,
): AsyncGenerator<string> {
  const patternSegments = normalizedPattern.split("/");
  // Canonical workspace root bounds symlink descent (see resolveSymlinkDescent).
  let workspaceRealpath: string;
  try {
    workspaceRealpath = await fs.realpath(workspaceDir);
  } catch {
    workspaceRealpath = path.resolve(workspaceDir);
  }
  const rootRelativeDir = initialRelativeDir === "." ? "" : initialRelativeDir;
  const rootAbs = path.resolve(workspaceDir, rootRelativeDir);
  let rootRealpath: string;
  try {
    rootRealpath = await fs.realpath(rootAbs);
  } catch {
    rootRealpath = rootAbs;
  }
  const stack: WalkFrame[] = [
    { relativeDir: rootRelativeDir, realpath: rootRealpath, parent: null },
  ];
  let visitedEntries = 0;
  while (stack.length > 0) {
    const frame = stack.pop();
    if (!frame) {
      continue;
    }
    const currentRelativeDir = frame.relativeDir;
    const currentDir = path.resolve(workspaceDir, currentRelativeDir);
    if (!isPathInside(workspaceDir, currentDir)) {
      continue;
    }

    let entries: syncFs.Dirent[];
    try {
      entries = await fs.readdir(currentDir, { withFileTypes: true });
    } catch (error) {
      if (strictRead && (error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
      continue;
    }

    for (const entry of entries) {
      visitedEntries += 1;
      if (visitedEntries % EXTRA_BOOTSTRAP_GLOB_YIELD_INTERVAL === 0) {
        await yieldImmediate();
      }
      const childRelativePath = currentRelativeDir
        ? path.join(currentRelativeDir, entry.name)
        : entry.name;
      const normalizedChildPath = normalizeWorkspacePatternPath(childRelativePath);
      if (entry.isDirectory()) {
        // Skip dot-directory subtrees the glob can never match, matching
        // fs.glob's default dot behavior instead of walking `.git`/`.openclaw`.
        if (
          entry.name.startsWith(".") &&
          !globPrefixCanDescend(normalizedChildPath.split("/"), patternSegments)
        ) {
          continue;
        }
        // Descend only when the directory could still contain a match, so the
        // traversal stays bounded to the pattern's own subtree without changing
        // which files match. Broad patterns like `**/AGENTS.md` still recurse
        // into build-output directory names (e.g. `dist`), so the walker returns
        // the same match set as fs.glob — no ignored-directory pruning silently
        // drops a configured match on upgrade. A real subdirectory's canonical
        // path is parent-canonical/name, so the ancestor chain extends without an
        // extra realpath syscall.
        if (matcher.match(normalizedChildPath, true)) {
          stack.push({
            relativeDir: childRelativePath,
            realpath: path.join(frame.realpath, entry.name),
            parent: frame,
          });
        }
        continue;
      }
      if (entry.isSymbolicLink()) {
        // fs.glob descends a directory symlink named literally at its aligned
        // pattern depth but never one reached through a `*`/`**` wildcard. Apply
        // the same partial-match prune as real directories so a literal-named
        // link whose prefix cannot lead to a match stays off the stack.
        const childSegments = normalizedChildPath.split("/");
        if (
          patternSegmentIsLiteralAtDepth(childSegments.length - 1, patternSegments) &&
          matcher.match(normalizedChildPath, true)
        ) {
          const descendFrame = await resolveSymlinkDescent(
            workspaceDir,
            workspaceRealpath,
            childRelativePath,
            frame,
          );
          if (descendFrame) {
            stack.push(descendFrame);
            continue;
          }
        }
        // Not descended: the link is a terminal leaf candidate, yielded only on a
        // full match like any file.
        // oxlint-disable-next-line unicorn/prefer-regexp-test -- Minimatch.match returns a boolean; it has no RegExp#test.
        if (matcher.match(normalizedChildPath)) {
          yield normalizedChildPath;
        }
        continue;
      }
      if (entry.isFile() && matcher.match(normalizedChildPath)) {
        yield normalizedChildPath;
      }
    }
  }
}

// Always resolve globs with the yielding walker. fs.glob would be faster for
// simple patterns, but it only exposes matched paths — Node traverses the
// directory tree internally, so a sparse pattern like `**/AGENTS.md` across a
// huge workspace can block the event loop. The walker yields periodically while
// it walks, so the active path can never stall. The walk always completes and
// returns every file matched within the real tree; the downstream bootstrap
// character budget handles content limiting.
export async function resolveExtraBootstrapPatternPaths(
  workspaceDir: string,
  pattern: string,
  strictRead: boolean,
): Promise<string[]> {
  if (typeof path.matchesGlob !== "function") {
    return [pattern];
  }

  const normalizedPattern = normalizeWorkspacePatternPath(pattern);
  const matcher = new Minimatch(normalizedPattern, {
    nocomment: true,
    nonegate: true,
    windowsPathsNoEscape: true,
  });
  const matches: string[] = [];
  for await (const candidate of walkWorkspaceFiles(
    workspaceDir,
    resolveGlobWalkRoot(normalizedPattern),
    strictRead,
    matcher,
    normalizedPattern,
  )) {
    // The walker already applies the Minimatch matcher before yielding, so every
    // candidate is a confirmed match. No cap of any kind: the walk always
    // completes over the real tree so the configured glob is fully preserved,
    // and the bootstrap character budget limits content downstream.
    matches.push(candidate);
  }
  // A glob that matched nothing resolves to an empty set, matching fs.glob's
  // no-match behavior. Returning [pattern] is reserved for the no-glob-support
  // fallback above, where the literal is the only thing we can hand back.
  return matches;
}

export function patternWalkRootStaysInWorkspace(workspaceDir: string, pattern: string): boolean {
  const walkRoot = path.resolve(workspaceDir, resolveGlobWalkRoot(pattern));
  return isPathInside(workspaceDir, walkRoot);
}
