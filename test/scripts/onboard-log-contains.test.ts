// Onboard log contains tests cover bounded E2E wizard log polling.
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { logTailContains, readLogTail } from "../../scripts/e2e/lib/onboard/log-contains.mjs";

const SCRIPT_PATH = "scripts/e2e/lib/onboard/log-contains.mjs";

describe("onboard log-contains helper", () => {
  const tempRoots: string[] = [];

  afterEach(() => {
    for (const root of tempRoots.splice(0)) {
      rmSync(root, { force: true, recursive: true });
    }
  });

  function writeLog(contents: string) {
    const root = mkdtempSync(path.join(tmpdir(), "openclaw-onboard-log-"));
    tempRoots.push(root);
    const logPath = path.join(root, "wizard.log");
    writeFileSync(logPath, contents, "utf8");
    return logPath;
  }

  it("searches only a bounded tail window", () => {
    const logPath = writeLog(
      `prefix marker\n${"x".repeat(4096)}\n\u001b[32mReady\n to start\u001b[0m\n`,
    );

    const tail = readLogTail(logPath, 64);

    expect(Buffer.byteLength(tail, "utf8")).toBeLessThanOrEqual(64);
    expect(tail).toContain("Ready");
    expect(tail).not.toContain("prefix marker");
    expect(logTailContains(logPath, "Ready to start", 64)).toBe(true);
    expect(logTailContains(logPath, "prefix marker", 64)).toBe(false);
  });

  it("preserves CLI status behavior for matching and missing logs", () => {
    const logPath = writeLog(`${"x".repeat(4096)}\nWizard Complete\n`);

    expect(spawnSync(process.execPath, [SCRIPT_PATH, logPath, "wizard complete"]).status).toBe(0);
    expect(spawnSync(process.execPath, [SCRIPT_PATH, logPath, "prefix marker"]).status).toBe(1);
    expect(spawnSync(process.execPath, [SCRIPT_PATH, `${logPath}.missing`, "wizard"]).status).toBe(
      1,
    );
  });

  it("rejects invalid read windows", () => {
    const logPath = writeLog("hello\n");

    expect(() => readLogTail(logPath, 0)).toThrow("maxBytes must be a positive integer");
  });
});
