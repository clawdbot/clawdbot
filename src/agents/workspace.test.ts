import { describe, expect, it } from "vitest";

import {
  DEFAULT_AGENTS_FILENAME,
  DEFAULT_MEMORY_ALT_FILENAME,
  DEFAULT_MEMORY_FILENAME,
  DEFAULT_TOOLS_FILENAME,
  filterBootstrapFilesForSession,
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

  it("includes extraWorkspaceFiles when present", async () => {
    const tempDir = await makeTempWorkspace("clawdbot-workspace-");
    await writeWorkspaceFile({ dir: tempDir, name: "PANTHEON.md", content: "shared protocols" });

    const files = await loadWorkspaceBootstrapFiles(tempDir, {
      extraFiles: ["PANTHEON.md"],
    });

    const extra = files.find((f) => f.name === "PANTHEON.md");
    expect(extra).toBeDefined();
    expect(extra?.missing).toBe(false);
    expect(extra?.content).toBe("shared protocols");
    expect(extra?.isExtra).toBe(true);
  });

  it("skips extraWorkspaceFiles when file does not exist", async () => {
    const tempDir = await makeTempWorkspace("clawdbot-workspace-");

    const files = await loadWorkspaceBootstrapFiles(tempDir, {
      extraFiles: ["MISSING.md"],
    });

    // Extra files that don't exist are silently skipped (not marked missing)
    const extra = files.find((f) => f.name === "MISSING.md");
    expect(extra).toBeUndefined();
  });

  it("dedupes extraWorkspaceFiles against defaults", async () => {
    const tempDir = await makeTempWorkspace("clawdbot-workspace-");
    await writeWorkspaceFile({ dir: tempDir, name: "AGENTS.md", content: "default" });

    const files = await loadWorkspaceBootstrapFiles(tempDir, {
      extraFiles: ["AGENTS.md"], // duplicate of default
    });

    // Should only have one AGENTS.md entry (the default)
    const agentsEntries = files.filter((f) => f.name === DEFAULT_AGENTS_FILENAME);
    expect(agentsEntries).toHaveLength(1);
    expect(agentsEntries[0]?.isExtra).toBeUndefined();
  });
});

describe("filterBootstrapFilesForSession", () => {
  it("returns all files for main session", () => {
    const files = [
      { name: DEFAULT_AGENTS_FILENAME, path: "/a/AGENTS.md", missing: false },
      { name: DEFAULT_TOOLS_FILENAME, path: "/a/TOOLS.md", missing: false },
      { name: "IDENTITY.md", path: "/a/IDENTITY.md", missing: false },
      { name: "PANTHEON.md", path: "/a/PANTHEON.md", missing: false, isExtra: true },
    ];

    const filtered = filterBootstrapFilesForSession(files, "agent:main:main");
    expect(filtered).toHaveLength(4);
  });

  it("filters to allowlist + extras for subagent session", () => {
    const files = [
      { name: DEFAULT_AGENTS_FILENAME, path: "/a/AGENTS.md", missing: false },
      { name: DEFAULT_TOOLS_FILENAME, path: "/a/TOOLS.md", missing: false },
      { name: "IDENTITY.md", path: "/a/IDENTITY.md", missing: false },
      { name: "PANTHEON.md", path: "/a/PANTHEON.md", missing: false, isExtra: true },
    ];

    const filtered = filterBootstrapFilesForSession(files, "agent:main:subagent:abc123");
    expect(filtered).toHaveLength(3); // AGENTS.md, TOOLS.md, PANTHEON.md (extra)
    expect(filtered.map((f) => f.name).sort()).toEqual(["AGENTS.md", "PANTHEON.md", "TOOLS.md"]);
  });
});
