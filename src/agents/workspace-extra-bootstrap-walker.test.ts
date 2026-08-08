// Parity tests for the cooperative extra-bootstrap glob walker. These pin the
// walker to Node fs.glob's platform case rules and symlink-descent semantics,
// the two spots where a hand-rolled walker most easily drifts from fs.glob and
// silently drops a configured bootstrap file. Symlink cases compare the walker's
// match set directly against `fs.glob` over the same real tree so the fixtures
// stay anchored to actual Node behavior rather than a transcribed expectation.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  patternHasUnsupportedParentTraversal,
  resolveExtraBootstrapPatternPaths,
} from "./workspace-extra-bootstrap-walker.js";
import { loadExtraBootstrapFilesWithDiagnostics } from "./workspace.js";

const realPlatform = process.platform;

function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, "platform", { value: platform, configurable: true });
}

async function nodeGlobRelative(workspaceDir: string, pattern: string): Promise<string[]> {
  const matches: string[] = [];
  for await (const match of fs.glob(pattern, { cwd: workspaceDir })) {
    matches.push(match.replaceAll(path.sep, "/"));
  }
  return matches.toSorted();
}

describe("resolveExtraBootstrapPatternPaths platform case parity", () => {
  let fixtureRoot = "";
  let fixtureCount = 0;

  const createWorkspaceDir = async (prefix: string) => {
    const dir = path.join(fixtureRoot, `${prefix}-${fixtureCount++}`);
    await fs.mkdir(dir, { recursive: true });
    return dir;
  };

  beforeAll(async () => {
    fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-walker-parity-"));
  });

  afterAll(async () => {
    if (fixtureRoot) {
      await fs.rm(fixtureRoot, { recursive: true, force: true });
    }
  });

  afterEach(() => {
    setPlatform(realPlatform);
  });

  // Node fs.glob builds its Minimatch with `nocase: isWindows || isMacOS` plus
  // `nocaseMagicOnly`, so a case-differing MAGIC segment like `**/*.MD` still
  // matches `AGENTS.md` on macOS/Windows but not on Linux. Without this the
  // walker would silently drop the file on mac/win where fs.glob would have
  // matched it.
  for (const platform of ["darwin", "win32"] as const) {
    it(`matches a case-differing magic segment on ${platform}`, async () => {
      const workspaceDir = await createWorkspaceDir(`nocase-${platform}`);
      await fs.writeFile(path.join(workspaceDir, "AGENTS.md"), "agents", "utf-8");

      setPlatform(platform);
      const matches = await resolveExtraBootstrapPatternPaths(workspaceDir, "**/*.MD", false);

      expect(matches).toStrictEqual(["AGENTS.md"]);
    });
  }

  it("does not match a case-differing magic segment on linux", async () => {
    const workspaceDir = await createWorkspaceDir("nocase-linux");
    await fs.writeFile(path.join(workspaceDir, "AGENTS.md"), "agents", "utf-8");

    setPlatform("linux");
    const matches = await resolveExtraBootstrapPatternPaths(workspaceDir, "**/*.MD", false);

    expect(matches).toStrictEqual([]);
  });

  it("keeps literal path segments case-sensitive even on macOS (nocaseMagicOnly)", async () => {
    // nocase applies only to the magic portion of the pattern; a literal segment
    // must still match byte-for-byte, matching Node. `**/AGENTS.MD` carries a
    // magic `**` (so it routes through the walker) but the literal `AGENTS.MD`
    // must not match the on-disk `AGENTS.md` even where nocase is on, while the
    // fully-magic `**/*.MD` must.
    const workspaceDir = await createWorkspaceDir("literal-case");
    await fs.writeFile(path.join(workspaceDir, "AGENTS.md"), "agents", "utf-8");

    setPlatform("darwin");
    const literalSegment = await resolveExtraBootstrapPatternPaths(
      workspaceDir,
      "**/AGENTS.MD",
      false,
    );
    const magicSegment = await resolveExtraBootstrapPatternPaths(workspaceDir, "**/*.MD", false);

    expect(literalSegment).toStrictEqual([]);
    expect(magicSegment).toStrictEqual(["AGENTS.md"]);
  });

  it("matches Node fs.glob for optimized globstar parent traversal", async () => {
    // Regression: without optimizationLevel: 2 (which Node fs.glob's createMatcher
    // sets) the walk matcher classifies `*/**/../b/AGENTS.md` such that it matches
    // nothing, while real fs.glob returns `a/x/b/AGENTS.md`. Mirroring the option
    // realigns the matcher with fs.glob so a configured bootstrap file is not
    // silently dropped.
    const workspaceDir = await createWorkspaceDir("optimized-parent");
    await fs.mkdir(path.join(workspaceDir, "a", "x", "b"), { recursive: true });
    await fs.writeFile(path.join(workspaceDir, "a", "x", "b", "AGENTS.md"), "agents", "utf-8");

    const pattern = "*/**/../b/AGENTS.md";
    const matches = (
      await resolveExtraBootstrapPatternPaths(workspaceDir, pattern, false)
    ).toSorted();

    expect(matches).toStrictEqual(["a/x/b/AGENTS.md"]);
    expect(matches).toStrictEqual(await nodeGlobRelative(workspaceDir, pattern));
  });
});

