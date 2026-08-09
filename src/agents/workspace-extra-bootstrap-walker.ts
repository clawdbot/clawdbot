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
    // Mirror Node fs.glob's createMatcher, which sets optimizationLevel: 2. That
    // level normalizes reducible parent-traversal patterns (`*/../`, `*/**/../b`,
    // `<p>/../`) into a downward form so the walk matcher agrees with fs.glob
    // instead of matching nothing. Inherited by extraBootstrapMagicOptions() via
    // its spread on purpose: it keeps the routing gate and the matcher aligned
    // (gate-neutral — hasMagic classification is identical with or without the
    // flag). A globstar parent traversal like `**/../AGENTS.md` is NOT collapsible,
    // so a `..` survives in the optimized globParts; the downward matcher cannot
    // resolve it, so walkExtraBootstrapParentTraversalMatches walks those contained
    // parent transitions separately to reproduce fs.glob's in-root match set.
    optimizationLevel: 2,
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

// A `..` segment tells fs.glob's walker to step up a directory level; this
// matcher-only downward walk cannot do that. optimizationLevel 2 collapses the
// reducible forms (`*/../`, `<p>/../`) into a downward pattern the walk matches,
// but a globstar parent (`**/../`) cannot be reduced, so its `..` survives in
// the optimized globParts. Those surviving alternatives are resolved by
// walkExtraBootstrapParentTraversalMatches, which walks the contained parent
// transitions directly; a collapsible or `..`-free pattern never reaches it.
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
// depth. Braces expand to independent concrete alternatives in Node's globber,
// and its dot rule runs per alternative, so a dot subtree is prunable only when
// NO brace-free expansion could descend into it — OR the per-expansion check.
function globPrefixCanDescend(dirSegments: string[], patternExpansions: string[][]): boolean {
  return patternExpansions.some((patternSegments) =>
    expansionPrefixCanDescend(dirSegments, patternSegments),
  );
}

