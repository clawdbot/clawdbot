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
import { braceExpand, escape as escapeGlobMagic, Minimatch } from "minimatch";
import { isPathInside } from "../infra/path-guards.js";

const EXTRA_BOOTSTRAP_GLOB_YIELD_INTERVAL = 256;

// The glob metacharacters minimatch's `escape` wraps in a single-char class
// (`[` -> `[[]`, `*` -> `[*]`, `(` -> `[(]`, `{` -> `[{]`, …). A magic-free
// pattern that reaches the literal reader may carry exactly these wraps when it
// named one of those characters literally, so the reader reverses them to
// recover the on-disk path. Only these wraps are reversed, so a genuine
// single-char class like `[1]` (a real directory literally named `pkg[1]`) is
// left untouched.
const ESCAPED_MAGIC_CLASS = /\[([?*()[\]{}])\]/gu;

// Node fs.glob applies case-insensitive matching to MAGIC segments on macOS and
// Windows (nocase + nocaseMagicOnly) so an existing configured glob like
// `**/*.MD` still matches `AGENTS.md` there, while literal path segments stay
// case-sensitive. Mirror that per-platform rule; the flag is read at matcher
// build time so it always reflects the running OS. Byte-exact literal-segment
// case parity is intentionally out of scope — nocaseMagicOnly keeps literals
// case-sensitive, matching Node.
function extraBootstrapNocase(): boolean {
  return process.platform === "darwin" || process.platform === "win32";
}

// Minimatch options for the walk matcher, mirroring Node fs.glob's own
// createMatcher options (nocase/nocaseMagicOnly/platform) so the walker matches
// the same file set fs.glob would on each platform. Built per call because
// `nocase` depends on the running OS. Keep the magic detector below in sync so
// the routing gate and the matcher never disagree about which patterns are
// globs.
function extraBootstrapMatchOptions() {
  return {
    nocomment: true,
    nonegate: true,
    windowsPathsNoEscape: true,
    nocase: extraBootstrapNocase(),
    nocaseMagicOnly: true,
    platform: process.platform,
  };
}

// Magic-detection options: the match options plus `magicalBraces`, which makes
// `Minimatch.hasMagic()` treat a brace alternation like `{a,b}` as magic. The
// matcher already expands `{a,b}` into multiple concrete paths, but without this
// flag `hasMagic()` reports a brace-only pattern as a literal, so the gate and
// the matcher would disagree and the brace pattern would never reach the walker.
function extraBootstrapMagicOptions() {
  return {
    ...extraBootstrapMatchOptions(),
    magicalBraces: true,
  };
}

export function hasGlobPattern(pattern: string): boolean {
  // Adopt Node glob grammar: a pattern is a glob when Minimatch — the same
  // engine the walker matches with — reports magic. This covers `?*{}`, bracket
  // classes (`[ab]`), and extglobs (`@(a|b)`, `+(x)`, `!(x)`, `?(a)`, `*(a)`),
  // so the routing gate and the walk matcher agree on what resolves through the
  // walker. A pattern Minimatch folds to a literal (a plain path, or a single
  // metacharacter-free segment such as a collapsed single-char class) stays a
  // literal file.
  const normalized = normalizeWorkspacePatternPath(pattern);
  return new Minimatch(normalized, extraBootstrapMagicOptions()).hasMagic();
}

function normalizeWorkspacePatternPath(value: string): string {
  return value
    .replaceAll(path.sep, "/")
    .replaceAll("\\", "/")
    .replace(/^\.\/+/u, "");
}

// Escape a pattern's glob metacharacters into their literal (bracket-wrapped)
// form so a path meant literally routes back through the literal reader. Used by
// the doctor extra-bootstrap glob-escape migration to repair configs written
// before the walker adopted Node glob grammar (a real directory named `pkg[ab]`
// whose `[ab]` is now read as a character class). windowsPathsNoEscape matches
// the walk matcher so the escape is walker-consistent.
export function escapeWorkspacePatternLiteral(pattern: string): string {
  return escapeGlobMagic(pattern, { windowsPathsNoEscape: true });
}

// Reverse escapeWorkspacePatternLiteral for the literal reader: minimatch treats
// a fully-escaped pattern (e.g. `pkg[[]ab[]]`) as magic-free, so hasGlobPattern
// routes it to the literal branch where the raw string still carries the `[x]`
// escapes. Unwrap exactly the metacharacter escapes to open the real `pkg[ab]`
// path; a literal single-char class such as `pkg[1]` carries no metacharacter
// inside the brackets and is left unchanged.
export function unescapeWorkspacePatternLiteral(pattern: string): string {
  return pattern.replace(ESCAPED_MAGIC_CLASS, "$1");
}