describe("resolveExtraBootstrapPatternPaths parent-traversal parity and diagnostics", () => {
  let fixtureRoot = "";
  let fixtureCount = 0;

  const createWorkspaceDir = async (prefix: string) => {
    const dir = path.join(fixtureRoot, `${prefix}-${fixtureCount++}`);
    await fs.mkdir(dir, { recursive: true });
    return dir;
  };

  beforeAll(async () => {
    // realpath the root so relative-path comparisons hold on macOS, where
    // os.tmpdir() is a /var -> /private/var symlink the loader canonicalizes.
    fixtureRoot = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-walker-parent-")),
    );
  });

  afterAll(async () => {
    if (fixtureRoot) {
      await fs.rm(fixtureRoot, { recursive: true, force: true });
    }
  });

  // A small tree with a root AGENTS.md plus `a/AGENTS.md` under a subdir, so the
  // reducible parent-traversal shapes have real targets to resolve against.
  const seedTree = async (prefix: string): Promise<string> => {
    const workspaceDir = await createWorkspaceDir(prefix);
    await fs.mkdir(path.join(workspaceDir, "a", "x"), { recursive: true });
    await fs.mkdir(path.join(workspaceDir, "foo"), { recursive: true });
    await fs.writeFile(path.join(workspaceDir, "AGENTS.md"), "root", "utf-8");
    await fs.writeFile(path.join(workspaceDir, "a", "AGENTS.md"), "a", "utf-8");
    return workspaceDir;
  };

  const loaderRelative = async (workspaceDir: string, pattern: string): Promise<string[]> => {
    const { files } = await loadExtraBootstrapFilesWithDiagnostics(workspaceDir, [pattern]);
    return files
      .map((file) => path.relative(workspaceDir, file.path).replaceAll(path.sep, "/"))
      .toSorted();
  };

  it("matches Node fs.glob for reducible parent-traversal shapes", async () => {
    // optimizationLevel 2 collapses `*/../`, `a/*/../`, and literal `foo/../` into a
    // downward form, so the observable loader result equals fs.glob's set. These
    // are the parent-traversal shapes the walker fully supports.
    for (const pattern of ["*/../AGENTS.md", "a/*/../AGENTS.md", "foo/../AGENTS.md"]) {
      const workspaceDir = await seedTree("supported");
      expect(await loaderRelative(workspaceDir, pattern)).toStrictEqual(
        await nodeGlobRelative(workspaceDir, pattern),
      );
      expect(patternHasUnsupportedParentTraversal(pattern)).toBe(false);
    }
  });

  it("records an unsupported-pattern diagnostic for a globstar parent traversal", async () => {
    // `**/../` cannot be reduced to a downward walk (fs.glob steps up a level; this
    // matcher-only walk cannot), so the walker would silently return []. The loader
    // must surface an explicit diagnostic instead of dropping the configured
    // pattern without a trace.
    for (const pattern of ["**/../AGENTS.md", "x/**/../AGENTS.md"]) {
      const workspaceDir = await seedTree("unsupported");
      expect(patternHasUnsupportedParentTraversal(pattern)).toBe(true);
      const { files, diagnostics } = await loadExtraBootstrapFilesWithDiagnostics(workspaceDir, [
        pattern,
      ]);
      expect(files).toHaveLength(0);
      expect(diagnostics.map((diagnostic) => diagnostic.reason)).toContain("unsupported-pattern");
    }
  });
});

