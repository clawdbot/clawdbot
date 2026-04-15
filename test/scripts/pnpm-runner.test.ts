import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createPnpmRunnerSpawnSpec, resolvePnpmRunner } from "../../scripts/pnpm-runner.mjs";

describe("resolvePnpmRunner", () => {
  it("uses npm_execpath when it points to a JS pnpm entrypoint", () => {
    expect(
      resolvePnpmRunner({
        npmExecPath: "/home/test/.cache/node/corepack/v1/pnpm/10.32.1/bin/pnpm.cjs",
        nodeExecPath: "/usr/local/bin/node",
        pnpmArgs: ["exec", "vitest", "run"],
        platform: "linux",
      }),
    ).toEqual({
      command: "/usr/local/bin/node",
      args: [
        "/home/test/.cache/node/corepack/v1/pnpm/10.32.1/bin/pnpm.cjs",
        "exec",
        "vitest",
        "run",
      ],
      shell: false,
    });
  });

  it("uses npm_execpath when it points to a shebang pnpm script", () => {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), "pnpm-runner-"));
    const npmExecPath = path.join(tempDir, "pnpm");
    writeFileSync(npmExecPath, "#!/usr/bin/env node\nconsole.log('pnpm');\n");

    try {
      expect(
        resolvePnpmRunner({
          npmExecPath,
          nodeExecPath: "/usr/local/bin/node",
          pnpmArgs: ["exec", "vitest", "run"],
          platform: "linux",
        }),
      ).toEqual({
        command: "/usr/local/bin/node",
        args: [npmExecPath, "exec", "vitest", "run"],
        shell: false,
      });
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("prepends node args when launching pnpm through node", () => {
    expect(
      resolvePnpmRunner({
        npmExecPath: "/home/test/.cache/node/corepack/v1/pnpm/10.32.1/bin/pnpm.cjs",
        nodeArgs: ["--no-maglev"],
        nodeExecPath: "/usr/local/bin/node",
        pnpmArgs: ["exec", "vitest", "run"],
        platform: "linux",
      }),
    ).toEqual({
      command: "/usr/local/bin/node",
      args: [
        "--no-maglev",
        "/home/test/.cache/node/corepack/v1/pnpm/10.32.1/bin/pnpm.cjs",
        "exec",
        "vitest",
        "run",
      ],
      shell: false,
    });
  });

  it("falls back to bare pnpm when npm_execpath points to a native pnpm binary", () => {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), "pnpm-runner-"));
    const npmExecPath = path.join(tempDir, "pnpm");
    writeFileSync(npmExecPath, Buffer.from([0x7f, 0x45, 0x4c, 0x46]));

    try {
      expect(
        resolvePnpmRunner({
          npmExecPath,
          pnpmArgs: ["exec", "vitest", "run"],
          platform: "linux",
        }),
      ).toEqual({
        command: "pnpm",
        args: ["exec", "vitest", "run"],
        shell: false,
      });
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("falls back to bare pnpm on non-Windows when npm_execpath is missing", () => {
    expect(
      resolvePnpmRunner({
        npmExecPath: "",
        pnpmArgs: ["exec", "vitest", "run"],
        platform: "linux",
      }),
    ).toEqual({
      command: "pnpm",
      args: ["exec", "vitest", "run"],
      shell: false,
    });
  });

  it("wraps pnpm.cmd via cmd.exe on Windows when npm_execpath is unavailable", () => {
    expect(
      resolvePnpmRunner({
        comSpec: "C:\\Windows\\System32\\cmd.exe",
        npmExecPath: "",
        pnpmArgs: ["exec", "vitest", "run", "-t", "path with spaces"],
        platform: "win32",
      }),
    ).toEqual({
      command: "C:\\Windows\\System32\\cmd.exe",
      args: ["/d", "/s", "/c", 'pnpm.cmd exec vitest run -t "path with spaces"'],
      shell: false,
      windowsVerbatimArguments: true,
    });
  });

  it("escapes caret arguments for Windows cmd.exe", () => {
    expect(
      resolvePnpmRunner({
        comSpec: "C:\\Windows\\System32\\cmd.exe",
        npmExecPath: "",
        pnpmArgs: ["exec", "vitest", "-t", "@scope/pkg@^1.2.3"],
        platform: "win32",
      }),
    ).toEqual({
      command: "C:\\Windows\\System32\\cmd.exe",
      args: ["/d", "/s", "/c", "pnpm.cmd exec vitest -t @scope/pkg@^^1.2.3"],
      shell: false,
      windowsVerbatimArguments: true,
    });
  });

  it("builds a shared spawn spec with inherited stdio and env overrides", () => {
    const env = { PATH: "/custom/bin", FOO: "bar" };
    expect(
      createPnpmRunnerSpawnSpec({
        cwd: "/repo",
        detached: true,
        npmExecPath: "",
        pnpmArgs: ["exec", "vitest", "run"],
        platform: "linux",
        env,
      }),
    ).toEqual({
      command: "pnpm",
      args: ["exec", "vitest", "run"],
      options: {
        cwd: "/repo",
        detached: true,
        stdio: "inherit",
        env,
        shell: false,
        windowsVerbatimArguments: undefined,
      },
    });
  });
});
