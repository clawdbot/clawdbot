// Behavior tests for fs.glob-backed extra-bootstrap pattern resolution. The
// resolver delegates matching to Node fs.glob and only adds a workspace
// realpath-containment filter, so these cases compare the resolver's match set
// directly against `fs.glob` over the same real tree (the parity oracle) and pin
// the two places the containment filter must diverge from fs.glob: a match whose
// realpath escapes the workspace, and a literal-named symlink pointing outside.
// A final block covers the fs.glob-absent capability fallback (runtimes without
// fs.promises.glob), where matching runs through the local Minimatch walk.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { isPathInside } from "../infra/path-guards.js";
import {
  resolveExtraBootstrapPatternPaths,
  toPortableMatchPath,
} from "./workspace-extra-bootstrap-walker.js";
import { loadExtraBootstrapFilesWithDiagnostics } from "./workspace.js";

async function nodeGlobRelative(workspaceDir: string, pattern: string): Promise<string[]> {
  const matches: string[] = [];
  for await (const match of fs.glob(pattern, { cwd: workspaceDir })) {
    matches.push(match.replaceAll(path.sep, "/"));
  }
  return matches.toSorted();
}

describe("resolveExtraBootstrapPatternPaths glob semantics", () => {
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

  it("matches Node fs.glob for optimized globstar parent traversal", async () => {
    // `*/**/../b/AGENTS.md` is a reducible parent-traversal shape fs.glob resolves
    // to `a/x/b/AGENTS.md`; delegating to fs.glob returns the same set with no
    // matcher plumbing to keep in sync.
    const workspaceDir = await createWorkspaceDir("optimized-parent");
    await fs.mkdir(path.join(workspaceDir, "a", "x", "b"), { recursive: true });
    await fs.writeFile(path.join(workspaceDir, "a", "x", "b", "AGENTS.md"), "agents", "utf-8");

    const pattern = "*/**/../b/AGENTS.md";
    const matches = (await resolveExtraBootstrapPatternPaths(workspaceDir, pattern)).toSorted();

    expect(matches).toStrictEqual(["a/x/b/AGENTS.md"]);
    expect(matches).toStrictEqual(await nodeGlobRelative(workspaceDir, pattern));
  });
});

