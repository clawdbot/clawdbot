// Canvas tests cover pnpm runner plugin behavior.
import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolvePnpmRunner } from "./pnpm-runner.mjs";

describe("canvas pnpm runner", () => {
  const posixIt = process.platform === "win32" ? it.skip : it;

  it.each(["pnpm", "pnpm-native"])("executes native %s from npm_execpath directly", (basename) => {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), "canvas-pnpm-runner-"));
    const npmExecPath = path.join(tempDir, basename);
    writeFileSync(npmExecPath, Buffer.from([0xcf, 0xfa, 0xed, 0xfe]));
    chmodSync(npmExecPath, 0o755);

    try {
      expect(
        resolvePnpmRunner({
          env: { PATH: "" },
          npmExecPath,
          platform: "darwin",
          pnpmArgs: ["exec", "rolldown", "-c"],
        }),
      ).toEqual({
        args: ["exec", "rolldown", "-c"],
        command: npmExecPath,
        shell: false,
      });
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  posixIt("falls back to bare pnpm when native npm_execpath is not executable", () => {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), "canvas-pnpm-runner-"));
    const npmExecPath = path.join(tempDir, "pnpm");
    writeFileSync(npmExecPath, Buffer.from([0xcf, 0xfa, 0xed, 0xfe]));
    chmodSync(npmExecPath, 0o644);

    try {
      expect(
        resolvePnpmRunner({
          env: { PATH: "" },
          npmExecPath,
          platform: "darwin",
          pnpmArgs: ["exec", "rolldown", "-c"],
        }),
      ).toEqual({
        args: ["exec", "rolldown", "-c"],
        command: "pnpm",
        shell: false,
      });
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  posixIt("uses Corepack when pnpm is not directly available on PATH", () => {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), "canvas-pnpm-runner-corepack-"));
    const corepackPath = path.join(tempDir, "corepack");
    writeFileSync(corepackPath, "#!/bin/sh\nexit 0\n");
    chmodSync(corepackPath, 0o755);

    try {
      expect(
        resolvePnpmRunner({
          env: { PATH: tempDir },
          npmExecPath: "",
          platform: "darwin",
          pnpmArgs: ["exec", "rolldown", "-c"],
        }),
      ).toEqual({
        args: ["pnpm", "exec", "rolldown", "-c"],
        command: corepackPath,
        shell: false,
      });
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  posixIt("ignores a missing pnpm JS npm_execpath before checking PATH", () => {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), "canvas-pnpm-runner-missing-"));
    const corepackPath = path.join(tempDir, "corepack");
    writeFileSync(corepackPath, "#!/bin/sh\nexit 0\n");
    chmodSync(corepackPath, 0o755);

    try {
      expect(
        resolvePnpmRunner({
          env: { PATH: tempDir },
          npmExecPath: path.join(tempDir, "missing-pnpm.mjs"),
          platform: "darwin",
          pnpmArgs: ["exec", "rolldown", "-c"],
        }),
      ).toEqual({
        args: ["pnpm", "exec", "rolldown", "-c"],
        command: corepackPath,
        shell: false,
      });
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  posixIt("prefers a direct pnpm executable over Corepack", () => {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), "canvas-pnpm-runner-path-"));
    const pnpmPath = path.join(tempDir, "pnpm");
    const corepackPath = path.join(tempDir, "corepack");
    writeFileSync(pnpmPath, "#!/bin/sh\nexit 0\n");
    writeFileSync(corepackPath, "#!/bin/sh\nexit 0\n");
    chmodSync(pnpmPath, 0o755);
    chmodSync(corepackPath, 0o755);

    try {
      expect(
        resolvePnpmRunner({
          env: { PATH: tempDir },
          npmExecPath: "",
          platform: "darwin",
          pnpmArgs: ["exec", "rolldown", "-c"],
        }),
      ).toEqual({
        args: ["exec", "rolldown", "-c"],
        command: pnpmPath,
        shell: false,
      });
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
  posixIt("launches shell npm_execpath with its own interpreter and literal arguments", () => {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), "canvas-pnpm-shell-"));
    const npmExecPath = path.join(tempDir, "pnpm");
    writeFileSync(npmExecPath, "#!/bin/sh\nprintf '%s' \"$1\"\n");
    chmodSync(npmExecPath, 0o755);
    try {
      const spec = resolvePnpmRunner({ npmExecPath, pnpmArgs: ["literal & argument"] });
      const result = spawnSync(spec.command, spec.args, { encoding: "utf8", shell: spec.shell });
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toBe("literal & argument");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it.runIf(process.platform === "win32")(
    "launches native PATH entries and spaced cmd wrappers",
    () => {
      const tempDir = mkdtempSync(path.join(os.tmpdir(), "canvas pnpm windows "));
      try {
        const nativePath = path.join(tempDir, "pnpm.exe");
        copyFileSync(process.execPath, nativePath);
        const args = [
          "--eval",
          "process.stdout.write(JSON.stringify(process.argv.slice(1)))",
          "space and & literal",
        ];
        const native = resolvePnpmRunner({
          npmExecPath: "",
          env: { PATH: tempDir },
          pnpmArgs: args,
        });
        expect(native.command).toBe(nativePath);
        const result = spawnSync(native.command, native.args, {
          encoding: "utf8",
          shell: native.shell,
        });
        expect(result.status, result.stderr).toBe(0);
        expect(JSON.parse(result.stdout)).toEqual(["space and & literal"]);
        const cmdPath = path.join(tempDir, "pnpm.cmd");
        writeFileSync(cmdPath, `@echo off\r\n"${process.execPath}" --version\r\n`);
        const cmd = resolvePnpmRunner({ npmExecPath: cmdPath });
        const cmdResult = spawnSync(cmd.command, cmd.args, {
          encoding: "utf8",
          shell: cmd.shell,
          windowsVerbatimArguments: cmd.windowsVerbatimArguments,
        });
        expect(cmdResult.status, cmdResult.stderr).toBe(0);
        expect(cmdResult.stdout.trim()).toBe(process.version);
        expect(() =>
          resolvePnpmRunner({ npmExecPath: cmdPath, pnpmArgs: ["unsafe&argument"] }),
        ).toThrow(/unsafe/);
      } finally {
        rmSync(tempDir, { recursive: true, force: true });
      }
    },
  );

  it.runIf(process.platform === "win32")(
    "preserves literal arguments through spaced cmd wrappers",
    () => {
      const tempDir = mkdtempSync(path.join(os.tmpdir(), "canvas pnpm argv "));
      try {
        const capturePath = path.join(tempDir, "capture.cjs");
        writeFileSync(
          capturePath,
          "process.stdout.write(JSON.stringify(process.argv.slice(2)));\n",
        );
        const cmdPath = path.join(tempDir, "pnpm.cmd");
        writeFileSync(cmdPath, `@echo off\r\n"${process.execPath}" "${capturePath}" %*\r\n`);
        const expected = ["", "left ^ right", "C:\\two words\\", 'say "hi"'];
        const spec = resolvePnpmRunner({ npmExecPath: cmdPath, pnpmArgs: expected });

        const result = spawnSync(spec.command, spec.args, {
          encoding: "utf8",
          shell: spec.shell,
          windowsVerbatimArguments: spec.windowsVerbatimArguments,
        });

        expect(result.status, result.stderr).toBe(0);
        expect(JSON.parse(result.stdout)).toEqual(expected);
      } finally {
        rmSync(tempDir, { recursive: true, force: true });
      }
    },
  );
});
