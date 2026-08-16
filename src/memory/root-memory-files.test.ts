import { mkdirSync, chmodSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  CANONICAL_ROOT_MEMORY_FILENAME,
  exactWorkspaceEntryExists,
  resolveCanonicalRootMemoryFile,
} from "./root-memory-files.js";

const isRoot = process.getuid && process.getuid() === 0;
const canTestEacces = process.platform !== "win32" && !isRoot;

describe("resolveCanonicalRootMemoryFile", () => {
  it("returns null for non-existent directory", async () => {
    const result = await resolveCanonicalRootMemoryFile(
      join(tmpdir(), `no-such-dir-${Date.now()}`),
    );
    expect(result).toBeNull();
  });

  it("returns null when directory has no MEMORY.md", async () => {
    const dir = join(tmpdir(), `root-memory-test-empty-${Date.now()}`);
    try {
      mkdirSync(dir, { recursive: true });
      const result = await resolveCanonicalRootMemoryFile(dir);
      expect(result).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns path when MEMORY.md exists as a regular file", async () => {
    const dir = join(tmpdir(), `root-memory-test-exists-${Date.now()}`);
    try {
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, CANONICAL_ROOT_MEMORY_FILENAME), "# Memory\n");
      const result = await resolveCanonicalRootMemoryFile(dir);
      expect(result).toBe(join(dir, CANONICAL_ROOT_MEMORY_FILENAME));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("re-throws EACCES when directory is not readable", async ({ skip }) => {
    if (!canTestEacces) return skip();
    const dir = join(tmpdir(), `root-memory-test-eacces-${Date.now()}`);
    try {
      mkdirSync(dir, { recursive: true });
      chmodSync(dir, 0o000);
      await expect(resolveCanonicalRootMemoryFile(dir)).rejects.toThrow();
    } finally {
      try {
        chmodSync(dir, 0o755);
      } catch {
        // already gone
      }
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("exactWorkspaceEntryExists", () => {
  it("returns false for non-existent directory", async () => {
    const result = await exactWorkspaceEntryExists(
      join(tmpdir(), `no-such-dir-${Date.now()}`),
      "MEMORY.md",
    );
    expect(result).toBe(false);
  });

  it("returns true when entry exists", async () => {
    const dir = join(tmpdir(), `exact-entry-test-exists-${Date.now()}`);
    try {
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "MEMORY.md"), "");
      const result = await exactWorkspaceEntryExists(dir, "MEMORY.md");
      expect(result).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns false when entry does not exist", async () => {
    const dir = join(tmpdir(), `exact-entry-test-missing-${Date.now()}`);
    try {
      mkdirSync(dir, { recursive: true });
      const result = await exactWorkspaceEntryExists(dir, "MEMORY.md");
      expect(result).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("re-throws EACCES when directory is not readable", async ({ skip }) => {
    if (!canTestEacces) return skip();
    const dir = join(tmpdir(), `exact-entry-test-eacces-${Date.now()}`);
    try {
      mkdirSync(dir, { recursive: true });
      chmodSync(dir, 0o000);
      await expect(exactWorkspaceEntryExists(dir, "MEMORY.md")).rejects.toThrow();
    } finally {
      try {
        chmodSync(dir, 0o755);
      } catch {
        // already gone
      }
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
