// Covers git root and HEAD path discovery.
import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { withTempDir } from "../test-helpers/temp-dir.js";
import { findGitRoot, resolveGitHeadPath } from "./git-root.js";

async function expectGitRootResolution(params: {
  label: string;
  setup: (
    temp: string,
  ) => Promise<{ startPath: string; expectedRoot: string | null; expectedHead: string | null }>;
}): Promise<void> {
  await withTempDir({ prefix: `openclaw-${params.label}-` }, async (temp) => {
    const { startPath, expectedRoot, expectedHead } = await params.setup(temp);
    expect(findGitRoot(startPath)).toBe(expectedRoot);
    expect(resolveGitHeadPath(startPath)).toBe(expectedHead);
  });
}

describe("git-root", () => {
  it.each([
    {
      name: "starting at the repo root itself",
      label: "git-root-self",
      setup: async (temp: string) => {
        const repoRoot = path.join(temp, "repo");
        await fs.mkdir(path.join(repoRoot, ".git"), { recursive: true });
        return {
          startPath: repoRoot,
          expectedRoot: repoRoot,
          expectedHead: path.join(repoRoot, ".git", "HEAD"),
        };
      },
    },
    {
      name: ".git is a directory",
      label: "git-root-dir",
      setup: async (temp: string) => {
        const repoRoot = path.join(temp, "repo");
        const workspace = path.join(repoRoot, "nested", "workspace");
        await fs.mkdir(path.join(repoRoot, ".git"), { recursive: true });
        await fs.mkdir(workspace, { recursive: true });
        return {
          startPath: workspace,
          expectedRoot: repoRoot,
          expectedHead: path.join(repoRoot, ".git", "HEAD"),
        };
      },
    },
    {
      name: ".git is a gitdir pointer file",
      label: "git-root-file",
      setup: async (temp: string) => {
        const repoRoot = path.join(temp, "repo");
        const workspace = path.join(repoRoot, "nested", "workspace");
        const gitDir = path.join(repoRoot, ".actual-git");
        await fs.mkdir(workspace, { recursive: true });
        await fs.mkdir(gitDir, { recursive: true });
        await fs.writeFile(path.join(repoRoot, ".git"), "gitdir: .actual-git\n", "utf-8");
        return {
          startPath: workspace,
          expectedRoot: repoRoot,
          expectedHead: path.join(gitDir, "HEAD"),
        };
      },
    },
    {
      name: "invalid gitdir content still keeps root detection",
      label: "git-root-invalid-file",
      setup: async (temp: string) => {
        const parentRoot = path.join(temp, "repo");
        const childRoot = path.join(parentRoot, "child");
        const nested = path.join(childRoot, "nested");
        await fs.mkdir(path.join(parentRoot, ".git"), { recursive: true });
        await fs.mkdir(nested, { recursive: true });
        await fs.writeFile(path.join(childRoot, ".git"), "not-a-gitdir-pointer\n", "utf-8");
        return {
          startPath: nested,
          expectedRoot: childRoot,
          expectedHead: path.join(parentRoot, ".git", "HEAD"),
        };
      },
    },
    {
      name: "invalid gitdir content without a parent repo",
      label: "git-root-invalid-only",
      setup: async (temp: string) => {
        const repoRoot = path.join(temp, "repo");
        const nested = path.join(repoRoot, "nested");
        await fs.mkdir(nested, { recursive: true });
        await fs.writeFile(path.join(repoRoot, ".git"), "not-a-gitdir-pointer\n", "utf-8");
        return {
          startPath: nested,
          expectedRoot: repoRoot,
          expectedHead: null,
        };
      },
    },
  ])("resolves git roots when $name", async ({ label, setup }) => {
    await expectGitRootResolution({ label, setup });
  });

  it("respects maxDepth traversal limit", async () => {
    await withTempDir({ prefix: "openclaw-git-root-depth-" }, async (temp) => {
      const repoRoot = path.join(temp, "repo");
      const nested = path.join(repoRoot, "a", "b", "c");
      await fs.mkdir(path.join(repoRoot, ".git"), { recursive: true });
      await fs.mkdir(nested, { recursive: true });

      expect(findGitRoot(nested, { maxDepth: 2 })).toBeNull();
      expect(resolveGitHeadPath(nested, { maxDepth: 2 })).toBeNull();
    });
  });
});
