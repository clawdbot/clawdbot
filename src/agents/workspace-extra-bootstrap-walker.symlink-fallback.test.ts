// Behavior tests for the fs.glob-absent capability fallback's symlink descent.
// Split out of workspace-extra-bootstrap-walker.test.ts (which stays under the
// per-file line cap): on runtimes without fs.promises.glob the local Minimatch
// walk is the matcher, and it must follow literal-named directory symlinks exactly
// where fs.glob follows them so a bootstrap file behind a symlinked package
// directory is not silently dropped. Each parity case computes fs.glob's set FIRST
// (while the API exists), then hides fs.glob and asserts the fallback returns the
// same set. Termination is structural (pattern-progress budget, never a visited-
// realpath set), so symlink cycles terminate while two aliases pointing at one
// target both resolve.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { resolveExtraBootstrapPatternPaths } from "./workspace-extra-bootstrap-walker.js";
import { loadExtraBootstrapFilesWithDiagnostics } from "./workspace.js";

async function nodeGlobRelative(workspaceDir: string, pattern: string): Promise<string[]> {
  const matches: string[] = [];
  for await (const match of fs.glob(pattern, { cwd: workspaceDir })) {
    matches.push(match.replaceAll(path.sep, "/"));
  }
  return matches.toSorted();
}

