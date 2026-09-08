import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createPnpmRunnerSpawnSpec, resolvePnpmRunner } from "../../scripts/pnpm-runner.mts";
import { buildCmdExeCommandLine } from "../../scripts/windows-cmd-helpers.mjs";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

describe("resolvePnpmRunner", () => {
  const posixIt = process.platform === "win32" ? it.skip : it;

  const tempDirs = useAutoCleanupTempDirTracker(afterAll);
  let fixturesRoot: string;

  beforeAll(() => {
    fixturesRoot = tempDirs.make("pnpm-runner-");
    const writeLauncher = (relativePath: string, source: string | Buffer, mode?: number) => {
      const file = path.join(fixturesRoot, relativePath);
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, source);
      if (mode !== undefined) {
        chmodSync(file, mode);
      }
    };
    for (const name of ["pnpm-cli.cjs", "pnpm.cjs", "pnpm.mjs"]) {
      writeLauncher(
        `env/${name}`,
        `console.log(JSON.stringify({
          entrypoint: process.argv[1],
          npmExecPath: process.env.npm_execpath ?? null,
          args: process.argv.slice(2),
        }));\n`,
      );
    }
    writeLauncher("js/pnpm.cjs", "console.log('pnpm');\n");
    writeLauncher("shebang/pnpm", "#!/usr/bin/env node\nconsole.log('pnpm');\n");
    const elfHeader = Buffer.from([0x7f, 0x45, 0x4c, 0x46]);
    for (const name of ["pnpm", "pnpm-native"]) {
      writeLauncher(`native/${name}`, elfHeader, 0o755);
    }
    writeLauncher("not-executable/pnpm", elfHeader, 0o644);
    writeLauncher("shell/pnpm", '#!/bin/sh\nprintf "%s\\n" "$@"\n', 0o755);
    writeLauncher("parent/pnpm", "#!/usr/bin/env node\n", 0o755);
    // PATH absence and precedence need separate directories even though setup is shared.
    mkdirSync(path.join(fixturesRoot, "child"));
    for (const name of ["corepack/corepack", "path/pnpm", "path/corepack"]) {
      writeLauncher(name, "#!/bin/sh\nexit 0\n", 0o755);
    }
    writeLauncher("windows/corepack.cmd", "@exit /b 0\r\n");
  });

  afterEach(() => vi.unstubAllEnvs());

  it.each([
    { name: "supplied env", env: "selected", override: false, entrypoint: "pnpm.cjs" },
    { name: "explicit override", env: "selected", override: true, entrypoint: "pnpm.mjs" },
    { name: "default process env", env: "default", override: false, entrypoint: "pnpm-cli.cjs" },
    { name: "empty env with override", env: "empty", override: true, entrypoint: "pnpm.mjs" },
  ])("executes with $name at the child boundary", ({ env: envMode, override, entrypoint }) => {
    const tempDir = path.join(fixturesRoot, "env");
    const parentPath = path.join(tempDir, "pnpm-cli.cjs");
    const selectedPath = path.join(tempDir, "pnpm.cjs");
    const overridePath = path.join(tempDir, "pnpm.mjs");
    const env =
      envMode === "selected"
        ? { npm_execpath: selectedPath }
        : envMode === "empty"
          ? {}
          : undefined;
    const params = {
      cwd: tempDir,
      env,
      npmExecPath: override ? overridePath : undefined,
      pnpmArgs: ["literal & argument"],
      stdio: "pipe",
    };
    // Windows worker env copies are case-sensitive. Set the default environment
    // in a real main thread so launcher selection and child inheritance agree.
    const result = spawnSync(process.execPath, ["--input-type=module", "-"], {
      encoding: "utf8",
      input: `
        import { spawnSync } from "node:child_process";
        process.env.npm_execpath = ${JSON.stringify(parentPath)};
        const { createPnpmRunnerSpawnSpec } = await import(${JSON.stringify(new URL("../../scripts/pnpm-runner.mts", import.meta.url).href)});
        const spec = createPnpmRunnerSpawnSpec(${JSON.stringify(params)});
        const result = spawnSync(spec.command, spec.args, { ...spec.options, encoding: "utf8" });
        if (result.error) throw result.error;
        process.stdout.write(result.stdout);
        process.stderr.write(result.stderr);
        process.exitCode = result.status ?? 1;
      `,
    });
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      entrypoint: path.join(tempDir, entrypoint),
      npmExecPath: envMode === "selected" ? selectedPath : envMode === "empty" ? null : parentPath,
      args: ["literal & argument"],
    });
  });

  it("uses npm_execpath when it points to a JS pnpm entrypoint", () => {
    const tempDir = path.join(fixturesRoot, "js");
    const npmExecPath = path.join(tempDir, "pnpm.cjs");

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
  });

  it("uses npm_execpath when it points to a shebang pnpm script", () => {
    const tempDir = path.join(fixturesRoot, "shebang");
    const npmExecPath = path.join(tempDir, "pnpm");

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
  });

  it("prepends node args when launching pnpm through node", () => {
    const tempDir = path.join(fixturesRoot, "js");
    const npmExecPath = path.join(tempDir, "pnpm.cjs");

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
  });

  it.each(["pnpm", "pnpm-native"])("executes native %s from npm_execpath directly", (basename) => {
    const tempDir = path.join(fixturesRoot, "native");
    const npmExecPath = path.join(tempDir, basename);

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
  });

  posixIt("falls back to bare pnpm when native npm_execpath is not executable", () => {
    const tempDir = path.join(fixturesRoot, "not-executable");
    const npmExecPath = path.join(tempDir, "pnpm");

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
  });

  it.each(["pnpm.exe", "pnpm-native.exe"])("executes %s directly on Windows", (basename) => {
    const npmExecPath = `C:\\Users\\test\\AppData\\Local\\pnpm\\${basename}`;

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

  posixIt("executes a shell npm_execpath with its own interpreter", () => {
    const tempDir = path.join(fixturesRoot, "shell");
    const npmExecPath = path.join(tempDir, "pnpm");
    const spec = createPnpmRunnerSpawnSpec({
      npmExecPath,
      pnpmArgs: ["literal & argument"],
      stdio: "pipe",
    });
    const result = spawnSync(spec.command, spec.args, { ...spec.options, encoding: "utf8" });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe("literal & argument\n");
  });

  it("uses pnpm.cjs through node for Windows-style paths", () => {
    const tempDir = path.join(fixturesRoot, "js");
    const npmExecPath = path.join(tempDir, "pnpm.cjs");

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
  });

  it("falls back to pnpm.cmd on Windows for a missing legacy pnpm 10 JS entrypoint", () => {
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

  posixIt("does not resolve parent npm_execpath or PATH for an explicit empty env", () => {
    const tempDir = path.join(fixturesRoot, "parent");
    const npmExecPath = path.join(tempDir, "pnpm");
    vi.stubEnv("npm_execpath", npmExecPath);
    vi.stubEnv("PATH", tempDir);
    expect(
      resolvePnpmRunner({
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
    const childDir = path.join(fixturesRoot, "child");

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
  });

  posixIt("uses Corepack when pnpm is not directly available on PATH", () => {
    const tempDir = path.join(fixturesRoot, "corepack");
    const corepackPath = path.join(tempDir, "corepack");

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
  });

  posixIt("prefers a direct pnpm executable over Corepack", () => {
    const tempDir = path.join(fixturesRoot, "path");
    const pnpmPath = path.join(tempDir, "pnpm");

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
    const tempDir = path.join(fixturesRoot, "windows");
    const corepackPath = path.join(tempDir, "corepack.cmd");

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
