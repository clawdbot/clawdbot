// Bootstrap-file loading, transient-read retries, guarded workspace reads, and
// per-session bootstrap filtering for agent workspaces.
import syncFs from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { makeTempWorkspace, writeWorkspaceFile } from "../test-helpers/workspace.js";
import {
  DEFAULT_AGENTS_FILENAME,
  DEFAULT_MEMORY_FILENAME,
  DEFAULT_TOOLS_FILENAME,
  filterBootstrapFilesForSession,
  loadWorkspaceBootstrapFiles,
  readWorkspaceFileWithGuards,
  type WorkspaceBootstrapFile,
} from "./workspace.js";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

function expectSubagentAllowedBootstrapNames(files: WorkspaceBootstrapFile[]) {
  const names = files.map((file) => file.name);
  expect(names).toStrictEqual(["AGENTS.md"]);
}

function expectCronAllowedBootstrapNames(files: WorkspaceBootstrapFile[]) {
  const names = files.map((file) => file.name);
  expect(names).toStrictEqual(["AGENTS.md", "SOUL.md", "IDENTITY.md", "USER.md"]);
}

describe("loadWorkspaceBootstrapFiles", () => {
  const getMemoryEntries = (files: Awaited<ReturnType<typeof loadWorkspaceBootstrapFiles>>) =>
    files.filter((file) => file.name === DEFAULT_MEMORY_FILENAME);

  const expectSingleMemoryEntry = (
    files: Awaited<ReturnType<typeof loadWorkspaceBootstrapFiles>>,
    content: string,
  ) => {
    const memoryEntries = getMemoryEntries(files);
    expect(memoryEntries).toHaveLength(1);
    expect(memoryEntries[0]?.missing).toBe(false);
    expect(memoryEntries[0]?.content).toBe(content);
  };

  it("includes MEMORY.md when present", async () => {
    const tempDir = await makeTempWorkspace("openclaw-workspace-");
    await writeWorkspaceFile({ dir: tempDir, name: "MEMORY.md", content: "memory" });

    const files = await loadWorkspaceBootstrapFiles(tempDir);
    expectSingleMemoryEntry(files, "memory");
  });

  it("ignores lowercase memory.md when MEMORY.md is absent", async () => {
    const tempDir = await makeTempWorkspace("openclaw-workspace-");
    await writeWorkspaceFile({ dir: tempDir, name: "memory.md", content: "alt" });

    const files = await loadWorkspaceBootstrapFiles(tempDir);
    expect(getMemoryEntries(files)).toHaveLength(0);
  });

  it("omits memory entries when no memory files exist", async () => {
    const tempDir = await makeTempWorkspace("openclaw-workspace-");

    const files = await loadWorkspaceBootstrapFiles(tempDir);
    expect(getMemoryEntries(files)).toHaveLength(0);
  });

  it("treats hardlinked bootstrap aliases as unreadable", async () => {
    if (process.platform === "win32") {
      return;
    }
    const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-workspace-hardlink-"));
    try {
      const workspaceDir = path.join(rootDir, "workspace");
      const outsideDir = path.join(rootDir, "outside");
      await fs.mkdir(workspaceDir, { recursive: true });
      await fs.mkdir(outsideDir, { recursive: true });
      const outsideFile = path.join(outsideDir, DEFAULT_AGENTS_FILENAME);
      const linkPath = path.join(workspaceDir, DEFAULT_AGENTS_FILENAME);
      await fs.writeFile(outsideFile, "outside", "utf-8");
      try {
        await fs.link(outsideFile, linkPath);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "EXDEV") {
          return;
        }
        throw err;
      }

      const files = await loadWorkspaceBootstrapFiles(workspaceDir);
      const agents = files.find((file) => file.name === DEFAULT_AGENTS_FILENAME);
      expect(agents?.missing).toBe(false);
      expect(agents?.content).toBe("[UNREADABLE: path must not be hardlinked]");
    } finally {
      await fs.rm(rootDir, { recursive: true, force: true });
    }
  });

  it("retries a transient bootstrap read instead of dropping the file for the turn", async () => {
    const tempDir = await makeTempWorkspace("openclaw-workspace-");
    await writeWorkspaceFile({
      dir: tempDir,
      name: DEFAULT_AGENTS_FILENAME,
      content: "# AGENTS.md\n\nkeep me\n",
    });

    const originalRead = syncFs.read.bind(syncFs);
    let readCalls = 0;
    let threwTransient = false;
    const readSpy = vi.spyOn(syncFs, "read").mockImplementation(((
      fd: number,
      buffer: Buffer,
      offset: number,
      length: number,
      position: number | null,
      callback: (err: NodeJS.ErrnoException | null, bytesRead: number, buffer: Buffer) => void,
    ) => {
      readCalls += 1;
      if (!threwTransient) {
        threwTransient = true;
        // Surface the transient failure through the async fd read callback the
        // way the bootstrap reader consumes it, so the retry path re-opens a
        // fresh fd and reads again on the next attempt.
        callback(
          Object.assign(new Error("Unknown system error -11: read"), {
            code: "EAGAIN",
            errno: -11,
          }),
          0,
          buffer,
        );
        return;
      }
      originalRead(fd, buffer, offset, length, position, callback);
    }) as typeof syncFs.read);

    try {
      const files = await loadWorkspaceBootstrapFiles(tempDir);
      expect(threwTransient).toBe(true);
      // The retry re-opens and reads again, so the failed first read is followed
      // by at least one more successful read.
      expect(readCalls).toBeGreaterThanOrEqual(2);
      const agents = files.find((file) => file.name === DEFAULT_AGENTS_FILENAME);
      expect(agents?.missing).toBe(false);
      expect(agents?.content).toContain("keep me");
    } finally {
      readSpy.mockRestore();
    }
  });

  it("marks a bootstrap file unreadable after transient read retries are exhausted", async () => {
    const tempDir = await makeTempWorkspace("openclaw-workspace-");
    await writeWorkspaceFile({
      dir: tempDir,
      name: DEFAULT_AGENTS_FILENAME,
      content: "# AGENTS.md\n",
    });

    const readSpy = vi.spyOn(syncFs, "read").mockImplementation(((
      fd: number,
      buffer: Buffer,
      offset: number,
      length: number,
      position: number | null,
      callback: (err: NodeJS.ErrnoException | null, bytesRead: number, buffer: Buffer) => void,
    ) => {
      void fd;
      void offset;
      void length;
      void position;
      // Keep failing every async fd read so all retry attempts are exhausted.
      callback(
        Object.assign(new Error("Unknown system error -11: read"), {
          code: "EAGAIN",
          errno: -11,
        }),
        0,
        buffer,
      );
    }) as typeof syncFs.read);

    try {
      const files = await loadWorkspaceBootstrapFiles(tempDir);
      const agents = files.find((file) => file.name === DEFAULT_AGENTS_FILENAME);
      expect(agents?.missing).toBe(false);
      expect(agents?.content).toBe("[UNREADABLE: Unknown system error -11: read]");
    } finally {
      readSpy.mockRestore();
    }
  });

  it("retries a transient boundary-resolution failure before dropping a bootstrap file", async () => {
    const tempDir = await makeTempWorkspace("openclaw-workspace-");
    await writeWorkspaceFile({
      dir: tempDir,
      name: DEFAULT_AGENTS_FILENAME,
      content: "# AGENTS.md\n\nboundary retry\n",
    });

    const agentsPath = path.join(syncFs.realpathSync(tempDir), DEFAULT_AGENTS_FILENAME);
    const originalLstat = syncFs.promises.lstat.bind(syncFs.promises);
    let agentsLstatAttempts = 0;
    const lstatSpy = vi.spyOn(syncFs.promises, "lstat").mockImplementation((async (
      target: unknown,
      options?: unknown,
    ) => {
      if (String(target) === agentsPath && ++agentsLstatAttempts === 1) {
        throw Object.assign(new Error("Unknown system error -11: lstat"), {
          code: "EAGAIN",
          errno: -11,
        });
      }
      return await originalLstat(target as never, options as never);
    }) as typeof syncFs.promises.lstat);

    try {
      const files = await loadWorkspaceBootstrapFiles(tempDir);
      expect(agentsLstatAttempts).toBeGreaterThanOrEqual(2);
      const agents = files.find((file) => file.name === DEFAULT_AGENTS_FILENAME);
      expect(agents?.missing).toBe(false);
      expect(agents?.content).toContain("boundary retry");
    } finally {
      lstatSpy.mockRestore();
    }
  });

  it("retries a transient open failure before dropping a bootstrap file", async () => {
    const tempDir = await makeTempWorkspace("openclaw-workspace-");
    await writeWorkspaceFile({
      dir: tempDir,
      name: DEFAULT_AGENTS_FILENAME,
      content: "# AGENTS.md\n\nopen retry\n",
    });

    // Behavior under test: the transient-open RETRY contract — a transient open
    // failure (reason "io") must be retried (re-open) rather than dropping the
    // file for the turn. Spying on openSync is incidental: the identity-pinned
    // open is a synchronous fs-safe primitive (openPinnedFileSync), so that is
    // simply where a transient open surfaces. This test does not assert that the
    // open MUST stay synchronous — only that a transient open is retried.
    const originalOpenSync = syncFs.openSync.bind(syncFs);
    let threwTransientOpen = false;
    const openSpy = vi.spyOn(syncFs, "openSync").mockImplementation(((
      ...args: Parameters<typeof syncFs.openSync>
    ) => {
      if (!threwTransientOpen) {
        threwTransientOpen = true;
        throw Object.assign(new Error("Unknown system error -11: open"), {
          code: "EAGAIN",
          errno: -11,
        });
      }
      return originalOpenSync(...args);
    }) as typeof syncFs.openSync);

    try {
      const files = await loadWorkspaceBootstrapFiles(tempDir);
      expect(threwTransientOpen).toBe(true);
      const agents = files.find((file) => file.name === DEFAULT_AGENTS_FILENAME);
      expect(agents?.missing).toBe(false);
      expect(agents?.content).toContain("open retry");
    } finally {
      openSpy.mockRestore();
    }
  });
});

