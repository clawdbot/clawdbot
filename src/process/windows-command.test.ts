// Windows command tests cover command quoting and shell resolution on Windows.
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { withTempDir } from "../test-utils/temp-dir.js";
import { withMockedWindowsPlatform } from "../test-utils/vitest-spies.js";
import { resolveSafeChildProcessInvocation, resolveWindowsCommandShim } from "./windows-command.js";

describe("Windows command helpers", () => {
  it("leaves commands unchanged outside Windows", () => {
    expect(
      resolveWindowsCommandShim({
        command: "pnpm",
        cmdCommands: ["pnpm"],
        platform: "linux",
      }),
    ).toBe("pnpm");
  });

  it("appends .cmd for configured Windows shims", () => {
    expect(
      resolveWindowsCommandShim({
        command: "pnpm",
        cmdCommands: ["corepack", "pnpm", "yarn"],
        platform: "win32",
      }),
    ).toBe("pnpm.cmd");
  });

  it("appends .cmd for corepack on Windows", () => {
    expect(
      resolveWindowsCommandShim({
        command: "corepack",
        cmdCommands: ["corepack", "pnpm", "yarn"],
        platform: "win32",
      }),
    ).toBe("corepack.cmd");
  });

  it("keeps explicit extensions on Windows", () => {
    expect(
      resolveWindowsCommandShim({
        command: "npm.cmd",
        cmdCommands: ["npm", "npx"],
        platform: "win32",
      }),
    ).toBe("npm.cmd");
  });

  it("resolves relative executables against the child cwd", async () => {
    await withTempDir("openclaw-windows-command-cwd-", async (cwd) => {
      const binDir = path.join(cwd, "bin");
      const executable = path.join(binDir, "tool.exe");
      await mkdir(binDir);
      await writeFile(executable, "");

      await withMockedWindowsPlatform(async () => {
        expect(
          resolveSafeChildProcessInvocation({
            argv: ["./bin/tool"],
            cwd,
            env: { PATHEXT: ".EXE" },
          }).command,
        ).toBe(executable);
      });
    });
  });

  it("resolves bare executables from PATH without allowing child-cwd shadowing", async () => {
    await withTempDir("openclaw-windows-command-bare-path-", async (base) => {
      const cwd = path.join(base, "cwd");
      const binDir = path.join(base, "bin");
      const cwdExecutable = path.join(cwd, "tool.exe");
      const pathExecutable = path.join(binDir, "tool.exe");
      await mkdir(cwd);
      await mkdir(binDir);
      await writeFile(cwdExecutable, "");
      await writeFile(pathExecutable, "");

      await withMockedWindowsPlatform(async () => {
        expect(
          resolveSafeChildProcessInvocation({
            argv: ["tool.exe"],
            cwd,
            env: { PATH: binDir, PATHEXT: ".EXE" },
          }).command,
        ).toBe(pathExecutable);
      });
    });
  });

  it("requires an explicit relative path for executables in the child cwd", async () => {
    await withTempDir("openclaw-windows-command-bare-cwd-", async (cwd) => {
      await writeFile(path.join(cwd, "tool.exe"), "");

      await withMockedWindowsPlatform(async () => {
        expect(() =>
          resolveSafeChildProcessInvocation({
            argv: ["tool.exe"],
            cwd,
            env: { PATH: "", PATHEXT: ".EXE" },
          }),
        ).toThrow(/ENOENT/);
      });
    });
  });

  it("accepts explicit executable paths independently of PATHEXT", async () => {
    await withTempDir("openclaw-windows-command-explicit-", async (cwd) => {
      const executable = path.join(cwd, "tool.exe");
      await writeFile(executable, "");

      await withMockedWindowsPlatform(async () => {
        expect(
          resolveSafeChildProcessInvocation({
            argv: [executable],
            cwd,
            env: { PATH: "", PATHEXT: ".CMD;.BAT" },
          }).command,
        ).toBe(executable);
      });
    });
  });

  it("resolves PATH and PATHEXT keys case-insensitively", async () => {
    await withTempDir("openclaw-windows-command-env-case-", async (binDir) => {
      const executable = path.join(binDir, "tool.exe");
      await writeFile(executable, "");

      await withMockedWindowsPlatform(async () => {
        expect(
          resolveSafeChildProcessInvocation({
            argv: ["tool"],
            env: { path: binDir, pathext: ".EXE" },
          }).command,
        ).toBe(executable);
      });
    });
  });

  it("accepts PATH executables with explicit extensions independently of PATHEXT", async () => {
    await withTempDir("openclaw-windows-command-path-extension-", async (binDir) => {
      const executable = path.join(binDir, "tool.exe");
      await writeFile(executable, "");

      await withMockedWindowsPlatform(async () => {
        expect(
          resolveSafeChildProcessInvocation({
            argv: ["tool.exe"],
            env: { PATH: binDir, PATHEXT: ".CMD;.BAT" },
          }).command,
        ).toBe(executable);
      });
    });
  });

  it("honors PATHEXT precedence before package-manager shim fallback", async () => {
    await withTempDir("openclaw-windows-command-pathext-", async (binDir) => {
      const exePath = path.join(binDir, "pnpm.exe");
      await writeFile(exePath, "");
      await writeFile(path.join(binDir, "pnpm.cmd"), "");

      await withMockedWindowsPlatform(async () => {
        expect(
          resolveSafeChildProcessInvocation({
            argv: ["pnpm", "--version"],
            env: { PATH: binDir, PATHEXT: ".EXE;.CMD" },
          }),
        ).toMatchObject({
          args: ["--version"],
          command: exePath,
          usesWindowsExitCodeShim: false,
        });
      });
    });
  });
});
