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

  it("caps expanded bootstrap glob matches", async () => {
    const workspaceDir = await createWorkspaceDir("glob-match-limit");
    await Promise.all(
      Array.from({ length: 140 }, async (_, index) => {
        const packageDir = path.join(workspaceDir, "packages", `pkg-${index}`);
        await fs.mkdir(packageDir, { recursive: true });
        await fs.writeFile(path.join(packageDir, "AGENTS.md"), `agents ${index}`, "utf-8");
      }),
    );

    const files = await loadExtraBootstrapFileList(workspaceDir, ["packages/*/AGENTS.md"]);

    expect(files).toHaveLength(128);
  });

  it("stops on the traversal limit when matches appear late in a huge tree", async () => {
    // Regression: a sparse pattern can yield zero matches until very late, so a
    // match-count cap alone never fires. The walker must bound on entries it
    // visits (visitedEntries), not just yielded matches, or the event loop
    // stalls scanning the whole tree. Fill the root with >20,000 non-matching
    // entries so the visit limit fires while still iterating root, before the
    // late-match subdir is ever popped off the traversal stack.
    const workspaceDir = await createWorkspaceDir("glob-sparse-late-match");
    const lateDir = path.join(workspaceDir, "late");
    await fs.mkdir(lateDir, { recursive: true });
    await fs.writeFile(path.join(lateDir, "AGENTS.md"), "late agents", "utf-8");

    // Batched writes keep concurrent file descriptors well under the OS limit.
    const noiseCount = 21_000;
    const batchSize = 200;
    for (let start = 0; start < noiseCount; start += batchSize) {
      const end = Math.min(start + batchSize, noiseCount);
      await Promise.all(
        Array.from({ length: end - start }, (_, offset) =>
          fs.writeFile(path.join(workspaceDir, `noise-${start + offset}.txt`), "x", "utf-8"),
        ),
      );
    }

    const { files, diagnostics } = await loadExtraBootstrapFilesWithDiagnostics(workspaceDir, [
      "**/AGENTS.md",
    ]);

    // The late match lives behind the traversal limit, so it must be dropped and
    // the truncation reported even though almost nothing matched.
    expect(files).toHaveLength(0);
    expect(diagnostics).toContainEqual(
      expect.objectContaining({
        reason: "glob-match-limit",
        path: "**/AGENTS.md",
      }),
    );
  });

  it("emits a glob-match-limit diagnostic when match cap is hit", async () => {
    const workspaceDir = await createWorkspaceDir("glob-match-limit-diagnostic");
    await Promise.all(
      Array.from({ length: 140 }, async (_, index) => {
        const packageDir = path.join(workspaceDir, "packages", `pkg-${index}`);
        await fs.mkdir(packageDir, { recursive: true });
        await fs.writeFile(path.join(packageDir, "AGENTS.md"), `agents ${index}`, "utf-8");
      }),
    );

    const { files, diagnostics } = await loadExtraBootstrapFilesWithDiagnostics(workspaceDir, [
      "packages/*/AGENTS.md",
    ]);

    expect(files).toHaveLength(128);
    expect(diagnostics).toContainEqual(
      expect.objectContaining({
        reason: "glob-match-limit",
        path: "packages/*/AGENTS.md",
      }),
    );
    expect(diagnostics[0].detail).toContain("truncated");
  });

  it("does not emit glob-match-limit diagnostic when under cap", async () => {
    const workspaceDir = await createWorkspaceDir("glob-no-truncation");
    await Promise.all(
      Array.from({ length: 5 }, async (_, index) => {
        const packageDir = path.join(workspaceDir, "packages", `pkg-${index}`);
        await fs.mkdir(packageDir, { recursive: true });
        await fs.writeFile(path.join(packageDir, "AGENTS.md"), `agents ${index}`, "utf-8");
      }),
    );

    const { files, diagnostics } = await loadExtraBootstrapFilesWithDiagnostics(workspaceDir, [
      "packages/*/AGENTS.md",
    ]);

    expect(files).toHaveLength(5);
    const truncationDiags = diagnostics.filter((d) => d.reason === "glob-match-limit");
    expect(truncationDiags).toHaveLength(0);
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
