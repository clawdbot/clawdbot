import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import type { DoctorPrompter } from "./doctor-prompter.js";

const note = vi.hoisted(() => vi.fn());

vi.mock("../terminal/note.js", () => ({
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
    await expect(fs.access(path.join(tmpDir, "memory.md"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(migration.archivedLegacyPath).toBeTruthy();
    await expect(fs.access(migration.archivedLegacyPath ?? "")).resolves.toBeUndefined();
  });

  it("warns and repairs split-brain root memory through workspace doctor helpers", async () => {
    await fs.writeFile(path.join(tmpDir, "MEMORY.md"), "# Canonical\n", "utf8");
    await fs.writeFile(path.join(tmpDir, "memory.md"), "# Legacy\n", "utf8");
    const entries = new Set(await fs.readdir(tmpDir));
    if (!entries.has("MEMORY.md") || !entries.has("memory.md")) {
      return;
    }
    const cfg = { agents: { defaults: { workspace: tmpDir } } } as OpenClawConfig;
    const prompter = {
      confirmRuntimeRepair: vi.fn(async () => true),
    } as unknown as DoctorPrompter;

    await noteWorkspaceMemoryHealth(cfg);
    expect(note).toHaveBeenCalledWith(
      expect.stringContaining("Split root durable memory"),
      "Workspace memory",
    );
    note.mockClear();

    await maybeRepairWorkspaceMemoryHealth({ cfg, prompter });

    expect(prompter.confirmRuntimeRepair).toHaveBeenCalledWith({
      message: "Merge legacy root memory.md into canonical MEMORY.md and remove the shadowed file?",
      initialValue: true,
    });
    const canonical = await fs.readFile(path.join(tmpDir, "MEMORY.md"), "utf8");
    expect(canonical).toContain("# Legacy");
    await expect(fs.access(path.join(tmpDir, "memory.md"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(note).toHaveBeenCalledWith(
      expect.stringContaining("Workspace memory root merged:"),
      "Doctor changes",
    );
  });
});
