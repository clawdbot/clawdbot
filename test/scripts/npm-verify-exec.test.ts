// Npm Verify Exec tests cover npm verify exec script behavior.
import { afterEach, describe, expect, it } from "vitest";
import { runNpmVerifyCommand } from "../../scripts/lib/npm-verify-exec.ts";
import { withEnv } from "../../src/test-utils/env.js";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe("npm verifier command execution", () => {
  it("trims successful command output", () => {
    const root = tempDirs.make("openclaw-npm-verify-exec-");

    expect(
      runNpmVerifyCommand(
        {
          command: process.execPath,
          args: ["-e", "process.stdout.write('  ok\\n')"],
        },
        root,
        { timeoutMs: 5_000 },
      ),
    ).toBe("ok");
  });

  it("bounds hung commands even when they ignore SIGTERM", () => {
    const root = tempDirs.make("openclaw-npm-verify-exec-");
    const startedAt = Date.now();

    expect(() =>
      runNpmVerifyCommand(
        {
          command: process.execPath,
          args: ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);"],
        },
        root,
        { timeoutMs: 100 },
      ),
    ).toThrow(/ETIMEDOUT|timed out/u);
    expect(Date.now() - startedAt).toBeLessThan(2_500);
  });

  it("bounds buffered command output", () => {
    const root = tempDirs.make("openclaw-npm-verify-exec-");

    expect(() =>
      runNpmVerifyCommand(
        {
          command: process.execPath,
          args: ["-e", "process.stdout.write('x'.repeat(2048));"],
        },
        root,
        { maxBufferBytes: 1024, timeoutMs: 5_000 },
      ),
    ).toThrow(/ENOBUFS|maxBuffer/u);
  });

  it("rejects malformed command limit environment values", () => {
    const root = tempDirs.make("openclaw-npm-verify-exec-");

    withEnv({ OPENCLAW_NPM_VERIFY_COMMAND_TIMEOUT_MS: "5m" }, () => {
      expect(() =>
        runNpmVerifyCommand(
          { command: process.execPath, args: ["-e", "process.stdout.write('ok')"] },
          root,
        ),
      ).toThrow("invalid OPENCLAW_NPM_VERIFY_COMMAND_TIMEOUT_MS: 5m");
    });

    withEnv({ OPENCLAW_NPM_VERIFY_COMMAND_MAX_BUFFER_BYTES: "16mb" }, () => {
      expect(() =>
        runNpmVerifyCommand(
          { command: process.execPath, args: ["-e", "process.stdout.write('ok')"] },
          root,
        ),
      ).toThrow("invalid OPENCLAW_NPM_VERIFY_COMMAND_MAX_BUFFER_BYTES: 16mb");
    });
  });
});