describe("resolveExtraBootstrapPatternPaths parent-traversal parity", () => {
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

  // fs.glob's globstar-parent `..` can step above the cwd (`**/../AGENTS.md`
  // matches the workspace root's own parent when the zero-globstar case pops out
  // of the tree). The walker prunes those escaping matches for containment, so the
  // parity oracle is fs.glob's set restricted to entries that stay inside the
  // workspace — anything the walker is allowed to return.
  const nodeGlobContained = async (workspaceDir: string, pattern: string): Promise<string[]> => {
    const contained: string[] = [];
    for await (const match of fs.glob(pattern, { cwd: workspaceDir })) {
      const rel = match.replaceAll(path.sep, "/");
      if (rel !== ".." && !rel.startsWith("../")) {
        contained.push(rel);
      }
    }
    return contained.toSorted();
  };

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
    // downward form, so the observable loader result equals fs.glob's set.
    for (const pattern of ["*/../AGENTS.md", "a/*/../AGENTS.md", "foo/../AGENTS.md"]) {
      const workspaceDir = await seedTree("supported");
      expect(await loaderRelative(workspaceDir, pattern)).toStrictEqual(
        await nodeGlobRelative(workspaceDir, pattern),
      );
    }
  });

  it("returns Node fs.glob's contained match set for a globstar parent traversal", async () => {
    // FINDING A: `**/../AGENTS.md` and similar globstar-parent patterns are a
    // supported fs.glob shape — Node steps up a level and returns the contained
    // matches (`AGENTS.md`, `a/AGENTS.md` here). The walker must resolve the same
    // in-root set instead of declaring the pattern unsupported and dropping every
    // configured bootstrap file. Differential: the walker's set equals fs.glob's,
    // restricted to matches that stay inside the workspace.
    // Deepen the seed so a globstar parent has more than one contained target and
    // the parity is meaningful.
    for (const pattern of ["**/../AGENTS.md", "x/**/../AGENTS.md", "**/../a/AGENTS.md"]) {
      const workspaceDir = await seedTree("globstar-parent");
      const deep = path.join(workspaceDir, "a", "x", "deep");
      await fs.mkdir(deep, { recursive: true });
      await fs.writeFile(path.join(workspaceDir, "a", "x", "AGENTS.md"), "ax", "utf-8");

      const walkerMatches = (
        await resolveExtraBootstrapPatternPaths(workspaceDir, pattern)
      ).toSorted();
      const contained = await nodeGlobContained(workspaceDir, pattern);

      expect(walkerMatches).toStrictEqual(contained);
    }
  });

  it("matches Node fs.glob for globstar-parent leaf directories (parity lock)", async () => {
    // Parity lock for the globstar-parent leaf case. Node fs.glob only reaches a
    // parent-directory AGENTS.md by descending into a CHILD of that directory and
    // popping back up, so a leaf directory with no child dir is NOT the source of a
    // match: the globstar has nothing to descend, `**/..` never lands on the leaf,
    // and the leaf's own AGENTS.md is omitted. These guard against a future
    // "current-directory continuation" that would add the wrong superset
    // (`leaf/AGENTS.md`) and diverge from fs.glob.

    // Tree A: root AGENTS.md + a childless leaf dir. fs.glob yields only the root
    // file; the leaf's own AGENTS.md is omitted.
    const treeA = await createWorkspaceDir("f1-leaf-with-root");
    await fs.mkdir(path.join(treeA, "leaf"), { recursive: true });
    await fs.writeFile(path.join(treeA, "AGENTS.md"), "root", "utf-8");
    await fs.writeFile(path.join(treeA, "leaf", "AGENTS.md"), "leaf", "utf-8");
    const walkerA = (await resolveExtraBootstrapPatternPaths(treeA, "**/../AGENTS.md")).toSorted();
    expect(walkerA).toStrictEqual(["AGENTS.md"]);
    expect(walkerA).toStrictEqual(await nodeGlobContained(treeA, "**/../AGENTS.md"));

    // Tree B: only a childless leaf dir, no root file. Nothing to pop up to, so the
    // in-root match set is empty.
    const treeB = await createWorkspaceDir("f1-leaf-no-root");
    await fs.mkdir(path.join(treeB, "leaf"), { recursive: true });
    await fs.writeFile(path.join(treeB, "leaf", "AGENTS.md"), "leaf", "utf-8");
    const walkerB = (await resolveExtraBootstrapPatternPaths(treeB, "**/../AGENTS.md")).toSorted();
    expect(walkerB).toStrictEqual([]);
    expect(walkerB).toStrictEqual(await nodeGlobContained(treeB, "**/../AGENTS.md"));

    // Tree C: root + `sub` with its own child dir. `sub` is a reachable parent (via
    // `sub/child` popping) and root is reached via `sub` popping, so both AGENTS.md
    // files match; `sub/child/AGENTS.md` stays omitted because `child` is itself a
    // childless leaf.
    const treeC = await createWorkspaceDir("f1-child-bearing");
    await fs.mkdir(path.join(treeC, "sub", "child"), { recursive: true });
    await fs.writeFile(path.join(treeC, "AGENTS.md"), "root", "utf-8");
    await fs.writeFile(path.join(treeC, "sub", "AGENTS.md"), "sub", "utf-8");
    await fs.writeFile(path.join(treeC, "sub", "child", "AGENTS.md"), "child", "utf-8");
    const walkerC = (await resolveExtraBootstrapPatternPaths(treeC, "**/../AGENTS.md")).toSorted();
    expect(walkerC).toStrictEqual(["AGENTS.md", "sub/AGENTS.md"]);
    expect(walkerC).toStrictEqual(await nodeGlobContained(treeC, "**/../AGENTS.md"));
  });

  it("prunes a globstar parent traversal that only escapes the workspace", async () => {
    // The contained-parent walk still enforces the workspace boundary: a globstar
    // parent whose only fs.glob matches sit above the root (via the zero-globstar
    // pop) must resolve to nothing rather than leak an out-of-tree file, even
    // though fs.glob itself would return the escaping path.
    const rootDir = await createWorkspaceDir("escape-only");
    const workspaceDir = path.join(rootDir, "workspace");
    await fs.mkdir(path.join(workspaceDir, "only"), { recursive: true });
    // The single AGENTS.md lives in the workspace's PARENT; `*/../AGENTS.md` reduces
    // to a downward walk that cannot reach it, and `**/../AGENTS.md`'s only match is
    // the escaping parent pop, so both must be empty.
    await fs.writeFile(path.join(rootDir, "AGENTS.md"), "outside", "utf-8");

    const matches = await resolveExtraBootstrapPatternPaths(workspaceDir, "**/../AGENTS.md");

    expect(matches).toStrictEqual([]);
    // fs.glob would surface the escaping parent match; the walker must not.
    expect(await nodeGlobRelative(workspaceDir, "**/../AGENTS.md")).toContain("../AGENTS.md");
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
      const matches = (await resolveExtraBootstrapPatternPaths(workspaceDir, pattern)).toSorted();

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
      const matches = (await resolveExtraBootstrapPatternPaths(workspaceDir, pattern)).toSorted();

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
      const matches = (await resolveExtraBootstrapPatternPaths(workspaceDir, pattern)).toSorted();

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
      const matches = (await resolveExtraBootstrapPatternPaths(workspaceDir, pattern)).toSorted();

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
      const matches = (await resolveExtraBootstrapPatternPaths(workspaceDir, pattern)).toSorted();

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
      const matches = (await resolveExtraBootstrapPatternPaths(workspaceDir, pattern)).toSorted();

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
        (await resolveExtraBootstrapPatternPaths(workspaceDir, recursive)).toSorted(),
      ).toStrictEqual(await nodeGlobRelative(workspaceDir, recursive));

      // A literal chain naming the loop repeatedly must also terminate; completing
      // is the assertion (the deleted guard existed only to force termination).
      await expect(
        resolveExtraBootstrapPatternPaths(workspaceDir, "loop/loop/loop/**/AGENTS.md"),
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
      const matches = (await resolveExtraBootstrapPatternPaths(workspaceDir, pattern)).toSorted();

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
      );

      expect(matches).toStrictEqual([]);
    },
  );

  it.runIf(process.platform !== "win32")(
    "refuses an initial walk root that is a directory symlink escaping the workspace",
    async () => {
      // Containment guard for a pattern whose literal prefix is itself a directory
      // symlink pointing outside the workspace: fs.glob would follow the link, but
      // the realpath filter drops every match whose canonical path escapes the
      // workspace, so the resolver returns nothing. (The loader additionally
      // rejects this pattern up front via patternWalkRootStaysInWorkspace, surfacing
      // a security diagnostic — see workspace.load-extra-bootstrap-files.test.ts.)
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

      const matches = await resolveExtraBootstrapPatternPaths(
        workspaceDir,
        "outside-link/**/AGENTS.md",
      );

      expect(matches).toStrictEqual([]);
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
      const matches = (await resolveExtraBootstrapPatternPaths(workspaceDir, pattern)).toSorted();

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
      const matches = (await resolveExtraBootstrapPatternPaths(workspaceDir, pattern)).toSorted();

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
      const matches = (await resolveExtraBootstrapPatternPaths(workspaceDir, pattern)).toSorted();

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
      const matches = (await resolveExtraBootstrapPatternPaths(workspaceDir, pattern)).toSorted();

      expect(matches).toStrictEqual([]);
      expect(matches).toStrictEqual(await nodeGlobRelative(workspaceDir, pattern));
    },
  );

  it.runIf(process.platform !== "win32")(
    "does not follow a wildcard-reached symlink in a globstar-parent pattern",
    async () => {
      // The contained-parent walk must apply the same symlink rule as the downward
      // walk: fs.glob never follows a symlink reached through a `*`/`**` wildcard, so
      // `*/**/../AGENTS.md` where `sl` is a symlink must resolve to fs.glob's set
      // (nothing here) rather than crossing the link and matching under its target.
      const workspaceDir = await createWorkspaceDir("parent-wildcard-symlink");
      const target = path.join(workspaceDir, "target");
      await fs.mkdir(path.join(target, "sub"), { recursive: true });
      await fs.writeFile(path.join(target, "AGENTS.md"), "tgt", "utf-8");
      if (!(await trySymlink(path.join(".", "target"), path.join(workspaceDir, "sl")))) {
        return;
      }

      const pattern = "*/**/../AGENTS.md";
      const matches = (await resolveExtraBootstrapPatternPaths(workspaceDir, pattern)).toSorted();

      expect(matches).toStrictEqual(await nodeGlobRelative(workspaceDir, pattern));
    },
  );

  it.runIf(process.platform !== "win32")(
    "does not escape the workspace via a literal symlink in a globstar-parent pattern",
    async () => {
      // A literal-named directory symlink pointing OUTSIDE the workspace must not be
      // followed by the contained-parent walk, even though fs.glob would descend a
      // literal symlink: the walker enforces the workspace boundary fs.glob does not,
      // exactly as the downward walk's resolveSymlinkDescent does.
      const rootDir = await createWorkspaceDir("parent-literal-escape");
      const workspaceDir = path.join(rootDir, "workspace");
      const external = path.join(rootDir, "external");
      await fs.mkdir(path.join(external, "sub"), { recursive: true });
      await fs.writeFile(path.join(external, "AGENTS.md"), "outside", "utf-8");
      await fs.mkdir(workspaceDir, { recursive: true });
      if (!(await trySymlink(external, path.join(workspaceDir, "link")))) {
        return;
      }
      const workspaceReal = await fs.realpath(workspaceDir);

      const matches = await resolveExtraBootstrapPatternPaths(workspaceDir, "link/**/../AGENTS.md");

      expect(matches).toStrictEqual([]);
      // No returned path may resolve outside the workspace root.
      for (const match of matches) {
        const resolved = await fs.realpath(path.resolve(workspaceDir, match));
        expect(isPathInside(workspaceReal, resolved)).toBe(true);
      }
      // fs.glob itself would follow the literal link and surface the escaping match;
      // the walker intentionally diverges to hold containment.
      expect(await nodeGlobRelative(workspaceDir, "link/**/../AGENTS.md")).toContain(
        "link/AGENTS.md",
      );
    },
  );

  it.runIf(process.platform !== "win32")(
    "follows a contained literal symlink in a globstar-parent pattern (parity)",
    async () => {
      // The containment guard must not over-prune: a literal-named symlink whose
      // target stays inside the workspace is still followed, matching fs.glob's
      // contained set so a legitimately configured bootstrap file is not dropped.
      const workspaceDir = await createWorkspaceDir("parent-literal-contained");
      const real = path.join(workspaceDir, "real");
      await fs.mkdir(path.join(real, "sub"), { recursive: true });
      await fs.writeFile(path.join(real, "AGENTS.md"), "inside", "utf-8");
      if (!(await trySymlink(path.join(".", "real"), path.join(workspaceDir, "link")))) {
        return;
      }

      const pattern = "link/**/../AGENTS.md";
      const matches = (await resolveExtraBootstrapPatternPaths(workspaceDir, pattern)).toSorted();

      expect(matches).toStrictEqual(["link/AGENTS.md"]);
      expect(matches).toStrictEqual(await nodeGlobRelative(workspaceDir, pattern));
    },
  );
});

