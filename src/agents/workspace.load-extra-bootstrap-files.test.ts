// Extra bootstrap file tests cover glob/literal path loading, workspace
// containment checks, symlink handling, and diagnostics for skipped files.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  loadExtraBootstrapFilesWithDiagnostics,
  loadWorkspacePatternFilesWithDiagnostics,
} from "./workspace.js";

describe("loadExtraBootstrapFilesWithDiagnostics", () => {
  let fixtureRoot = "";
  let fixtureCount = 0;

  const createWorkspaceDir = async (prefix: string) => {
    const dir = path.join(fixtureRoot, `${prefix}-${fixtureCount++}`);
    await fs.mkdir(dir, { recursive: true });
    return dir;
  };

  beforeAll(async () => {
    fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-extra-bootstrap-"));
  });

  afterAll(async () => {
    if (fixtureRoot) {
      await fs.rm(fixtureRoot, { recursive: true, force: true });
    }
  });

  async function loadExtraBootstrapFileList(dir: string, extraPatterns: string[]) {
    const { files } = await loadExtraBootstrapFilesWithDiagnostics(dir, extraPatterns);
    return files;
  }

  it("loads recognized bootstrap files from glob patterns", async () => {
    const workspaceDir = await createWorkspaceDir("glob");
    const packageDir = path.join(workspaceDir, "packages", "core");
    await fs.mkdir(packageDir, { recursive: true });
    await fs.writeFile(path.join(packageDir, "SOUL.md"), "soul", "utf-8");
    await fs.writeFile(path.join(packageDir, "README.md"), "not bootstrap", "utf-8");

    const files = await loadExtraBootstrapFileList(workspaceDir, ["packages/*/*"]);

    expect(files).toStrictEqual([
      {
        name: "SOUL.md",
        path: path.join(packageDir, "SOUL.md"),
        content: "soul",
        missing: false,
      },
    ]);
  });

  it("loads glob patterns with explicit current-directory prefixes", async () => {
    const workspaceDir = await createWorkspaceDir("glob-current-dir");
    const packageDir = path.join(workspaceDir, "packages", "core");
    await fs.mkdir(packageDir, { recursive: true });
    await fs.writeFile(path.join(packageDir, "AGENTS.md"), "agents", "utf-8");

    const files = await loadExtraBootstrapFileList(workspaceDir, ["./packages/*/AGENTS.md"]);

    expect(files).toStrictEqual([
      {
        name: "AGENTS.md",
        path: path.join(packageDir, "AGENTS.md"),
        content: "agents",
        missing: false,
      },
    ]);
  });

  it("matches broad globs under directories named like build outputs", async () => {
    // Regression: the walker must match the same file set as fs.glob. A broad
    // pattern like `**/AGENTS.md` includes files under directories such as
    // `dist` — there is no ignored-directory pruning that would silently change
    // which files an existing configured pattern matches on upgrade.
    const workspaceDir = await createWorkspaceDir("glob-no-pruning");
    const distDir = path.join(workspaceDir, "dist");
    await fs.mkdir(distDir, { recursive: true });
    await fs.writeFile(path.join(distDir, "AGENTS.md"), "dist agents", "utf-8");

    const files = await loadExtraBootstrapFileList(workspaceDir, ["**/AGENTS.md"]);

    expect(files).toStrictEqual([
      {
        name: "AGENTS.md",
        path: path.join(distDir, "AGENTS.md"),
        content: "dist agents",
        missing: false,
      },
    ]);
  });

  it("honors explicit globs rooted in an ignored directory", async () => {
    const workspaceDir = await createWorkspaceDir("glob-explicit-ignored-dir");
    const distDir = path.join(workspaceDir, "dist", "nested");
    await fs.mkdir(distDir, { recursive: true });
    await fs.writeFile(path.join(distDir, "AGENTS.md"), "dist agents", "utf-8");

    const files = await loadExtraBootstrapFileList(workspaceDir, ["dist/**/AGENTS.md"]);

    expect(files).toStrictEqual([
      {
        name: "AGENTS.md",
        path: path.join(distDir, "AGENTS.md"),
        content: "dist agents",
        missing: false,
      },
    ]);
  });

  it("does not traverse dot directories a broad glob cannot match", async () => {
    // Regression: `**/AGENTS.md` must not descend into dot directories like
    // `.git`/`.openclaw`. Node fs.glob skips dot segments for `*`/`**`, so these
    // bootstrap files are never matches; walking them only stalls bootstrap prep.
    const workspaceDir = await createWorkspaceDir("glob-dot-prune");
    const gitDir = path.join(workspaceDir, ".git", "hooks");
    const openclawDir = path.join(workspaceDir, ".openclaw", "nested");
    const realDir = path.join(workspaceDir, "packages");
    await fs.mkdir(gitDir, { recursive: true });
    await fs.mkdir(openclawDir, { recursive: true });
    await fs.mkdir(realDir, { recursive: true });
    await fs.writeFile(path.join(gitDir, "AGENTS.md"), "git agents", "utf-8");
    await fs.writeFile(path.join(openclawDir, "AGENTS.md"), "openclaw agents", "utf-8");
    await fs.writeFile(path.join(realDir, "AGENTS.md"), "real agents", "utf-8");

    const files = await loadExtraBootstrapFileList(workspaceDir, ["**/AGENTS.md"]);

    expect(files).toStrictEqual([
      {
        name: "AGENTS.md",
        path: path.join(realDir, "AGENTS.md"),
        content: "real agents",
        missing: false,
      },
    ]);
  });

  it("descends into dot directories an explicitly dotted glob names", async () => {
    // A pattern that names a literal-dot segment (`.openclaw/**`) must still walk
    // into the dot directory and return its matches; only globs that cannot reach
    // a dot segment are pruned.
    const workspaceDir = await createWorkspaceDir("glob-dot-explicit");
    const openclawDir = path.join(workspaceDir, ".openclaw", "nested");
    await fs.mkdir(openclawDir, { recursive: true });
    await fs.writeFile(path.join(openclawDir, "AGENTS.md"), "openclaw agents", "utf-8");

    const files = await loadExtraBootstrapFileList(workspaceDir, [".openclaw/**/AGENTS.md"]);

    expect(files).toStrictEqual([
      {
        name: "AGENTS.md",
        path: path.join(openclawDir, "AGENTS.md"),
        content: "openclaw agents",
        missing: false,
      },
    ]);
  });

  it("descends into a dot directory named after a non-leading glob segment", async () => {
    // `**/.config/*.md` aligns the literal `.config` segment with the dot
    // directory, so the walker must descend even though the dot dir is not the
    // pattern root.
    const workspaceDir = await createWorkspaceDir("glob-dot-nonleading");
    const configDir = path.join(workspaceDir, "nested", ".config");
    await fs.mkdir(configDir, { recursive: true });
    await fs.writeFile(path.join(configDir, "AGENTS.md"), "config agents", "utf-8");

    const files = await loadExtraBootstrapFileList(workspaceDir, ["**/.config/AGENTS.md"]);

    expect(files).toStrictEqual([
      {
        name: "AGENTS.md",
        path: path.join(configDir, "AGENTS.md"),
        content: "config agents",
        missing: false,
      },
    ]);
  });

  it("returns every matching file without an artificial match cap", async () => {
    const workspaceDir = await createWorkspaceDir("glob-no-match-cap");
    const fileCount = 140;
    await Promise.all(
      Array.from({ length: fileCount }, async (_, index) => {
        const packageDir = path.join(workspaceDir, "packages", `pkg-${index}`);
        await fs.mkdir(packageDir, { recursive: true });
        await fs.writeFile(path.join(packageDir, "AGENTS.md"), `agents ${index}`, "utf-8");
      }),
    );

    const { files, diagnostics } = await loadExtraBootstrapFilesWithDiagnostics(workspaceDir, [
      "packages/*/AGENTS.md",
    ]);

    // All matches within the traversal bound are returned; downstream bootstrap
    // character budgeting handles content limiting, not a glob match cap.
    expect(files).toHaveLength(fileCount);
    expect(diagnostics).toHaveLength(0);
  });

  it("returns matches that appear late in a deep tree without truncation", async () => {
    // Regression: a sparse pattern can yield zero matches until very late in a
    // large tree. The walker yields periodically to avoid the fs.glob event-loop
    // stall, but it must still walk the whole tree and return every real match —
    // no hard traversal cutoff that silently drops late configured globs.
    const workspaceDir = await createWorkspaceDir("glob-sparse-late-match");

    // Build a modest deep tree with plenty of non-matching entries, then place
    // the only AGENTS.md deep at the end so it is reached late in traversal.
    const dirCount = 60;
    const filesPerDir = 30;
    await Promise.all(
      Array.from({ length: dirCount }, async (_, dirIndex) => {
        const branchDir = path.join(workspaceDir, `branch-${dirIndex}`, "nested");
        await fs.mkdir(branchDir, { recursive: true });
        await Promise.all(
          Array.from({ length: filesPerDir }, (__, fileIndex) =>
            fs.writeFile(path.join(branchDir, `noise-${fileIndex}.txt`), "x", "utf-8"),
          ),
        );
      }),
    );
    const lateDir = path.join(workspaceDir, "zzz-late", "deep");
    await fs.mkdir(lateDir, { recursive: true });
    await fs.writeFile(path.join(lateDir, "AGENTS.md"), "late agents", "utf-8");

    const { files, diagnostics } = await loadExtraBootstrapFilesWithDiagnostics(workspaceDir, [
      "**/AGENTS.md",
    ]);

    // The late match is still returned and no truncation diagnostic is emitted.
    expect(files).toStrictEqual([
      {
        name: "AGENTS.md",
        path: path.join(lateDir, "AGENTS.md"),
        content: "late agents",
        missing: false,
      },
    ]);
    expect(diagnostics).toHaveLength(0);
  });

  it("returns all matches for a glob pattern (order follows walker, not sorted)", async () => {
    // Order is intentionally NOT asserted: the walker visits directories in
    // filesystem order, which is platform-dependent. Deterministic bootstrap
    // ordering is deferred to a separate change; here we only prove that every
    // match is resolved for a multi-match glob.
    const workspaceDir = await createWorkspaceDir("glob-multi-match");
    for (const name of ["zeta", "alpha", "mid", "beta"]) {
      const packageDir = path.join(workspaceDir, "packages", name);
      await fs.mkdir(packageDir, { recursive: true });
      await fs.writeFile(path.join(packageDir, "AGENTS.md"), name, "utf-8");
    }

    const files = await loadExtraBootstrapFileList(workspaceDir, ["packages/*/AGENTS.md"]);

    expect(files.map((file: { path: string }) => file.path).toSorted()).toStrictEqual(
      [
        path.join(workspaceDir, "packages", "alpha", "AGENTS.md"),
        path.join(workspaceDir, "packages", "beta", "AGENTS.md"),
        path.join(workspaceDir, "packages", "mid", "AGENTS.md"),
        path.join(workspaceDir, "packages", "zeta", "AGENTS.md"),
      ].toSorted(),
    );
  });

  it("resolves a glob that matches nothing to an empty set without diagnostics", async () => {
    // Parity with fs.glob's no-match behavior: a configured glob that matches
    // no files yields no bootstrap files and no diagnostics. The literal pattern
    // must not leak through as a phantom "missing" path the way a non-glob
    // literal would.
    const workspaceDir = await createWorkspaceDir("glob-no-match");
    const packageDir = path.join(workspaceDir, "packages", "core");
    await fs.mkdir(packageDir, { recursive: true });
    await fs.writeFile(path.join(packageDir, "README.md"), "not bootstrap", "utf-8");

    const { files, diagnostics } = await loadExtraBootstrapFilesWithDiagnostics(workspaceDir, [
      "packages/*/AGENTS.md",
    ]);

    expect(files).toHaveLength(0);
    expect(diagnostics).toHaveLength(0);
  });

  it("loads literal bootstrap paths with square brackets", async () => {
    const workspaceDir = await createWorkspaceDir("literal-brackets");
    const packageDir = path.join(workspaceDir, "pkg[1]");
    await fs.mkdir(packageDir, { recursive: true });
    await fs.writeFile(path.join(packageDir, "AGENTS.md"), "literal agents", "utf-8");

    const files = await loadExtraBootstrapFileList(workspaceDir, ["pkg[1]/AGENTS.md"]);

    expect(files).toStrictEqual([
      {
        name: "AGENTS.md",
        path: path.join(packageDir, "AGENTS.md"),
        content: "literal agents",
        missing: false,
      },
    ]);
  });

  it("loads bootstrap files from valid child directories beginning with two dots", async () => {
    const workspaceDir = await createWorkspaceDir("dotdot-name");
    const packageDir = path.join(workspaceDir, "..notes");
    await fs.mkdir(packageDir);
    await fs.writeFile(path.join(packageDir, "AGENTS.md"), "agents", "utf-8");

    const files = await loadExtraBootstrapFileList(workspaceDir, ["..notes/AGENTS.md"]);

    expect(files).toStrictEqual([
      {
        name: "AGENTS.md",
        path: path.join(packageDir, "AGENTS.md"),
        content: "agents",
        missing: false,
      },
    ]);
  });

  it("keeps path-traversal attempts outside workspace excluded", async () => {
    const rootDir = await createWorkspaceDir("root");
    const workspaceDir = path.join(rootDir, "workspace");
    const outsideDir = path.join(rootDir, "outside");
    await fs.mkdir(workspaceDir, { recursive: true });
    await fs.mkdir(outsideDir, { recursive: true });
    await fs.writeFile(path.join(outsideDir, "AGENTS.md"), "outside", "utf-8");

    const files = await loadExtraBootstrapFileList(workspaceDir, ["../outside/AGENTS.md"]);

    expect(files).toHaveLength(0);
  });

  it("supports symlinked workspace roots with realpath checks", async () => {
    if (process.platform === "win32") {
      return;
    }

    const rootDir = await createWorkspaceDir("symlink");
    const realWorkspace = path.join(rootDir, "real-workspace");
    const linkedWorkspace = path.join(rootDir, "linked-workspace");
    await fs.mkdir(realWorkspace, { recursive: true });
    await fs.writeFile(path.join(realWorkspace, "AGENTS.md"), "linked agents", "utf-8");
    await fs.symlink(realWorkspace, linkedWorkspace, "dir");

    const files = await loadExtraBootstrapFileList(linkedWorkspace, ["AGENTS.md"]);

    expect(files).toStrictEqual([
      {
        name: "AGENTS.md",
        path: path.join(linkedWorkspace, "AGENTS.md"),
        content: "linked agents",
        missing: false,
      },
    ]);
  });

  it("descends a literal-named directory symlink reached under a wildcard", async () => {
    // Regression: the cooperative walker replaced fs.glob. fs.glob follows a
    // directory symlink whose path segment is named literally in the pattern
    // (`*/linked/**` -> the `linked` link is descended), so its descendants
    // must still match. Here `linked` appears as a nested entry under a `*`
    // wildcard, so it is not folded into the walk root and the descent logic
    // is exercised directly.
    if (process.platform === "win32") {
      return;
    }

    const workspaceDir = await createWorkspaceDir("symlink-literal-descend");
    const pkgDir = path.join(workspaceDir, "pkg");
    const target = path.join(workspaceDir, "target");
    const targetNested = path.join(target, "nested");
    await fs.mkdir(pkgDir, { recursive: true });
    await fs.mkdir(targetNested, { recursive: true });
    await fs.writeFile(path.join(target, "AGENTS.md"), "top agents", "utf-8");
    await fs.writeFile(path.join(targetNested, "AGENTS.md"), "nested agents", "utf-8");
    try {
      await fs.symlink(target, path.join(pkgDir, "linked"), "dir");
    } catch (err) {
      if (["EPERM", "EACCES", "ENOSYS"].includes((err as NodeJS.ErrnoException).code ?? "")) {
        return;
      }
      throw err;
    }

    const files = await loadExtraBootstrapFileList(workspaceDir, ["*/linked/**/AGENTS.md"]);

    expect(files.map((file: { path: string }) => file.path).toSorted()).toStrictEqual(
      [
        path.join(pkgDir, "linked", "AGENTS.md"),
        path.join(pkgDir, "linked", "nested", "AGENTS.md"),
      ].toSorted(),
    );
  });

  it("keeps a wildcard-reached directory symlink terminal", async () => {
    // fs.glob never follows a symlink reached through a `*`/`**` wildcard
    // segment, even when the target holds matches. The real target directory is
    // still matched directly (it lives in the workspace), but the path THROUGH
    // the symlink must not be expanded.
    if (process.platform === "win32") {
      return;
    }

    const workspaceDir = await createWorkspaceDir("symlink-wildcard-terminal");
    const realDir = path.join(workspaceDir, "real");
    const linkTarget = path.join(workspaceDir, "linktarget");
    await fs.mkdir(realDir, { recursive: true });
    await fs.mkdir(linkTarget, { recursive: true });
    await fs.writeFile(path.join(realDir, "AGENTS.md"), "real agents", "utf-8");
    await fs.writeFile(path.join(linkTarget, "AGENTS.md"), "target agents", "utf-8");
    try {
      await fs.symlink(linkTarget, path.join(realDir, "wl"), "dir");
    } catch (err) {
      if (["EPERM", "EACCES", "ENOSYS"].includes((err as NodeJS.ErrnoException).code ?? "")) {
        return;
      }
      throw err;
    }

    const files = await loadExtraBootstrapFileList(workspaceDir, ["**/AGENTS.md"]);
    const resolved = files.map((file: { path: string }) => file.path).toSorted();

    // Both real files match; the `**`-reached symlink `real/wl` stays a leaf, so
    // its target is not re-walked through the symlink path.
    expect(resolved).toStrictEqual(
      [path.join(linkTarget, "AGENTS.md"), path.join(realDir, "AGENTS.md")].toSorted(),
    );
    expect(resolved).not.toContain(path.join(realDir, "wl", "AGENTS.md"));
  });

  it("does not loop on an ancestor-pointing literal directory symlink", async () => {
    // Cycle guard: a directory symlink can point at an ancestor (`a/loop -> a`).
    // The `loop` segment is literal in `*/loop/**/AGENTS.md`, so descent would
    // be attempted, but the realpath ancestor check refuses to re-enter `a`.
    // The walk must terminate and must not expand matches through the loop.
    if (process.platform === "win32") {
      return;
    }

    const workspaceDir = await createWorkspaceDir("symlink-cycle");
    const dirA = path.join(workspaceDir, "a");
    await fs.mkdir(dirA, { recursive: true });
    await fs.writeFile(path.join(dirA, "AGENTS.md"), "a agents", "utf-8");
    try {
      await fs.symlink(dirA, path.join(dirA, "loop"), "dir");
    } catch (err) {
      if (["EPERM", "EACCES", "ENOSYS"].includes((err as NodeJS.ErrnoException).code ?? "")) {
        return;
      }
      throw err;
    }

    const files = await loadExtraBootstrapFileList(workspaceDir, ["*/loop/**/AGENTS.md"]);

    // Ancestor descent is refused, so no phantom `a/loop/...` match is produced
    // and the walk terminates instead of looping.
    expect(files).toHaveLength(0);
  }, 15000);

  it("rejects hardlinked aliases to files outside workspace", async () => {
    // Hardlinks can look like in-workspace files by path; inode/realpath checks
    // keep outside bootstrap content from entering the prompt.
    if (process.platform === "win32") {
      return;
    }

    const rootDir = await createWorkspaceDir("hardlink");
    const workspaceDir = path.join(rootDir, "workspace");
    const outsideDir = path.join(rootDir, "outside");
    await fs.mkdir(workspaceDir, { recursive: true });
    await fs.mkdir(outsideDir, { recursive: true });
    const outsideFile = path.join(outsideDir, "AGENTS.md");
    const linkedFile = path.join(workspaceDir, "AGENTS.md");
    await fs.writeFile(outsideFile, "outside", "utf-8");
    try {
      await fs.link(outsideFile, linkedFile);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "EXDEV") {
        return;
      }
      throw err;
    }

    const files = await loadExtraBootstrapFileList(workspaceDir, ["AGENTS.md"]);
    expect(files).toHaveLength(0);
  });

  it("skips oversized bootstrap files and reports diagnostics", async () => {
    const workspaceDir = await createWorkspaceDir("oversized");
    const payload = "x".repeat(2 * 1024 * 1024 + 1);
    await fs.writeFile(path.join(workspaceDir, "AGENTS.md"), payload, "utf-8");

    const { files, diagnostics } = await loadExtraBootstrapFilesWithDiagnostics(workspaceDir, [
      "AGENTS.md",
    ]);

    expect(files).toHaveLength(0);
    expect(diagnostics.map((diagnostic) => diagnostic.reason)).toContain("security");
  });

  it.runIf(process.platform !== "win32")(
    "reports unreadable glob branches during strict doctor discovery",
    async () => {
      const workspaceDir = await createWorkspaceDir("strict-unreadable");
      const blockedDir = path.join(workspaceDir, "packages", "blocked");
      const readableDir = path.join(workspaceDir, "packages", "readable");
      await fs.mkdir(blockedDir, { recursive: true });
      await fs.mkdir(readableDir, { recursive: true });
      await fs.writeFile(path.join(blockedDir, "TOOLS.md"), "blocked", "utf-8");
      await fs.writeFile(path.join(readableDir, "TOOLS.md"), "readable", "utf-8");
      await fs.chmod(blockedDir, 0o000);
      try {
        const result = await loadWorkspacePatternFilesWithDiagnostics(
          workspaceDir,
          ["packages/*/TOOLS.md"],
          {
            acceptedBasenames: new Set(["TOOLS.md"]),
            strictPatternRead: true,
          },
        );
        expect(result.files).toEqual([]);
        expect(result.diagnostics).toEqual([
          expect.objectContaining({
            reason: "io",
            path: path.join(workspaceDir, "packages", "*", "TOOLS.md"),
          }),
        ]);
      } finally {
        await fs.chmod(blockedDir, 0o700);
      }
    },
  );

  it.runIf(process.platform !== "win32")(
    "does not descend into unreadable branches that cannot satisfy a shallow pattern",
    async () => {
      const workspaceDir = await createWorkspaceDir("strict-pruned");
      const privateDir = path.join(workspaceDir, "packages", "blocked", "node_modules", "private");
      const readableDir = path.join(workspaceDir, "packages", "readable");
      await fs.mkdir(privateDir, { recursive: true });
      await fs.mkdir(readableDir, { recursive: true });
      await fs.writeFile(path.join(privateDir, "TOOLS.md"), "irrelevant", "utf-8");
      await fs.writeFile(path.join(readableDir, "TOOLS.md"), "readable", "utf-8");
      await fs.chmod(privateDir, 0o000);
      try {
        const result = await loadWorkspacePatternFilesWithDiagnostics(
          workspaceDir,
          ["packages/*/TOOLS.md"],
          {
            acceptedBasenames: new Set(["TOOLS.md"]),
            strictPatternRead: true,
          },
        );
        expect(result.diagnostics).toEqual([]);
        expect(result.files).toEqual([
          expect.objectContaining({ path: path.join(readableDir, "TOOLS.md") }),
        ]);
      } finally {
        await fs.chmod(privateDir, 0o700);
      }
    },
  );
});
