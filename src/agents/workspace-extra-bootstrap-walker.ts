/**
 * Extra bootstrap file glob resolution.
 *
 * Resolves `**\/AGENTS.md`-style extra-bootstrap patterns with Node's async
 * `fs.promises.glob`, which awaits per-directory lstat/readdir and keeps the
 * event loop live during embedded_run bootstrap-context. fs.glob owns matching
 * (dot rules, platform case, `..`, literal-named directory symlinks); this
 * module only filters each match to a workspace-contained realpath, a boundary
 * fs.glob does not enforce, so out-of-workspace bootstrap content never reaches
 * the prompt.
 *
 * fs.glob is absent on some runtimes (older Node, certain Bun builds). A narrow
 * capability fallback resolves the same pattern with a local Minimatch directory
 * walk there, so a configured glob still loads its files instead of throwing
 * into the loader's `io` diagnostic and dropping the whole configured set. The
 * fallback triggers only when the API is unavailable — a real fs.glob error
 * still surfaces — and its matches pass through the same realpath containment
 * filter as the fs.glob path.
 */
import syncFs from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { Minimatch } from "minimatch";
import { isPathInside } from "../infra/path-guards.js";

// Normalize a configured pattern to POSIX-relative form: fs.glob expects
// "/"-separated patterns and a leading "./" carries no meaning.
function normalizeWorkspacePatternPath(value: string): string {
  return value
    .replaceAll(path.sep, "/")
    .replaceAll("\\", "/")
    .replace(/^\.\/+/u, "");
}

// Fold ONLY the platform separator in an fs.glob match, never backslashes: a
// backslash is a legal POSIX filename byte, so rewriting it (as the pattern-side
// normalization does) would point the loader at a different, missing path and
// silently drop the file. Windows folding stays lossless — its names cannot hold
// a backslash. `separator` is injectable so both branches get test coverage on
// one platform.
export function toPortableMatchPath(match: string, separator: string = path.sep): string {
  return match.replaceAll(separator, "/");
}

export function hasGlobPattern(pattern: string): boolean {
  // Keep square brackets literal here; workspace paths commonly contain them.
  // Only `? * { }` route a pattern to fs.glob, so an existing config path like
  // `pkg[ab]/AGENTS.md` still loads only the literal file rather than fanning
  // out to a bracket-class expansion after upgrade (a `main` compatibility
  // contract). A pattern that mixes brackets with real magic (`pkg[ab]/*/…`)
  // does route to fs.glob, where `[ab]` is a character class — the same
  // asymmetry `main` has.
  return /[?*{}]/u.test(pattern);
}

// Leading literal directory prefix of a pattern: the path segments before the
// first glob-magic segment. Only the security pre-gate uses it, to decide
// whether a pattern rooted at a literal directory symlink escapes the workspace
// before fs.glob reads there. A magic-first pattern (`{a,b}/…`) collapses to "."
// (the workspace root), matching fs.glob which would root that walk at the
// workspace.
//
// The prefix grammar must match how the pattern is actually resolved, or the
// pre-gate realpaths the wrong directory. `hasGlobPattern` keeps `[ ]` literal
// for routing (so `pkg[ab]/AGENTS.md` opens its real bracket-named file), but a
// pattern that ALSO contains `? * { }` is routed to fs.glob, where `[ab]` is a
// character class. For that routed case the literal prefix must stop before a
// bracket segment too: `pkg[ab]/*/AGENTS.md` collapses to the workspace root,
// exactly where fs.glob roots its walk over `pkga`/`pkgb`. Realpathing the
// literal `pkg[ab]` directory instead would falsely reject the whole pattern if
// a stray `pkg[ab]` symlink escaped the workspace. A fully-literal pattern
// (routedToGlob false) keeps `[ ]` literal and its whole path — the `main`
// bracket-path compatibility contract.
function literalPatternPrefix(pattern: string, routedToGlob: boolean): string {
  const magicSegment = routedToGlob ? /[?*{}[\]]/u : /[?*{}]/u;
  const segments = normalizeWorkspacePatternPath(pattern).split("/");
  const literal: string[] = [];
  for (const segment of segments) {
    if (magicSegment.test(segment)) {
      break;
    }
    literal.push(segment);
  }
  return literal.join("/") || ".";
}

// Walk root for the fs.glob-absent fallback: the literal directory prefix before
// the first glob-magic character, so the local scan starts where fs.glob would
// root its walk instead of always re-reading from the workspace root.
function resolveFallbackWalkRoot(normalizedPattern: string): string {
  const globIndex = normalizedPattern.search(/[?*{}]/u);
  if (globIndex === -1) {
    return normalizedPattern;
  }
  const slashIndex = normalizedPattern.lastIndexOf("/", globIndex);
  return slashIndex === -1 ? "." : normalizedPattern.slice(0, slashIndex) || ".";
}

