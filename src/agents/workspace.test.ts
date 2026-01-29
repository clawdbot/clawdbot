import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  DEFAULT_AGENTS_FILENAME,
  DEFAULT_IDENTITY_FILENAME,
  DEFAULT_MEMORY_ALT_FILENAME,
  DEFAULT_MEMORY_DIR,
  DEFAULT_MEMORY_FILENAME,
  DEFAULT_SOUL_FILENAME,
  DEFAULT_USER_FILENAME,
  ensureAgentWorkspace,
  loadWorkspaceBootstrapFiles,
} from "./workspace.js";
import { makeTempWorkspace, writeWorkspaceFile } from "../test-helpers/workspace.js";

describe("loadWorkspaceBootstrapFiles", () => {
  it("includes MEMORY.md when present", async () => {
    const tempDir = await makeTempWorkspace("moltbot-workspace-");
    await writeWorkspaceFile({ dir: tempDir, name: "MEMORY.md", content: "memory" });

    const files = await loadWorkspaceBootstrapFiles(tempDir);
    const memoryEntries = files.filter((file) =>
      [DEFAULT_MEMORY_FILENAME, DEFAULT_MEMORY_ALT_FILENAME].includes(file.name),
    );

    expect(memoryEntries).toHaveLength(1);
    expect(memoryEntries[0]?.missing).toBe(false);
    expect(memoryEntries[0]?.content).toBe("memory");
  });

  it("includes memory.md when MEMORY.md is absent", async () => {
    const tempDir = await makeTempWorkspace("moltbot-workspace-");
    await writeWorkspaceFile({ dir: tempDir, name: "memory.md", content: "alt" });

    const files = await loadWorkspaceBootstrapFiles(tempDir);
    const memoryEntries = files.filter((file) =>
      [DEFAULT_MEMORY_FILENAME, DEFAULT_MEMORY_ALT_FILENAME].includes(file.name),
    );

    expect(memoryEntries).toHaveLength(1);
    expect(memoryEntries[0]?.missing).toBe(false);
    expect(memoryEntries[0]?.content).toBe("alt");
  });

  it("omits memory entries when no memory files exist", async () => {
    const tempDir = await makeTempWorkspace("moltbot-workspace-");

    const files = await loadWorkspaceBootstrapFiles(tempDir);
    const memoryEntries = files.filter((file) =>
      [DEFAULT_MEMORY_FILENAME, DEFAULT_MEMORY_ALT_FILENAME].includes(file.name),
    );

    expect(memoryEntries).toHaveLength(0);
  });
});

describe("ensureAgentWorkspace", () => {
  it("creates memory directory with symlinks to identity files", async () => {
    const tempDir = await makeTempWorkspace("moltbot-workspace-");

    const result = await ensureAgentWorkspace({
      dir: tempDir,
      ensureBootstrapFiles: true,
    });

    // Check memory directory was created
    expect(result.memoryDir).toBe(path.join(tempDir, DEFAULT_MEMORY_DIR));
    const memoryDirStat = await fs.stat(result.memoryDir!);
    expect(memoryDirStat.isDirectory()).toBe(true);

    // Check symlinks exist in memory directory
    const memoryFiles = await fs.readdir(result.memoryDir!);
    expect(memoryFiles).toContain(DEFAULT_SOUL_FILENAME);
    expect(memoryFiles).toContain(DEFAULT_USER_FILENAME);
    expect(memoryFiles).toContain(DEFAULT_AGENTS_FILENAME);
    expect(memoryFiles).toContain(DEFAULT_IDENTITY_FILENAME);

    // Check symlinks point to correct files
    const soulLink = await fs.readlink(path.join(result.memoryDir!, DEFAULT_SOUL_FILENAME));
    expect(soulLink).toBe(`../${DEFAULT_SOUL_FILENAME}`);
  });

  it("does not create memory directory when ensureBootstrapFiles is false", async () => {
    const tempDir = await makeTempWorkspace("moltbot-workspace-");

    const result = await ensureAgentWorkspace({
      dir: tempDir,
      ensureBootstrapFiles: false,
    });

    expect(result.memoryDir).toBeUndefined();
    const memoryDirPath = path.join(tempDir, DEFAULT_MEMORY_DIR);
    await expect(fs.access(memoryDirPath)).rejects.toThrow();
  });

  it("does not overwrite existing files in memory directory", async () => {
    const tempDir = await makeTempWorkspace("moltbot-workspace-");
    const memoryDir = path.join(tempDir, DEFAULT_MEMORY_DIR);
    await fs.mkdir(memoryDir, { recursive: true });

    // Create an existing file in memory directory
    const existingContent = "existing content";
    await fs.writeFile(path.join(memoryDir, DEFAULT_SOUL_FILENAME), existingContent);

    await ensureAgentWorkspace({
      dir: tempDir,
      ensureBootstrapFiles: true,
    });

    // Check existing file was not overwritten
    const content = await fs.readFile(path.join(memoryDir, DEFAULT_SOUL_FILENAME), "utf-8");
    expect(content).toBe(existingContent);
  });
});
