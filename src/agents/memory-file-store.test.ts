import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { appendMemoryFileEntry, memoryFileStoreTesting } from "./memory-file-store.js";
import type { ExtensionContext } from "./sessions/extensions/types.js";
import { createWriteToolDefinition } from "./sessions/tools/write.js";

const temporaryDirectories: string[] = [];

async function makeWorkspace(prefix: string): Promise<string> {
  const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  temporaryDirectories.push(workspaceDir);
  await fs.mkdir(path.join(workspaceDir, "memory"), { recursive: true });
  return workspaceDir;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => fs.rm(directory, { recursive: true, force: true })),
  );
});

describe("memory file store", () => {
  it("rejects a readback mismatch and rolls back the pre-commit provenance", async () => {
    const rollback = vi.fn(async () => undefined);
    const recordWriteProvenance = vi.fn(async () => rollback);
    const readText = vi
      .fn<() => Promise<string>>()
      .mockResolvedValueOnce("")
      .mockResolvedValueOnce("corrupted after write\n");
    const write = vi.fn(async () => undefined);
    const store = memoryFileStoreTesting.create({
      openRoot: async () => ({ readText, write }),
      withFileMutationQueue: async (_filePath, operation) => await operation(),
    });

    await expect(
      store({
        workspaceDir: "/workspace",
        relativePath: "memory/2026-08-08.md",
        entry: "- The user prefers concise replies.",
        originClass: "agent",
        observedAt: 1,
        recordWriteProvenance,
      }),
    ).rejects.toThrow(/could not be verified/i);

    expect(recordWriteProvenance).toHaveBeenCalledOnce();
    expect(rollback).toHaveBeenCalledOnce();
  });

  it("rolls back provenance when the append commit fails", async () => {
    const rollback = vi.fn(async () => undefined);
    const recordWriteProvenance = vi.fn(async () => rollback);
    const store = memoryFileStoreTesting.create({
      openRoot: async () => ({
        readText: vi.fn(async () => ""),
        write: vi.fn(async () => {
          throw new Error("disk full");
        }),
      }),
      withFileMutationQueue: async (_filePath, operation) => await operation(),
    });

    await expect(
      store({
        workspaceDir: "/workspace",
        relativePath: "memory/2026-08-08.md",
        entry: "- The user uses metric units.",
        originClass: "untrusted",
        observedAt: 2,
        recordWriteProvenance,
      }),
    ).rejects.toThrow("disk full");

    expect(recordWriteProvenance).toHaveBeenCalledOnce();
    expect(rollback).toHaveBeenCalledOnce();
  });

  it("rejects symlink and hardlink leaf targets", async () => {
    const workspaceDir = await makeWorkspace("openclaw-memory-store-links-");
    const outsideDir = await makeWorkspace("openclaw-memory-store-links-outside-");
    const outsideFile = path.join(outsideDir, "outside.md");
    const relativePath = "memory/2026-08-08.md";
    const targetPath = path.join(workspaceDir, relativePath);
    await fs.writeFile(outsideFile, "outside\n", "utf8");

    await fs.symlink(outsideFile, targetPath, "file");
    await expect(
      appendMemoryFileEntry({
        workspaceDir,
        relativePath,
        entry: "- Must not escape.",
        originClass: "agent",
        observedAt: 3,
      }),
    ).rejects.toThrow();
    await expect(fs.readFile(outsideFile, "utf8")).resolves.toBe("outside\n");

    await fs.unlink(targetPath);
    await fs.link(outsideFile, targetPath);
    await expect(
      appendMemoryFileEntry({
        workspaceDir,
        relativePath,
        entry: "- Must not share an inode.",
        originClass: "agent",
        observedAt: 4,
      }),
    ).rejects.toThrow();
    await expect(fs.readFile(outsideFile, "utf8")).resolves.toBe("outside\n");
  });

  it("serializes against the generic write tool and records the final verified content hash", async () => {
    const workspaceDir = await makeWorkspace("openclaw-memory-store-cross-writer-");
    const relativePath = "memory/2026-08-08.md";
    const absolutePath = path.join(workspaceDir, relativePath);
    let releaseWrite!: () => void;
    let signalWriteStarted!: () => void;
    const writeRelease = new Promise<void>((resolve) => {
      releaseWrite = resolve;
    });
    const writeStarted = new Promise<void>((resolve) => {
      signalWriteStarted = resolve;
    });
    const writeTool = createWriteToolDefinition(workspaceDir, {
      operations: {
        mkdir: async (directory) => {
          await fs.mkdir(directory, { recursive: true });
        },
        readFile: async (filePath) => await fs.readFile(filePath),
        statFile: async (filePath) => {
          const stat = await fs.stat(filePath).catch(() => undefined);
          return stat
            ? { type: stat.isFile() ? "file" : "other", size: stat.size, mtimeMs: stat.mtimeMs }
            : null;
        },
        writeFile: async (filePath, content) => {
          signalWriteStarted();
          await writeRelease;
          await fs.writeFile(filePath, content, "utf8");
        },
      },
    });
    let provenanceHash: string | undefined;
    const recordWriteProvenance = vi.fn(async ({ contentAfter }: { contentAfter: string }) => {
      provenanceHash = createHash("sha256").update(contentAfter).digest("hex");
    });
    const writeAbortController = new AbortController();
    const onWriteUpdate = vi.fn();
    const writeContext = {
      get ui(): never {
        throw new Error("write tool must not access the extension UI");
      },
      hasUI: false,
      cwd: workspaceDir,
      get sessionManager(): never {
        throw new Error("write tool must not access the session manager");
      },
      get modelRegistry(): never {
        throw new Error("write tool must not access the model registry");
      },
      model: undefined,
      isIdle: () => false,
      signal: writeAbortController.signal,
      abort: () => writeAbortController.abort(),
      hasPendingMessages: () => false,
      shutdown: vi.fn(),
      getContextUsage: () => undefined,
      compact: vi.fn(),
      getSystemPrompt: () => "memory file store test",
    } satisfies ExtensionContext;

    const genericWrite = writeTool.execute(
      "generic-write",
      {
        path: relativePath,
        content: "# Daily\n",
      },
      writeAbortController.signal,
      onWriteUpdate,
      writeContext,
    );
    await writeStarted;
    const memoryStore = appendMemoryFileEntry({
      workspaceDir,
      relativePath,
      entry: "- The user uses metric units.",
      originClass: "agent",
      observedAt: 5,
      recordWriteProvenance,
    });
    await Promise.resolve();
    expect(recordWriteProvenance).not.toHaveBeenCalled();

    releaseWrite();
    await Promise.all([genericWrite, memoryStore]);

    const persisted = await fs.readFile(absolutePath, "utf8");
    expect(persisted).toBe("# Daily\n- The user uses metric units.\n");
    expect(provenanceHash).toBe(createHash("sha256").update(persisted).digest("hex"));
  });
});
