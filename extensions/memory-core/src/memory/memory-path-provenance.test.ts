// Memory Core tests cover workspace path provenance classification.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { readMemoryArtifactProvenance } from "openclaw/plugin-sdk/memory-core-host-runtime-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createMemoryCoreTestHarness } from "../test-helpers.js";
import { resolveMemoryPathClassification } from "./memory-path-provenance.js";

vi.mock("openclaw/plugin-sdk/memory-core-host-runtime-core", { spy: true });

createMemoryCoreTestHarness();

afterEach(() => {
  vi.restoreAllMocks();
});

describe("memory path provenance", () => {
  it("trusts canonical workspace memory while excluding system and lookalike paths", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "memory-path-provenance-"));
    const workspaceDir = path.join(root, "workspace");
    const outsideDir = path.join(root, "outside");
    await fs.mkdir(path.join(workspaceDir, "memory", "projects"), { recursive: true });
    await fs.mkdir(path.join(workspaceDir, "memory", "dreaming", "deep"), { recursive: true });
    await fs.mkdir(path.join(workspaceDir, "Memory"), { recursive: true });
    await fs.mkdir(outsideDir, { recursive: true });

    const classify = async (relativePath: string, source: "memory" | "sessions" = "memory") => {
      const absolutePath = path.join(workspaceDir, relativePath);
      await fs.mkdir(path.dirname(absolutePath), { recursive: true });
      await fs.writeFile(absolutePath, "fixture");
      return await resolveMemoryPathClassification({ absolutePath, source, workspaceDir });
    };

    await expect(classify("MEMORY.md")).resolves.toEqual({
      curatedRoot: true,
      originClass: "agent",
    });
    await expect(classify("USER.md")).resolves.toEqual({
      curatedRoot: true,
      originClass: "agent",
    });
    await expect(classify("memory/2026-07-27.md")).resolves.toMatchObject({
      originClass: "agent",
    });
    await expect(classify("memory/projects/notes.md")).resolves.toMatchObject({
      originClass: "agent",
    });
    await expect(classify("DREAMS.md")).resolves.toMatchObject({ originClass: "system" });
    await expect(classify("memory/dreaming/deep/report.md")).resolves.toMatchObject({
      originClass: "system",
    });
    await expect(classify("notes/extra.md")).resolves.toMatchObject({
      originClass: "untrusted",
    });
    const caseVariantDir = await fs.realpath(path.join(workspaceDir, "Memory"));
    if (path.basename(caseVariantDir) === "Memory") {
      await expect(classify("Memory/payload.md")).resolves.toMatchObject({
        originClass: "untrusted",
      });
    }
    await expect(classify("memory/2026-07-27.md", "sessions")).resolves.toMatchObject({
      originClass: "untrusted",
    });

    const outsideFile = path.join(outsideDir, "payload.md");
    await fs.writeFile(outsideFile, "outside");
    if (process.platform !== "win32") {
      await fs.symlink(outsideFile, path.join(workspaceDir, "memory", "linked.md"));
      await expect(
        resolveMemoryPathClassification({
          absolutePath: path.join(workspaceDir, "memory", "linked.md"),
          source: "memory",
          workspaceDir,
        }),
      ).resolves.toMatchObject({ originClass: "untrusted" });
    }
  });

  it("honors sticky untrusted provenance for runtime-written memory files", async () => {
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "memory-path-runtime-taint-"));
    try {
      const absolutePath = path.join(workspaceDir, "MEMORY.md");
      await fs.writeFile(absolutePath, "network-authored memory", "utf8");
      vi.mocked(readMemoryArtifactProvenance).mockResolvedValueOnce({
        fileHash: "0".repeat(64),
        originClass: "untrusted",
        observedAt: 1,
      });

      await expect(
        resolveMemoryPathClassification({ absolutePath, source: "memory", workspaceDir }),
      ).resolves.toEqual({ curatedRoot: true, originClass: "untrusted" });
    } finally {
      await fs.rm(workspaceDir, { recursive: true, force: true });
    }
  });
});
