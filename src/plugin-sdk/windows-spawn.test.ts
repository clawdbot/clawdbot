/**
 * Tests Windows spawn compatibility helpers.
 */
import { spawnSync } from "node:child_process";
import { copyFile, mkdir, realpath, writeFile } from "node:fs/promises";
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
  it.runIf(process.platform === "win32")(
    "resolves mixed-case PATH and PATHEXT keys for a native Windows spawn",
    async () => {
      const dir = await createTempDir("openclaw-windows-spawn-env-case-");
      const executable = path.join(dir, "mixed-env-tool.MiXeD");
      await copyFile(process.execPath, executable);
      const env = { pAtH: dir, pAtHeXt: ".MiXeD" };

      const program = resolveWindowsSpawnProgram({
        command: "mixed-env-tool",
        platform: "win32",
        env,
        execPath: process.execPath,
      });
      const invocation = materializeWindowsSpawnProgram(program, [
        "-e",
        'process.stdout.write("native-ok")',
      ]);
      const child = spawnSync(invocation.command, invocation.argv, { env, encoding: "utf8" });

      expect(program).toMatchObject({ command: executable, resolution: "direct" });
      expect(child.error).toBeUndefined();
      expect(child.status).toBe(0);
      expect(child.stdout).toBe("native-ok");
    },
  );

  it.each(["node script.js", "pnpm exec tool", '"C:\\tools\\pnpm.cmd" exec tool'])(
    "rejects command strings with inline arguments on Windows: %s",
    (command) => {
      expect(() =>
        resolveWindowsSpawnProgram({
          command,
          platform: "win32",
          env: {},
          execPath: "C:\\node\\node.exe",
        }),
      ).toThrow("Windows spawn command must be an executable path only");
    },
  );

  it.each(["pnpm checkout", "node tools"])(
    "preserves an existing launcher path inside %s on Windows",
    async (directory) => {
      const root = await realpath(await createTempDir("openclaw-windows-spawn-test-"));
      const dir = path.join(root, directory);
      await mkdir(dir);
      const launcher = path.join(dir, "launcher.js");
      await writeFile(launcher, "process.exit(0);\n", "utf8");

      const program = resolveWindowsSpawnProgram({
        command: launcher,
        platform: "win32",
        env: {},
        execPath: process.execPath,
      });

      expect(materializeWindowsSpawnProgram(program, ["--version"])).toEqual({
        command: process.execPath,
        argv: [launcher, "--version"],
        resolution: "node-entrypoint",
        shell: undefined,
        windowsHide: true,
      });
    },
  );

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
