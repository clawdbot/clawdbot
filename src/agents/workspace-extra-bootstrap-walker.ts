/**
 * Extra bootstrap file glob resolution.
 *
 * Resolves `**\/AGENTS.md`-style extra-bootstrap patterns with Node's async
 * `fs.promises.glob`, which awaits per-directory lstat/readdir and keeps the
 * event loop live during embedded_run bootstrap-context — the reason no bespoke
 * yielding walker is needed here. fs.glob owns matching (dot rules, platform
 * case, `..`, literal-named directory symlinks); this module only filters each
 * match to a workspace-contained realpath, a boundary fs.glob does not enforce,
 * so out-of-workspace bootstrap content never reaches the prompt.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { isPathInside } from "../infra/path-guards.js";

// Normalize a configured pattern to POSIX-relative form: fs.glob expects
// "/"-separated patterns and a leading "./" carries no meaning.
function normalizeWorkspacePatternPath(value: string): string {
  return value
    .replaceAll(path.sep, "/")
    .replaceAll("\\", "/")
    .replace(/^\.\/+/u, "");
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

// Resolve a glob pattern to workspace-relative POSIX paths via Node's async
// fs.glob, keeping only matches whose realpath stays inside the workspace root.
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
  try {
    // Single async pass. fs.glob resolves `..` (a globstar parent steps above
    // cwd) and follows literal-named directory symlinks out of the tree; the
    // realpath containment filter drops any match that escapes the workspace so
    // those never enter the prompt.
    for await (const relativeMatch of fs.glob(normalizedPattern, { cwd: workspaceDir })) {
      const absolute = path.resolve(workspaceDir, relativeMatch);
      let realpath: string;
      try {
        realpath = await fs.realpath(absolute);
      } catch {
        continue;
      }
      if (isPathInside(workspaceRealpath, realpath)) {
        matches.add(normalizeWorkspacePatternPath(relativeMatch));
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
