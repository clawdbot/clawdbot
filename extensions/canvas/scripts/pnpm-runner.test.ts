// Canvas tests cover pnpm runner plugin behavior.
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolvePnpmRunner } from "./pnpm-runner.mjs";

describe("canvas pnpm runner", () => {
  const posixIt = process.platform === "win32" ? it.skip : it;

  it("executes native pnpm binaries from npm_execpath directly on non-Windows", () => {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), "canvas-pnpm-runner-"));
    const npmExecPath = path.join(tempDir, "pnpm");
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
});
