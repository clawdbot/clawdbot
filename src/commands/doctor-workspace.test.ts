// Doctor workspace tests cover workspace path checks, repairs, and user-facing notes.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import type { DoctorPrompter } from "./doctor-prompter.js";

const note = vi.hoisted(() => vi.fn());

vi.mock("../../packages/terminal-core/src/note.js", () => ({
  note,
}));

import {
  detectRootMemoryFiles,
  formatRootMemoryFilesWarning,
  maybeRepairWorkspaceMemoryHealth,
  migrateLegacyRootMemoryFile,
  noteWorkspaceMemoryHealth,
  shouldSuggestMemorySystem,
} from "./doctor-workspace.js";

async function expectPathMissing(targetPath: string): Promise<void> {
  try {
    await fs.access(targetPath);
  } catch (error) {
    expect((error as NodeJS.ErrnoException).code).toBe("ENOENT");
    return;
  }
  throw new Error(`expected path to be missing: ${targetPath}`);
}

function firstNoteCall() {
  return note.mock.calls[0];
}

describe("root memory repair", () => {
  let tmpDir = "";

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-root-memory-"));
    note.mockClear();
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("ignores lowercase-only root memory for automatic repair", async () => {
    await fs.writeFile(path.join(tmpDir, "memory.md"), "# Legacy\n", "utf8");

    const detection = await detectRootMemoryFiles(tmpDir);
    expect(detection.canonicalExists).toBe(false);
    expect(detection.legacyExists).toBe(true);
    expect(formatRootMemoryFilesWarning(detection)).toBeNull();

    const migration = await migrateLegacyRootMemoryFile(tmpDir);
    expect(migration.changed).toBe(false);
    await expect(fs.readFile(path.join(tmpDir, "memory.md"), "utf8")).resolves.toBe("# Legacy\n");
    const entries = await fs.readdir(tmpDir);
    expect(entries).toContain("memory.md");
    expect(entries).not.toContain("MEMORY.md");
    await expect(shouldSuggestMemorySystem(tmpDir)).resolves.toBe(true);
  });

  it("merges true split-brain root memory files into MEMORY.md", async () => {
    await fs.writeFile(path.join(tmpDir, "MEMORY.md"), "# Canonical\n", "utf8");
    await fs.writeFile(path.join(tmpDir, "memory.md"), "# Legacy\n", "utf8");
    const entries = new Set(await fs.readdir(tmpDir));
    if (!entries.has("MEMORY.md") || !entries.has("memory.md")) {
      return;
    }

    const detection = await detectRootMemoryFiles(tmpDir);
    expect(formatRootMemoryFilesWarning(detection)).toContain("Split root durable memory");

    const migration = await migrateLegacyRootMemoryFile(tmpDir);
    expect(migration.changed).toBe(true);
    expect(migration.removedLegacy).toBe(true);
    expect(migration.mergedLegacy).toBe(true);

    const canonical = await fs.readFile(path.join(tmpDir, "MEMORY.md"), "utf8");
    expect(canonical).toContain("# Canonical");
    expect(canonical).toContain("# Legacy");
    await expectPathMissing(path.join(tmpDir, "memory.md"));
    if (migration.archivedLegacyPath === undefined) {
      throw new Error("expected archived legacy memory path");
    }
    await expect(fs.access(migration.archivedLegacyPath)).resolves.toBeUndefined();
  });

  it("reads legacy content after moving it into the archive", async () => {
    const canonicalPath = path.join(tmpDir, "MEMORY.md");
    const legacyPath = path.join(tmpDir, "memory.md");
    await fs.writeFile(canonicalPath, "# Canonical\n", "utf8");
    await fs.writeFile(legacyPath, "# Legacy\n", "utf8");

    const rename = vi.spyOn(fs, "rename");
    rename.mockImplementationOnce(async (sourcePath, targetPath) => {
      await fs.appendFile(sourcePath, "# Added before archive\n", "utf8");
      rename.mockRestore();
      await fs.rename(sourcePath, targetPath);
    });

    const migration = await migrateLegacyRootMemoryFile(tmpDir);
    expect(migration.changed).toBe(true);
    const canonical = await fs.readFile(canonicalPath, "utf8");
    expect(canonical).toContain("# Legacy");
    expect(canonical).toContain("# Added before archive");
  });

  it("preserves the archive when the archived file grows past the read limit", async () => {
    const canonicalPath = path.join(tmpDir, "MEMORY.md");
    const legacyPath = path.join(tmpDir, "memory.md");
    await fs.writeFile(canonicalPath, "# Canonical\n", "utf8");
    await fs.writeFile(legacyPath, "# Legacy\n", "utf8");

    const rename = vi.spyOn(fs, "rename");
    rename.mockImplementationOnce(async (sourcePath, targetPath) => {
      await fs.appendFile(sourcePath, Buffer.alloc(9 * 1024 * 1024));
      rename.mockRestore();
      await fs.rename(sourcePath, targetPath);
    });

    const migration = await migrateLegacyRootMemoryFile(tmpDir);

    expect(migration.changed).toBe(true);
    expect(migration.removedLegacy).toBe(true);
    expect(migration.readLimitExceeded).toBe(true);
    await expectPathMissing(legacyPath);
    if (!migration.archivedLegacyPath) {
      throw new Error("expected preserved archive path");
    }
    await expect(fs.access(migration.archivedLegacyPath)).resolves.toBeUndefined();
  });

  it("preserves a concurrent legacy replacement beside the archive", async () => {
    const canonicalPath = path.join(tmpDir, "MEMORY.md");
    const legacyPath = path.join(tmpDir, "memory.md");
    await fs.writeFile(canonicalPath, "# Canonical\n", "utf8");
    await fs.writeFile(legacyPath, "# Legacy\n", "utf8");

    const rename = vi.spyOn(fs, "rename");
    rename.mockImplementationOnce(async (sourcePath, targetPath) => {
      await fs.appendFile(sourcePath, Buffer.alloc(9 * 1024 * 1024));
      rename.mockRestore();
      await fs.rename(sourcePath, targetPath);
      await fs.writeFile(sourcePath, "# Concurrent replacement\n", "utf8");
    });

    const migration = await migrateLegacyRootMemoryFile(tmpDir);

    expect(migration.changed).toBe(true);
    expect(migration.removedLegacy).toBe(true);
    expect(migration.readLimitExceeded).toBe(true);
    if (!migration.archivedLegacyPath) {
      throw new Error("expected preserved archive path");
    }
    await expect(fs.readFile(legacyPath, "utf8")).resolves.toBe("# Concurrent replacement\n");
    await expect(fs.access(migration.archivedLegacyPath)).resolves.toBeUndefined();
  });

  it("warns and repairs split-brain root memory through workspace doctor helpers", async () => {
    await fs.writeFile(path.join(tmpDir, "MEMORY.md"), "# Canonical\n", "utf8");
    await fs.writeFile(path.join(tmpDir, "memory.md"), "# Legacy\n", "utf8");
    const entries = new Set(await fs.readdir(tmpDir));
    if (!entries.has("MEMORY.md") || !entries.has("memory.md")) {
      return;
    }
    const cfg = {
      agents: { defaults: { workspace: tmpDir }, entries: { main: { default: true } } },
    } as OpenClawConfig;
    const prompter = {
      confirmRuntimeRepair: vi.fn(async () => true),
    } as unknown as DoctorPrompter;

    await noteWorkspaceMemoryHealth(cfg);
    const detection = await detectRootMemoryFiles(tmpDir);
    const expectedWarning = formatRootMemoryFilesWarning(detection);
    if (!expectedWarning) {
      throw new Error("expected split root memory warning");
    }
    expect(note).toHaveBeenCalledWith(expectedWarning, "Workspace memory");
    note.mockClear();

    await maybeRepairWorkspaceMemoryHealth({ cfg, prompter });

    expect(prompter.confirmRuntimeRepair).toHaveBeenCalledWith({
      message: "Merge legacy root memory.md into canonical MEMORY.md and remove the shadowed file?",
      initialValue: true,
    });
    const canonical = await fs.readFile(path.join(tmpDir, "MEMORY.md"), "utf8");
    expect(canonical).toContain("# Legacy");
    await expectPathMissing(path.join(tmpDir, "memory.md"));
    expect(note).toHaveBeenCalledTimes(1);
    const repairNote = firstNoteCall();
    const repairMessage = String(repairNote?.[0] ?? "");
    const repairLines = repairMessage.split("\n");
    expect(repairLines[0]).toBe("Workspace memory root merged:");
    expect(repairLines).toContain(`- canonical: ${path.join(tmpDir, "MEMORY.md")}`);
    expect(repairLines).toContain(
      `- merged legacy content from: ${path.join(tmpDir, "memory.md")}`,
    );
    expect(repairLines).toContain(`- removed legacy file: ${path.join(tmpDir, "memory.md")}`);
    expect(repairNote?.[1]).toBe("Doctor changes");
  });

  it("treats an oversized AGENTS.md as missing memory guidance", async () => {
    await fs.writeFile(path.join(tmpDir, "AGENTS.md"), "x".repeat(2 * 1024 * 1024), "utf8");

    await expect(shouldSuggestMemorySystem(tmpDir)).resolves.toBe(true);
  });

  it("follows a symlinked AGENTS.md while keeping its target bounded", async () => {
    const agentsTarget = path.join(tmpDir, "agents-target.md");
    const agentsPath = path.join(tmpDir, "AGENTS.md");
    await fs.writeFile(agentsTarget, "Use MEMORY.md for durable memory.\n", "utf8");
    await fs.symlink(agentsTarget, agentsPath);

    await expect(shouldSuggestMemorySystem(tmpDir)).resolves.toBe(false);

    await fs.writeFile(agentsTarget, "MEMORY.md\n".repeat(200_000), "utf8");
    await expect(shouldSuggestMemorySystem(tmpDir)).resolves.toBe(true);
  });

  it("does not archive or remove an oversized legacy memory file", async () => {
    await fs.writeFile(path.join(tmpDir, "MEMORY.md"), "# Canonical\n", "utf8");
    await fs.writeFile(path.join(tmpDir, "memory.md"), "# Legacy\n".repeat(1_000_000), "utf8");

    const migration = await migrateLegacyRootMemoryFile(tmpDir);
    expect(migration.changed).toBe(false);
    expect(migration.removedLegacy).toBe(false);
    expect(migration.mergedLegacy).toBe(false);
    expect(migration.readLimitExceeded).toBe(true);
    await expect(fs.readFile(path.join(tmpDir, "memory.md"), "utf8")).resolves.toContain(
      "# Legacy",
    );
  });

  it("does not archive or remove a valid legacy memory file when canonical is oversized", async () => {
    await fs.writeFile(path.join(tmpDir, "MEMORY.md"), "# Canonical\n".repeat(1_000_000), "utf8");
    await fs.writeFile(path.join(tmpDir, "memory.md"), "# Legacy\n", "utf8");

    const migration = await migrateLegacyRootMemoryFile(tmpDir);
    expect(migration.changed).toBe(false);
    expect(migration.removedLegacy).toBe(false);
    expect(migration.mergedLegacy).toBe(false);
    expect(migration.readLimitExceeded).toBe(true);
    await expect(fs.readFile(path.join(tmpDir, "memory.md"), "utf8")).resolves.toContain(
      "# Legacy",
    );
  });

  it("does not archive or remove a legacy memory file when canonical cannot be read", async () => {
    const targetFile = path.join(tmpDir, "canonical-target.md");
    await fs.writeFile(targetFile, "# Canonical\n", "utf8");
    await fs.symlink(targetFile, path.join(tmpDir, "MEMORY.md"));
    await fs.writeFile(path.join(tmpDir, "memory.md"), "# Legacy\n", "utf8");

    const migration = await migrateLegacyRootMemoryFile(tmpDir);
    expect(migration.changed).toBe(false);
    expect(migration.removedLegacy).toBe(false);
    expect(migration.mergedLegacy).toBe(false);
    expect(migration.readError).toBe(true);
    expect(migration.readLimitExceeded).toBe(false);
    await expect(fs.readFile(path.join(tmpDir, "memory.md"), "utf8")).resolves.toContain(
      "# Legacy",
    );
  });

  it("reports a skipped repair when a root memory file cannot be read", async () => {
    const targetFile = path.join(tmpDir, "canonical-target.md");
    await fs.writeFile(targetFile, "# Canonical\n", "utf8");
    await fs.symlink(targetFile, path.join(tmpDir, "MEMORY.md"));
    await fs.writeFile(path.join(tmpDir, "memory.md"), "# Legacy\n", "utf8");
    const cfg = {
      agents: { defaults: { workspace: tmpDir }, entries: { main: { default: true } } },
    } as OpenClawConfig;
    const prompter = {
      confirmRuntimeRepair: vi.fn(async () => true),
    } as unknown as DoctorPrompter;

    await maybeRepairWorkspaceMemoryHealth({ cfg, prompter });

    expect(note).toHaveBeenCalledTimes(1);
    const repairNote = firstNoteCall();
    const repairMessage = String(repairNote?.[0] ?? "");
    const repairLines = repairMessage.split("\n");
    expect(repairLines[0]).toBe("Workspace memory root repair skipped (a file could not be read):");
    expect(repairLines).toContain(`- canonical: ${path.join(tmpDir, "MEMORY.md")}`);
    expect(repairLines).toContain(`- legacy: ${path.join(tmpDir, "memory.md")}`);
    expect(repairNote?.[1]).toBe("Doctor changes");
  });

  it("reports a skipped repair when a root memory file is oversized", async () => {
    await fs.writeFile(path.join(tmpDir, "MEMORY.md"), "# Canonical\n", "utf8");
    await fs.writeFile(path.join(tmpDir, "memory.md"), "# Legacy\n".repeat(1_000_000), "utf8");
    const cfg = {
      agents: { defaults: { workspace: tmpDir }, entries: { main: { default: true } } },
    } as OpenClawConfig;
    const prompter = {
      confirmRuntimeRepair: vi.fn(async () => true),
    } as unknown as DoctorPrompter;

    await maybeRepairWorkspaceMemoryHealth({ cfg, prompter });

    expect(note).toHaveBeenCalledTimes(1);
    const repairNote = firstNoteCall();
    const repairMessage = String(repairNote?.[0] ?? "");
    const repairLines = repairMessage.split("\n");
    expect(repairLines[0]).toBe(
      "Workspace memory root repair skipped (a file exceeded the safe read limit):",
    );
    expect(repairLines).toContain(`- canonical: ${path.join(tmpDir, "MEMORY.md")}`);
    expect(repairLines).toContain(`- legacy: ${path.join(tmpDir, "memory.md")}`);
    expect(repairNote?.[1]).toBe("Doctor changes");
  });

  it("skips without mutation when legacy memory cannot be archived atomically", async () => {
    const canonicalPath = path.join(tmpDir, "MEMORY.md");
    const legacyPath = path.join(tmpDir, "memory.md");
    await fs.writeFile(canonicalPath, "# Canonical\n", "utf8");
    await fs.writeFile(legacyPath, "# Legacy\n", "utf8");
    const rename = vi
      .spyOn(fs, "rename")
      .mockRejectedValueOnce(Object.assign(new Error("cross-device rename"), { code: "EXDEV" }));

    try {
      const migration = await migrateLegacyRootMemoryFile(tmpDir);

      expect(migration.changed).toBe(false);
      expect(migration.removedLegacy).toBe(false);
      expect(migration.mergedLegacy).toBe(false);
      expect(migration.archiveError).toBe(true);
      await expect(fs.readFile(canonicalPath, "utf8")).resolves.toBe("# Canonical\n");
      await expect(fs.readFile(legacyPath, "utf8")).resolves.toBe("# Legacy\n");
    } finally {
      rename.mockRestore();
    }
  });

  it("reports when legacy memory cannot be archived atomically", async () => {
    await fs.writeFile(path.join(tmpDir, "MEMORY.md"), "# Canonical\n", "utf8");
    await fs.writeFile(path.join(tmpDir, "memory.md"), "# Legacy\n", "utf8");
    const cfg = {
      agents: { defaults: { workspace: tmpDir }, entries: { main: { default: true } } },
    } as OpenClawConfig;
    const prompter = {
      confirmRuntimeRepair: vi.fn(async () => true),
    } as unknown as DoctorPrompter;
    const rename = vi
      .spyOn(fs, "rename")
      .mockRejectedValueOnce(Object.assign(new Error("cross-device rename"), { code: "EXDEV" }));

    try {
      await maybeRepairWorkspaceMemoryHealth({ cfg, prompter });
    } finally {
      rename.mockRestore();
    }

    const repairNote = firstNoteCall();
    const repairLines = String(repairNote?.[0] ?? "").split("\n");
    expect(repairLines[0]).toBe(
      "Workspace memory root repair skipped (legacy memory could not be archived atomically):",
    );
    expect(repairLines).toContain(`- canonical: ${path.join(tmpDir, "MEMORY.md")}`);
    expect(repairLines).toContain(`- legacy: ${path.join(tmpDir, "memory.md")}`);
    expect(repairNote?.[1]).toBe("Doctor changes");
  });

  it("reports a preserved archive when a failed repair cannot restore legacy", async () => {
    const canonicalPath = path.join(tmpDir, "MEMORY.md");
    const legacyPath = path.join(tmpDir, "memory.md");
    await fs.writeFile(canonicalPath, "# Canonical\n", "utf8");
    await fs.writeFile(legacyPath, "# Legacy\n", "utf8");
    const cfg = {
      agents: { defaults: { workspace: tmpDir }, entries: { main: { default: true } } },
    } as OpenClawConfig;
    const prompter = {
      confirmRuntimeRepair: vi.fn(async () => true),
    } as unknown as DoctorPrompter;
    const rename = vi.spyOn(fs, "rename");
    rename.mockImplementationOnce(async (sourcePath, targetPath) => {
      await fs.appendFile(sourcePath, Buffer.alloc(9 * 1024 * 1024));
      rename.mockRestore();
      await fs.rename(sourcePath, targetPath);
    });
    await maybeRepairWorkspaceMemoryHealth({ cfg, prompter });

    const repairLines = String(firstNoteCall()?.[0] ?? "").split("\n");
    expect(repairLines).toContainEqual(expect.stringContaining("- preserved archive: "));
  });
});
