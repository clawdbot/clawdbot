// Pnpm Runner tests cover pnpm runner script behavior.
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createPnpmRunnerSpawnSpec, resolvePnpmRunner } from "../../scripts/pnpm-runner.mjs";
import { buildCmdExeCommandLine } from "../../scripts/windows-cmd-helpers.mjs";

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
          env: { PATH: "" },
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
        env: { PATH: "" },
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
        env: { PATH: "" },
        pnpmArgs: ["exec", "vitest", "run"],
        platform: "linux",
      }),
    ).toEqual({
      command: "pnpm",
      args: ["exec", "vitest", "run"],
      shell: false,
    });
  });

  posixIt("does not resolve executables from the parent PATH for an explicit empty env", () => {
    expect(
      resolvePnpmRunner({
        npmExecPath: "",
        env: {},
        pnpmArgs: ["exec", "vitest", "run"],
        platform: "linux",
      }),
    ).toEqual({
      command: "pnpm",
      args: ["exec", "vitest", "run"],
      shell: false,
    });
  });

  posixIt("resolves relative PATH entries from the child working directory", () => {
    const childDir = mkdtempSync(path.join(os.tmpdir(), "pnpm-runner-child-"));

    try {
      expect(
        resolvePnpmRunner({
          cwd: childDir,
          npmExecPath: "",
          env: { PATH: "node_modules/.bin" },
          pnpmArgs: ["exec", "vitest", "run"],
          platform: "linux",
        }),
      ).toEqual({
        command: "pnpm",
        args: ["exec", "vitest", "run"],
        shell: false,
      });
    } finally {
      rmSync(childDir, { recursive: true, force: true });
    }
  });

  posixIt("uses Corepack when pnpm is not directly available on PATH", () => {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), "pnpm-runner-corepack-"));
    const corepackPath = path.join(tempDir, "corepack");
    writeFileSync(corepackPath, "#!/bin/sh\nexit 0\n");
    chmodSync(corepackPath, 0o755);

    try {
      expect(
        resolvePnpmRunner({
          npmExecPath: "",
          env: { PATH: tempDir },
          pnpmArgs: ["exec", "tsdown"],
          platform: "darwin",
        }),
      ).toEqual({
        command: corepackPath,
        args: ["pnpm", "exec", "tsdown"],
        shell: false,
      });
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  posixIt("prefers a direct pnpm executable over Corepack", () => {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), "pnpm-runner-path-"));
    const pnpmPath = path.join(tempDir, "pnpm");
    const corepackPath = path.join(tempDir, "corepack");
    writeFileSync(pnpmPath, "#!/bin/sh\nexit 0\n");
    writeFileSync(corepackPath, "#!/bin/sh\nexit 0\n");
    chmodSync(pnpmPath, 0o755);
    chmodSync(corepackPath, 0o755);

    try {
      expect(
        resolvePnpmRunner({
          npmExecPath: "",
          env: { PATH: tempDir },
          pnpmArgs: ["exec", "tsdown"],
          platform: "darwin",
        }),
      ).toEqual({
        command: pnpmPath,
        args: ["exec", "tsdown"],
        shell: false,
      });
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("wraps pnpm.cmd via cmd.exe on Windows when npm_execpath is unavailable", () => {
    expect(
      resolvePnpmRunner({
        comSpec: "C:\\Windows\\System32\\cmd.exe",
        env: { PATH: "" },
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

  it("ignores ambient ComSpec when defaulting the Windows cmd shim launcher", () => {
    expect(
      resolvePnpmRunner({
        env: {
          ComSpec: "C:\\Users\\test\\bin\\cmd.exe",
          PATH: "",
          SystemRoot: "D:\\Windows",
        },
        npmExecPath: "",
        pnpmArgs: ["exec", "vitest", "run"],
        platform: "win32",
      }),
    ).toEqual({
      command: "D:\\Windows\\System32\\cmd.exe",
      args: ["/d", "/s", "/c", "pnpm.cmd exec vitest run"],
      shell: false,
      windowsVerbatimArguments: true,
    });
  });

  it("uses Corepack on Windows when no pnpm shim is available", () => {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), "pnpm-runner-corepack-"));
    const corepackPath = path.join(tempDir, "corepack.cmd");
    writeFileSync(corepackPath, "@exit /b 0\r\n");

    try {
      expect(
        resolvePnpmRunner({
          comSpec: "C:\\Windows\\System32\\cmd.exe",
          npmExecPath: "",
          env: { Path: tempDir, PATHEXT: ".CMD;.EXE" },
          pnpmArgs: ["exec", "vitest", "run"],
          platform: "win32",
        }),
      ).toEqual({
        command: "C:\\Windows\\System32\\cmd.exe",
        args: [
          "/d",
          "/s",
          "/c",
          buildCmdExeCommandLine(corepackPath, ["pnpm", "exec", "vitest", "run"]),
        ],
        shell: false,
        windowsVerbatimArguments: true,
      });
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("escapes caret arguments for Windows cmd.exe", () => {
    expect(
      resolvePnpmRunner({
        comSpec: "C:\\Windows\\System32\\cmd.exe",
        env: { PATH: "" },
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