describe("resolveExtraBootstrapPatternPaths matching-directory parity", () => {
  let fixtureRoot = "";
  let fixtureCount = 0;

  const createWorkspaceDir = async (prefix: string) => {
    const dir = path.join(fixtureRoot, `${prefix}-${fixtureCount++}`);
    await fs.mkdir(dir, { recursive: true });
    return dir;
  };

  beforeAll(async () => {
    fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-walker-dir-"));
  });

  afterAll(async () => {
    if (fixtureRoot) {
      await fs.rm(fixtureRoot, { recursive: true, force: true });
    }
  });

  it("emits directories that match the pattern (fs.glob parity)", async () => {
    // FINDING C: Node fs.glob returns DIRECTORIES that match the pattern, not just
    // files. The walker used to descend a matching directory without ever yielding
    // it, so a configured directory match vanished silently instead of reaching the
    // guarded loader as a diagnostic. Differential: the walker's set — files AND
    // matching directories — must equal fs.glob's over the same tree.
    const workspaceDir = await createWorkspaceDir("dir-match");
    // `dir-agents/AGENTS.md/inner.md`: AGENTS.md is itself a DIRECTORY here, so
    // `**/AGENTS.md` matches that directory (a terminal full match) as well as the
    // real file below.
    await fs.mkdir(path.join(workspaceDir, "dir-agents", "AGENTS.md"), { recursive: true });
    await fs.writeFile(
      path.join(workspaceDir, "dir-agents", "AGENTS.md", "inner.md"),
      "inner",
      "utf-8",
    );
    await fs.mkdir(path.join(workspaceDir, "pkg"), { recursive: true });
    await fs.writeFile(path.join(workspaceDir, "pkg", "AGENTS.md"), "file agents", "utf-8");

    for (const pattern of ["**/AGENTS.md", "*/AGENTS.md"]) {
      const walkerMatches = (
        await resolveExtraBootstrapPatternPaths(workspaceDir, pattern)
      ).toSorted();

      expect(walkerMatches).toStrictEqual(await nodeGlobRelative(workspaceDir, pattern));
      // The matching directory is present, proving it is not silently dropped.
      expect(walkerMatches).toContain("dir-agents/AGENTS.md");
    }
  });
});

