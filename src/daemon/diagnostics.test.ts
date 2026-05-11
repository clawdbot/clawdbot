import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readLastGatewayErrorLine } from "./diagnostics.js";
import { resolveGatewayLogPaths } from "./restart-logs.js";

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
    const env = { OPENCLAW_STATE_DIR: stateDir };
    const { logDir, stdoutPath, stderrPath } = resolveGatewayLogPaths(env);
    fs.mkdirSync(logDir, { recursive: true });
    fs.writeFileSync(stderrPath, "failed to bind gateway socket stale\n", "utf8");
    fs.writeFileSync(stdoutPath, "gateway stdout current\n", "utf8");

    await expect(readLastGatewayErrorLine(env, { platform: "darwin" })).resolves.toBe(
      "gateway stdout current",
    );
  });
});
