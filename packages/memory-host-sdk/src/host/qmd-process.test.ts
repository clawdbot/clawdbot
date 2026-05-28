import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const spawnMock = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  return {
    ...actual,
    spawn: spawnMock,
  };
});

import {
  checkQmdBinaryAvailability,
  resolveCliSpawnInvocation,
  resolveQmdBinaryUnavailableReason,
  runCliCommand,
  type QmdBinaryAvailability,
} from "./qmd-process.js";

function createMockChild() {
  const child = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter;
    stderr: EventEmitter;
    kill: ReturnType<typeof vi.fn>;
    closeWith: (code?: number | null, signal?: NodeJS.Signals | null) => void;
  };
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = vi.fn();
  child.closeWith = (code: number | null = 0, signal: NodeJS.Signals | null = null) => {
    child.emit("close", code, signal);
  };
  return child;
}

let fixtureRoot = "";
let tempDir = "";
let platformSpy: { mockRestore(): void } | null = null;
let fixtureId = 0;
const originalPath = process.env.PATH;
const originalPathExt = process.env.PATHEXT;

beforeAll(async () => {
  fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-qmd-win-spawn-"));
  platformSpy = vi.spyOn(process, "platform", "get").mockReturnValue("win32");
});

afterAll(async () => {
  platformSpy?.mockRestore();
  platformSpy = null;
  if (fixtureRoot) {
    await fs.rm(fixtureRoot, { recursive: true, force: true });
  }
});

beforeEach(async () => {
  tempDir = path.join(fixtureRoot, `case-${fixtureId++}`);
  await fs.mkdir(tempDir, { recursive: true });
});

afterEach(() => {
  process.env.PATH = originalPath;
  process.env.PATHEXT = originalPathExt;
  spawnMock.mockReset();
  tempDir = "";
});

describe("resolveCliSpawnInvocation", () => {
  it("unwraps npm cmd shims to a direct node entrypoint", async () => {
    const binDir = path.join(tempDir, "node_modules", ".bin");
    const packageDir = path.join(tempDir, "node_modules", "qmd");
    const scriptPath = path.join(packageDir, "dist", "cli.js");
    await fs.mkdir(path.dirname(scriptPath), { recursive: true });
    await fs.mkdir(binDir, { recursive: true });
    await fs.writeFile(path.join(binDir, "qmd.cmd"), "@echo off\r\n", "utf8");
    await fs.writeFile(
      path.join(packageDir, "package.json"),
      JSON.stringify({ name: "qmd", version: "0.0.0", bin: { qmd: "dist/cli.js" } }),
      "utf8",
    );
    await fs.writeFile(scriptPath, "module.exports = {};\n", "utf8");

    process.env.PATH = `${binDir};${originalPath ?? ""}`;
    process.env.PATHEXT = ".CMD;.EXE";

    const invocation = resolveCliSpawnInvocation({
      command: "qmd",
      args: ["query", "hello"],
      env: process.env,
      packageName: "qmd",
    });

    expect(invocation.command).toBe(process.execPath);
    expect(invocation.argv).toEqual([scriptPath, "query", "hello"]);
    expect(invocation.shell).not.toBe(true);
    expect(invocation.windowsHide).toBe(true);
  });

  it("fails closed when a Windows cmd shim cannot be resolved without shell execution", async () => {
    const binDir = path.join(tempDir, "bad-bin");
    await fs.mkdir(binDir, { recursive: true });
    await fs.writeFile(path.join(binDir, "qmd.cmd"), "@echo off\r\nREM no entrypoint\r\n", "utf8");

    process.env.PATH = `${binDir};${originalPath ?? ""}`;
    process.env.PATHEXT = ".CMD;.EXE";

    expect(() =>
      resolveCliSpawnInvocation({
        command: "qmd",
        args: ["query", "hello"],
        env: process.env,
        packageName: "qmd",
      }),
    ).toThrow(/without shell execution/);
  });

  it("keeps bare commands bare when no Windows wrapper exists on PATH", () => {
    process.env.PATH = originalPath ?? "";
    process.env.PATHEXT = ".CMD;.EXE";

    const invocation = resolveCliSpawnInvocation({
      command: "qmd",
      args: ["query", "hello"],
      env: process.env,
      packageName: "qmd",
    });

    expect(invocation.command).toBe("qmd");
    expect(invocation.argv).toEqual(["query", "hello"]);
    expect(invocation.shell).not.toBe(true);
  });
});