describe("resolveExtraBootstrapPatternPaths matched-path realpath failures", () => {
  let fixtureRoot = "";
  let fixtureCount = 0;

  const createWorkspaceDir = async (prefix: string) => {
    const dir = path.join(fixtureRoot, `${prefix}-${fixtureCount++}`);
    await fs.mkdir(dir, { recursive: true });
    return dir;
  };

  beforeAll(async () => {
    fixtureRoot = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-walker-realpath-")),
    );
  });

  afterAll(async () => {
    if (fixtureRoot) {
      await fs.rm(fixtureRoot, { recursive: true, force: true });
    }
  });

  it("skips a match that vanished (ENOENT delete-race) and still resolves the rest", async () => {
    // F1 (matched-path branch): fs.glob can yield a match that is unlinked before
    // the per-match fs.realpath runs — a benign delete-race surfacing as ENOENT.
    // That match is skipped silently while a sibling match that still exists
    // resolves normally, and the walker does not throw. The "vanished" entry names
    // a path with no file on disk, so real fs.realpath throws ENOENT exactly as a
    // delete-race would; only fs.glob is stubbed to yield the phantom entry.
    const workspaceDir = await createWorkspaceDir("enoent-skip");
    await fs.mkdir(path.join(workspaceDir, "present"), { recursive: true });
    await fs.writeFile(path.join(workspaceDir, "present", "AGENTS.md"), "present", "utf-8");

    const globSpy = vi.spyOn(fs, "glob").mockImplementation((() =>
      (async function* () {
        yield path.join("vanished", "AGENTS.md");
        yield path.join("present", "AGENTS.md");
      })()) as unknown as typeof fs.glob);

    try {
      const matches = (
        await resolveExtraBootstrapPatternPaths(workspaceDir, "**/AGENTS.md")
      ).toSorted();
      expect(matches).toStrictEqual(["present/AGENTS.md"]);
    } finally {
      globSpy.mockRestore();
    }
  });

  it("rethrows a non-ENOENT realpath failure on a matched path (EACCES)", async () => {
    // F1 (matched-path branch): a non-ENOENT failure on a matched file (EACCES
    // here) is a real fault, not a delete-race, so the walker rethrows instead of
    // silently dropping the match. The loader turns that rethrow into an
    // operator-visible `io` diagnostic — see workspace.load-extra-bootstrap-files.
    const workspaceDir = await createWorkspaceDir("eacces-rethrow");
    await fs.mkdir(path.join(workspaceDir, "pkg"), { recursive: true });
    await fs.writeFile(path.join(workspaceDir, "pkg", "AGENTS.md"), "agents", "utf-8");

    const globSpy = vi.spyOn(fs, "glob").mockImplementation((() =>
      (async function* () {
        yield path.join("pkg", "AGENTS.md");
      })()) as unknown as typeof fs.glob);
    const realpathError = Object.assign(new Error("simulated realpath EACCES"), { code: "EACCES" });
    const realpathSpy = vi.spyOn(fs, "realpath").mockImplementation((async (
      target: Parameters<typeof fs.realpath>[0],
    ) => {
      // Only the matched file fails; the workspace-root realpath still succeeds so
      // the failure is proven to originate at the matched path, not the root.
      if (target.toString().includes("AGENTS.md")) {
        throw realpathError;
      }
      return target.toString();
    }) as unknown as typeof fs.realpath);

    try {
      await expect(resolveExtraBootstrapPatternPaths(workspaceDir, "**/AGENTS.md")).rejects.toBe(
        realpathError,
      );
    } finally {
      realpathSpy.mockRestore();
      globSpy.mockRestore();
    }
  });
});

