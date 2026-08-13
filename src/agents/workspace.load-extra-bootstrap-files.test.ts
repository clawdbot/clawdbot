// Extra bootstrap file tests cover glob/literal path loading, workspace
// containment checks, symlink handling, and diagnostics for skipped files.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
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

  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function loadExtraBootstrapFileList(dir: string, extraPatterns: string[]) {
    const { files } = await loadExtraBootstrapFilesWithDiagnostics(dir, extraPatterns);
    return files;
  }

  // Loader result as workspace-relative paths, sorted, for differential parity.
  const loaderRelative = async (workspaceDir: string, pattern: string): Promise<string[]> => {
    const files = await loadExtraBootstrapFileList(workspaceDir, [pattern]);
    return files
      .map((file) => path.relative(workspaceDir, file.path).replaceAll(path.sep, "/"))
      .toSorted();
  };

  // Oracle for `..`-surviving patterns: Node fs.glob's match set restricted to
  // entries that stay inside the workspace. fs.glob's globstar-parent `..` can step
  // above the cwd (yielding `../AGENTS.md`), which the loader prunes for
  // containment, so the parity target is fs.glob's contained subset — exactly what
  // the loader is allowed to return.
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

  it("surfaces an io diagnostic when fs.glob fails for a non-ENOENT reason", async () => {
    // F1: fs.glob walks past per-entry failures, so a thrown error is a real
    // top-level failure. Any non-ENOENT failure must surface as an
    // operator-visible `io` diagnostic instead of silently dropping every
    // configured bootstrap file (the pre-fix behavior gated the rethrow behind a
    // strict-read flag, so a normal load returned [] with no diagnostic).
    const workspaceDir = await createWorkspaceDir("glob-io-failure");
    const globError = Object.assign(new Error("simulated glob failure"), { code: "EIO" });
    const globSpy = vi.spyOn(fs, "glob").mockImplementation((() => {
      throw globError;
    }) as unknown as typeof fs.glob);

    try {
      const { files, diagnostics } = await loadExtraBootstrapFilesWithDiagnostics(workspaceDir, [
        "**/AGENTS.md",
      ]);
      expect(files).toHaveLength(0);
      expect(diagnostics).toHaveLength(1);
      expect(diagnostics[0]?.reason).toBe("io");
      expect(diagnostics[0]?.detail).toContain("simulated glob failure");
    } finally {
      globSpy.mockRestore();
    }
  });

  it("resolves a missing workspace cwd to no matches without a diagnostic (ENOENT)", async () => {
    // F1 boundary: a missing cwd makes fs.glob throw ENOENT, which legitimately
    // means "no matches" rather than an error to surface — no files, no diagnostic.
    const missingDir = path.join(fixtureRoot, `missing-cwd-${fixtureCount++}`);

    const { files, diagnostics } = await loadExtraBootstrapFilesWithDiagnostics(missingDir, [
      "**/AGENTS.md",
    ]);

    expect(files).toHaveLength(0);
    expect(diagnostics).toHaveLength(0);
  });

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

  it("surfaces a diagnostic for a directory that matches the pattern", async () => {
    // FINDING C: Node fs.glob returns directories that match the pattern; main
    // routes those through the guarded loader so a configured directory match
    // surfaces a diagnostic instead of silently vanishing. Here `pkg/AGENTS.md` is
    // itself a directory, so `**/AGENTS.md` matches it — the loader must report it
    // (a directory cannot be read as a bootstrap file) while still loading the real
    // sibling file match.
    const workspaceDir = await createWorkspaceDir("glob-dir-diagnostic");
    const dirNamedLikeBootstrap = path.join(workspaceDir, "pkg", "AGENTS.md");
    await fs.mkdir(dirNamedLikeBootstrap, { recursive: true });
    await fs.writeFile(path.join(dirNamedLikeBootstrap, "inner.md"), "inner", "utf-8");
    const realFile = path.join(workspaceDir, "other", "AGENTS.md");
    await fs.mkdir(path.dirname(realFile), { recursive: true });
    await fs.writeFile(realFile, "real agents", "utf-8");

    const { files, diagnostics } = await loadExtraBootstrapFilesWithDiagnostics(workspaceDir, [
      "**/AGENTS.md",
    ]);

    // The real file still loads; the directory does not leak in as content.
    expect(files.map((file) => file.path)).toStrictEqual([realFile]);
    // The directory match is not dropped silently — it reaches the guarded loader
    // and produces a diagnostic pointing at the directory path.
    expect(diagnostics.map((diagnostic) => diagnostic.path)).toContain(dirNamedLikeBootstrap);
  });

  it("returns Node fs.glob's contained set for a globstar with repeated parent traversal", async () => {
    // P1-A: `**/../../AGENTS.md` is a supported fs.glob shape — Node steps up two
    // levels and returns the CONTAINED matches. Earlier this branch rejected the
    // pattern outright and dropped every configured file; the loader now routes the
    // `..`-surviving alternative through fs.glob and keeps its workspace-contained
    // result. Differential: the loader's set equals fs.glob's, restricted to matches
    // inside the workspace, and is not the empty reject.
    const workspaceDir = await createWorkspaceDir("repeated-parent");
    await fs.mkdir(path.join(workspaceDir, "a", "x", "deep"), { recursive: true });
    await fs.writeFile(path.join(workspaceDir, "AGENTS.md"), "root", "utf-8");
    await fs.writeFile(path.join(workspaceDir, "a", "AGENTS.md"), "a", "utf-8");

    const { diagnostics } = await loadExtraBootstrapFilesWithDiagnostics(workspaceDir, [
      "**/../../AGENTS.md",
    ]);
    const expected = await nodeGlobContained(workspaceDir, "**/../../AGENTS.md");

    expect(await loaderRelative(workspaceDir, "**/../../AGENTS.md")).toStrictEqual(expected);
    // The fix's whole point: the contained set is non-empty, not the old reject.
    expect(expected.length).toBeGreaterThan(0);
    expect(diagnostics).toHaveLength(0);
  });

  it("keeps single-.. globstar parent traversal supported (regression guard)", async () => {
    // Guard the reducible boundary: one `..` after the globstar (`**/../AGENTS.md`)
    // stays exact fs.glob parity. fs.glob returns both the root file (via `a`
    // popping) and `a/AGENTS.md` (via `a/x` popping).
    const workspaceDir = await createWorkspaceDir("single-parent");
    await fs.mkdir(path.join(workspaceDir, "a", "x"), { recursive: true });
    await fs.writeFile(path.join(workspaceDir, "AGENTS.md"), "root", "utf-8");
    await fs.writeFile(path.join(workspaceDir, "a", "AGENTS.md"), "a", "utf-8");

    const { diagnostics } = await loadExtraBootstrapFilesWithDiagnostics(workspaceDir, [
      "**/../AGENTS.md",
    ]);

    expect(await loaderRelative(workspaceDir, "**/../AGENTS.md")).toStrictEqual(
      await nodeGlobContained(workspaceDir, "**/../AGENTS.md"),
    );
    expect(await loaderRelative(workspaceDir, "**/../AGENTS.md")).toStrictEqual([
      "AGENTS.md",
      "a/AGENTS.md",
    ]);
    expect(diagnostics).toHaveLength(0);
  });

  it("routes each brace alternative correctly: hot-path walker and fs.glob-contained", async () => {
    // Mixed-brace routing: `{**/../../AGENTS.md,a/AGENTS.md}` mixes a `..`-surviving
    // alternative (resolved via fs.glob + containment) with a `..`-free downward
    // alternative (resolved by the yielding walker). The loader returns the union of
    // both, with no diagnostic — parity with fs.glob over the whole pattern.
    const workspaceDir = await createWorkspaceDir("brace-mixed-parent");
    await fs.mkdir(path.join(workspaceDir, "a", "x", "deep"), { recursive: true });
    await fs.writeFile(path.join(workspaceDir, "AGENTS.md"), "root", "utf-8");
    await fs.writeFile(path.join(workspaceDir, "a", "AGENTS.md"), "a", "utf-8");

    const pattern = "{**/../../AGENTS.md,a/AGENTS.md}";
    const { diagnostics } = await loadExtraBootstrapFilesWithDiagnostics(workspaceDir, [pattern]);
    const expected = await nodeGlobContained(workspaceDir, pattern);

    expect(await loaderRelative(workspaceDir, pattern)).toStrictEqual(expected);
    // Both routes contribute: the downward `a/AGENTS.md` and at least the contained
    // repeated-parent match.
    expect(expected).toContain("a/AGENTS.md");
    expect(expected).toContain("AGENTS.md");
    expect(diagnostics).toHaveLength(0);
  });

  it.runIf(process.platform !== "win32")(
    "emits a security diagnostic for a glob whose literal root is an external symlink",
    async () => {
      // P1-B: a glob whose literal root prefix is a directory symlink pointing
      // OUTSIDE the workspace (`outside-link/**/AGENTS.md` where `outside-link` ->
      // ../outside) must not silently resolve to nothing. The loader's walk-root gate
      // resolves the symlink's realpath, sees it escape the workspace, and surfaces a
      // `security` diagnostic instead of a silent no-op.
      const rootDir = await createWorkspaceDir("external-symlink-root");
      const workspaceDir = path.join(rootDir, "workspace");
      const outsideDir = path.join(rootDir, "outside");
      await fs.mkdir(workspaceDir, { recursive: true });
      await fs.mkdir(outsideDir, { recursive: true });
      await fs.writeFile(path.join(outsideDir, "AGENTS.md"), "outside", "utf-8");
      const linkPath = path.join(workspaceDir, "outside-link");
      try {
        await fs.symlink(path.join("..", "outside"), linkPath, "dir");
      } catch (err) {
        if (["EPERM", "EACCES", "ENOSYS"].includes((err as NodeJS.ErrnoException).code ?? "")) {
          return;
        }
        throw err;
      }

      const { files, diagnostics } = await loadExtraBootstrapFilesWithDiagnostics(workspaceDir, [
        "outside-link/**/AGENTS.md",
      ]);

      expect(files).toHaveLength(0);
      expect(diagnostics).toHaveLength(1);
      expect(diagnostics[0]?.reason).toBe("security");
      expect(diagnostics[0]?.path).toBe(path.join(workspaceDir, "outside-link/**/AGENTS.md"));
    },
  );

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

  it("loads a literal-bracket directory as a literal path", async () => {
    // `main` grammar: square brackets are literal, so `pkg[ab]/AGENTS.md` names
    // the real directory literally called `pkg[ab]` and reads that one file — it
    // is never routed to fs.glob to expand `[ab]` as a character class.
    const workspaceDir = await createWorkspaceDir("literal-brackets-multi");
    const packageDir = path.join(workspaceDir, "pkg[ab]");
    await fs.mkdir(packageDir, { recursive: true });
    await fs.writeFile(path.join(packageDir, "AGENTS.md"), "literal bracket agents", "utf-8");

    const files = await loadExtraBootstrapFileList(workspaceDir, ["pkg[ab]/AGENTS.md"]);

    expect(files).toStrictEqual([
      {
        name: "AGENTS.md",
        path: path.join(packageDir, "AGENTS.md"),
        content: "literal bracket agents",
        missing: false,
      },
    ]);
  });

  it("loads only the literal bracket dir even when sibling dirs satisfy the bracket class", async () => {
    // `main` grammar regression guard: dirs `a`/`b` would satisfy `[ab]` as a
    // character class AND a real directory literally named `[ab]` exists. Because
    // brackets are literal, `[ab]/AGENTS.md` loads ONLY the `[ab]` directory's
    // file and must NOT fan out to `a`/`b` — the pre-fix union behavior that
    // broke the one-file contract for shipped configs.
    const workspaceDir = await createWorkspaceDir("literal-bracket-only");
    for (const name of ["a", "b", "[ab]"]) {
      const dir = path.join(workspaceDir, name);
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(path.join(dir, "AGENTS.md"), `${name} agents`, "utf-8");
    }

    const files = await loadExtraBootstrapFileList(workspaceDir, ["[ab]/AGENTS.md"]);

    expect(files.map((file: { path: string }) => file.path)).toStrictEqual([
      path.join(workspaceDir, "[ab]", "AGENTS.md"),
    ]);
  });

  it("loads only the literal bracket dir, not the prefixed bracket-class siblings", async () => {
    // The named P1 regression scenario: `pkg[ab]/AGENTS.md` where a real directory
    // literally called `pkg[ab]` exists AND sibling dirs `pkga`/`pkgb` satisfy the
    // bracket class. `main` treats brackets as literal and loads only the literal
    // `pkg[ab]` file; the sibling `pkga`/`pkgb` files must NOT be injected after
    // upgrade (the compatibility regression this PR reverts).
    const workspaceDir = await createWorkspaceDir("literal-bracket-prefixed-only");
    for (const name of ["pkga", "pkgb", "pkg[ab]"]) {
      const dir = path.join(workspaceDir, name);
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(path.join(dir, "AGENTS.md"), `${name} agents`, "utf-8");
    }

    const files = await loadExtraBootstrapFileList(workspaceDir, ["pkg[ab]/AGENTS.md"]);
    const loadedPaths = files.map((file: { path: string }) => file.path);

    expect(loadedPaths).toStrictEqual([path.join(workspaceDir, "pkg[ab]", "AGENTS.md")]);
    expect(loadedPaths).not.toContain(path.join(workspaceDir, "pkga", "AGENTS.md"));
    expect(loadedPaths).not.toContain(path.join(workspaceDir, "pkgb", "AGENTS.md"));
  });

  it.runIf(process.platform !== "win32")(
    "resolves a routed mixed-bracket glob past an external bracket-named symlink without a false security reject",
    async () => {
      // F2 regression: `pkg[ab]/*/AGENTS.md` contains `*`, so it is routed to
      // fs.glob where `[ab]` is a character class matching the real `pkga`/`pkgb`
      // dirs. A directory symlink literally named `pkg[ab]` points OUTSIDE the
      // workspace. Pre-fix the security pre-gate derived the literal prefix with
      // brackets-literal grammar, realpath'd that escaping `pkg[ab]` symlink, and
      // falsely rejected the whole pattern with a `security` diagnostic even
      // though fs.glob never walks the symlink. The fix uses routed grammar for
      // the prefix so it stops before the bracket segment (collapsing to the
      // workspace root, where fs.glob actually roots the walk).
      const routedWs = await createWorkspaceDir("routed-bracket-symlink");
      const outsideRouted = await createWorkspaceDir("routed-bracket-outside");
      await fs.writeFile(path.join(outsideRouted, "AGENTS.md"), "outside", "utf-8");
      for (const name of ["pkga", "pkgb"]) {
        const dir = path.join(routedWs, name, "core");
        await fs.mkdir(dir, { recursive: true });
        await fs.writeFile(path.join(dir, "AGENTS.md"), `${name} agents`, "utf-8");
      }
      try {
        await fs.symlink(outsideRouted, path.join(routedWs, "pkg[ab]"), "dir");
      } catch (err) {
        if (["EPERM", "EACCES", "ENOSYS"].includes((err as NodeJS.ErrnoException).code ?? "")) {
          return;
        }
        throw err;
      }

      const routed = await loadExtraBootstrapFilesWithDiagnostics(routedWs, [
        "pkg[ab]/*/AGENTS.md",
      ]);
      expect(routed.diagnostics).toHaveLength(0);
      expect(routed.files.map((file) => file.path).toSorted()).toStrictEqual(
        [
          path.join(routedWs, "pkga", "core", "AGENTS.md"),
          path.join(routedWs, "pkgb", "core", "AGENTS.md"),
        ].toSorted(),
      );

      // A fully-literal `pkg[ab]/AGENTS.md` (no `? * { }`) is NOT routed: brackets
      // stay literal and name the real on-disk `pkg[ab]` directory, so the
      // `main` bracket-path compatibility contract still opens that one file.
      const literalWs = await createWorkspaceDir("literal-bracket-realdir");
      const realBracketDir = path.join(literalWs, "pkg[ab]");
      await fs.mkdir(realBracketDir, { recursive: true });
      await fs.writeFile(path.join(realBracketDir, "AGENTS.md"), "literal bracket", "utf-8");

      const literal = await loadExtraBootstrapFilesWithDiagnostics(literalWs, [
        "pkg[ab]/AGENTS.md",
      ]);
      expect(literal.diagnostics).toHaveLength(0);
      expect(literal.files.map((file) => file.path)).toStrictEqual([
        path.join(realBracketDir, "AGENTS.md"),
      ]);
    },
  );

  it("treats a bracket parent with a child glob as fs.glob (bracket is a class)", async () => {
    // A pattern that mixes brackets with real magic (`pkg[ab]/**/AGENTS.md`)
    // routes to fs.glob, where `[ab]` IS a character class — the same asymmetry
    // `main` has. With no `pkga`/`pkgb` directory the class matches nothing, so
    // the literal `pkg[ab]` subtree is not opened and nothing loads.
    const workspaceDir = await createWorkspaceDir("bracket-parent-child-glob");
    const nested = path.join(workspaceDir, "pkg[ab]", "nested");
    await fs.mkdir(nested, { recursive: true });
    await fs.writeFile(path.join(nested, "AGENTS.md"), "nested", "utf-8");

    const { files, diagnostics } = await loadExtraBootstrapFilesWithDiagnostics(workspaceDir, [
      "pkg[ab]/**/AGENTS.md",
    ]);

    expect(files).toHaveLength(0);
    expect(diagnostics).toHaveLength(0);
  });

  it("computes the walk root from the first magic segment for a bracket-then-star pattern", async () => {
    // A bracket followed by real magic (`packages/[ab]/*/AGENTS.md`) routes to
    // fs.glob, where `[ab]` is a character class. The walk-root split must cut
    // before the first `? * { }` segment (`*`), starting the walk at the literal
    // `packages/[ab]` prefix rather than misreading the whole thing as a literal
    // path. `[ab]` then matches `a` as a class and `*` matches `core`.
    const workspaceDir = await createWorkspaceDir("walk-root-magic");
    const bracketDir = path.join(workspaceDir, "packages", "a", "core");
    await fs.mkdir(bracketDir, { recursive: true });
    await fs.writeFile(path.join(bracketDir, "AGENTS.md"), "bracket agents", "utf-8");

    const bracketFiles = await loadExtraBootstrapFileList(workspaceDir, [
      "packages/[ab]/*/AGENTS.md",
    ]);
    expect(bracketFiles).toStrictEqual([
      {
        name: "AGENTS.md",
        path: path.join(bracketDir, "AGENTS.md"),
        content: "bracket agents",
        missing: false,
      },
    ]);
  });

  it("resolves a brace alternation that spans a slash through the glob walker", async () => {
    // Regression: `{a/b,c}` is a brace alternation whose members contain "/".
    // The routing gate reports it as a glob, so the walk root must be computed
    // from the brace expansions (`a/b`, `c`) rather than the raw segments — a
    // per-segment scan sees `{a` and `b,c}` as non-magic and would root the walk
    // at the bogus literal path `{a/b,c}/AGENTS.md`, silently matching nothing.
    const workspaceDir = await createWorkspaceDir("brace-slash");
    const nestedDir = path.join(workspaceDir, "a", "b");
    const topDir = path.join(workspaceDir, "c");
    await fs.mkdir(nestedDir, { recursive: true });
    await fs.mkdir(topDir, { recursive: true });
    await fs.writeFile(path.join(nestedDir, "AGENTS.md"), "nested agents", "utf-8");
    await fs.writeFile(path.join(topDir, "AGENTS.md"), "top agents", "utf-8");

    const files = await loadExtraBootstrapFileList(workspaceDir, ["{a/b,c}/AGENTS.md"]);

    expect(files.map((file: { path: string }) => file.path).toSorted()).toStrictEqual(
      [path.join(nestedDir, "AGENTS.md"), path.join(topDir, "AGENTS.md")].toSorted(),
    );
  });

  it("treats a truly-literal path with no magic as a literal file", async () => {
    // A plain path with no glob metacharacters must be read as a literal file,
    // never routed through the walker. Uses a nested literal path so it also
    // proves the walk-root fallback returns the full literal path.
    const workspaceDir = await createWorkspaceDir("literal-no-magic");
    const dir = path.join(workspaceDir, "packages", "core");
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "AGENTS.md"), "literal agents", "utf-8");

    const files = await loadExtraBootstrapFileList(workspaceDir, ["packages/core/AGENTS.md"]);

    expect(files).toStrictEqual([
      {
        name: "AGENTS.md",
        path: path.join(dir, "AGENTS.md"),
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

  it("follows a contained ancestor-pointing literal directory symlink once", async () => {
    // FIX 2: a directory symlink can point at an ancestor (`a/loop -> a`). The
    // `loop` segment is literal in `*/loop/**/AGENTS.md`, so fs.glob follows the
    // link once; the walker now matches that instead of over-rejecting it via a
    // realpath cycle guard. Termination is structural — `**` never re-crosses the
    // symlink — so the walk still completes.
    if (process.platform === "win32") {
      return;
    }

    const workspaceDir = await createWorkspaceDir("symlink-ancestor");
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

    // The ancestor link is followed exactly once, matching fs.glob, and the walk
    // terminates instead of looping.
    expect(files).toStrictEqual([
      {
        name: "AGENTS.md",
        path: path.join(dirA, "loop", "AGENTS.md"),
        content: "a agents",
        missing: false,
      },
    ]);
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
    "skips an unreadable glob branch and still loads readable matches",
    async () => {
      // Node fs.glob walks past a subtree it cannot read (EACCES) rather than
      // throwing, so an unreadable sibling package must not abort loading of the
      // readable one — the readable match still loads and no diagnostic is
      // surfaced for the skipped branch.
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
        expect(result.files).toEqual([
          expect.objectContaining({ path: path.join(readableDir, "TOOLS.md") }),
        ]);
        expect(result.diagnostics).toEqual([]);
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