// fs.glob-absent fallback matcher (older Node / some Bun builds): resolve the
// pattern with a local Minimatch directory walk, yielding workspace-relative
// matches for the shared realpath-containment filter in the resolver. A subtree
// that cannot be read is skipped, not thrown — mirroring how fs.glob walks past
// an unreadable branch, so an unreadable sibling package never aborts loading of
// a readable one. Yields the raw separator-joined relative path (backslashes
// preserved) so the caller's toPortableMatchPath folds only the platform
// separator, exactly as on the fs.glob path.
async function* walkFallbackMatches(
  workspaceDir: string,
  normalizedPattern: string,
): AsyncGenerator<string> {
  const matcher = new Minimatch(normalizedPattern, {
    nocomment: true,
    nonegate: true,
    windowsPathsNoEscape: true,
  });
  const walkRoot = resolveFallbackWalkRoot(normalizedPattern);
  const stack = [walkRoot === "." ? "" : walkRoot];
  while (stack.length > 0) {
    const currentRelativeDir = stack.pop() ?? "";
    const currentDir = path.resolve(workspaceDir, currentRelativeDir);
    if (!isPathInside(workspaceDir, currentDir)) {
      continue;
    }
    let entries: syncFs.Dirent[];
    try {
      entries = await fs.readdir(currentDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const childRelativePath = currentRelativeDir
        ? path.join(currentRelativeDir, entry.name)
        : entry.name;
      const matchKey = toPortableMatchPath(childRelativePath);
      if (entry.isDirectory()) {
        // Descend only where a partial match can still be completed: a shallow
        // pattern never enters a deeper subtree, bounding the walk to fs.glob's.
        if (matcher.match(matchKey, true)) {
          stack.push(childRelativePath);
        }
        continue;
      }
      if ((entry.isFile() || entry.isSymbolicLink()) && matcher.match(matchKey)) {
        yield childRelativePath;
      }
    }
  }
}

// Resolve a glob pattern to workspace-relative POSIX paths, keeping only matches
// whose realpath stays inside the workspace root. fs.glob owns matching where
// available; a runtime without it uses the local Minimatch walk fallback.
export async function resolveExtraBootstrapPatternPaths(
  workspaceDir: string,
  pattern: string,
): Promise<string[]> {
  const normalizedPattern = normalizeWorkspacePatternPath(pattern);
  // Canonical workspace root bounds containment: a symlinked workspace dir
  // (macOS /var -> /private/var) must compare against its realpath, not its
  // lexical path, or every contained match would be rejected.
  let workspaceRealpath: string;
  try {
    workspaceRealpath = await fs.realpath(workspaceDir);
  } catch {
    workspaceRealpath = path.resolve(workspaceDir);
  }
  const matches = new Set<string>();
  // Capability branch: fs.glob is the matcher wherever it exists; the local walk
  // keeps configured patterns resolving where it is absent. Narrow by design — it
  // switches on the missing API only and never swallows a real fs.glob error.
  const matchSource =
    typeof fs.glob === "function"
      ? fs.glob(normalizedPattern, { cwd: workspaceDir })
      : walkFallbackMatches(workspaceDir, normalizedPattern);
  try {
    // Single async pass. fs.glob resolves `..` (a globstar parent steps above
    // cwd) and follows literal-named directory symlinks out of the tree; the
    // realpath containment filter drops any match that escapes the workspace so
    // those never enter the prompt. The fallback walk yields the same shape and
    // shares this filter.
    for await (const relativeMatch of matchSource) {
      const absolute = path.resolve(workspaceDir, relativeMatch);
      let realpath: string;
      try {
        realpath = await fs.realpath(absolute);
      } catch (error) {
        // ENOENT here is a benign delete-race: the entry vanished between
        // fs.glob yielding it and this realpath, so skip that one match. Any
        // other failure (EACCES/ELOOP/…) is a real fault on a matched file and
        // is rethrown so the outer catch reaches the loader, which surfaces a
        // per-pattern `io` diagnostic instead of a silently empty match set.
        // Tradeoff: one failing match degrades its whole pattern to that io
        // diagnostic; per-match surfacing would need a wider return signature,
        // deliberately out of scope.
        // SAFETY: Node fs failures carry an ErrnoException-shaped `code`; the cast only reads that property.
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          continue;
        }
        throw error;
      }
      if (isPathInside(workspaceRealpath, realpath)) {
        matches.add(toPortableMatchPath(relativeMatch));
      }
    }
  } catch (error) {
    // fs.glob walks past per-entry read failures (an unreadable subtree is
    // skipped, not thrown), so a throw here is a top-level failure. A missing
    // cwd (ENOENT) legitimately means "no matches". Every other failure must
    // surface: the loader turns the rethrow into an operator-visible "io"
    // diagnostic, instead of silently dropping every configured bootstrap file.
    // SAFETY: Node fs failures carry an ErrnoException-shaped `code`; the cast only reads that property.
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }
  return [...matches];
}

// Loader security pre-gate: reject a pattern whose leading literal directory
// prefix escapes the workspace so the loader surfaces a `security` diagnostic
// instead of a silent empty resolve. Lexical containment first (a literal
// `../outside` prefix), then realpath containment: a literal-prefix directory
// symlink can point outside the workspace while staying lexically inside
// (`linked/**` where `linked` -> /external), and fs.glob would resolve that
// external target (P1-B). A prefix that does not exist yet has no realpath —
// fall through to the lexical result, since the glob simply finds nothing there.
export async function patternWalkRootStaysInWorkspace(
  workspaceDir: string,
  pattern: string,
): Promise<boolean> {
  const walkRoot = path.resolve(
    workspaceDir,
    literalPatternPrefix(pattern, hasGlobPattern(pattern)),
  );
  if (!isPathInside(workspaceDir, walkRoot)) {
    return false;
  }
  let workspaceRealpath: string;
  try {
    workspaceRealpath = await fs.realpath(workspaceDir);
  } catch {
    return true;
  }
  let rootRealpath: string;
  try {
    rootRealpath = await fs.realpath(walkRoot);
  } catch {
    return true;
  }
  return isPathInside(workspaceRealpath, rootRealpath);
}
