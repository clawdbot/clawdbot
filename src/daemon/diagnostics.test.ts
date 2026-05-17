import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readLastGatewayErrorLine } from "./diagnostics.js";
import { resolveGatewayLogPaths, resolveGatewaySupervisorLogPaths } from "./restart-logs.js";

const tempDirs: string[] = [];

afterEach(() => {
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
});