describe("readWorkspaceFileWithGuards", () => {
  it("reads workspace file content through the async fd path", async () => {
    const tempDir = await makeTempWorkspace("openclaw-workspace-read-");
    const filePath = path.join(tempDir, DEFAULT_AGENTS_FILENAME);
    await fs.writeFile(filePath, "workspace rules", "utf-8");

    await expect(
      readWorkspaceFileWithGuards({
        filePath,
        workspaceDir: tempDir,
      }),
    ).resolves.toMatchObject({ ok: true, content: "workspace rules" });
  });

  it("returns cached content when the file identity still matches", async () => {
    const tempDir = await makeTempWorkspace("openclaw-workspace-read-cache-");
    const filePath = path.join(tempDir, DEFAULT_AGENTS_FILENAME);
    await fs.writeFile(filePath, "cached rules", "utf-8");

    await expect(
      readWorkspaceFileWithGuards({
        filePath,
        workspaceDir: tempDir,
      }),
    ).resolves.toMatchObject({ ok: true, content: "cached rules" });
    const readSpy = vi.spyOn(syncFs, "read");

    await expect(
      readWorkspaceFileWithGuards({
        filePath,
        workspaceDir: tempDir,
      }),
    ).resolves.toMatchObject({ ok: true, content: "cached rules" });
    expect(readSpy).not.toHaveBeenCalled();
  });

  it("closes the fd when an async read fails", async () => {
    const tempDir = await makeTempWorkspace("openclaw-workspace-read-error-");
    const filePath = path.join(tempDir, DEFAULT_TOOLS_FILENAME);
    await fs.writeFile(filePath, "tool notes", "utf-8");
    const readError = new Error("read failed");
    vi.spyOn(syncFs, "read").mockImplementation(((
      fd,
      buffer,
      offset,
      length,
      position,
      callback,
    ) => {
      void fd;
      void buffer;
      void offset;
      void length;
      void position;
      callback(readError, 0, buffer);
    }) as typeof syncFs.read);
    const closeSpy = vi.spyOn(syncFs, "close");

    const result = await readWorkspaceFileWithGuards({
      filePath,
      workspaceDir: tempDir,
    });

    expect(result).toStrictEqual({ ok: false, reason: "io", error: readError });
    expect(closeSpy).toHaveBeenCalled();
  });

  it("assembles full content when fs.read returns short reads", async () => {
    const tempDir = await makeTempWorkspace("openclaw-workspace-short-read-");
    const filePath = path.join(tempDir, DEFAULT_AGENTS_FILENAME);
    const fullContent = "ABCDEFGHIJ";
    await fs.writeFile(filePath, fullContent, "utf-8");

    // Simulate short reads: yield 3 bytes at a time
    const originalRead = syncFs.read.bind(syncFs);
    const readSpy = vi.spyOn(syncFs, "read").mockImplementation(((
      fd: number,
      buffer: Buffer,
      offset: number,
      length: number,
      position: number | null,
      callback: (err: NodeJS.ErrnoException | null, bytesRead: number, buffer: Buffer) => void,
    ) => {
      const chunk = Math.min(length, 3);
      originalRead(fd, buffer, offset, chunk, position, callback);
    }) as typeof syncFs.read);

    const result = await readWorkspaceFileWithGuards({
      filePath,
      workspaceDir: tempDir,
    });

    expect(result).toMatchObject({ ok: true, content: fullContent });
    // Must have called read more than once to reassemble full content
    expect(readSpy.mock.calls.length).toBeGreaterThan(1);
  });
});

