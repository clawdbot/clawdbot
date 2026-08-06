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
import { resolveExtraBootstrapPatternPaths } from "./workspace-extra-bootstrap-walker.js";

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
    "refuses an ancestor-pointing symlink cycle (intentional fs.glob divergence)",
    async () => {
      // Cycle guard: `a/loop -> a` names `loop` literally in `*/loop/**`, so
      // descent is attempted, but the realpath ancestor check refuses to re-enter
      // `a`. This deliberately diverges from fs.glob (which follows the loop once)
      // to guarantee termination, so it is asserted directly, not against fs.glob.
      const workspaceDir = await createWorkspaceDir("ancestor-cycle");
      const dirA = path.join(workspaceDir, "a");
      await fs.mkdir(dirA, { recursive: true });
      await fs.writeFile(path.join(dirA, "AGENTS.md"), "a", "utf-8");
      if (!(await trySymlink(dirA, path.join(dirA, "loop")))) {
        return;
      }

      const matches = await resolveExtraBootstrapPatternPaths(
        workspaceDir,
        "*/loop/**/AGENTS.md",
        false,
      );

      expect(matches).toStrictEqual([]);
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