describe("resolveExtraBootstrapPatternPaths literal-backslash match paths", () => {
  let fixtureRoot = "";
  let fixtureCount = 0;

  const createWorkspaceDir = async (prefix: string) => {
    const dir = path.join(fixtureRoot, `${prefix}-${fixtureCount++}`);
    await fs.mkdir(dir, { recursive: true });
    return dir;
  };

  beforeAll(async () => {
    // realpath the root so the loader's containment realpath compares canonical
    // paths on macOS (/var -> /private/var).
    fixtureRoot = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-walker-backslash-")),
    );
  });

  afterAll(async () => {
    if (fixtureRoot) {
      await fs.rm(fixtureRoot, { recursive: true, force: true });
    }
  });

  it.runIf(process.platform !== "win32")(
    "preserves a literal backslash byte in a POSIX match path (fs.glob parity)",
    async () => {
      // Regression: backslash is a legal filename byte on POSIX. fs.glob yields a
      // match whose directory name contains a literal backslash; the walker must
      // keep that byte so the loader opens the real file. Rewriting every "\\" to
      // "/" (the introduced defect) points the loader at a different, missing path
      // and silently drops the configured bootstrap file. The parity oracle is raw
      // fs.glob normalized only by the platform separator — a POSIX no-op — so the
      // backslash survives untouched.
      const workspaceDir = await createWorkspaceDir("backslash-dir");
      const backslashDir = path.join(workspaceDir, "back\\slash-dir");
      await fs.mkdir(backslashDir, { recursive: true });
      await fs.writeFile(path.join(backslashDir, "AGENTS.md"), "backslash agents", "utf-8");
      // Control file with no backslash proves the normal path is unaffected.
      await fs.mkdir(path.join(workspaceDir, "control"), { recursive: true });
      await fs.writeFile(path.join(workspaceDir, "control", "AGENTS.md"), "control", "utf-8");

      const pattern = "**/AGENTS.md";
      const matches = (await resolveExtraBootstrapPatternPaths(workspaceDir, pattern)).toSorted();

      expect(matches).toStrictEqual(await nodeGlobRelative(workspaceDir, pattern));
      // The backslash byte is present, not folded to a forward slash.
      expect(matches).toContain("back\\slash-dir/AGENTS.md");

      // The loader must actually load that file's content through the returned
      // path — proving the match is not degraded into a "missing file" diagnostic.
      const { files, diagnostics } = await loadExtraBootstrapFilesWithDiagnostics(workspaceDir, [
        pattern,
      ]);
      const backslashFile = files.find(
        (file) => file.path === path.join(backslashDir, "AGENTS.md"),
      );
      expect(backslashFile?.content).toBe("backslash agents");
      expect(diagnostics).toHaveLength(0);
    },
  );
});