describe("filterBootstrapFilesForSession", () => {
  const mockFiles: WorkspaceBootstrapFile[] = [
    { name: "AGENTS.md", path: "/w/AGENTS.md", content: "", missing: false },
    { name: "SOUL.md", path: "/w/SOUL.md", content: "", missing: false },
    { name: "IDENTITY.md", path: "/w/IDENTITY.md", content: "", missing: false },
    { name: "USER.md", path: "/w/USER.md", content: "", missing: false },
    { name: "BOOTSTRAP.md", path: "/w/BOOTSTRAP.md", content: "", missing: false },
    { name: "MEMORY.md", path: "/w/MEMORY.md", content: "", missing: false },
  ];

  it("returns all files for main session (no sessionKey)", () => {
    const result = filterBootstrapFilesForSession(mockFiles);
    expect(result).toStrictEqual(mockFiles);
  });

  it("returns all files for normal (non-subagent, non-cron) session key", () => {
    const result = filterBootstrapFilesForSession(mockFiles, "agent:default:chat:main");
    expect(result).toStrictEqual(mockFiles);
  });

  it("filters to allowlist for subagent sessions", () => {
    const result = filterBootstrapFilesForSession(mockFiles, "agent:default:subagent:task-1");
    expectSubagentAllowedBootstrapNames(result);
  });

  it("filters to allowlist for cron sessions", () => {
    const result = filterBootstrapFilesForSession(mockFiles, "agent:default:cron:daily-check");
    expectCronAllowedBootstrapNames(result);
  });
});
