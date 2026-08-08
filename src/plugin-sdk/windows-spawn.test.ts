/**
 * Tests Windows spawn compatibility helpers.
 */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createPluginSdkTestHarness } from "./test-helpers.js";
import { materializeWindowsSpawnProgram, resolveWindowsSpawnProgram } from "./windows-spawn.js";

const { createTempDir } = createPluginSdkTestHarness({
  cleanup: {
    maxRetries: 8,
    retryDelay: 8,
  },
});

describe("resolveWindowsSpawnProgram", () => {
  it("rejects node command strings that include inline entrypoint arguments on Windows", () => {
    expect(() =>
      resolveWindowsSpawnProgram({
        command: "node C:\\Users\\me\\.openclaw\\npm\\node_modules\\@openai\\codex\\bin\\codex.js",
        platform: "win32",
        env: {},
        execPath: "C:\\node\\node.exe",
      }),
    ).toThrow("Windows spawn command must be an executable path only");
  });

  it("allows executable paths with spaces on Windows", () => {
    const resolved = resolveWindowsSpawnProgram({
      command: "C:\\Program Files\\OpenAI Codex\\codex.exe",
      platform: "win32",
      env: {},
      execPath: "C:\\node\\node.exe",
    });

    expect(resolved).toEqual({
      command: "C:\\Program Files\\OpenAI Codex\\codex.exe",
      leadingArgv: [],
      resolution: "direct",
      windowsHide: undefined,
    });
  });

  it("fails closed by default for unresolved windows wrappers", async () => {
    const dir = await createTempDir("openclaw-windows-spawn-test-");
    const shimPath = path.join(dir, "wrapper.cmd");
    await writeFile(shimPath, "@ECHO off\r\necho wrapper\r\n", "utf8");

    expect(() =>
      resolveWindowsSpawnProgram({
        command: shimPath,
        platform: "win32",
        env: { PATH: dir, PATHEXT: ".CMD;.EXE;.BAT" },
        execPath: "C:\\node\\node.exe",
      }),
    ).toThrow(/without shell execution/);
  });

  it("only returns shell fallback when explicitly opted in", async () => {
    const dir = await createTempDir("openclaw-windows-spawn-test-");
    const shimPath = path.join(dir, "wrapper.cmd");
    await writeFile(shimPath, "@ECHO off\r\necho wrapper\r\n", "utf8");

    const resolved = resolveWindowsSpawnProgram({
      command: shimPath,
      platform: "win32",
      env: { PATH: dir, PATHEXT: ".CMD;.EXE;.BAT" },
      execPath: "C:\\node\\node.exe",
      allowShellFallback: true,
    });
    const invocation = materializeWindowsSpawnProgram(resolved, ["--cwd", "C:\\safe & calc.exe"]);

    expect(invocation).toEqual({
      command: shimPath,
      argv: ["--cwd", "C:\\safe & calc.exe"],
      resolution: "shell-fallback",
      shell: true,
      windowsHide: undefined,
    });
  });

  it("preserves custom batch-wrapper behavior instead of bypassing its target", async () => {
    const dir = await createTempDir("openclaw-windows-spawn-test-");
    const targetPath = path.join(dir, "tool.exe");
    const wrapperPath = path.join(dir, "wrapper.cmd");
    await writeFile(targetPath, "", "utf8");
    await writeFile(
      wrapperPath,
      '@ECHO off\r\nSET WRAPPER_FLAG=1\r\n"%~dp0\\tool.exe" %*\r\n',
      "utf8",
    );

    const resolved = resolveWindowsSpawnProgram({
      command: wrapperPath,
      platform: "win32",
      env: { PATH: dir, PATHEXT: ".CMD;.EXE;.BAT" },
      execPath: "C:\\node\\node.exe",
      allowShellFallback: true,
    });

    expect(resolved).toEqual({
      command: wrapperPath,
      leadingArgv: [],
      resolution: "shell-fallback",
      shell: true,
    });
  });

  it("resolves pnpm-style CMD wrapper that launches .exe directly without @ENDLOCAL", async () => {
    const dir = await createTempDir("openclaw-windows-spawn-test-");
    const targetPath = path.join(dir, "tool.exe");
    const wrapperPath = path.join(dir, "wrapper.cmd");
    await writeFile(targetPath, "", "utf8");
    // pnpm generates CMD wrappers with @SETLOCAL, @IF NOT DEFINED, and direct .exe launch.
    await writeFile(
      wrapperPath,
      [
        "@SETLOCAL",
        "@IF NOT DEFINED SOME_VAR (",
        '  @SET "SOME_VAR=%~dp0\\some\\path"',
        ") ELSE (",
        '  @SET "SOME_VAR=%~dp0\\some\\path;%SOME_VAR%"',
        ")",
        '@"%~dp0\\tool.exe"   %*',
        "",
      ].join("\r\n"),
      "utf8",
    );

    const resolved = resolveWindowsSpawnProgram({
      command: wrapperPath,
      platform: "win32",
      env: { PATH: dir, PATHEXT: ".CMD;.EXE;.BAT" },
      execPath: "C:\\node\\node.exe",
      packageName: "tool",
    });

    expect(resolved).toEqual({
      command: targetPath,
      leadingArgv: [],
      resolution: "exe-entrypoint",
      windowsHide: true,
    });
  });

  it("resolves pnpm-style CMD wrapper that launches via node with @SETLOCAL and @IF", async () => {
    const dir = await createTempDir("openclaw-windows-spawn-test-");
    const targetDir = path.join(dir, "node_modules", "tool", "bin");
    await mkdir(targetDir, { recursive: true });
    const targetPath = path.join(targetDir, "tool.js");
    const wrapperPath = path.join(dir, "tool.cmd");
    await writeFile(targetPath, "console.log('hello')", "utf8");
    // pnpm also generates wrappers that launch node with a .js entrypoint.
    await writeFile(
      wrapperPath,
      [
        "@SETLOCAL",
        "@IF NOT DEFINED NODE_PATH (",
        '  @SET "NODE_PATH=%~dp0\\node_modules"',
        ") ELSE (",
        '  @SET "NODE_PATH=%~dp0\\node_modules;%NODE_PATH%"',
        ")",
        '@"%~dp0\\node_modules\\tool\\bin\\tool.js"   %*',
        "",
      ].join("\r\n"),
      "utf8",
    );

    const resolved = resolveWindowsSpawnProgram({
      command: wrapperPath,
      platform: "win32",
      env: { PATH: dir, PATHEXT: ".CMD;.EXE;.BAT" },
      execPath: "C:\\node\\node.exe",
    });

    expect(resolved).toEqual({
      command: "C:\\node\\node.exe",
      leadingArgv: [targetPath],
      resolution: "node-entrypoint",
      windowsHide: true,
    });
  });

  it("does not reinterpret a forwarded batch wrapper as a Node script", async () => {
    const dir = await createTempDir("openclaw-windows-spawn-test-");
    const targetPath = path.join(dir, "inner.cmd");
    const wrapperPath = path.join(dir, "wrapper.cmd");
    await writeFile(targetPath, "@ECHO off\r\necho inner\r\n", "utf8");
    await writeFile(wrapperPath, '@ECHO off\r\n"%~dp0\\inner.cmd" %*\r\n', "utf8");

    const resolved = resolveWindowsSpawnProgram({
      command: wrapperPath,
      platform: "win32",
      env: { PATH: dir, PATHEXT: ".CMD;.EXE;.BAT" },
      execPath: "C:\\node\\node.exe",
      allowShellFallback: true,
    });

    expect(resolved).toEqual({
      command: wrapperPath,
      leadingArgv: [],
      resolution: "shell-fallback",
      shell: true,
    });
  });
});
