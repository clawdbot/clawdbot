// Daemon diagnostics tests cover service diagnostic collection and formatting.
import fs from "node:fs";
import fsPromises from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readGatewayLogTailLines, readLastGatewayErrorLine } from "./diagnostics.js";
import { resolveGatewayLogPaths, resolveGatewaySupervisorLogPaths } from "./restart-logs.js";

const tempDirs: string[] = [];
const DIAGNOSTIC_TAIL_BYTES = 256 * 1024;
type PositionalRead = (
  buffer: Buffer,
  offset: number,
  length: number,
  position: number,
) => Promise<{ bytesRead: number; buffer: Buffer }>;

afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function makeTempStateDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-daemon-diagnostics-"));
  tempDirs.push(dir);
  return dir;
}

describe("readLastGatewayErrorLine", () => {
  it("ignores stale launchd stderr when stderr is suppressed", async () => {
    const stateDir = makeTempStateDir();
    const homeDir = makeTempStateDir();
    const env = { HOME: homeDir, OPENCLAW_STATE_DIR: stateDir };
    const stateLogs = resolveGatewayLogPaths(env);
    const launchdLogs = resolveGatewaySupervisorLogPaths(env, { platform: "darwin" });
    fs.mkdirSync(stateLogs.logDir, { recursive: true });
    fs.mkdirSync(launchdLogs.logDir, { recursive: true });
    fs.writeFileSync(stateLogs.stderrPath, "failed to bind gateway socket stale\n", "utf8");
    fs.writeFileSync(launchdLogs.stdoutPath, "gateway stdout current\n", "utf8");

    await expect(readLastGatewayErrorLine(env, { platform: "darwin" })).resolves.toBe(
      "gateway stdout current",
    );
  });

  it("prefers the current stderr error over a stale stdout match on linux", async () => {
    const stateDir = makeTempStateDir();
    const homeDir = makeTempStateDir();
    const env = { HOME: homeDir, OPENCLAW_STATE_DIR: stateDir };
    const stateLogs = resolveGatewayLogPaths(env);
    fs.mkdirSync(stateLogs.logDir, { recursive: true });
    // stderr carries the real, current failure; stdout carries an older matching
    // line. On non-darwin platforms stderr is the strongest failure signal, so
    // it must win instead of the stale stdout match.
    fs.writeFileSync(stateLogs.stderrPath, "failed to bind gateway socket EADDRINUSE\n", "utf8");
    fs.writeFileSync(stateLogs.stdoutPath, "gateway start blocked: stale prior reason\n", "utf8");

    await expect(readLastGatewayErrorLine(env, { platform: "linux" })).resolves.toBe(
      "failed to bind gateway socket EADDRINUSE",
    );
  });

  it("ignores stale stdout errors outside the bounded diagnostic tail", async () => {
    const stateDir = makeTempStateDir();
    const homeDir = makeTempStateDir();
    const env = { HOME: homeDir, OPENCLAW_STATE_DIR: stateDir };
    const stateLogs = resolveGatewayLogPaths(env);
    fs.mkdirSync(stateLogs.logDir, { recursive: true });
    fs.writeFileSync(
      stateLogs.stdoutPath,
      [
        "gateway start blocked: stale prior reason",
        "non-error filler line\n".repeat(20_000),
        "gateway stdout current",
        "",
      ].join("\n"),
      "utf8",
    );

    await expect(readLastGatewayErrorLine(env, { platform: "linux" })).resolves.toBe(
      "gateway stdout current",
    );
  });

  it("ignores a matching partial line at the bounded tail boundary", async () => {
    const stateDir = makeTempStateDir();
    const homeDir = makeTempStateDir();
    const env = { HOME: homeDir, OPENCLAW_STATE_DIR: stateDir };
    const stateLogs = resolveGatewayLogPaths(env);
    fs.mkdirSync(stateLogs.logDir, { recursive: true });
    fs.writeFileSync(
      stateLogs.stdoutPath,
      `${"x".repeat(DIAGNOSTIC_TAIL_BYTES + 1)} gateway start blocked: partial stale reason\n` +
        "gateway stdout current\n",
      "utf8",
    );

    await expect(readLastGatewayErrorLine(env, { platform: "linux" })).resolves.toBe(
      "gateway stdout current",
    );
  });

  it("fills short positional reads before decoding the tail", async () => {
    const dir = makeTempStateDir();
    const file = path.join(dir, "gateway.log");
    fs.writeFileSync(file, "old line\nrecent one\nrecent two\n", "utf8");
    const realOpen = fsPromises.open.bind(fsPromises);
    vi.spyOn(fsPromises, "open").mockImplementation(async (...args) => {
      const handle = await realOpen(...args);
      const realRead = handle.read.bind(handle) as PositionalRead;
      const shortRead = vi.fn<PositionalRead>((buffer, offset, length, position) =>
        realRead(buffer, offset, Math.min(length, 3), position),
      );
      Object.defineProperty(handle, "read", { configurable: true, value: shortRead });
      return handle;
    });

    await expect(readGatewayLogTailLines(file)).resolves.toEqual([
      "old line",
      "recent one",
      "recent two",
    ]);
  });

  it("surfaces ENOSPC from stdout ahead of a generic stderr tail on linux", async () => {
    const stateDir = makeTempStateDir();
    const homeDir = makeTempStateDir();
    const env = { HOME: homeDir, OPENCLAW_STATE_DIR: stateDir };
    const stateLogs = resolveGatewayLogPaths(env);
    fs.mkdirSync(stateLogs.logDir, { recursive: true });
    fs.writeFileSync(
      stateLogs.stdoutPath,
      "parse/handle error: Error: ENOSPC: no space left on device, write\n",
      "utf8",
    );
    fs.writeFileSync(stateLogs.stderrPath, "gateway stderr tail without a known pattern\n", "utf8");

    await expect(readLastGatewayErrorLine(env, { platform: "linux" })).resolves.toBe(
      "parse/handle error: Error: ENOSPC: no space left on device, write",
    );
  });

  it("does not return a generic log tail when a pattern match is required", async () => {
    const stateDir = makeTempStateDir();
    const homeDir = makeTempStateDir();
    const env = { HOME: homeDir, OPENCLAW_STATE_DIR: stateDir };
    const stateLogs = resolveGatewayLogPaths(env);
    fs.mkdirSync(stateLogs.logDir, { recursive: true });
    fs.writeFileSync(stateLogs.stdoutPath, "gateway stdout current\n", "utf8");
    fs.writeFileSync(stateLogs.stderrPath, "routine gateway stderr\n", "utf8");

    await expect(
      readLastGatewayErrorLine(env, { platform: "linux", requirePatternMatch: true }),
    ).resolves.toBeNull();
  });
});
