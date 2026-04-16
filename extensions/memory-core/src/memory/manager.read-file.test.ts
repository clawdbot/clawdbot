import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { readMemoryFile } from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

describe("MemoryIndexManager.readFile", () => {
  let workspaceDir: string;
  let memoryDir: string;
  let extraDir: string;

  beforeAll(async () => {
    workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-mem-read-"));
    memoryDir = path.join(workspaceDir, "memory");
    extraDir = path.join(workspaceDir, "extra");
    await fs.mkdir(memoryDir, { recursive: true });
  });

  afterEach(async () => {
    await Promise.all(
      [memoryDir, extraDir].map(async (root) => {
        const entries = await fs.readdir(root).catch(() => []);
        await Promise.all(
          entries.map(async (entry) => {
            await fs.rm(path.join(root, entry), { recursive: true, force: true });
          }),
        );
      }),
    );
  });

  afterAll(async () => {
    await fs.rm(workspaceDir, { recursive: true, force: true });
  });

  it("returns empty text when the requested file does not exist", async () => {
    const relPath = "memory/2099-01-01.md";
    const result = await readMemoryFile({
      workspaceDir,
      extraPaths: [],
      relPath,
    });
    expect(result).toEqual({ text: "", path: relPath });
  });

  it("returns content slices when the file exists", async () => {
    const relPath = "memory/2026-02-20.md";
    const absPath = path.join(workspaceDir, relPath);
    await fs.mkdir(path.dirname(absPath), { recursive: true });
    await fs.writeFile(absPath, ["line 1", "line 2", "line 3"].join("\n"), "utf-8");

    const result = await readMemoryFile({
      workspaceDir,
      extraPaths: [],
      relPath,
      from: 2,
      lines: 1,
    });
    expect(result).toEqual({
      text: "line 2\n\n[More content available. Use from=3 to continue.]",
      path: relPath,
      from: 2,
      lines: 1,
      truncated: true,
      nextFrom: 3,
    });
  });

  it("returns a default-sized excerpt when no line range is provided", async () => {
    const relPath = "memory/default-window.md";
    const absPath = path.join(workspaceDir, relPath);
    await fs.mkdir(path.dirname(absPath), { recursive: true });
    await fs.writeFile(
      absPath,
      Array.from({ length: 150 }, (_, index) => `line ${index + 1}`).join("\n"),
      "utf-8",
    );

    const result = await readMemoryFile({
      workspaceDir,
      extraPaths: [],
      relPath,
    });

    expect(result.path).toBe(relPath);
    expect(result.from).toBe(1);
    expect(result.lines).toBe(120);
    expect(result.truncated).toBe(true);
    expect(result.nextFrom).toBe(121);
    expect(result.text).toContain("line 1");
    expect(result.text).toContain("line 120");
    expect(result.text).not.toContain("line 121");
    expect(result.text).toContain("Use from=121 to continue.");
  });

  it("returns a bounded window when from is provided without lines", async () => {
    const relPath = "memory/from-only.md";
    const absPath = path.join(workspaceDir, relPath);
    await fs.mkdir(path.dirname(absPath), { recursive: true });
    await fs.writeFile(
      absPath,
      Array.from({ length: 160 }, (_, index) => `line ${index + 1}`).join("\n"),
      "utf-8",
    );

    const result = await readMemoryFile({
      workspaceDir,
      extraPaths: [],
      relPath,
      from: 21,
    });

    expect(result.from).toBe(21);
    expect(result.lines).toBe(120);
    expect(result.truncated).toBe(true);
    expect(result.nextFrom).toBe(141);
    expect(result.text).toContain("line 21");
    expect(result.text).toContain("line 140");
    expect(result.text).not.toContain("line 141");
  });

  it("honors injected defaultLines and maxChars overrides", async () => {
    const relPath = "memory/agent-limits.md";
    const absPath = path.join(workspaceDir, relPath);
    await fs.mkdir(path.dirname(absPath), { recursive: true });
    await fs.writeFile(
      absPath,
      Array.from({ length: 40 }, (_, index) => `line ${index + 1}: ${"x".repeat(40)}`).join("\n"),
      "utf-8",
    );

    const result = await readMemoryFile({
      workspaceDir,
      extraPaths: [],
      relPath,
      defaultLines: 5,
      maxChars: 220,
    });

    expect(result.from).toBe(1);
    expect(result.lines).toBeLessThanOrEqual(5);
    expect(result.truncated).toBe(true);
    expect(result.nextFrom).toBeGreaterThan(1);
    expect(result.text).toContain("Use from=");
  });

  it("returns empty text when the requested slice is past EOF", async () => {
    const relPath = "memory/window.md";
    const absPath = path.join(workspaceDir, relPath);
    await fs.mkdir(path.dirname(absPath), { recursive: true });
    await fs.writeFile(absPath, ["alpha", "beta"].join("\n"), "utf-8");

    const result = await readMemoryFile({
      workspaceDir,
      extraPaths: [],
      relPath,
      from: 10,
      lines: 5,
    });
    expect(result).toEqual({ text: "", path: relPath, from: 10, lines: 0 });
  });

  it("caps returned text to the default max chars and exposes continuation metadata", async () => {
    const relPath = "memory/char-cap.md";
    const absPath = path.join(workspaceDir, relPath);
    await fs.mkdir(path.dirname(absPath), { recursive: true });
    await fs.writeFile(
      absPath,
      Array.from({ length: 200 }, (_, index) => `${index + 1}: ${"x".repeat(200)}`).join("\n"),
      "utf-8",
    );

    const result = await readMemoryFile({
      workspaceDir,
      extraPaths: [],
      relPath,
    });

    expect(result.truncated).toBe(true);
    expect(result.nextFrom).toBeGreaterThan(1);
    expect(result.lines).toBeLessThan(120);
    expect(result.text.length).toBeLessThanOrEqual(12_000 + 64);
    expect(result.text).toContain("Use from=");
  });

  it("suggests read fallback for pathological single-line truncation in workspace memory files", async () => {
    const relPath = "memory/oversized-line.md";
    const absPath = path.join(workspaceDir, relPath);
    await fs.mkdir(path.dirname(absPath), { recursive: true });
    await fs.writeFile(absPath, `1: ${"x".repeat(20_000)}`, "utf-8");

    const result = await readMemoryFile({
      workspaceDir,
      extraPaths: [],
      relPath,
    });

    expect(result.truncated).toBe(true);
    expect(result.lines).toBe(1);
    expect(result.nextFrom).toBeUndefined();
    expect(result.text).toContain("use read on the source file");
    expect(result.text).not.toContain("Use from=");
  });

  it("does not advertise line continuation when a single oversized line is cut mid-line", async () => {
    const relPath = "memory/oversized-line-with-tail.md";
    const absPath = path.join(workspaceDir, relPath);
    await fs.mkdir(path.dirname(absPath), { recursive: true });
    await fs.writeFile(absPath, [`1: ${"x".repeat(20_000)}`, "line 2"].join("\n"), "utf-8");

    const result = await readMemoryFile({
      workspaceDir,
      extraPaths: [],
      relPath,
    });

    expect(result.truncated).toBe(true);
    expect(result.lines).toBe(1);
    expect(result.nextFrom).toBeUndefined();
    expect(result.text).not.toContain("Use from=");
  });

  it("omits truncation metadata when the full excerpt fits and no more lines remain", async () => {
    const relPath = "memory/complete.md";
    const absPath = path.join(workspaceDir, relPath);
    await fs.mkdir(path.dirname(absPath), { recursive: true });
    await fs.writeFile(absPath, ["alpha", "beta", "gamma"].join("\n"), "utf-8");

    const result = await readMemoryFile({
      workspaceDir,
      extraPaths: [],
      relPath,
    });

    expect(result).toEqual({
      text: "alpha\nbeta\ngamma",
      path: relPath,
      from: 1,
      lines: 3,
    });
  });

  it("returns empty text when the file disappears after stat", async () => {
    const relPath = "memory/transient.md";
    const absPath = path.join(workspaceDir, relPath);
    await fs.mkdir(path.dirname(absPath), { recursive: true });
    await fs.writeFile(absPath, "first\nsecond", "utf-8");

    const realReadFile = fs.readFile;
    let injected = false;
    const readSpy = vi
      .spyOn(fs, "readFile")
      .mockImplementation(async (...args: Parameters<typeof realReadFile>) => {
        const [target, options] = args;
        if (!injected && typeof target === "string" && path.resolve(target) === absPath) {
          injected = true;
          const err = new Error("missing") as NodeJS.ErrnoException;
          err.code = "ENOENT";
          throw err;
        }
        return realReadFile(target, options);
      });

    try {
      const result = await readMemoryFile({
        workspaceDir,
        extraPaths: [],
        relPath,
      });
      expect(result).toEqual({ text: "", path: relPath });
    } finally {
      readSpy.mockRestore();
    }
  });

  it("rejects non-memory paths", async () => {
    await expect(
      readMemoryFile({
        workspaceDir,
        extraPaths: [],
        relPath: "NOTES.md",
      }),
    ).rejects.toThrow("path required");
  });

  it("allows additional memory paths and blocks symlinks", async () => {
    await fs.mkdir(extraDir, { recursive: true });
    await fs.writeFile(path.join(extraDir, "extra.md"), "Extra content.");
    await fs.writeFile(path.join(extraDir, "oversized.md"), `1: ${"y".repeat(20_000)}`);

    await expect(
      readMemoryFile({
        workspaceDir,
        extraPaths: [extraDir],
        relPath: "extra/extra.md",
      }),
    ).resolves.toEqual({
      path: "extra/extra.md",
      text: "Extra content.",
      from: 1,
      lines: 1,
    });

    const oversized = await readMemoryFile({
      workspaceDir,
      extraPaths: [extraDir],
      relPath: "extra/oversized.md",
    });
    expect(oversized.truncated).toBe(true);
    expect(oversized.text).not.toContain("use read on the source file");

    const linkPath = path.join(extraDir, "linked.md");
    let symlinkOk = true;
    try {
      await fs.symlink(path.join(extraDir, "extra.md"), linkPath, "file");
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "EPERM" || code === "EACCES") {
        symlinkOk = false;
      } else {
        throw err;
      }
    }
    if (symlinkOk) {
      await expect(
        readMemoryFile({
          workspaceDir,
          extraPaths: [extraDir],
          relPath: "extra/linked.md",
        }),
      ).rejects.toThrow("path required");
    }
  });
});