describe("resolveExtraBootstrapPatternPaths fs.glob-absent fallback", () => {
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

  // Run `body` with BOTH native glob APIs hidden — fs.promises.glob and
  // path.matchesGlob — so the resolver takes its capability fallback AND that
  // fallback resolves segments without a native matcher, exactly as on a runtime
  // that ships neither (older Node, some Bun builds). Each original descriptor is
  // saved and restored in `finally`, or the property is deleted when the runtime
  // had none, so no sibling test observes the gap.
  const withoutNativeGlobApis = async (body: () => Promise<void>): Promise<void> => {
    const originalGlob = Object.getOwnPropertyDescriptor(fs, "glob");
    const originalMatchesGlob = Object.getOwnPropertyDescriptor(path, "matchesGlob");
    Object.defineProperty(fs, "glob", { value: undefined, configurable: true, writable: true });
    Object.defineProperty(path, "matchesGlob", {
      value: undefined,
      configurable: true,
      writable: true,
    });
    try {
      expect(typeof fs.glob).not.toBe("function");
      expect(typeof path.matchesGlob).not.toBe("function");
      await body();
    } finally {
      if (originalGlob) {
        Object.defineProperty(fs, "glob", originalGlob);
      } else {
        delete (fs as { glob?: unknown }).glob;
      }
      if (originalMatchesGlob) {
        Object.defineProperty(path, "matchesGlob", originalMatchesGlob);
      } else {
        delete (path as { matchesGlob?: unknown }).matchesGlob;
      }
    }
  };

  beforeAll(async () => {
    // realpath the root so the shared containment realpath compares canonical
    // paths on macOS (/var -> /private/var).
    fixtureRoot = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-walker-noglob-")),
    );
  });

  afterAll(async () => {
    if (fixtureRoot) {
      await fs.rm(fixtureRoot, { recursive: true, force: true });
    }
  });

  it("discriminates the fix: an unguarded fs.glob call throws when the API is absent", async () => {
    // Discriminating control. The pre-fix resolver iterated `fs.glob(...)`
    // unconditionally; with the API hidden that exact call throws synchronously.
    // This reproduces the failure the fallback removes — the throw the loader turns
    // into an `io` diagnostic and an empty match set — proving the fallback, not
    // the test harness, is what lets the guarded resolver succeed in the cases
    // below.
    const workspaceDir = await createWorkspaceDir("control");
    await fs.writeFile(path.join(workspaceDir, "AGENTS.md"), "root", "utf-8");
    await withoutNativeGlobApis(async () => {
      const callUnguardedGlob = () =>
        (fs.glob as unknown as (pattern: string, options: unknown) => AsyncIterable<string>)(
          "**/AGENTS.md",
          { cwd: workspaceDir },
        );
      expect(callUnguardedGlob).toThrow();
    });
  });

  it("resolves a recursive pattern via the local walk when fs.glob is absent", async () => {
    // Fix: without fs.glob the resolver falls back to the local Minimatch walk and
    // still returns every configured match across sibling directories instead of
    // throwing. Same match set the fs.glob path returns for this tree.
    const workspaceDir = await createWorkspaceDir("recursive");
    await fs.writeFile(path.join(workspaceDir, "AGENTS.md"), "root", "utf-8");
    await fs.mkdir(path.join(workspaceDir, "pkg-a"), { recursive: true });
    await fs.mkdir(path.join(workspaceDir, "pkg-b", "deep"), { recursive: true });
    await fs.writeFile(path.join(workspaceDir, "pkg-a", "AGENTS.md"), "a", "utf-8");
    await fs.writeFile(path.join(workspaceDir, "pkg-b", "deep", "AGENTS.md"), "bd", "utf-8");

    await withoutNativeGlobApis(async () => {
      const matches = (
        await resolveExtraBootstrapPatternPaths(workspaceDir, "**/AGENTS.md")
      ).toSorted();
      expect(matches).toStrictEqual(["AGENTS.md", "pkg-a/AGENTS.md", "pkg-b/deep/AGENTS.md"]);
    });
  });

  it("roots the fallback walk at the pattern's literal prefix", async () => {
    // The fallback scans from the literal directory prefix before the first
    // glob-magic segment (`packages/*/TOOLS.md` -> `packages`), matching only the
    // intended sibling packages and never a same-named file outside that prefix.
    const workspaceDir = await createWorkspaceDir("prefixed");
    await fs.mkdir(path.join(workspaceDir, "packages", "one"), { recursive: true });
    await fs.mkdir(path.join(workspaceDir, "packages", "two"), { recursive: true });
    await fs.mkdir(path.join(workspaceDir, "elsewhere"), { recursive: true });
    await fs.writeFile(path.join(workspaceDir, "packages", "one", "TOOLS.md"), "one", "utf-8");
    await fs.writeFile(path.join(workspaceDir, "packages", "two", "TOOLS.md"), "two", "utf-8");
    await fs.writeFile(path.join(workspaceDir, "elsewhere", "TOOLS.md"), "no", "utf-8");

    await withoutNativeGlobApis(async () => {
      const matches = (
        await resolveExtraBootstrapPatternPaths(workspaceDir, "packages/*/TOOLS.md")
      ).toSorted();
      expect(matches).toStrictEqual(["packages/one/TOOLS.md", "packages/two/TOOLS.md"]);
    });
  });

  it("loads configured bootstrap files through the loader when fs.glob is absent", async () => {
    // Loader-boundary discriminating test. Pre-fix, a configured glob with no
    // fs.glob threw into the loader's catch, producing an `io` diagnostic and an
    // EMPTY file set. Post-fix the fallback resolves the pattern, so the file loads
    // and no diagnostic is surfaced. This single assertion fails on pre-fix code
    // (empty files + io diagnostic) and passes on the fix.
    const workspaceDir = await createWorkspaceDir("loader-boundary");
    await fs.mkdir(path.join(workspaceDir, "pkg"), { recursive: true });
    await fs.writeFile(path.join(workspaceDir, "pkg", "AGENTS.md"), "pkg agents", "utf-8");

    await withoutNativeGlobApis(async () => {
      const { files, diagnostics } = await loadExtraBootstrapFilesWithDiagnostics(workspaceDir, [
        "**/AGENTS.md",
      ]);
      const loaded = files.find(
        (file) => file.path === path.join(workspaceDir, "pkg", "AGENTS.md"),
      );
      expect(loaded?.content).toBe("pkg agents");
      expect(diagnostics).toStrictEqual([]);
    });
  });

  it.runIf(process.platform !== "win32")(
    "drops a fallback match whose realpath escapes the workspace",
    async () => {
      // Containment holds on the fallback path too: a literal-named directory
      // symlink whose target escapes the workspace is dropped by the shared
      // realpath filter, so out-of-tree bootstrap content never reaches the prompt
      // even without fs.glob.
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

      await withoutNativeGlobApis(async () => {
        const matches = await resolveExtraBootstrapPatternPaths(
          workspaceDir,
          "pkg/linked/**/AGENTS.md",
        );
        expect(matches).toStrictEqual([]);
      });
    },
  );

  it("resolves a mixed bracket-class + wildcard pattern via the fallback (fs.glob parity)", async () => {
    // The fallback walk root must use the matcher's grammar: `[ab]` is a character
    // CLASS here (the pattern also carries `*`, so it routes to fs.glob where the
    // class is honored). fs.glob loads both packages; the fallback must load the
    // same set. Pre-fix the walk root scan missed `[`/`]`, so it rooted the walk at
    // the non-existent literal dir `packages/[ab]` and silently loaded nothing.
    const workspaceDir = await createWorkspaceDir("bracket-star");
    await fs.mkdir(path.join(workspaceDir, "packages", "a", "x"), { recursive: true });
    await fs.mkdir(path.join(workspaceDir, "packages", "b", "y"), { recursive: true });
    await fs.writeFile(path.join(workspaceDir, "packages", "a", "x", "AGENTS.md"), "a", "utf-8");
    await fs.writeFile(path.join(workspaceDir, "packages", "b", "y", "AGENTS.md"), "b", "utf-8");

    const pattern = "packages/[ab]/*/AGENTS.md";
    const oracle = await nodeGlobRelative(workspaceDir, pattern);
    expect(oracle).toStrictEqual(["packages/a/x/AGENTS.md", "packages/b/y/AGENTS.md"]);

    await withoutNativeGlobApis(async () => {
      const matches = (await resolveExtraBootstrapPatternPaths(workspaceDir, pattern)).toSorted();
      expect(matches).toStrictEqual(oracle);
    });
  });

  it("resolves a root-level bracket-class pattern via the fallback (fs.glob parity)", async () => {
    // Character class in the FIRST segment: the literal prefix is the workspace
    // root, exactly where fs.glob roots the walk. Pre-fix the scan skipped the
    // bracket and rooted at the non-existent literal dir `[ab]`, dropping both.
    const workspaceDir = await createWorkspaceDir("bracket-root");
    await fs.mkdir(path.join(workspaceDir, "a", "x"), { recursive: true });
    await fs.mkdir(path.join(workspaceDir, "b", "y"), { recursive: true });
    await fs.writeFile(path.join(workspaceDir, "a", "x", "AGENTS.md"), "a", "utf-8");
    await fs.writeFile(path.join(workspaceDir, "b", "y", "AGENTS.md"), "b", "utf-8");

    const pattern = "[ab]/*/AGENTS.md";
    const oracle = await nodeGlobRelative(workspaceDir, pattern);
    expect(oracle).toStrictEqual(["a/x/AGENTS.md", "b/y/AGENTS.md"]);

    await withoutNativeGlobApis(async () => {
      const matches = (await resolveExtraBootstrapPatternPaths(workspaceDir, pattern)).toSorted();
      expect(matches).toStrictEqual(oracle);
    });
  });

  it("resolves a bracket-class + globstar pattern via the fallback (fs.glob parity)", async () => {
    // Bracket class combined with `**`: the walk still roots at the literal prefix
    // before the class segment (`packages`), and the globstar spans depth. Pre-fix
    // the root was the non-existent literal `packages/[ab]`, dropping everything.
    const workspaceDir = await createWorkspaceDir("bracket-globstar");
    await fs.mkdir(path.join(workspaceDir, "packages", "a", "deep"), { recursive: true });
    await fs.mkdir(path.join(workspaceDir, "packages", "b"), { recursive: true });
    await fs.writeFile(
      path.join(workspaceDir, "packages", "a", "deep", "AGENTS.md"),
      "ad",
      "utf-8",
    );
    await fs.writeFile(path.join(workspaceDir, "packages", "b", "AGENTS.md"), "b", "utf-8");

    const pattern = "packages/[ab]/**/AGENTS.md";
    const oracle = await nodeGlobRelative(workspaceDir, pattern);
    expect(oracle).toStrictEqual(["packages/a/deep/AGENTS.md", "packages/b/AGENTS.md"]);

    await withoutNativeGlobApis(async () => {
      const matches = (await resolveExtraBootstrapPatternPaths(workspaceDir, pattern)).toSorted();
      expect(matches).toStrictEqual(oracle);
    });
  });

  it("loads bracket-class fallback files through the loader with no diagnostics", async () => {
    // Loader boundary for the bracket-class case. The pattern carries `*`, so the
    // loader routes it to the glob resolver; with fs.glob absent the fallback must
    // still load both bracketed packages and surface no diagnostic. Pre-fix the
    // fallback dropped everything, leaving the files unloaded.
    const workspaceDir = await createWorkspaceDir("bracket-loader");
    await fs.mkdir(path.join(workspaceDir, "packages", "a", "x"), { recursive: true });
    await fs.mkdir(path.join(workspaceDir, "packages", "b", "y"), { recursive: true });
    await fs.writeFile(path.join(workspaceDir, "packages", "a", "x", "AGENTS.md"), "a", "utf-8");
    await fs.writeFile(path.join(workspaceDir, "packages", "b", "y", "AGENTS.md"), "b", "utf-8");

    await withoutNativeGlobApis(async () => {
      const { files, diagnostics } = await loadExtraBootstrapFilesWithDiagnostics(workspaceDir, [
        "packages/[ab]/*/AGENTS.md",
      ]);
      const contents = files
        .map((file) => file.content)
        .toSorted((a, b) => (a ?? "").localeCompare(b ?? ""));
      expect(contents).toStrictEqual(["a", "b"]);
      expect(diagnostics).toStrictEqual([]);
    });
  });

  it("keeps a brace-across-slash pattern unchanged (regression pin)", async () => {
    // Regression pin for the delegation fix: a brace alternative that spans a slash
    // (`{a/b,c}`) collapses its literal prefix to the workspace root under both the
    // old scan and the matcher grammar, so its match set must not change. This case
    // passes before and after the fix — it guards against a per-segment rewrite that
    // would split the brace on `/` and regress it.
    const workspaceDir = await createWorkspaceDir("brace-slash");
    await fs.mkdir(path.join(workspaceDir, "a", "b"), { recursive: true });
    await fs.mkdir(path.join(workspaceDir, "c"), { recursive: true });
    await fs.writeFile(path.join(workspaceDir, "a", "b", "AGENTS.md"), "ab", "utf-8");
    await fs.writeFile(path.join(workspaceDir, "c", "AGENTS.md"), "c", "utf-8");

    const pattern = "{a/b,c}/AGENTS.md";
    const oracle = await nodeGlobRelative(workspaceDir, pattern);
    expect(oracle).toStrictEqual(["a/b/AGENTS.md", "c/AGENTS.md"]);

    await withoutNativeGlobApis(async () => {
      const matches = (await resolveExtraBootstrapPatternPaths(workspaceDir, pattern)).toSorted();
      expect(matches).toStrictEqual(oracle);
    });
  });

  it("treats an escaped bracket as a literal directory name (fs.glob parity)", async () => {
    // Escaped-bracket probe: `[[]ab]` is a class matching a single `[` followed by
    // the literal `ab]`, so the pattern targets a directory LITERALLY named `[ab]`.
    // The fallback must root before that magic segment and match the literal dir,
    // exactly as fs.glob does. Pre-fix the walk root was the non-existent literal
    // `packages/[[]ab]`, so nothing loaded.
    const workspaceDir = await createWorkspaceDir("escaped-bracket");
    await fs.mkdir(path.join(workspaceDir, "packages", "[ab]", "x"), { recursive: true });
    await fs.writeFile(
      path.join(workspaceDir, "packages", "[ab]", "x", "AGENTS.md"),
      "lit",
      "utf-8",
    );

    const pattern = "packages/[[]ab]/*/AGENTS.md";
    const oracle = await nodeGlobRelative(workspaceDir, pattern);
    expect(oracle).toStrictEqual(["packages/[ab]/x/AGENTS.md"]);

    await withoutNativeGlobApis(async () => {
      const matches = (await resolveExtraBootstrapPatternPaths(workspaceDir, pattern)).toSorted();
      expect(matches).toStrictEqual(oracle);
    });
  });

  it("selects a valid walk root when the buggy prefix names a file (fs.glob parity)", async () => {
    // Literal-prefix-is-a-file probe. `pkg[ab]/*/AGENTS.md` has `pkg[ab]` as a
    // single character-class segment matching `pkga`/`pkgb`, so the matcher grammar
    // roots the walk at the workspace root. A real FILE literally named `pkg[ab]`
    // sits in the tree: the pre-fix scan (blind to `[`/`]`) rooted the walk at that
    // file's path, so readdir failed and nothing loaded. The fix roots at the
    // workspace root and matches both real package dirs, exactly as fs.glob does.
    const workspaceDir = await createWorkspaceDir("file-prefix");
    await fs.writeFile(path.join(workspaceDir, "pkg[ab]"), "decoy", "utf-8");
    await fs.mkdir(path.join(workspaceDir, "pkga", "x"), { recursive: true });
    await fs.mkdir(path.join(workspaceDir, "pkgb", "y"), { recursive: true });
    await fs.writeFile(path.join(workspaceDir, "pkga", "x", "AGENTS.md"), "a", "utf-8");
    await fs.writeFile(path.join(workspaceDir, "pkgb", "y", "AGENTS.md"), "b", "utf-8");

    const pattern = "pkg[ab]/*/AGENTS.md";
    const oracle = await nodeGlobRelative(workspaceDir, pattern);
    expect(oracle).toStrictEqual(["pkga/x/AGENTS.md", "pkgb/y/AGENTS.md"]);

    await withoutNativeGlobApis(async () => {
      const matches = (await resolveExtraBootstrapPatternPaths(workspaceDir, pattern)).toSorted();
      expect(matches).toStrictEqual(oracle);
    });
  });
});

describe("toPortableMatchPath", () => {
  it("preserves literal backslash bytes on POSIX (separator '/')", () => {
    // POSIX separator: only "/" is folded (a no-op), so a legal backslash byte in
    // a filename survives and forward slashes are unchanged.
    expect(toPortableMatchPath("back\\slash-dir/AGENTS.md", "/")).toBe("back\\slash-dir/AGENTS.md");
    expect(toPortableMatchPath("a/b/c/AGENTS.md", "/")).toBe("a/b/c/AGENTS.md");
  });

  it("folds real separators to '/' under a Windows separator ('\\\\')", () => {
    // Windows separator branch — otherwise unreachable on POSIX CI: real "\\"
    // separators fold to "/", lossless because Windows filenames cannot contain a
    // backslash. Any embedded "/" (already portable) is left alone.
    expect(toPortableMatchPath("a\\b\\c\\AGENTS.md", "\\")).toBe("a/b/c/AGENTS.md");
    expect(toPortableMatchPath("a\\b/c\\AGENTS.md", "\\")).toBe("a/b/c/AGENTS.md");
  });
});
