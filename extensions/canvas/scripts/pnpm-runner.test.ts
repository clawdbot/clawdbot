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
});
