// Npm Runner tests cover npm runner script behavior.
import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveNpmRunner } from "../../scripts/npm-runner.mjs";

describe("resolveNpmRunner", () => {
  it("anchors npm staging to the active node toolchain when npm-cli.js exists", () => {
    const execPath = "/Users/test/.nodenv/versions/24.13.0/bin/node";
    const expectedNpmCliPath = path.posix.resolve(
      path.posix.dirname(execPath),
      "../lib/node_modules/npm/bin/npm-cli.js",
    );

    const runner = resolveNpmRunner({
      execPath,
      env: {},
      existsSync: (candidate) => candidate === expectedNpmCliPath,
      platform: "darwin",
    });

    expect(runner).toEqual({
      command: execPath,
      args: [expectedNpmCliPath],
      shell: false,
    });
  });

  it("uses the active node executable when its basename is not node", () => {
    const execPath = "/Users/test/.toolchains/node-24/bin/node24";
    const expectedNpmCliPath = path.posix.resolve(
      path.posix.dirname(execPath),
      "../lib/node_modules/npm/bin/npm-cli.js",
    );

    const runner = resolveNpmRunner({
      execPath,
      env: {},
      existsSync: (candidate) => candidate === expectedNpmCliPath,
      npmArgs: ["pack", "openclaw@beta"],
      platform: "darwin",
    });

    expect(runner).toEqual({
      command: execPath,
      args: [expectedNpmCliPath, "pack", "openclaw@beta"],
      shell: false,
    });
  });

  it("anchors Windows npm staging to the adjacent npm-cli.js without a shell", () => {
    const execPath = "C:\\nodejs\\node.exe";
    const expectedNpmCliPath = path.win32.resolve(
      path.win32.dirname(execPath),
      "node_modules/npm/bin/npm-cli.js",
    );

    const runner = resolveNpmRunner({
      execPath,
      env: {},
      existsSync: (candidate) => candidate === expectedNpmCliPath,
      platform: "win32",
    });

    expect(runner).toEqual({
      command: execPath,
      args: [expectedNpmCliPath],
      shell: false,
    });
  });

  it("uses an adjacent npm.exe on Windows without a shell", () => {
    const execPath = "C:\\nodejs\\node.exe";
    const expectedNpmExePath = path.win32.resolve(path.win32.dirname(execPath), "npm.exe");

    const runner = resolveNpmRunner({
      execPath,
      env: {},
      existsSync: (candidate) => candidate === expectedNpmExePath,
      npmArgs: ["install", "--silent"],
      platform: "win32",
    });

    expect(runner).toEqual({
      command: expectedNpmExePath,
      args: ["install", "--silent"],
      shell: false,
    });
  });

  it("wraps an adjacent npm.cmd via cmd.exe without enabling shell mode", () => {
    const execPath = "C:\\nodejs\\node.exe";
    const npmCmdPath = path.win32.resolve(path.win32.dirname(execPath), "npm.cmd");

    const runner = resolveNpmRunner({
      comSpec: "C:\\Windows\\System32\\cmd.exe",
      execPath,
      env: {},
      existsSync: (candidate) => candidate === npmCmdPath,
      npmArgs: ["install", "--omit=dev"],
      platform: "win32",
    });

    expect(runner).toEqual({
      command: "C:\\Windows\\System32\\cmd.exe",
      args: ["/d", "/s", "/c", `${npmCmdPath} install --omit=dev`],
      shell: false,
      windowsVerbatimArguments: true,
    });
  });

  it("escapes caret semver specs when invoking npm.cmd through cmd.exe", () => {
    const execPath = "C:\\nodejs\\node.exe";
    const npmCmdPath = path.win32.resolve(path.win32.dirname(execPath), "npm.cmd");

    const runner = resolveNpmRunner({
      comSpec: "C:\\Windows\\System32\\cmd.exe",
      execPath,
      env: {},
      existsSync: (candidate) => candidate === npmCmdPath,
      npmArgs: ["install", "@slack/bolt@^4.6.0"],
      platform: "win32",
    });

    expect(runner).toEqual({
      command: "C:\\Windows\\System32\\cmd.exe",
      args: ["/d", "/s", "/c", `${npmCmdPath} install @slack/bolt@^^4.6.0`],
      shell: false,
      windowsVerbatimArguments: true,
    });
  });

  it("ignores ambient ComSpec when wrapping an adjacent npm.cmd on Windows", () => {
    const execPath = "C:\\nodejs\\node.exe";
    const npmCmdPath = path.win32.resolve(path.win32.dirname(execPath), "npm.cmd");

    const runner = resolveNpmRunner({
      env: {
        ComSpec: "C:\\Users\\test\\bin\\cmd.exe",
        SystemRoot: "D:\\Windows",
      },
      execPath,
      existsSync: (candidate) => candidate === npmCmdPath,
      npmArgs: ["install"],
      platform: "win32",
    });

    expect(runner.command).toBe("D:\\Windows\\System32\\cmd.exe");
  });

  it("prefixes PATH with the active node dir when falling back to bare npm", () => {
    expect(
      resolveNpmRunner({
        execPath: "/tmp/node",
        env: {
          PATH: "/usr/bin:/bin",
        },
        existsSync: () => false,
        platform: "linux",
      }),
    ).toEqual({
      command: "npm",
      args: [],
      shell: false,
      env: {
        PATH: `/tmp${path.delimiter}/usr/bin:/bin`,
      },
    });
  });

  it("fails closed on Windows when no toolchain-local npm CLI exists", () => {
    expect(() =>
      resolveNpmRunner({
        execPath: "C:\\node\\node.exe",
        env: {
          Path: "C:\\Windows\\System32",
        },
        existsSync: () => false,
        platform: "win32",
      }),
    ).toThrow("OpenClaw refuses to shell out to bare npm on Windows");
  });
});