// Per-expansion dot-prefix descent check for one brace-free pattern. Returns
// whether `dirSegments` can be a prefix of some path this expansion matches;
// used to prune dot-directory subtrees (`.git`, `.openclaw`, …) the glob could
// never reach. matchesGlob applies the dot rule per single segment, so the only
// extra rule here is that `**` cannot consume a leading-dot segment.
function expansionPrefixCanDescend(dirSegments: string[], patternSegments: string[]): boolean {
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
// dot rule in globPrefixCanDescend. Braces expand to independent literal
// alternatives in Node's globber (`pkg/{linked,other}/**` follows the `linked`
// symlink via the `linked` alternative), so descent is allowed when ANY
// brace-free expansion's alignment allows it; each expansion is brace-free, so
// the literal / **-taint / leading-dot rules below classify each concrete
// alternative correctly rather than mis-reading a raw `{…}` segment as magic.
function symlinkDescentAllowed(
  dirSegments: string[],
  patternExpansions: string[][],
  ancestorSymlinkDepths: ReadonlySet<number>,
): boolean {
  return patternExpansions.some((patternSegments) =>
    expansionAllowsSymlinkDescent(dirSegments, patternSegments, ancestorSymlinkDepths),
  );
}

// Per-expansion symlink-descent alignment for one brace-free pattern.
// `ancestorSymlinkDepths` holds the 0-based path indices already reached by
// following a symlink; a `**` may not consume one of them because globstar never
// traverses INTO a symlink (see the loop-safety note on WalkFrame).
function expansionAllowsSymlinkDescent(
  dirSegments: string[],
  patternSegments: string[],
  ancestorSymlinkDepths: ReadonlySet<number>,
): boolean {
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
      // `**` never consumes the final symlink segment (that is wildcard-reached),
      // never crosses a leading-dot segment, and never crosses an already-followed
      // symlink: globstar does not traverse into a symlink in fs.glob, so letting a
      // leading `**` absorb an ancestor link would re-cross a contained
      // ancestor-pointing link on every pass and diverge from fs.glob (which only
      // follows a link where the pattern names it literally).
      if (
        dirIndex === lastDirIndex ||
        segment.startsWith(".") ||
        ancestorSymlinkDepths.has(dirIndex)
      ) {
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

// Ancestor chain node for the active descent path. `symlinkDepths` holds the
// 0-based path-segment indices at which a directory symlink was followed to reach
// this frame; it is what makes the walk terminate without a realpath cycle guard.
// A symlink is only ever descended after symlinkDescentAllowed aligns it against a
// LITERAL pattern segment (wildcards never cross a symlink) whose preceding `**`
// did not consume one of these depths — so globstar cannot re-cross a contained
// ancestor-pointing link (`a/loop -> a`). Each followed link therefore advances
// past a distinct literal pattern segment, and the pattern has finitely many, so
// the walk is bounded and matches fs.glob (which follows such a link only where
// the pattern names it literally).
type WalkFrame = { relativeDir: string; symlinkDepths: ReadonlySet<number> };

// Decide whether a literal-named directory symlink should be descended, mirroring
// fs.glob which follows literal-named directory symlinks. Returns a child frame
// when the link resolves to a directory that stays inside the workspace;
// otherwise null so the caller keeps the symlink as a terminal leaf candidate.
async function resolveSymlinkDescent(
  workspaceDir: string,
  workspaceRealpath: string,
  childRelativePath: string,
  childSymlinkDepths: ReadonlySet<number>,
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
  // Record this link's depth so a later `**` cannot re-cross it (see WalkFrame).
  return { relativeDir: childRelativePath, symlinkDepths: childSymlinkDepths };
}

async function* walkWorkspaceFiles(
  workspaceDir: string,
  initialRelativeDir: string,
  strictRead: boolean,
  matcher: Minimatch,
  normalizedPattern: string,
): AsyncGenerator<string> {
  // Brace alternations expand to separate concrete alternatives in Node's
  // globber (`pkg/{linked,other}/**` -> `pkg/linked/**` and `pkg/other/**`), and
  // its symlink and dot-prefix rules run per alternative. Expand once here, off
  // the symlink hot path, so the descent checks classify each brace-free
  // alternative independently instead of mis-reading a raw `{…}` segment as a
  // magic segment. A brace-free pattern expands to a single alternative, so
  // existing single-path behavior is preserved.
  const patternExpansions = braceExpand(normalizedPattern, extraBootstrapMagicOptions()).map(
    (expansion) => expansion.split("/"),
  );
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
  // Mirror resolveSymlinkDescent containment for the seed/initial root (P1-E):
  // a pattern whose literal prefix is a directory symlink pointing outside the
  // workspace resolves rootRealpath to the external target. Descended frames go
  // through resolveSymlinkDescent, but the seed frame does not, so reject an
  // external initial root here before pushing it or calling readdir. An empty
  // relToRoot means rootRealpath === workspaceRealpath (the root itself), which
  // is inside and must be allowed; only `..` or an absolute path escapes.
  const rootRelToWorkspace = path.relative(workspaceRealpath, rootRealpath);
  if (rootRelToWorkspace.startsWith("..") || path.isAbsolute(rootRelToWorkspace)) {
    return;
  }
  const stack: WalkFrame[] = [{ relativeDir: rootRelativeDir, symlinkDepths: new Set() }];
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
          !globPrefixCanDescend(normalizedChildPath.split("/"), patternExpansions)
        ) {
          continue;
        }
        // fs.glob returns a directory that fully matches the pattern (a configured
        // match whose on-disk entry is a directory), routing it through the guarded
        // loader so it surfaces a diagnostic instead of vanishing silently. Emit the
        // full match here; the partial-match descent below still runs for deeper
        // matches, and a full match yields this exact path only once (the descent
        // only produces distinct deeper paths), so this is not a double-emit.
        // oxlint-disable-next-line unicorn/prefer-regexp-test -- Minimatch.match returns a boolean; it has no RegExp#test.
        if (matcher.match(normalizedChildPath)) {
          yield normalizedChildPath;
        }
        // Descend only when the directory could still contain a match, so the
        // traversal stays bounded to the pattern's own subtree without changing
        // which files match. Broad patterns like `**/AGENTS.md` still recurse
        // into build-output directory names (e.g. `dist`), so the walker returns
        // the same match set as fs.glob — no ignored-directory pruning silently
        // drops a configured match on upgrade.
        if (matcher.match(normalizedChildPath, true)) {
          // Real directory: inherit the parent's followed-symlink depths unchanged
          // (a real segment is never a symlink crossing).
          stack.push({ relativeDir: childRelativePath, symlinkDepths: frame.symlinkDepths });
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
          symlinkDescentAllowed(childSegments, patternExpansions, frame.symlinkDepths) &&
          matcher.match(normalizedChildPath, true)
        ) {
          // This link sits at the last path index; record it so a `**` deeper in
          // the walk cannot re-cross it (see WalkFrame loop-safety note).
          const childSymlinkDepths = new Set(frame.symlinkDepths);
          childSymlinkDepths.add(childSegments.length - 1);
          const descendFrame = await resolveSymlinkDescent(
            workspaceDir,
            workspaceRealpath,
            childRelativePath,
            childSymlinkDepths,
          );
          if (descendFrame) {
            // fs.glob yields a directory symlink that fully matches the pattern even
            // as it descends it, so emit that full match into the guarded loader
            // before continuing the descent. This branch is mutually exclusive with
            // the terminal-leaf yield below (that one only runs when the link is not
            // descended), so the same path is never emitted twice.
            // oxlint-disable-next-line unicorn/prefer-regexp-test -- Minimatch.match returns a boolean; it has no RegExp#test.
            if (matcher.match(normalizedChildPath)) {
              yield normalizedChildPath;
            }
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

// Resolve the contained `..` (parent) transitions Node fs.glob performs for a
// globstar-parent pattern such as `**/../AGENTS.md`. optimizationLevel 2 reduces
// the collapsible `..` shapes (`*/../`, `<literal>/../`, `a/**/../b`) into a
// downward form the main matcher already handles, but a globstar parent (`**/..`)
// cannot be rewritten downward, so a `..` survives in globParts. fs.glob resolves
// it by, at each directory reachable by the globstar, matching the tokens after
// the `..` from that directory's parent (and descending its children with the
// globstar retained). This walker mirrors that rule directly: a `**` matches zero
// or more real child directories, and a `..` pops one level, so "globstar matches
// zero, then `..`" lands on the parent exactly as fs.glob does. Popping is lexical
// and any pop that would leave the workspace root is pruned, so no parent
// transition escapes containment (the boundary fs.glob itself does not enforce).
// Symlink descent mirrors the downward walk: a globstar never crosses a symlink,
// and a literal token follows a directory symlink only when its realpath stays in
// the workspace (a wildcard-reached or out-of-tree link is never followed), so the
// two walkers agree with each other and with fs.glob's followed-symlink rule.
// Only alternatives that still carry a `..` are walked here; every `..`-free
// alternative is already covered by the downward matcher in walkWorkspaceFiles.
//
// Accepted deviation: for the pathological, never-configured shape of two or more
// consecutive `..` after a globstar (`**/../../AGENTS.md`), Node's internal
// fs.glob prunes a few additional contained matches this recursive rule keeps, so
// the walker may return a superset of the contained set there. It never escapes
// the workspace and never affects single-`..` globstar parents like the case
// above.
async function* walkExtraBootstrapParentTraversalMatches(
  workspaceDir: string,
  strictRead: boolean,
  globParts: string[][],
): AsyncGenerator<string> {
  const parentAlternatives = globParts.filter((parts) => parts.includes(".."));
  if (parentAlternatives.length === 0) {
    return;
  }
  // Canonical workspace root bounds literal-symlink descent below, exactly as the
  // downward walk does via resolveSymlinkDescent.
  let workspaceRealpath: string;
  try {
    workspaceRealpath = await fs.realpath(workspaceDir);
  } catch {
    workspaceRealpath = path.resolve(workspaceDir);
  }
  const emitted = new Set<string>();
  let visitedEntries = 0;
  const readDirEntries = async (relativeDir: string): Promise<syncFs.Dirent[] | null> => {
    const abs = path.resolve(workspaceDir, relativeDir);
    if (!isPathInside(workspaceDir, abs)) {
      return null;
    }
    try {
      return await fs.readdir(abs, { withFileTypes: true });
    } catch (error) {
      if (strictRead && (error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
      return null;
    }
  };
  async function* matchTokens(
    relativeDir: string,
    tokens: string[],
    tokenIndex: number,
  ): AsyncGenerator<string> {
    if (tokenIndex >= tokens.length) {
      return;
    }
    const token = tokens[tokenIndex]!;
    const isLastToken = tokenIndex === tokens.length - 1;
    if (token === "..") {
      // Lexical parent step. An empty relativeDir is the workspace root, so a pop
      // there escapes the workspace — prune it to keep the transition contained.
      if (relativeDir === "") {
        return;
      }
      const separatorIndex = relativeDir.lastIndexOf("/");
      const parent = separatorIndex === -1 ? "" : relativeDir.slice(0, separatorIndex);
      yield* matchTokens(parent, tokens, tokenIndex + 1);
      return;
    }
    if (token === "**") {
      // Globstar matches zero segments: advance past it at the same directory. A
      // following `..` then pops to this directory's parent, reproducing fs.glob's
      // `**/..` parent transition.
      yield* matchTokens(relativeDir, tokens, tokenIndex + 1);
      const entries = await readDirEntries(relativeDir);
      if (!entries) {
        return;
      }
      for (const entry of entries) {
        visitedEntries += 1;
        if (visitedEntries % EXTRA_BOOTSTRAP_GLOB_YIELD_INTERVAL === 0) {
          await yieldImmediate();
        }
        // Globstar matches one-or-more real directories; like the downward walk it
        // never crosses a symlink or a leading-dot segment.
        if (!entry.isDirectory() || entry.name.startsWith(".")) {
          continue;
        }
        const childRelativeDir = relativeDir ? `${relativeDir}/${entry.name}` : entry.name;
        yield* matchTokens(childRelativeDir, tokens, tokenIndex);
      }
      return;
    }
    // Literal or single-segment glob token.
    const entries = await readDirEntries(relativeDir);
    if (!entries) {
      return;
    }
    for (const entry of entries) {
      visitedEntries += 1;
      if (visitedEntries % EXTRA_BOOTSTRAP_GLOB_YIELD_INTERVAL === 0) {
        await yieldImmediate();
      }
      if (!path.matchesGlob(entry.name, token)) {
        continue;
      }
      const childRelativePath = relativeDir ? `${relativeDir}/${entry.name}` : entry.name;
      if (isLastToken) {
        // Terminal segment matches files and directories alike (fs.glob yields
        // matching directories too). Dedupe: the same target is reached once per
        // globstar-descended directory whose parent holds it.
        if (!emitted.has(childRelativePath)) {
          emitted.add(childRelativePath);
          yield childRelativePath;
        }
      } else if (entry.isDirectory()) {
        yield* matchTokens(childRelativePath, tokens, tokenIndex + 1);
      } else if (entry.isSymbolicLink() && !hasGlobPattern(token)) {
        // fs.glob follows a directory symlink only when a LITERAL segment names it,
        // never one reached through a `*`/`**` wildcard, and this walker enforces
        // the workspace containment fs.glob does not: resolveSymlinkDescent rejects
        // a link whose realpath escapes the root (and non-directory targets). Match
        // the downward walk here — without it the token walk would follow a
        // wildcard-reached or out-of-tree link that neither fs.glob nor
        // walkWorkspaceFiles would, breaking parity and the containment invariant.
        const descend = await resolveSymlinkDescent(
          workspaceDir,
          workspaceRealpath,
          childRelativePath,
          new Set(),
        );
        if (descend) {
          yield* matchTokens(childRelativePath, tokens, tokenIndex + 1);
        }
      }
    }
  }
  for (const tokens of parentAlternatives) {
    yield* matchTokens("", tokens, 0);
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
  // A Set dedupes the two passes below: a globstar-parent pattern can expand to
  // both a downward alternative (matched by walkWorkspaceFiles) and a `..`
  // alternative (matched by the parent-traversal walk), and the same target can
  // surface from either.
  const matches = new Set<string>();
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
    matches.add(candidate);
  }
  // Globstar-parent patterns (`**/../AGENTS.md`) keep a `..` in the optimized
  // globParts that the downward matcher cannot resolve. Walk those contained
  // parent transitions so the pattern returns the same in-root match set as
  // fs.glob instead of silently resolving to nothing.
  for await (const candidate of walkExtraBootstrapParentTraversalMatches(
    workspaceDir,
    strictRead,
    matcher.globParts,
  )) {
    matches.add(candidate);
  }
  // A glob that matched nothing resolves to an empty set, matching fs.glob's
  // no-match behavior. Returning [pattern] is reserved for the no-glob-support
  // fallback above, where the literal is the only thing we can hand back.
  return [...matches];
}

export function patternWalkRootStaysInWorkspace(workspaceDir: string, pattern: string): boolean {
  const walkRoot = path.resolve(workspaceDir, resolveGlobWalkRoot(pattern));
  return isPathInside(workspaceDir, walkRoot);
}
