import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeTempWorkspace, writeWorkspaceFile } from "../test-helpers/workspace.js";
import { clearAllBootstrapSnapshots, getOrLoadBootstrapFiles } from "./bootstrap-cache.js";
import { loadWorkspaceBootstrapFiles, DEFAULT_AGENTS_FILENAME } from "./workspace.js";

describe("workspace bootstrap file caching", () => {
  let workspaceDir: string;

  beforeEach(async () => {
    clearAllBootstrapSnapshots();
    workspaceDir = await makeTempWorkspace("openclaw-bootstrap-cache-test-");
  });

  afterEach(() => {
    clearAllBootstrapSnapshots();
  });

  const loadAgentsFile = async (dir: string) => {
    const result = await loadWorkspaceBootstrapFiles(dir);
    return result.find((f) => f.name === DEFAULT_AGENTS_FILENAME);
  };

  const loadSessionAgentsFile = async (dir: string, sessionKey: string) => {
    const result = await getOrLoadBootstrapFiles({ workspaceDir: dir, sessionKey });
    return result.find((f) => f.name === DEFAULT_AGENTS_FILENAME);
  };

  const expectAgentsContent = (
    agentsFile: Awaited<ReturnType<typeof loadAgentsFile>>,
    content: string,
  ) => {
    expect(agentsFile?.content).toBe(content);
    expect(agentsFile?.missing).toBe(false);
  };

  it("returns cached content when mtime unchanged", async () => {
    const content1 = "# Initial content";
    await writeWorkspaceFile({
      dir: workspaceDir,
      name: DEFAULT_AGENTS_FILENAME,
      content: content1,
    });

    // First load
    const agentsFile1 = await loadAgentsFile(workspaceDir);
    expectAgentsContent(agentsFile1, content1);

    // Second load should use cached content (same mtime)
    const agentsFile2 = await loadAgentsFile(workspaceDir);
    expectAgentsContent(agentsFile2, content1);

    // Verify both calls returned the same content without re-reading
    expect(agentsFile1?.content).toBe(agentsFile2?.content);
  });

  it("invalidates cache when mtime changes", async () => {
    const content1 = "# Initial content";
    const content2 = "# Updated content";
    const filePath = path.join(workspaceDir, DEFAULT_AGENTS_FILENAME);

    await writeWorkspaceFile({
      dir: workspaceDir,
      name: DEFAULT_AGENTS_FILENAME,
      content: content1,
    });

    // First load
    const agentsFile1 = await loadAgentsFile(workspaceDir);
    expectAgentsContent(agentsFile1, content1);

    // Modify the file
    await writeWorkspaceFile({
      dir: workspaceDir,
      name: DEFAULT_AGENTS_FILENAME,
      content: content2,
    });
    // Some filesystems have coarse mtime precision; bump it explicitly.
    const bumpedTime = new Date(Date.now() + 1_000);
    await fs.utimes(filePath, bumpedTime, bumpedTime);

    // Second load should detect the change and return new content
    const agentsFile2 = await loadAgentsFile(workspaceDir);
    expectAgentsContent(agentsFile2, content2);
  });

  it("refreshes session bootstrap snapshots after workspace file changes", async () => {
    const content1 = "# Initial content";
    const content2 = "# Updated content";
    const filePath = path.join(workspaceDir, DEFAULT_AGENTS_FILENAME);

    await writeWorkspaceFile({
      dir: workspaceDir,
      name: DEFAULT_AGENTS_FILENAME,
      content: content1,
    });

    const agentsFile1 = await loadSessionAgentsFile(workspaceDir, "agent:main:main");
    expectAgentsContent(agentsFile1, content1);

    await writeWorkspaceFile({
      dir: workspaceDir,
      name: DEFAULT_AGENTS_FILENAME,
      content: content2,
    });
    const bumpedTime = new Date(Date.now() + 1_000);
    await fs.utimes(filePath, bumpedTime, bumpedTime);

    const agentsFile2 = await loadSessionAgentsFile(workspaceDir, "agent:main:main");
    expectAgentsContent(agentsFile2, content2);
  });

  it("invalidates cache when inode changes with same mtime", async () => {
    if (process.platform === "win32") {
      return;
    }
    const content1 = "# old-content";
    const content2 = "# new-content";
    const filePath = path.join(workspaceDir, DEFAULT_AGENTS_FILENAME);
    const tempPath = path.join(workspaceDir, ".AGENTS.tmp");

    await writeWorkspaceFile({
      dir: workspaceDir,
      name: DEFAULT_AGENTS_FILENAME,
      content: content1,
    });
    const originalStat = await fs.stat(filePath);

    const agentsFile1 = await loadAgentsFile(workspaceDir);
    expectAgentsContent(agentsFile1, content1);

    await fs.writeFile(tempPath, content2, "utf-8");
    await fs.utimes(tempPath, originalStat.atime, originalStat.mtime);
    await fs.rename(tempPath, filePath);
    await fs.utimes(filePath, originalStat.atime, originalStat.mtime);

    const agentsFile2 = await loadAgentsFile(workspaceDir);
    expectAgentsContent(agentsFile2, content2);
  });

  it("handles file deletion gracefully", async () => {
    const content = "# Some content";
    const filePath = path.join(workspaceDir, DEFAULT_AGENTS_FILENAME);

    await writeWorkspaceFile({ dir: workspaceDir, name: DEFAULT_AGENTS_FILENAME, content });

    // First load
    const agentsFile1 = await loadAgentsFile(workspaceDir);
    expectAgentsContent(agentsFile1, content);

    // Delete the file
    await fs.unlink(filePath);

    // Second load should handle deletion gracefully
    const result2 = await loadWorkspaceBootstrapFiles(workspaceDir);
    const agentsFile2 = result2.find((f) => f.name === DEFAULT_AGENTS_FILENAME);
    expect(agentsFile2?.missing).toBe(true);
    expect(agentsFile2?.content).toBeUndefined();
  });

  it("handles concurrent access", async () => {
    const content = "# Concurrent test content";
    await writeWorkspaceFile({ dir: workspaceDir, name: DEFAULT_AGENTS_FILENAME, content });

    // Multiple concurrent loads should all succeed
    const promises = Array.from({ length: 10 }, () => loadWorkspaceBootstrapFiles(workspaceDir));

    const results = await Promise.all(promises);

    // All results should be identical
    for (const result of results) {
      const agentsFile = result.find((f) => f.name === DEFAULT_AGENTS_FILENAME);
      expectAgentsContent(agentsFile, content);
    }
  });

  it("caches files independently by path", async () => {
    const content1 = "# File 1 content";
    const content2 = "# File 2 content";

    // Create two different workspace directories
    const workspace1 = await makeTempWorkspace("openclaw-cache-test1-");
    const workspace2 = await makeTempWorkspace("openclaw-cache-test2-");

    await writeWorkspaceFile({ dir: workspace1, name: DEFAULT_AGENTS_FILENAME, content: content1 });
    await writeWorkspaceFile({ dir: workspace2, name: DEFAULT_AGENTS_FILENAME, content: content2 });

    // Load from both workspaces
    const result1 = await loadWorkspaceBootstrapFiles(workspace1);
    const result2 = await loadWorkspaceBootstrapFiles(workspace2);

    const agentsFile1 = result1.find((f) => f.name === DEFAULT_AGENTS_FILENAME);
    const agentsFile2 = result2.find((f) => f.name === DEFAULT_AGENTS_FILENAME);

    expect(agentsFile1?.content).toBe(content1);
    expect(agentsFile2?.content).toBe(content2);
  });

  it("returns missing=true when bootstrap file never existed", async () => {
    const agentsFile = await loadAgentsFile(workspaceDir);
    expect(agentsFile?.missing).toBe(true);
    expect(agentsFile?.content).toBeUndefined();
  });
});
