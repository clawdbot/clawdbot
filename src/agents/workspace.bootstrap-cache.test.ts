/**
 * Integration coverage for workspace bootstrap cache reads.
 * Uses temp workspaces to verify real file loading through the cache layer.
 */
import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeTempWorkspace, writeWorkspaceFile } from "../test-helpers/workspace.js";
import { getOrLoadBootstrapFiles } from "./bootstrap-cache.js";
import * as workspaceBootstrapRead from "./workspace-bootstrap-read.js";
import {
  readWorkspaceFileCache,
  retireWorkspaceFileCache,
  writeWorkspaceFileCache,
} from "./workspace-file-cache.js";
import { loadWorkspaceBootstrapFiles, DEFAULT_AGENTS_FILENAME } from "./workspace.js";

describe("workspace bootstrap file caching", () => {
  let workspaceDir: string;

  beforeEach(async () => {
    workspaceDir = await makeTempWorkspace("openclaw-bootstrap-cache-test-");
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

  it("evicts the oldest cached file after 64 empty entries", async () => {
    const readFile = vi.spyOn(workspaceBootstrapRead, "readWorkspaceBootstrapFile");
    try {
      const workspaces: string[] = [];
      for (let index = 0; index <= 64; index += 1) {
        const dir = path.join(workspaceDir, String(index));
        await fs.mkdir(dir);
        await writeWorkspaceFile({ dir, name: DEFAULT_AGENTS_FILENAME, content: "" });
        expectAgentsContent(await loadAgentsFile(dir), "");
        workspaces.push(dir);
      }
      expect(readFile).toHaveBeenCalledTimes(65);

      expectAgentsContent(await loadAgentsFile(workspaces[0]!), "");
      expect(readFile).toHaveBeenCalledTimes(66);
    } finally {
      readFile.mockRestore();
    }
  });

  it("keeps recent files hot while bounding content across workspace fan-out", async () => {
    const content = "x".repeat(1024 * 1024);
    const workspaces: string[] = [];
    for (let index = 0; index < 16; index++) {
      const dir = path.join(workspaceDir, String(index));
      await fs.mkdir(dir);
      await writeWorkspaceFile({ dir, name: DEFAULT_AGENTS_FILENAME, content });
      workspaces.push(dir);
    }
    const readFile = vi.spyOn(workspaceBootstrapRead, "readWorkspaceBootstrapFile");
    const before = process.memoryUsage();
    const startedAt = performance.now();
    try {
      for (const dir of workspaces) {
        expectAgentsContent(await loadAgentsFile(dir), content);
      }
      expect(readFile).toHaveBeenCalledTimes(16);
      expectAgentsContent(await loadAgentsFile(workspaces[15]!), content);
      expect(readFile).toHaveBeenCalledTimes(16);
      expectAgentsContent(await loadAgentsFile(workspaces[0]!), content);
      expect(readFile).toHaveBeenCalledTimes(17);
      const after = process.memoryUsage();
      console.info("workspace-cache fan-out diagnostic", {
        platform: process.platform,
        sourceBytes: workspaces.length * Buffer.byteLength(content, "utf8"),
        elapsedMs: performance.now() - startedAt,
        rssDelta: after.rss - before.rss,
        externalDelta: after.external - before.external,
      });
    } finally {
      readFile.mockRestore();
      retireWorkspaceFileCache(workspaceDir);
    }
  });

  it("shares one cache entry across canonical workspace aliases", async () => {
    if (process.platform === "win32") {
      return;
    }
    const realWorkspace = path.join(workspaceDir, "real");
    const aliasWorkspace = path.join(workspaceDir, "alias");
    await fs.mkdir(realWorkspace);
    await fs.symlink(realWorkspace, aliasWorkspace, "dir");
    await writeWorkspaceFile({
      dir: realWorkspace,
      name: DEFAULT_AGENTS_FILENAME,
      content: "# shared",
    });
    const readFile = vi.spyOn(workspaceBootstrapRead, "readWorkspaceBootstrapFile");
    try {
      expectAgentsContent(await loadAgentsFile(realWorkspace), "# shared");
      expectAgentsContent(await loadAgentsFile(aliasWorkspace), "# shared");
      expect(readFile).toHaveBeenCalledTimes(1);
    } finally {
      readFile.mockRestore();
    }
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
    // Use integer-second mtime so utimes can restore it exactly, isolating ctime as the
    // only changed stat field after the in-place edit.
    const cleanTime = new Date(Math.floor(Date.now() / 1000) * 1000);
    await fs.utimes(filePath, cleanTime, cleanTime);
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

  it("invalidates cache when content changes in-place with restored mtime", async () => {
    if (process.platform === "win32") {
      return;
    }
    const content1 = "# old guidance";
    const content2 = "# new guidance";
    const filePath = path.join(workspaceDir, DEFAULT_AGENTS_FILENAME);

    await writeWorkspaceFile({
      dir: workspaceDir,
      name: DEFAULT_AGENTS_FILENAME,
      content: content1,
    });
    // Use integer-second mtime so utimes can restore it exactly, isolating ctime as the
    // only changed stat field after the in-place edit.
    const cleanTime = new Date(Math.floor(Date.now() / 1000) * 1000);
    await fs.utimes(filePath, cleanTime, cleanTime);
    const originalStat = await fs.stat(filePath);

    const agentsFile1 = await loadAgentsFile(workspaceDir);
    expectAgentsContent(agentsFile1, content1);

    // A loaded runner can complete both writes within one ctime tick. Wait for the
    // fixture's cache identity to change before asserting the production reload.
    await vi.waitFor(
      async () => {
        await fs.writeFile(filePath, content2, "utf-8");
        await fs.utimes(filePath, originalStat.atime, originalStat.mtime);
        expect((await fs.stat(filePath)).ctimeMs).not.toBe(originalStat.ctimeMs);
      },
      { interval: 1, timeout: 1_000 },
    );

    const editedStat = await fs.stat(filePath);
    expect(editedStat.dev).toBe(originalStat.dev);
    expect(editedStat.ino).toBe(originalStat.ino);
    expect(editedStat.size).toBe(originalStat.size);
    expect(editedStat.mtimeMs).toBe(originalStat.mtimeMs);

    const originalFstatSync = fsSync.fstatSync;
    const fstatSync = vi.spyOn(fsSync, "fstatSync").mockImplementationOnce((fd) => {
      const stat = originalFstatSync(fd);
      // Filesystems may coalesce rapid ctime updates; isolate the identity contract.
      stat.ctimeMs = originalStat.ctimeMs + 1;
      return stat;
    });
    try {
      const agentsFile2 = await loadAgentsFile(workspaceDir);
      expectAgentsContent(agentsFile2, content2);
    } finally {
      fstatSync.mockRestore();
    }
  });

  it("replaces a session snapshot when inode changes with identical bytes", async () => {
    if (process.platform === "win32") {
      return;
    }
    const content = "# stable-content";
    const filePath = path.join(workspaceDir, DEFAULT_AGENTS_FILENAME);
    const tempPath = path.join(workspaceDir, ".AGENTS.replacement");
    const sessionKey = "agent:main:identity-refresh";

    await writeWorkspaceFile({
      dir: workspaceDir,
      name: DEFAULT_AGENTS_FILENAME,
      content,
    });
    const originalStat = await fs.stat(filePath);
    const agentsFile1 = await loadSessionAgentsFile(workspaceDir, sessionKey);
    expectAgentsContent(agentsFile1, content);

    await fs.writeFile(tempPath, content, "utf-8");
    await fs.utimes(tempPath, originalStat.atime, originalStat.mtime);
    await fs.rename(tempPath, filePath);
    await fs.utimes(filePath, originalStat.atime, originalStat.mtime);

    const agentsFile2 = await loadSessionAgentsFile(workspaceDir, sessionKey);
    expectAgentsContent(agentsFile2, content);
    expect(agentsFile2).not.toBe(agentsFile1);
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

describe("workspace file cache retention", () => {
  const MIB = 1024 * 1024;
  let workspaceRoot = "";

  beforeEach(async () => {
    workspaceRoot = await makeTempWorkspace("openclaw-file-cache-test-");
  });

  afterEach(() => {
    retireWorkspaceFileCache(workspaceRoot);
  });

  function cacheFile(name: string, sizeBytes: number, identity = name): string {
    const filePath = path.join(workspaceRoot, name);
    writeWorkspaceFileCache({
      filePath,
      content: "x".repeat(sizeBytes),
      identity,
    });
    return filePath;
  }

  it("evicts the oldest content above the six-file byte budget", () => {
    const oldest = cacheFile("oldest", 2 * MIB);
    for (let index = 1; index < 6; index += 1) {
      cacheFile(`entry-${index}`, 2 * MIB);
    }
    const newest = cacheFile("newest", 1);

    expect(readWorkspaceFileCache(oldest, "oldest")).toBeUndefined();
    expect(readWorkspaceFileCache(newest, "newest")).toBe("x");
  });

  it("promotes hits before weighted eviction", () => {
    const first = cacheFile("first", 2 * MIB);
    const second = cacheFile("second", 2 * MIB);
    for (let index = 2; index < 6; index += 1) {
      cacheFile(`entry-${index}`, 2 * MIB);
    }
    expect(readWorkspaceFileCache(first, "first")).toHaveLength(2 * MIB);

    cacheFile("newest", 1);

    expect(readWorkspaceFileCache(second, "second")).toBeUndefined();
    expect(readWorkspaceFileCache(first, "first")).toHaveLength(2 * MIB);
  });

  it("subtracts replaced bytes before applying the limit", () => {
    const replaced = cacheFile("replaced", 2 * MIB, "old");
    writeWorkspaceFileCache({ filePath: replaced, content: "x", identity: "new" });
    const peers = Array.from({ length: 5 }, (_, index) => cacheFile(`peer-${index}`, 2 * MIB));

    expect(readWorkspaceFileCache(replaced, "new")).toBe("x");
    for (const [index, peer] of peers.entries()) {
      expect(readWorkspaceFileCache(peer, `peer-${index}`)).toHaveLength(2 * MIB);
    }
  });

  it("releases byte accounting on identity mismatch", () => {
    const stale = cacheFile("stale", 2 * MIB, "old");
    expect(readWorkspaceFileCache(stale, "new")).toBeUndefined();
    const peers = Array.from({ length: 6 }, (_, index) => cacheFile(`peer-${index}`, 2 * MIB));

    for (const [index, peer] of peers.entries()) {
      expect(readWorkspaceFileCache(peer, `peer-${index}`)).toHaveLength(2 * MIB);
    }
  });

  it("retires contained entries without evicting sibling roots", () => {
    const contained = cacheFile("contained", 1);
    const siblingRoot = `${workspaceRoot}-sibling`;
    const sibling = path.join(siblingRoot, "sibling");
    writeWorkspaceFileCache({ filePath: sibling, content: "s", identity: "sibling" });

    try {
      retireWorkspaceFileCache(workspaceRoot);

      expect(readWorkspaceFileCache(contained, "contained")).toBeUndefined();
      expect(readWorkspaceFileCache(sibling, "sibling")).toBe("s");
    } finally {
      retireWorkspaceFileCache(siblingRoot);
    }
  });
  it("keeps raw Unicode filesystem paths independent", () => {
    const composed = path.join(workspaceRoot, "caf\u00e9", "AGENTS.md");
    const decomposed = path.join(workspaceRoot, "cafe\u0301", "AGENTS.md");
    writeWorkspaceFileCache({ filePath: composed, content: "composed", identity: "composed" });
    writeWorkspaceFileCache({
      filePath: decomposed,
      content: "decomposed",
      identity: "decomposed",
    });

    expect(readWorkspaceFileCache(composed, "composed")).toBe("composed");
    expect(readWorkspaceFileCache(decomposed, "decomposed")).toBe("decomposed");
  });

  it("accounts for UTF-8 bytes rather than character count", () => {
    const content = "é".repeat(MIB);
    const files = Array.from({ length: 7 }, (_, index) => path.join(workspaceRoot, String(index)));
    for (const filePath of files) {
      writeWorkspaceFileCache({ filePath, content, identity: filePath });
    }

    expect(readWorkspaceFileCache(files[0]!, files[0]!)).toBeUndefined();
    expect(readWorkspaceFileCache(files[6]!, files[6]!)).toBe(content);
  });
});
