import { mkdir, symlink } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resetPluginStateStoreForTests } from "../plugin-state/plugin-state-store.js";
import { withStateDirEnv } from "../test-helpers/state-dir-env.js";
import {
  clearMemoryArtifactProvenance,
  listMemoryArtifactProvenance,
  normalizeMemoryArtifactRelativePath,
  readMemoryArtifactProvenance,
  recordMemoryArtifactWriteProvenance,
} from "./memory-artifact-provenance.js";

afterEach(() => {
  resetPluginStateStoreForTests();
});

describe("memory artifact provenance", () => {
  it("uses the same workspace identity through symlink aliases", async () => {
    await withStateDirEnv("openclaw-memory-artifact-", async ({ tempRoot }) => {
      const workspaceDir = path.join(tempRoot, "workspace");
      const workspaceAlias = path.join(tempRoot, "workspace-alias");
      const relativePath = "memory/2026-08-20.md";
      await mkdir(workspaceDir);
      await symlink(
        workspaceDir,
        workspaceAlias,
        process.platform === "win32" ? "junction" : "dir",
      );

      await recordMemoryArtifactWriteProvenance({
        workspaceDir: workspaceAlias,
        relativePath,
        contentBefore: "",
        contentAfter: "restricted",
        originClass: "untrusted",
        observedAt: 1,
      });

      await expect(
        readMemoryArtifactProvenance({ workspaceDir, relativePath }),
      ).resolves.toMatchObject({ originClass: "untrusted" });
      await expect(listMemoryArtifactProvenance({ workspaceDir })).resolves.toEqual([
        expect.objectContaining({ relativePath }),
      ]);
    });
  });

  it("keeps the least-trusted origin sticky across later writes", async () => {
    await withStateDirEnv("openclaw-memory-artifact-", async ({ tempRoot }) => {
      const address = { workspaceDir: tempRoot, relativePath: "memory/2026-08-20.md" };
      await recordMemoryArtifactWriteProvenance({
        ...address,
        contentBefore: "",
        contentAfter: "restricted",
        originClass: "untrusted",
        observedAt: 1,
      });
      await recordMemoryArtifactWriteProvenance({
        ...address,
        contentBefore: "restricted",
        contentAfter: "restricted\ntrusted",
        originClass: "agent",
        observedAt: 2,
      });

      await expect(readMemoryArtifactProvenance(address)).resolves.toMatchObject({
        originClass: "untrusted",
        observedAt: 2,
      });
      await expect(listMemoryArtifactProvenance({ workspaceDir: tempRoot })).resolves.toEqual([
        expect.objectContaining({ relativePath: address.relativePath }),
      ]);
    });
  });

  it("does not let an older rollback erase a later reservation", async () => {
    await withStateDirEnv("openclaw-memory-artifact-", async ({ tempRoot }) => {
      const address = { workspaceDir: tempRoot, relativePath: "MEMORY.md" };
      const rollback = await recordMemoryArtifactWriteProvenance({
        ...address,
        contentBefore: "",
        contentAfter: "first",
        originClass: "agent",
        observedAt: 1,
      });
      await recordMemoryArtifactWriteProvenance({
        ...address,
        contentBefore: "first",
        contentAfter: "second",
        originClass: "agent",
        observedAt: 2,
      });

      await rollback?.();

      await expect(readMemoryArtifactProvenance(address)).resolves.toMatchObject({
        originClass: "agent",
        observedAt: 2,
      });
    });
  });

  it("clears only the record matching the deleted file content", async () => {
    await withStateDirEnv("openclaw-memory-artifact-", async ({ tempRoot }) => {
      const address = { workspaceDir: tempRoot, relativePath: "USER.md" };
      await recordMemoryArtifactWriteProvenance({
        ...address,
        contentBefore: "",
        contentAfter: "current",
        originClass: "agent",
        observedAt: 1,
      });

      await clearMemoryArtifactProvenance({ ...address, contentBefore: "stale" });
      await expect(readMemoryArtifactProvenance(address)).resolves.toBeDefined();
      await clearMemoryArtifactProvenance({ ...address, contentBefore: "current" });
      await expect(readMemoryArtifactProvenance(address)).resolves.toBeUndefined();
    });
  });

  it("accepts only host-owned memory artifact paths", () => {
    expect(normalizeMemoryArtifactRelativePath("memory/2026-08-20.md")).toBe(
      "memory/2026-08-20.md",
    );
    expect(normalizeMemoryArtifactRelativePath("MEMORY.md")).toBe("MEMORY.md");
    expect(normalizeMemoryArtifactRelativePath("memory/dreaming/state.md")).toBeUndefined();
    expect(normalizeMemoryArtifactRelativePath("../memory/escape.md")).toBeUndefined();
  });
});