describe("checkQmdBinaryAvailability", () => {
  it("keeps legacy unavailable probe results source-compatible", () => {
    const legacyUnavailable: QmdBinaryAvailability = {
      available: false,
      error: "spawn qmd ENOENT",
    };

    expect(resolveQmdBinaryUnavailableReason(legacyUnavailable)).toBe("binary");
  });

  it("returns available when the qmd process spawns successfully", async () => {
    const child = createMockChild();
    spawnMock.mockImplementationOnce(() => {
      queueMicrotask(() => child.emit("spawn"));
      return child;
    });

    await expect(
      checkQmdBinaryAvailability({ command: "qmd", env: process.env, cwd: tempDir }),
    ).resolves.toEqual({ available: true });
    expect(child.kill).toHaveBeenCalledTimes(1);
    expect(child.kill).toHaveBeenCalledWith();
  });

  it("returns unavailable when the qmd process cannot be spawned", async () => {
    const child = createMockChild();
    const err = Object.assign(new Error("spawn qmd ENOENT"), { code: "ENOENT" });
    spawnMock.mockImplementationOnce(() => {
      queueMicrotask(() => child.emit("error", err));
      return child;
    });

    await expect(
      checkQmdBinaryAvailability({ command: "qmd", env: process.env, cwd: tempDir }),
    ).resolves.toEqual({ available: false, reason: "binary", error: "spawn qmd ENOENT" });
  });

  it("returns an explicit workspace error when cwd is missing", async () => {
    const missingDir = path.join(tempDir, "missing-workspace");

    await expect(
      checkQmdBinaryAvailability({ command: "qmd", env: process.env, cwd: missingDir }),
    ).resolves.toEqual({
      available: false,
      reason: "workspace-cwd",
      error: `workspace directory missing: ${missingDir}`,
    });
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("does not treat close-before-spawn as a successful availability probe", async () => {
    const child = createMockChild();
    const err = Object.assign(new Error("spawn qmd ENOENT"), { code: "ENOENT" });
    spawnMock.mockImplementationOnce(() => {
      queueMicrotask(() => child.emit("close"));
      queueMicrotask(() => child.emit("error", err));
      return child;
    });

    await expect(
      checkQmdBinaryAvailability({ command: "qmd", env: process.env, cwd: tempDir }),
    ).resolves.toEqual({ available: false, reason: "binary", error: "spawn qmd ENOENT" });
  });
});

describe("runCliCommand", () => {
  it("keeps stdout and stderr on non-zero exits", async () => {
    const child = createMockChild();
    spawnMock.mockImplementationOnce(() => {
      queueMicrotask(() => {
        child.stdout.emit("data", '[{"docid":"abc","score":0.93}]');
        child.stderr.emit("data", "ggml-metal-device.m:612");
        child.closeWith(134);
      });
      return child;
    });

    try {
      await runCliCommand({
        commandSummary: "qmd query test",
        spawnInvocation: { command: "qmd", argv: ["query", "test", "--json"] },
        env: process.env,
        cwd: tempDir,
        maxOutputChars: 10_000,
      });
      throw new Error("expected runCliCommand to reject");
    } catch (err) {
      expect(err).toBeInstanceOf(Error);
      if (!(err instanceof Error)) {
        throw err;
      }
      expect(err.name).toBe("CliCommandError");
      expect(err).toMatchObject({
        code: 134,
        signal: null,
        stdout: '[{"docid":"abc","score":0.93}]',
        stderr: "ggml-metal-device.m:612",
      });
      expect(err.message).toContain("qmd query test failed (code 134)");
    }
  });

  it("records signal-only command failures", async () => {
    const child = createMockChild();
    spawnMock.mockImplementationOnce(() => {
      queueMicrotask(() => {
        child.stdout.emit("data", "[]");
        child.closeWith(null, "SIGABRT");
      });
      return child;
    });

    await expect(
      runCliCommand({
        commandSummary: "qmd query test",
        spawnInvocation: { command: "qmd", argv: ["query", "test", "--json"] },
        env: process.env,
        cwd: tempDir,
        maxOutputChars: 10_000,
      }),
    ).rejects.toMatchObject({
      code: null,
      signal: "SIGABRT",
      stdout: "[]",
    });
  });

  it("does not expose truncated output as a recoverable command failure", async () => {
    const child = createMockChild();
    spawnMock.mockImplementationOnce(() => {
      queueMicrotask(() => {
        child.stdout.emit("data", "too much output");
        child.closeWith(1);
      });
      return child;
    });

    await expect(
      runCliCommand({
        commandSummary: "qmd query test",
        spawnInvocation: { command: "qmd", argv: ["query", "test", "--json"] },
        env: process.env,
        cwd: tempDir,
        maxOutputChars: 4,
      }),
    ).rejects.toThrow(/produced too much output/);
  });
});
