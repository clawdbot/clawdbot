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

  it("skips bootstrap glob matches in ignored directories", async () => {
    const workspaceDir = await createWorkspaceDir("glob-ignored-dirs");
    const packageDir = path.join(workspaceDir, "packages", "core");
    await fs.mkdir(path.join(workspaceDir, "node_modules", "pkg"), { recursive: true });
    await fs.mkdir(path.join(workspaceDir, ".git", "hooks"), { recursive: true });
    await fs.mkdir(packageDir, { recursive: true });
    await fs.writeFile(
      path.join(workspaceDir, "node_modules", "pkg", "AGENTS.md"),
      "deps",
      "utf-8",
    );
    await fs.writeFile(path.join(workspaceDir, ".git", "hooks", "AGENTS.md"), "git", "utf-8");
    await fs.writeFile(path.join(packageDir, "AGENTS.md"), "project", "utf-8");

    const files = await loadExtraBootstrapFileList(workspaceDir, ["**/AGENTS.md"]);

    expect(files).toStrictEqual([
      {
        name: "AGENTS.md",
        path: path.join(packageDir, "AGENTS.md"),
        content: "project",
        missing: false,
      },
    ]);
  });

  it("honors explicit globs rooted in an ignored directory", async () => {
    const workspaceDir = await createWorkspaceDir("glob-explicit-ignored-dir");
    const distDir = path.join(workspaceDir, "dist", "nested");
    await fs.mkdir(distDir, { recursive: true });
    await fs.writeFile(path.join(distDir, "AGENTS.md"), "dist agents", "utf-8");

    const files = await loadExtraBootstrapFiles(workspaceDir, ["dist/**/AGENTS.md"]);

    expect(files).toStrictEqual([
      {
        name: "AGENTS.md",
        path: path.join(distDir, "AGENTS.md"),
        content: "dist agents",
        missing: false,
      },
    ]);
  });

  it("still prunes ignored directories for non-explicit globs", async () => {
    const workspaceDir = await createWorkspaceDir("glob-prune-non-explicit");
    await fs.mkdir(path.join(workspaceDir, "node_modules", "pkg"), { recursive: true });
    await fs.writeFile(
      path.join(workspaceDir, "node_modules", "pkg", "AGENTS.md"),
      "deps",
      "utf-8",
    );

    const files = await loadExtraBootstrapFiles(workspaceDir, ["**/AGENTS.md"]);

    expect(files).toHaveLength(0);
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

  it("returns matches in lexicographically sorted normalized-relative-path order", async () => {
    // Regression: the walker visits directories in filesystem order, which varies
    // across machines. Matches must come back sorted by normalized relative path
    // so bootstrap byte order stays deterministic and the prompt cache is stable.
    const workspaceDir = await createWorkspaceDir("glob-stable-order");
    // Create siblings whose sorted order differs from creation order.
    for (const name of ["zeta", "alpha", "mid", "beta"]) {
      const packageDir = path.join(workspaceDir, "packages", name);
      await fs.mkdir(packageDir, { recursive: true });
      await fs.writeFile(path.join(packageDir, "AGENTS.md"), name, "utf-8");
    }

    const files = await loadExtraBootstrapFiles(workspaceDir, ["packages/*/AGENTS.md"]);

    expect(files.map((file) => file.path)).toStrictEqual([
      path.join(workspaceDir, "packages", "alpha", "AGENTS.md"),
      path.join(workspaceDir, "packages", "beta", "AGENTS.md"),
      path.join(workspaceDir, "packages", "mid", "AGENTS.md"),
      path.join(workspaceDir, "packages", "zeta", "AGENTS.md"),
    ]);
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