function resolveGlobWalkRoot(pattern: string): string {
  const normalized = normalizeWorkspacePatternPath(pattern);
  // Brace alternations can span "/" (`{a/b,c}/x`), so scanning the raw pattern
  // segment-by-segment would miss the brace — `{a` and `b,c}` are each non-magic
  // in isolation — and root the walk at a bogus literal path. The matcher expands
  // the braces, so that walk would start below some matches and silently return
  // nothing. Expand braces first (each expansion is brace-free, so its first
  // magic segment is well defined), then walk from the common literal ancestor of
  // every expansion so no possible match ever sits outside the walk root.
  const roots = braceExpand(normalized, extraBootstrapMagicOptions()).map(expansionWalkRoot);
  return commonAncestorDir(roots);
}

// Walk root for a single brace-free expansion: cut before the first magic
// segment (bracket classes and extglobs included), using the same magic
// definition as hasGlobPattern so the gate and the walk root agree. A pattern
// with no magic keeps its whole literal path.
function expansionWalkRoot(expansion: string): string {
  const segments = expansion.split("/");
  const firstMagicSegment = segments.findIndex((segment) => hasGlobPattern(segment));
  if (firstMagicSegment === -1) {
    return expansion;
  }
  // Magic at the top level walks from the workspace root.
  return segments.slice(0, firstMagicSegment).join("/") || ".";
}

// Deepest directory that is an ancestor of every brace expansion's walk root, so
// a single walk covers all expansions. Falls back to "." once the roots diverge
// at the top level (e.g. `{a/b,c}/x` -> roots `a/b`, `c`).
function commonAncestorDir(roots: string[]): string {
  const splitRoots = roots.map((root) => (root === "." ? [] : root.split("/")));
  const [first, ...rest] = splitRoots;
  if (!first) {
    return ".";
  }
  const common: string[] = [];
  for (let index = 0; index < first.length; index += 1) {
    const segment = first[index]!;
    if (!rest.every((segments) => segments[index] === segment)) {
      break;
    }
    common.push(segment);
  }
  return common.join("/") || ".";
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

// Decide whether a directory symlink at the current walk depth should be
// descended, mirroring Node fs.glob's symlink rule: a directory symlink is
// followed only when its own path segment is named by a LITERAL pattern segment
// (no glob magic) whose immediately-preceding pattern segment is not `**`. A
// symlink consumed by a wildcard (`*`/`**`), or one sitting directly after a
// `**` recursive prefix, is never followed even when a later literal names it
// (`**/wl/AGENTS.md` yields nothing for a `wl` symlink). A literal segment
// between the `**` and the symlink does re-enable descent, though
// (`**/pkg/linked/**` follows the `linked` symlink reached via literal `pkg`).
// Node tracks this per pattern index (globstar symlink taint); an alignment
// search over the walked path reproduces the same match set. `**` may match zero
// or more segments but never consumes the symlink segment itself (that is the
// wildcard-reached case) and never crosses a leading-dot segment, matching the
// dot rule in globPrefixCanDescend.
function symlinkDescentAllowed(dirSegments: string[], patternSegments: string[]): boolean {
  const dirLength = dirSegments.length;
  const patternLength = patternSegments.length;
  const lastDirIndex = dirLength - 1;
  const literalNotAfterRecursive = (patternIndex: number): boolean =>
    !hasGlobPattern(patternSegments[patternIndex]!) &&
    (patternIndex === 0 || patternSegments[patternIndex - 1] !== "**");
  const align = (dirIndex: number, patternIndex: number): boolean => {
    if (dirIndex === dirLength || patternIndex === patternLength) {
      return false;
    }
    const segment = dirSegments[dirIndex]!;
    const patternSegment = patternSegments[patternIndex]!;
    if (patternSegment === "**") {
      // `**` matches zero segments: try the pattern past it against this segment.
      if (align(dirIndex, patternIndex + 1)) {
        return true;
      }
      // `**` never consumes the final symlink segment (that is wildcard-reached)
      // and never crosses a leading-dot segment.
      if (dirIndex === lastDirIndex || segment.startsWith(".")) {
        return false;
      }
      return align(dirIndex + 1, patternIndex);
    }
    if (!path.matchesGlob(segment, patternSegment)) {
      return false;
    }
    if (dirIndex === lastDirIndex) {
      // Final (symlink) segment: descend only when named by a literal that does
      // not sit directly after a `**`.
      return literalNotAfterRecursive(patternIndex);
    }
    return align(dirIndex + 1, patternIndex + 1);
  };
  return align(0, 0);
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
        // pattern depth (even after a `**` recursive prefix, as long as a literal
        // segment sits between the `**` and the link) but never one reached
        // through a `*`/`**` wildcard. Apply the same partial-match prune as real
        // directories so a literal-named link whose prefix cannot lead to a match
        // stays off the stack.
        const childSegments = normalizedChildPath.split("/");
        if (
          symlinkDescentAllowed(childSegments, patternSegments) &&
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
  const matcher = new Minimatch(normalizedPattern, extraBootstrapMatchOptions());
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