describe("resolveExtraBootstrapPatternPaths fs.glob-absent fallback symlink descent", () => {
  // The fs.glob-absent fallback walk must follow a literal-named directory symlink
  // exactly where fs.glob does, so a configured bootstrap file behind a symlinked
  // package directory is not silently dropped on runtimes without fs.promises.glob.
  // Every parity case computes fs.glob's set FIRST (while the API exists), then
  // hides fs.glob and asserts the fallback returns the same set. Termination is
  // structural (pattern-progress budget, never a visited-realpath set), so symlink
  // cycles terminate while two aliases pointing at one target both resolve.
  let fixtureRoot = "";
  let fixtureCount = 0;

  const createWorkspaceDir = async (prefix: string) => {
    const dir = path.join(fixtureRoot, `${prefix}-${fixtureCount++}`);
    await fs.mkdir(dir, { recursive: true });
    return dir;
  };

  const trySymlink = async (
    target: string,
    linkPath: string,
    type: "dir" | "file" = "dir",
  ): Promise<boolean> => {
    try {
      await fs.symlink(target, linkPath, type);
      return true;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code ?? "";
      if (["EPERM", "EACCES", "ENOSYS"].includes(code)) {
        return false;
      }
      throw err;
    }
  };

  // Hide fs.promises.glob so the resolver takes its capability fallback, exactly as
  // on a runtime that ships no fs.glob. Restored in `finally`.
  const withoutFsGlob = async (body: () => Promise<void>): Promise<void> => {
    const original = Object.getOwnPropertyDescriptor(fs, "glob");
    Object.defineProperty(fs, "glob", { value: undefined, configurable: true, writable: true });
    try {
      expect(typeof fs.glob).not.toBe("function");
      await body();
    } finally {
      if (original) {
        Object.defineProperty(fs, "glob", original);
      }
    }
  };

  beforeAll(async () => {
    // realpath the root so the shared containment realpath compares canonical paths
    // on macOS (/var -> /private/var).
    fixtureRoot = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-walker-noglob-symlink-")),
    );
  });

  afterAll(async () => {
    if (fixtureRoot) {
      await fs.rm(fixtureRoot, { recursive: true, force: true });
    }
  });

  it.runIf(process.platform !== "win32")(
    "(1) descends a literal directory symlink reached after a ** prefix (fs.glob parity)",
    async () => {
      // Discriminating descent: `linked` is a directory symlink named literally in
      // the pattern and reached through the literal `pkg` after `**`. fs.glob
      // descends it; the pre-fix fallback saw isDirectory()===false on the symlink
      // Dirent and never descended, silently dropping every match behind the link.
      const workspaceDir = await createWorkspaceDir("literal-after-recursive");
      const pkgDir = path.join(workspaceDir, "pkg");
      const target = path.join(workspaceDir, "target");
      const targetNested = path.join(target, "nested");
      await fs.mkdir(pkgDir, { recursive: true });
      await fs.mkdir(targetNested, { recursive: true });
      await fs.writeFile(path.join(target, "AGENTS.md"), "top", "utf-8");
      await fs.writeFile(path.join(targetNested, "AGENTS.md"), "nested", "utf-8");
      if (!(await trySymlink(path.join("..", "target"), path.join(pkgDir, "linked")))) {
        return;
      }

      const pattern = "**/pkg/linked/**/AGENTS.md";
      const oracle = await nodeGlobRelative(workspaceDir, pattern);
      await withoutFsGlob(async () => {
        const matches = (await resolveExtraBootstrapPatternPaths(workspaceDir, pattern)).toSorted();
        expect(matches).toStrictEqual(["pkg/linked/AGENTS.md", "pkg/linked/nested/AGENTS.md"]);
        expect(matches).toStrictEqual(oracle);
      });
    },
  );

  it.runIf(process.platform !== "win32")(
    "(2) discards a fallback descent whose symlink target escapes the workspace",
    async () => {
      // Escape discard: descent is now attempted through `linked`, but the shared
      // realpath-containment filter drops every match whose canonical path leaves
      // the workspace, so out-of-tree bootstrap content never reaches the prompt and
      // the resolver does not throw.
      const rootDir = await createWorkspaceDir("escape");
      const workspaceDir = path.join(rootDir, "workspace");
      const outsideDir = path.join(rootDir, "outside");
      const pkgDir = path.join(workspaceDir, "pkg");
      await fs.mkdir(pkgDir, { recursive: true });
      await fs.mkdir(outsideDir, { recursive: true });
      await fs.writeFile(path.join(outsideDir, "AGENTS.md"), "outside", "utf-8");
      if (!(await trySymlink(path.join("..", "..", "outside"), path.join(pkgDir, "linked")))) {
        return;
      }

      await withoutFsGlob(async () => {
        const matches = await resolveExtraBootstrapPatternPaths(
          workspaceDir,
          "**/pkg/linked/**/AGENTS.md",
        );
        expect(matches).toStrictEqual([]);
      });
    },
  );

  it.runIf(process.platform !== "win32")(
    "(3) terminates a globstar pattern over a descended ancestor-loop symlink (fs.glob parity)",
    async () => {
      // Wildcard termination: `pkg/loop -> pkg` is a contained ancestor-pointing
      // symlink named literally in `*/loop/**`. fs.glob follows it once and the
      // trailing `**` never re-crosses the link. The fallback must match that set
      // and, critically, terminate — completing under the bounded timeout is the
      // proof that the trailing globstar cannot re-descend the loop forever.
      const workspaceDir = await createWorkspaceDir("ancestor-loop");
      const pkgDir = path.join(workspaceDir, "pkg");
      await fs.mkdir(pkgDir, { recursive: true });
      await fs.writeFile(path.join(pkgDir, "AGENTS.md"), "pkg", "utf-8");
      if (!(await trySymlink(pkgDir, path.join(pkgDir, "loop")))) {
        return;
      }

      const pattern = "*/loop/**/AGENTS.md";
      const oracle = await nodeGlobRelative(workspaceDir, pattern);
      await withoutFsGlob(async () => {
        const matches = (await resolveExtraBootstrapPatternPaths(workspaceDir, pattern)).toSorted();
        expect(matches).toStrictEqual(["pkg/loop/AGENTS.md"]);
        expect(matches).toStrictEqual(oracle);
      });
    },
    15000,
  );

  it.runIf(process.platform !== "win32")(
    "(4) terminates on a mutual symlink cycle a -> b -> a without hanging",
    async () => {
      // Cycle termination: `a -> b` and `b -> a` form an unresolvable loop. stat()
      // on either link raises ELOOP, which the descent treats as "do not descend",
      // so the walk terminates with no matches, exactly like fs.glob.
      const workspaceDir = await createWorkspaceDir("mutual-cycle");
      const dir = path.join(workspaceDir, "dir");
      await fs.mkdir(dir, { recursive: true });
      if (!(await trySymlink("b", path.join(dir, "a")))) {
        return;
      }
      if (!(await trySymlink("a", path.join(dir, "b")))) {
        return;
      }

      const pattern = "dir/a/**/AGENTS.md";
      const oracle = await nodeGlobRelative(workspaceDir, pattern);
      await withoutFsGlob(async () => {
        const matches = (await resolveExtraBootstrapPatternPaths(workspaceDir, pattern)).toSorted();
        expect(matches).toStrictEqual([]);
        expect(matches).toStrictEqual(oracle);
      });
    },
    15000,
  );

  it.runIf(process.platform !== "win32")(
    "(5) terminates on a self-referencing directory symlink (fs.glob parity)",
    async () => {
      // Cycle termination, resolving case: `self -> .` points at its own containing
      // directory, so `self/self/self/...` resolves indefinitely. fs.glob follows
      // the literal `self` once and the trailing `**` walks the real tree without
      // re-crossing the link; the structural budget must reproduce that finite set
      // instead of recursing forever.
      const workspaceDir = await createWorkspaceDir("self-loop");
      await fs.mkdir(path.join(workspaceDir, "sub"), { recursive: true });
      await fs.writeFile(path.join(workspaceDir, "AGENTS.md"), "root", "utf-8");
      await fs.writeFile(path.join(workspaceDir, "sub", "AGENTS.md"), "sub", "utf-8");
      if (!(await trySymlink(".", path.join(workspaceDir, "self")))) {
        return;
      }

      const pattern = "self/**/AGENTS.md";
      const oracle = await nodeGlobRelative(workspaceDir, pattern);
      await withoutFsGlob(async () => {
        const matches = (await resolveExtraBootstrapPatternPaths(workspaceDir, pattern)).toSorted();
        expect(matches).toStrictEqual(["self/AGENTS.md", "self/sub/AGENTS.md"]);
        expect(matches).toStrictEqual(oracle);
      });
    },
    15000,
  );

  it.runIf(process.platform !== "win32")(
    "(6) walks BOTH aliases pointing at the same target (identity-free cycle guard)",
    async () => {
      // ALIAS DISCRIMINATOR — the arbiter for the cycle guard. `pkg/link-a` and
      // `pkg/link-b` both point at the SAME `target` directory. fs.glob descends
      // both and yields both aliases' files. A visited-realpath-set guard would walk
      // the first alias, mark target's realpath visited, then wrongly SKIP the
      // second — so this test fails under any such guard. The structural budget
      // tracks pattern progress, never realpaths, so both aliases resolve.
      const workspaceDir = await createWorkspaceDir("aliases");
      const pkgDir = path.join(workspaceDir, "pkg");
      const target = path.join(workspaceDir, "target");
      const targetNested = path.join(target, "nested");
      await fs.mkdir(pkgDir, { recursive: true });
      await fs.mkdir(targetNested, { recursive: true });
      await fs.writeFile(path.join(target, "AGENTS.md"), "top", "utf-8");
      await fs.writeFile(path.join(targetNested, "AGENTS.md"), "nested", "utf-8");
      if (!(await trySymlink(path.join("..", "target"), path.join(pkgDir, "link-a")))) {
        return;
      }
      if (!(await trySymlink(path.join("..", "target"), path.join(pkgDir, "link-b")))) {
        return;
      }

      const pattern = "pkg/{link-a,link-b}/**/AGENTS.md";
      const oracle = await nodeGlobRelative(workspaceDir, pattern);
      await withoutFsGlob(async () => {
        const matches = (await resolveExtraBootstrapPatternPaths(workspaceDir, pattern)).toSorted();
        expect(matches).toStrictEqual([
          "pkg/link-a/AGENTS.md",
          "pkg/link-a/nested/AGENTS.md",
          "pkg/link-b/AGENTS.md",
          "pkg/link-b/nested/AGENTS.md",
        ]);
        expect(matches).toStrictEqual(oracle);
        // Both aliases are present — the assertion a visited-realpath guard fails.
        expect(matches.some((m) => m.startsWith("pkg/link-a/"))).toBe(true);
        expect(matches.some((m) => m.startsWith("pkg/link-b/"))).toBe(true);
      });
    },
  );

  it.runIf(process.platform !== "win32")(
    "(7) does not descend a directory deeper than the pattern can ever match (boundedness)",
    async () => {
      // Pruning negative: with a shallow, globstar-free pattern the walk must not
      // read a subtree no match can reach. `pkg/linked/deeper` cannot be a prefix of
      // any `pkg/linked/AGENTS.md` match, so the partial-match gate keeps it off the
      // stack — proven by asserting readdir is never called for that directory.
      const workspaceDir = await createWorkspaceDir("bounded");
      const pkgDir = path.join(workspaceDir, "pkg");
      const target = path.join(workspaceDir, "target");
      const deeper = path.join(target, "deeper");
      await fs.mkdir(pkgDir, { recursive: true });
      await fs.mkdir(deeper, { recursive: true });
      await fs.writeFile(path.join(target, "AGENTS.md"), "top", "utf-8");
      await fs.writeFile(path.join(deeper, "SENTINEL.md"), "never", "utf-8");
      if (!(await trySymlink(path.join("..", "target"), path.join(pkgDir, "linked")))) {
        return;
      }
      // The through-symlink path the descended walk would visit `deeper` under; the
      // walk reads it lexically (readdir follows the final link), never realpathed.
      const deeperViaLink = path.join(workspaceDir, "pkg", "linked", "deeper");

      // Globstar-free pattern: `pkg/linked/deeper` cannot be a prefix of any
      // `*/linked/AGENTS.md` match, so the partial-match gate must prune it.
      const pattern = "*/linked/AGENTS.md";
      const oracle = await nodeGlobRelative(workspaceDir, pattern);
      await withoutFsGlob(async () => {
        const readdirSpy = vi.spyOn(fs, "readdir");
        try {
          const matches = (
            await resolveExtraBootstrapPatternPaths(workspaceDir, pattern)
          ).toSorted();
          expect(matches).toStrictEqual(["pkg/linked/AGENTS.md"]);
          expect(matches).toStrictEqual(oracle);
          // The out-of-pattern subtree was never read: boundedness, not luck.
          const readDeeper = readdirSpy.mock.calls.some(
            (call) => call[0]?.toString() === deeperViaLink,
          );
          expect(readDeeper).toBe(false);
        } finally {
          readdirSpy.mockRestore();
        }
      });
    },
  );

  it.runIf(process.platform !== "win32")(
    "(8) yields a file reached THROUGH a symlinked directory (direct walker proof)",
    async () => {
      // W4 direct proof: the resolver (the fallback walk's only public entry) yields
      // the workspace-relative match for a file that lives behind a directory
      // symlink, so the fix is proven at the walk level, not only through the loader.
      const workspaceDir = await createWorkspaceDir("through-symlink");
      const pkgDir = path.join(workspaceDir, "pkg");
      const target = path.join(workspaceDir, "target");
      await fs.mkdir(pkgDir, { recursive: true });
      await fs.mkdir(target, { recursive: true });
      await fs.writeFile(path.join(target, "AGENTS.md"), "behind-link", "utf-8");
      if (!(await trySymlink(path.join("..", "target"), path.join(pkgDir, "linked")))) {
        return;
      }

      // `linked` is encountered mid-walk (below the "." walk root) as a symlink
      // Dirent, so the descent — not readdir following a walk-root link — is what
      // reaches the file.
      const pattern = "**/pkg/linked/**/AGENTS.md";
      await withoutFsGlob(async () => {
        const matches = await resolveExtraBootstrapPatternPaths(workspaceDir, pattern);
        expect(matches).toStrictEqual(["pkg/linked/AGENTS.md"]);
        // The yielded relative path resolves (through the link) to the real file.
        const resolved = await fs.realpath(path.resolve(workspaceDir, matches[0]!));
        expect(resolved).toBe(await fs.realpath(path.join(target, "AGENTS.md")));
      });
    },
  );

  it.runIf(process.platform !== "win32")(
    "(9) loads a symlinked-directory bootstrap file end-to-end through the loader",
    async () => {
      // Loader boundary: the real resolver + guarded loader the bundled hook calls
      // must load the file behind the symlinked directory and surface no diagnostic,
      // proving the descent reaches the session bootstrap set on a no-fs.glob runtime.
      const workspaceDir = await createWorkspaceDir("loader-boundary");
      const pkgDir = path.join(workspaceDir, "pkg");
      const target = path.join(workspaceDir, "target");
      await fs.mkdir(pkgDir, { recursive: true });
      await fs.mkdir(target, { recursive: true });
      await fs.writeFile(path.join(target, "AGENTS.md"), "linked agents", "utf-8");
      if (!(await trySymlink(path.join("..", "target"), path.join(pkgDir, "linked")))) {
        return;
      }

      await withoutFsGlob(async () => {
        const { files, diagnostics } = await loadExtraBootstrapFilesWithDiagnostics(workspaceDir, [
          "pkg/linked/**/AGENTS.md",
        ]);
        const loaded = files.find((file) => file.path === path.join(pkgDir, "linked", "AGENTS.md"));
        expect(loaded?.content).toBe("linked agents");
        expect(diagnostics).toStrictEqual([]);
      });
    },
  );
});
