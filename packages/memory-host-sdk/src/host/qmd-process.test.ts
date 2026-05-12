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

import { checkQmdBinaryAvailability, resolveCliSpawnInvocation } from "./qmd-process.js";

function createMockChild() {
  const child = new EventEmitter() as EventEmitter & {
    kill: ReturnType<typeof vi.fn>;
  };
  child.kill = vi.fn();
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
    ).resolves.toEqual({ available: false, error: "spawn qmd ENOENT" });
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
    ).resolves.toEqual({ available: false, error: "spawn qmd ENOENT" });
  });
});
