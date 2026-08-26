// Browser CDP snapshot tests cover bounded snapshot assertions.
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const SCRIPT_PATH = "scripts/e2e/lib/browser-cdp-snapshot/assert-snapshot.mjs";
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function runAssertSnapshot(snapshotPath: string, env: Record<string, string> = {}) {
  return spawnSync(process.execPath, [SCRIPT_PATH, snapshotPath], {
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
}

describe("browser CDP snapshot assertions", () => {
  it("rejects oversized snapshots before reading them into diagnostics", () => {
    const root = tempDirs.make("openclaw-browser-cdp-snapshot-");
    const snapshotPath = path.join(root, "snapshot.txt");
    writeFileSync(snapshotPath, "x".repeat(33), "utf8");

    const result = runAssertSnapshot(snapshotPath, {
      OPENCLAW_BROWSER_CDP_SNAPSHOT_MAX_BYTES: "32",
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("browser CDP snapshot exceeded 32 bytes");
    expect(result.stderr).not.toContain("x".repeat(33));
  });

  it("bounds missing-needle snapshot diagnostics", () => {
    const root = tempDirs.make("openclaw-browser-cdp-snapshot-");
    const snapshotPath = path.join(root, "snapshot.txt");
    writeFileSync(snapshotPath, `${"old snapshot line\n".repeat(6 * 1024)}recent tail`, "utf8");

    const result = runAssertSnapshot(snapshotPath);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("recent tail");
    expect(result.stderr).toContain("truncated snapshot diagnostic");
    expect(result.stderr.length).toBeLessThan(80 * 1024);
  });
});