describe("resolveExtraBootstrapPatternPaths symlink descent parity", () => {
  let fixtureRoot = "";
  let fixtureCount = 0;

  const createWorkspaceDir = async (prefix: string) => {
    const dir = path.join(fixtureRoot, `${prefix}-${fixtureCount++}`);
    await fs.mkdir(dir, { recursive: true });
    return dir;
  };

  const trySymlink = async (target: string, linkPath: string): Promise<boolean> => {
    try {
      await fs.symlink(target, linkPath, "dir");
      return true;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code ?? "";
      if (["EPERM", "EACCES", "ENOSYS"].includes(code)) {
        return false;
      }
      throw err;
    }
  };

  beforeAll(async () => {
    fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-walker-symlink-"));
  });

  afterAll(async () => {
    if (fixtureRoot) {
      await fs.rm(fixtureRoot, { recursive: true, force: true });
    }
  });

  it.runIf(process.platform !== "win32")(
    "follows a literal symlink reached via a literal segment after a ** prefix",
    async () => {
      // Regression (P1-B): `linked` is a directory symlink named literally in the
      // pattern and reached through the literal `pkg`, itself after `**`. fs.glob
      // descends it; the old walker over-rejected any symlink once a `**` sat
      // earlier in the pattern, silently dropping these matches.
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
      const matches = (
        await resolveExtraBootstrapPatternPaths(workspaceDir, pattern, false)
      ).toSorted();

      expect(matches).toStrictEqual(["pkg/linked/AGENTS.md", "pkg/linked/nested/AGENTS.md"]);
      // Anchor to real fs.glob over the same tree.
      expect(matches).toStrictEqual(await nodeGlobRelative(workspaceDir, pattern));
    },
  );

  it.runIf(process.platform !== "win32")(
    "follows a chain of literal symlinks after a ** prefix",
    async () => {
      // fs.glob follows symlink-then-symlink as long as each link's segment is a
      // literal reached without a `**` directly consuming it.
      const workspaceDir = await createWorkspaceDir("literal-chain");
      const pkgDir = path.join(workspaceDir, "pkg");
      const tgtA = path.join(workspaceDir, "tgtA");
      const tgtB = path.join(workspaceDir, "tgtB");
      const tgtBNested = path.join(tgtB, "nested");
      await fs.mkdir(pkgDir, { recursive: true });
      await fs.mkdir(tgtA, { recursive: true });
      await fs.mkdir(tgtBNested, { recursive: true });
      await fs.writeFile(path.join(tgtB, "AGENTS.md"), "b", "utf-8");
      await fs.writeFile(path.join(tgtBNested, "AGENTS.md"), "bn", "utf-8");
      if (!(await trySymlink(path.join("..", "tgtA"), path.join(pkgDir, "lnkA")))) {
        return;
      }
      if (!(await trySymlink(path.join("..", "tgtB"), path.join(tgtA, "lnkB")))) {
        return;
      }

      const pattern = "**/pkg/lnkA/lnkB/**/AGENTS.md";
      const matches = (
        await resolveExtraBootstrapPatternPaths(workspaceDir, pattern, false)
      ).toSorted();

      expect(matches).toStrictEqual(["pkg/lnkA/lnkB/AGENTS.md", "pkg/lnkA/lnkB/nested/AGENTS.md"]);
      expect(matches).toStrictEqual(await nodeGlobRelative(workspaceDir, pattern));
    },
  );

  it.runIf(process.platform !== "win32")(
    "keeps a symlink directly after ** terminal (wildcard-reached)",
    async () => {
      // A literal segment sitting DIRECTLY after `**` is still wildcard-reached:
      // fs.glob does not descend it. Here `wl` is a symlink and `**/wl/**` yields
      // nothing through the link (the real target is matched separately by the
      // broad pattern, not via the link path).
      const workspaceDir = await createWorkspaceDir("recursive-reached");
      const realDir = path.join(workspaceDir, "real");
      const linkTarget = path.join(workspaceDir, "linktarget");
      await fs.mkdir(realDir, { recursive: true });
      await fs.mkdir(linkTarget, { recursive: true });
      await fs.writeFile(path.join(linkTarget, "AGENTS.md"), "tgt", "utf-8");
      if (!(await trySymlink(path.join("..", "linktarget"), path.join(realDir, "wl")))) {
        return;
      }

      const pattern = "**/wl/**/AGENTS.md";
      const matches = (
        await resolveExtraBootstrapPatternPaths(workspaceDir, pattern, false)
      ).toSorted();

      expect(matches).toStrictEqual([]);
      expect(matches).toStrictEqual(await nodeGlobRelative(workspaceDir, pattern));
    },
  );

  it.runIf(process.platform !== "win32")(
    "does not follow a symlink whose own segment is matched by a wildcard",
    async () => {
      // `base/*/AGENTS.md`: the symlink `blink` is matched by `*`, not a literal,
      // so fs.glob does not descend it.
      const workspaceDir = await createWorkspaceDir("wildcard-own-segment");
      const baseDir = path.join(workspaceDir, "base");
      const target = path.join(workspaceDir, "tgt");
      await fs.mkdir(baseDir, { recursive: true });
      await fs.mkdir(target, { recursive: true });
      await fs.writeFile(path.join(target, "AGENTS.md"), "tgt", "utf-8");
      if (!(await trySymlink(path.join("..", "tgt"), path.join(baseDir, "blink")))) {
        return;
      }

      const pattern = "base/*/AGENTS.md";
      const matches = (
        await resolveExtraBootstrapPatternPaths(workspaceDir, pattern, false)
      ).toSorted();

      expect(matches).toStrictEqual([]);
      expect(matches).toStrictEqual(await nodeGlobRelative(workspaceDir, pattern));
    },
  );

  it.runIf(process.platform !== "win32")(
    "follows a contained ancestor-pointing symlink once (fs.glob parity)",
    async () => {
      // FIX 2: `pkg/loop -> pkg` is a contained ancestor-pointing directory symlink
      // named literally in `*/loop/**`. fs.glob follows it once; the walker now
      // matches that instead of over-rejecting it via a realpath cycle guard.
      // Termination is structural: `**` never re-crosses the symlink, so the loop
      // is followed only as many times as the pattern names it literally.
      const workspaceDir = await createWorkspaceDir("ancestor-follow-once");
      const pkgDir = path.join(workspaceDir, "pkg");
      await fs.mkdir(pkgDir, { recursive: true });
      await fs.writeFile(path.join(pkgDir, "AGENTS.md"), "pkg", "utf-8");
      if (!(await trySymlink(pkgDir, path.join(pkgDir, "loop")))) {
        return;
      }

      const pattern = "*/loop/**/AGENTS.md";
      const matches = (
        await resolveExtraBootstrapPatternPaths(workspaceDir, pattern, false)
      ).toSorted();

      expect(matches).toStrictEqual(["pkg/loop/AGENTS.md"]);
      expect(matches).toStrictEqual(await nodeGlobRelative(workspaceDir, pattern));
    },
    15000,
  );

  it.runIf(process.platform !== "win32")(
    "follows a self-referential symlink to the workspace root once (fs.glob parity)",
    async () => {
      // `self -> <workspace root>` named literally in `self/**`: fs.glob follows the
      // link once and `**` then walks the real tree without re-crossing `self`.
      const workspaceDir = await createWorkspaceDir("self-loop");
      await fs.mkdir(path.join(workspaceDir, "sub"), { recursive: true });
      await fs.writeFile(path.join(workspaceDir, "AGENTS.md"), "root", "utf-8");
      await fs.writeFile(path.join(workspaceDir, "sub", "AGENTS.md"), "sub", "utf-8");
      if (!(await trySymlink(workspaceDir, path.join(workspaceDir, "self")))) {
        return;
      }

      const pattern = "self/**/AGENTS.md";
      const matches = (
        await resolveExtraBootstrapPatternPaths(workspaceDir, pattern, false)
      ).toSorted();

      expect(matches).toStrictEqual(["self/AGENTS.md", "self/sub/AGENTS.md"]);
      expect(matches).toStrictEqual(await nodeGlobRelative(workspaceDir, pattern));
    },
    15000,
  );

  it.runIf(process.platform !== "win32")(
    "terminates on an adversarial ancestor loop without a cycle guard",
    async () => {
      // Adversarial termination: `loop -> .` (the workspace root) is a contained
      // self-loop. With the realpath cycle guard removed, termination must be
      // structural — `**` never crosses the symlink, and a literal loop chain names
      // it only finitely. Completing at all within the bounded timeout is the
      // proof; `**/AGENTS.md` additionally holds fs.glob parity.
      const workspaceDir = await createWorkspaceDir("adversarial-loop");
      await fs.mkdir(path.join(workspaceDir, "a"), { recursive: true });
      await fs.writeFile(path.join(workspaceDir, "AGENTS.md"), "root", "utf-8");
      await fs.writeFile(path.join(workspaceDir, "a", "AGENTS.md"), "a", "utf-8");
      if (!(await trySymlink(workspaceDir, path.join(workspaceDir, "loop")))) {
        return;
      }

      const recursive = "**/AGENTS.md";
      expect(
        (await resolveExtraBootstrapPatternPaths(workspaceDir, recursive, false)).toSorted(),
      ).toStrictEqual(await nodeGlobRelative(workspaceDir, recursive));

      // A literal chain naming the loop repeatedly must also terminate; completing
      // is the assertion (the deleted guard existed only to force termination).
      await expect(
        resolveExtraBootstrapPatternPaths(workspaceDir, "loop/loop/loop/**/AGENTS.md", false),
      ).resolves.toBeDefined();
    },
    15000,
  );

  it.runIf(process.platform !== "win32")(
    "does not let a leading ** re-cross a contained ancestor symlink",
    async () => {
      // Regression: `a/link -> ..` is a contained ancestor-pointing symlink named
      // by the literal `link` after `**`. fs.glob follows it once (globstar never
      // traverses INTO a symlink), yielding two matches. The walker must not let
      // the leading `**` absorb the `a/link` crossing to re-align the literal on
      // every pass — that produced a deep bogus match set bounded only by the OS
      // symlink limit (platform-dependent, non-deterministic) rather than the
      // pattern structure.
      const workspaceDir = await createWorkspaceDir("leading-star-ancestor");
      await fs.mkdir(path.join(workspaceDir, "a"), { recursive: true });
      await fs.writeFile(path.join(workspaceDir, "AGENTS.md"), "root", "utf-8");
      await fs.writeFile(path.join(workspaceDir, "a", "AGENTS.md"), "a", "utf-8");
      if (!(await trySymlink(path.join("..", ""), path.join(workspaceDir, "a", "link")))) {
        return;
      }

      const pattern = "**/a/link/**/AGENTS.md";
      const matches = (
        await resolveExtraBootstrapPatternPaths(workspaceDir, pattern, false)
      ).toSorted();

      expect(matches).toStrictEqual(["a/link/AGENTS.md", "a/link/a/AGENTS.md"]);
      expect(matches).toStrictEqual(await nodeGlobRelative(workspaceDir, pattern));
    },
    15000,
  );

  it.runIf(process.platform !== "win32")(
    "refuses a literal symlink whose target escapes the workspace",
    async () => {
      // Containment guard: fs.glob would follow an in-pattern literal symlink even
      // out of the tree; the walker refuses any link whose realpath leaves the
      // workspace so out-of-tree bootstrap content never enters the prompt.
      const rootDir = await createWorkspaceDir("escape-root");
      const workspaceDir = path.join(rootDir, "workspace");
      const outsideDir = path.join(rootDir, "outside");
      const pkgDir = path.join(workspaceDir, "pkg");
      await fs.mkdir(pkgDir, { recursive: true });
      await fs.mkdir(outsideDir, { recursive: true });
      await fs.writeFile(path.join(outsideDir, "AGENTS.md"), "outside", "utf-8");
      if (!(await trySymlink(path.join("..", "..", "outside"), path.join(pkgDir, "linked")))) {
        return;
      }

      const matches = await resolveExtraBootstrapPatternPaths(
        workspaceDir,
        "**/pkg/linked/**/AGENTS.md",
        false,
      );

      expect(matches).toStrictEqual([]);
    },
  );

  it.runIf(process.platform !== "win32")(
    "refuses an initial walk root that is a directory symlink escaping the workspace",
    async () => {
      // Containment guard for the seed/initial root (P1-E): when a pattern's
      // literal prefix is itself a directory symlink pointing outside the
      // workspace, the seed frame never passes through resolveSymlinkDescent, so
      // the walker must reject the external initial root before any readdir.
      const rootDir = await createWorkspaceDir("escape-initial-root");
      const workspaceDir = path.join(rootDir, "workspace");
      const outsideDir = path.join(rootDir, "outside");
      await fs.mkdir(workspaceDir, { recursive: true });
      await fs.mkdir(outsideDir, { recursive: true });
      await fs.writeFile(path.join(outsideDir, "AGENTS.md"), "outside", "utf-8");
      const linkPath = path.join(workspaceDir, "outside-link");
      if (!(await trySymlink(path.join("..", "outside"), linkPath))) {
        return;
      }
      const outsideRealpath = await fs.realpath(outsideDir);

      const readdirSpy = vi.spyOn(fs, "readdir");
      try {
        const matches = await resolveExtraBootstrapPatternPaths(
          workspaceDir,
          "outside-link/**/AGENTS.md",
          false,
        );

        expect(matches).toStrictEqual([]);
        // The reject must happen before any readdir of the escaped root, not as a
        // later per-file guard: prove readdir never touched the link or its target.
        for (const call of readdirSpy.mock.calls) {
          const readPath = call[0] as string;
          expect(readPath).not.toBe(linkPath);
          expect(readPath).not.toBe(outsideDir);
          expect(readPath).not.toBe(outsideRealpath);
        }
      } finally {
        readdirSpy.mockRestore();
      }
    },
  );

  it.runIf(process.platform !== "win32")(
    "follows a literal brace-alternative symlink (per-expansion alignment)",
    async () => {
      // Regression (P1): `pkg/{linked,other}/**/AGENTS.md` expands in Node's
      // globber to literal `linked` and `other` alternatives, so a `pkg/linked`
      // dir symlink is named by a literal and followed. Classifying the raw
      // `{linked,other}` segment as magic left the symlink terminal and dropped
      // these matches; expanding braces per-alternative restores descent.
      const workspaceDir = await createWorkspaceDir("brace-alt-literal");
      const pkgDir = path.join(workspaceDir, "pkg");
      const otherDir = path.join(pkgDir, "other");
      const target = path.join(workspaceDir, "target");
      const targetNested = path.join(target, "nested");
      await fs.mkdir(otherDir, { recursive: true });
      await fs.mkdir(targetNested, { recursive: true });
      await fs.writeFile(path.join(target, "AGENTS.md"), "top", "utf-8");
      await fs.writeFile(path.join(targetNested, "AGENTS.md"), "nested", "utf-8");
      await fs.writeFile(path.join(otherDir, "AGENTS.md"), "other", "utf-8");
      if (!(await trySymlink(path.join("..", "target"), path.join(pkgDir, "linked")))) {
        return;
      }

      const pattern = "pkg/{linked,other}/**/AGENTS.md";
      const matches = (
        await resolveExtraBootstrapPatternPaths(workspaceDir, pattern, false)
      ).toSorted();

      expect(matches).toStrictEqual([
        "pkg/linked/AGENTS.md",
        "pkg/linked/nested/AGENTS.md",
        "pkg/other/AGENTS.md",
      ]);
      expect(matches).toStrictEqual(await nodeGlobRelative(workspaceDir, pattern));
    },
  );

  it.runIf(process.platform !== "win32")(
    "keeps a brace-alternative wildcard-reached symlink terminal",
    async () => {
      // `pkg/{*,other}/AGENTS.md`: the `*` alternative reaches the `pkg/linked`
      // symlink by wildcard (descent refused) and the `other` alternative does
      // not name it, so no expansion follows the link.
      const workspaceDir = await createWorkspaceDir("brace-alt-wildcard");
      const pkgDir = path.join(workspaceDir, "pkg");
      const target = path.join(workspaceDir, "target");
      await fs.mkdir(pkgDir, { recursive: true });
      await fs.mkdir(target, { recursive: true });
      await fs.writeFile(path.join(target, "AGENTS.md"), "tgt", "utf-8");
      if (!(await trySymlink(path.join("..", "target"), path.join(pkgDir, "linked")))) {
        return;
      }

      const pattern = "pkg/{*,other}/AGENTS.md";
      const matches = (
        await resolveExtraBootstrapPatternPaths(workspaceDir, pattern, false)
      ).toSorted();

      expect(matches).toStrictEqual([]);
      expect(matches).toStrictEqual(await nodeGlobRelative(workspaceDir, pattern));
    },
  );

  it.runIf(process.platform !== "win32")(
    "follows a cross-slash brace alternative that names the symlink via a literal prefix",
    async () => {
      // `{**/linked,pkg/linked}/**/AGENTS.md`: the `**/linked` alternative reaches
      // `pkg/linked` directly after `**` (wildcard-reached, refused) but the
      // `pkg/linked` alternative names it via literal `pkg`, so descent is allowed
      // through that expansion. Pins per-expansion ** taint under OR-combining.
      const workspaceDir = await createWorkspaceDir("brace-alt-crossslash-follow");
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

      const pattern = "{**/linked,pkg/linked}/**/AGENTS.md";
      const matches = (
        await resolveExtraBootstrapPatternPaths(workspaceDir, pattern, false)
      ).toSorted();

      expect(matches).toStrictEqual(["pkg/linked/AGENTS.md", "pkg/linked/nested/AGENTS.md"]);
      expect(matches).toStrictEqual(await nodeGlobRelative(workspaceDir, pattern));
    },
  );

  it.runIf(process.platform !== "win32")(
    "does not follow a cross-slash brace alternative when every expansion is **-tainted or misses",
    async () => {
      // `{**/linked,other}/**/AGENTS.md`: `**/linked` reaches `pkg/linked` directly
      // after `**` (wildcard-reached, refused) and `other` never names it, so no
      // expansion follows the link. Confirms OR-combining does not leak descent
      // from a **-tainted alternative.
      const workspaceDir = await createWorkspaceDir("brace-alt-crossslash-refuse");
      const pkgDir = path.join(workspaceDir, "pkg");
      const target = path.join(workspaceDir, "target");
      await fs.mkdir(pkgDir, { recursive: true });
      await fs.mkdir(target, { recursive: true });
      await fs.writeFile(path.join(target, "AGENTS.md"), "tgt", "utf-8");
      if (!(await trySymlink(path.join("..", "target"), path.join(pkgDir, "linked")))) {
        return;
      }

      const pattern = "{**/linked,other}/**/AGENTS.md";
      const matches = (
        await resolveExtraBootstrapPatternPaths(workspaceDir, pattern, false)
      ).toSorted();

      expect(matches).toStrictEqual([]);
      expect(matches).toStrictEqual(await nodeGlobRelative(workspaceDir, pattern));
    },
  );
});
