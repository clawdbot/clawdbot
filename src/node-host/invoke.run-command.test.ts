import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { testing } from "./invoke.js";

describe("runCommand", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("captures stdout, stderr, and exit status", async () => {
    await expect(
      testing.runCommand(
        [
          process.execPath,
          "-e",
          "process.stdout.write('captured stdout'); process.stderr.write('captured stderr')",
        ],
        undefined,
        undefined,
        undefined,
      ),
    ).resolves.toEqual({
      exitCode: 0,
      timedOut: false,
      success: true,
      stdout: "captured stdout",
      stderr: "captured stderr",
      error: null,
      truncated: false,
    });
  });

  it("closes stdin for commands that wait for EOF", async () => {
    await expect(
      testing.runCommand(
        [
          process.execPath,
          "-e",
          "process.stdin.resume(); process.stdin.once('end', () => process.stdout.write('eof'))",
        ],
        undefined,
        undefined,
        2_000,
      ),
    ).resolves.toMatchObject({ success: true, stdout: "eof" });
  });

  it("preserves nonzero command results", async () => {
    await expect(
      testing.runCommand(
        [process.execPath, "-e", "process.stderr.write('failed'); process.exit(7)"],
        undefined,
        undefined,
        undefined,
      ),
    ).resolves.toMatchObject({
      exitCode: 7,
      timedOut: false,
      success: false,
      stderr: "failed",
      error: null,
    });
  });

  it.runIf(process.platform !== "win32")("force-kills timed-out command trees", async () => {
    const startedAt = Date.now();
    const result = await testing.runCommand(
      [process.execPath, "-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"],
      undefined,
      undefined,
      25,
    );
    expect(result).toMatchObject({ timedOut: true, success: false, error: null });
    expect(Date.now() - startedAt).toBeLessThan(2_000);
  });

  it("keeps the combined output prefix bounded", async () => {
    const result = await testing.runCommand(
      [process.execPath, "-e", "process.stdout.write('x'.repeat(200_001))"],
      undefined,
      undefined,
      undefined,
    );
    expect(result.stdout).toHaveLength(200_000);
    expect(result.stdout).toBe("x".repeat(200_000));
    expect(result.truncated).toBe(true);
  });

  it("preserves child launch errors", async () => {
    const result = await testing.runCommand(
      [`openclaw-missing-${process.pid}-${Date.now()}`],
      undefined,
      undefined,
      undefined,
    );
    expect(result).toMatchObject({ exitCode: undefined, timedOut: false, success: false });
    expect(result.error).toMatch(/ENOENT|not found/i);
  });

  describe("working directory failures", () => {
    const enoent = (message: string) =>
      Object.assign(new Error(message), { code: "ENOENT" }) as NodeJS.ErrnoException;

    it("blames a missing working directory instead of the shell", () => {
      const cwd = path.join(os.tmpdir(), `node-exec-missing-${process.pid}-${Date.now()}`);
      expect(testing.clarifyNodeExecCwdSpawnError(enoent("spawn /bin/sh ENOENT"), cwd)).toBe(
        `node exec working directory does not exist on the node host: ${cwd} (os reported: spawn /bin/sh ENOENT)`,
      );
    });

    it("flags a cwd that exists but is not a directory", async () => {
      const file = path.join(os.tmpdir(), `node-exec-file-${process.pid}-${Date.now()}.txt`);
      fs.writeFileSync(file, "x");
      try {
        const result = await testing.runCommand(
          [process.execPath, "-e", "process.exit(0)"],
          file,
          undefined,
          undefined,
        );
        expect(result).toMatchObject({ success: false });
        expect(result.error).toContain(
          `node exec working directory is not a directory on the node host: ${file}`,
        );
      } finally {
        fs.rmSync(file, { force: true });
      }
    });

    it("clarifies a missing cwd during execution", async () => {
      const cwd = path.join(os.tmpdir(), `node-exec-run-missing-${process.pid}-${Date.now()}`);
      const result = await testing.runCommand(
        [process.execPath, "-e", "process.exit(0)"],
        cwd,
        undefined,
        undefined,
      );
      expect(result).toMatchObject({ success: false });
      expect(result.error).toContain(
        `node exec working directory does not exist on the node host: ${cwd}`,
      );
    });

    it("preserves executable and unrelated errors", () => {
      const missingExecutable = "spawn /usr/bin/does-not-exist ENOENT";
      expect(testing.clarifyNodeExecCwdSpawnError(enoent(missingExecutable), os.tmpdir())).toBe(
        missingExecutable,
      );
      expect(testing.clarifyNodeExecCwdSpawnError(enoent("spawn /bin/sh ENOENT"), undefined)).toBe(
        "spawn /bin/sh ENOENT",
      );
      const denied = Object.assign(new Error("spawn EACCES"), {
        code: "EACCES",
      }) as NodeJS.ErrnoException;
      expect(testing.clarifyNodeExecCwdSpawnError(denied, "/missing")).toBe("spawn EACCES");
    });

    it("preserves the spawn error when the cwd cannot be inspected", () => {
      const message = "spawn /bin/sh ENOENT";
      vi.spyOn(fs, "statSync").mockImplementationOnce(() => {
        throw Object.assign(new Error("permission denied"), { code: "EACCES" });
      });
      expect(testing.clarifyNodeExecCwdSpawnError(enoent(message), "/unreadable")).toBe(message);
    });
  });
});
