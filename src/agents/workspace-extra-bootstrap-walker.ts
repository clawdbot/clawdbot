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
import { Minimatch } from "minimatch";
import { isPathInside } from "../infra/path-guards.js";

// Normalize a configured pattern to POSIX-relative form: fs.glob and Minimatch
// both expect "/"-separated patterns and a leading "./" carries no meaning.
function normalizeWorkspacePatternPath(value: string): string {
  return value
    .replaceAll(path.sep, "/")
    .replaceAll("\\", "/")
    .replace(/^\.\/+/u, "");
}

// Magic-detection options for the routing gate only. magicalBraces makes a brace
// alternation like `{a,b}` count as magic (fs.glob still expands it to concrete
// paths), while Minimatch folds a single-char class like `[1]` back to a literal
// — so a real directory named `pkg[1]` routes to the literal reader and
// `pkg[ab]` routes to fs.glob. No nocase/optimizationLevel/matcher plumbing:
// fs.glob performs the actual matching and applies its own platform case rules.
function extraBootstrapMagicOptions() {
  return {
    nocomment: true,
    nonegate: true,
    windowsPathsNoEscape: true,
    magicalBraces: true,
  };
}

export function hasGlobPattern(pattern: string): boolean {
  // A pattern is a glob when Minimatch reports magic; anything it folds to a
  // literal (a plain path or a collapsed single-char class) is read verbatim.
  const normalized = normalizeWorkspacePatternPath(pattern);
  return new Minimatch(normalized, extraBootstrapMagicOptions()).hasMagic();
}

// Leading literal directory prefix of a pattern: the path segments before the
// first glob-magic segment. Only the security pre-gate uses it, to decide
// whether a pattern rooted at a literal directory symlink escapes the workspace
// before fs.glob reads there. A magic-first pattern (`[ab]/…`, `{a,b}/…`)
// collapses to "." (the workspace root), matching fs.glob which would root that
// walk at the workspace; a fully-literal pattern keeps its whole path.
function literalPatternPrefix(pattern: string): string {
  const segments = normalizeWorkspacePatternPath(pattern).split("/");
  const literal: string[] = [];
  for (const segment of segments) {
    if (hasGlobPattern(segment)) {
      break;
    }
    literal.push(segment);
  }
  return literal.join("/") || ".";
}

// Literal interpretation of the raw pattern for the transparent no-match
// fallback: the pattern taken verbatim as a path (brackets/extglob NOT
// expanded). Returns the normalized workspace-relative path only when it
// resolves inside the workspace AND exists on disk; otherwise null.
async function containedLiteralPath(
  workspaceDir: string,
  workspaceRealpath: string,
  pattern: string,
): Promise<string | null> {
  const relative = normalizeWorkspacePatternPath(pattern);
  const absolute = path.resolve(workspaceDir, relative);
  if (!isPathInside(workspaceDir, absolute)) {
    return null;
  }
  let realpath: string;
  try {
    realpath = await fs.realpath(absolute);
  } catch {
    // No such on-disk path — a genuine no-match glob, not a mislabeled literal.
    return null;
  }
  return isPathInside(workspaceRealpath, realpath) ? relative : null;
}

// Resolve a glob pattern to workspace-relative POSIX paths via Node's async
// fs.glob, keeping only matches whose realpath stays inside the workspace root.
export async function resolveExtraBootstrapPatternPaths(
  workspaceDir: string,
  pattern: string,
  strictRead: boolean,
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
    // fs.glob skips per-entry read failures (an unreadable subtree is walked
    // past, not thrown), so this only fires on a top-level failure such as a
    // missing cwd. Strict doctor discovery surfaces a genuine non-ENOENT
    // failure; a normal bootstrap load drops the pattern instead of failing the
    // whole load.
    if (strictRead && (error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }
  // Transparent literal fallback (zero operator action): once the resolver
  // adopts Node glob grammar, a pattern like `pkg[ab]/AGENTS.md` written to name
  // a real directory literally called `pkg[ab]` parses its `[ab]` as a character
  // class and matches nothing. When the contained set is empty, fall back to the
  // raw pattern read as a literal path, keeping it only if it exists inside the
  // workspace. A live glob keeps a non-empty set, so the fallback never fires; a
  // genuine no-match glob (`packages/*/AGENTS.md`) adds nothing because its raw
  // form is not a real on-disk path (existence-gated), so no phantom "missing
  // file" diagnostic appears.
  //
  // Two accepted edge cases the fallback intentionally does NOT cover, both
  // extremely unlikely: (i) a pattern that is simultaneously a live glob AND a
  // literal path (dirs `pkga`, `pkgb`, and `pkg[ab]` all present) — the glob
  // matched, so the fallback stays dormant and the literal `pkg[ab]` file is not
  // added; (ii) a literal-bracket parent with a live child glob
  // (`pkg[ab]/**/AGENTS.md`) — the raw string is not itself a path, so the
  // existence gate rejects it.
  if (matches.size === 0) {
    const literal = await containedLiteralPath(workspaceDir, workspaceRealpath, pattern);
    if (literal) {
      matches.add(literal);
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
  const walkRoot = path.resolve(workspaceDir, literalPatternPrefix(pattern));
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
