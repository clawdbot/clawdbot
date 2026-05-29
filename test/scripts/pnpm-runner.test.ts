import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createPnpmRunnerSpawnSpec, resolvePnpmRunner } from "../../scripts/pnpm-runner.mjs";

describe("resolvePnpmRunner", () => {
  const posixIt = process.platform === "win32" ? it.skip : it;

  it("uses npm_execpath when it points to a JS pnpm entrypoint", () => {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), "pnpm-runner-"));
    const npmExecPath = path.join(tempDir, "pnpm.cjs");
    writeFileSync(npmExecPath, "console.log('pnpm');\n");

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
    const tempDir = mkdtempSync(path.join(os.tmpdir(), "pnpm-runner-"));
    const npmExecPath = path.join(tempDir, "pnpm.cjs");
    writeFileSync(npmExecPath, "console.log('pnpm');\n");

    try {
      expect(
        resolvePnpmRunner({
          npmExecPath,
          nodeArgs: ["--no-maglev"],
          nodeExecPath: "/usr/local/bin/node",
          pnpmArgs: ["exec", "vitest", "run"],
          platform: "linux",
        }),
      ).toEqual({
        command: "/usr/local/bin/node",
        args: ["--no-maglev", npmExecPath, "exec", "vitest", "run"],
        shell: false,
      });
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("executes native pnpm binaries from npm_execpath directly on non-Windows", () => {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), "pnpm-runner-"));
    const npmExecPath = path.join(tempDir, "pnpm");
    writeFileSync(npmExecPath, Buffer.from([0x7f, 0x45, 0x4c, 0x46]));
    chmodSync(npmExecPath, 0o755);

    try {
      expect(
        resolvePnpmRunner({
          npmExecPath,
          pnpmArgs: ["exec", "vitest", "run"],
          platform: "linux",
        }),
      ).toEqual({
        command: npmExecPath,
        args: ["exec", "vitest", "run"],
        shell: false,
      });
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  posixIt("falls back to bare pnpm when native npm_execpath is not executable", () => {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), "pnpm-runner-"));
    const npmExecPath = path.join(tempDir, "pnpm");
    writeFileSync(npmExecPath, Buffer.from([0x7f, 0x45, 0x4c, 0x46]));
    chmodSync(npmExecPath, 0o644);

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

  it("executes pnpm.exe directly on Windows", () => {
    const npmExecPath =
      "C:\\Users\\test\\AppData\\Local\\pnpm\\.tools\\@pnpm+exe\\10.32.1\\node_modules\\@pnpm\\exe\\pnpm.exe";

    expect(
      resolvePnpmRunner({
        npmExecPath,
        nodeArgs: ["--no-maglev"],
        nodeExecPath: "C:\\Program Files\\nodejs\\node.exe",
        pnpmArgs: ["exec", "vitest", "run"],
        platform: "win32",
      }),
    ).toEqual({
      command: npmExecPath,
      args: ["exec", "vitest", "run"],
      shell: false,
    });
  });

  it("uses pnpm.cjs through node for Windows-style paths", () => {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), "pnpm-runner-"));
    const npmExecPath = path.join(tempDir, "pnpm.cjs");
    writeFileSync(npmExecPath, "console.log('pnpm');\n");

    try {
      expect(
        resolvePnpmRunner({
          npmExecPath,
          nodeExecPath: "C:\\Program Files\\nodejs\\node.exe",
          pnpmArgs: ["exec", "vitest", "run"],
          platform: "win32",
        }),
      ).toEqual({
        command: "C:\\Program Files\\nodejs\\node.exe",
        args: [npmExecPath, "exec", "vitest", "run"],
        shell: false,
      });
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("falls back to pnpm.cmd on Windows when npm_execpath points to a missing JS entrypoint", () => {
    expect(
      resolvePnpmRunner({
        comSpec: "C:\\Windows\\System32\\cmd.exe",
        npmExecPath:
          "C:\\Users\\test\\AppData\\Local\\Temp\\cache\\corepack\\v1\\pnpm\\10.32.1\\bin\\pnpm.mjs",
        nodeExecPath: "C:\\Program Files\\nodejs\\node.exe",
        pnpmArgs: ["exec", "vitest", "run"],
        platform: "win32",
      }),
    ).toEqual({
      command: "C:\\Windows\\System32\\cmd.exe",
      args: ["/d", "/s", "/c", "pnpm.cmd exec vitest run"],
      shell: false,
      windowsVerbatimArguments: true,
    });
  });

  it("wraps an explicit pnpm.cmd path via cmd.exe on Windows", () => {
    expect(
      resolvePnpmRunner({
        comSpec: "C:\\Windows\\System32\\cmd.exe",
        npmExecPath: "C:\\Program Files\\pnpm\\pnpm.cmd",
        pnpmArgs: ["exec", "vitest", "run", "-t", "path with spaces"],
        platform: "win32",
      }),
    ).toEqual({
      command: "C:\\Windows\\System32\\cmd.exe",
      args: [
        "/d",
        "/s",
        "/c",
        '""C:\\Program Files\\pnpm\\pnpm.cmd" exec vitest run -t "path with spaces""',
      ],
      shell: false,
      windowsVerbatimArguments: true,
    });
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
