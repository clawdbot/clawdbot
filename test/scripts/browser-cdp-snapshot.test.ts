// Browser CDP snapshot tests cover bounded snapshot assertions.
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const SCRIPT_PATH = "scripts/e2e/lib/browser-cdp-snapshot/assert-snapshot.mjs";
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function runAssertSnapshot(snapshotPath: string, env: Record<string, string | undefined> = {}) {
  return spawnSync(process.execPath, [SCRIPT_PATH, snapshotPath], {
    encoding: "utf8",
    env: { ...process.env, OPENCLAW_BROWSER_CDP_SNAPSHOT_MAX_BYTES: undefined, ...env },
  });
}

describe("browser CDP snapshot assertions", () => {
  it.each([undefined, "", " 1024 ", "9007199254740991"])("accepts snapshot limit %j", (limit) => {
    const root = tempDirs.make("openclaw-browser-cdp-snapshot-");
    const snapshotPath = path.join(root, "snapshot.txt");
    writeFileSync(
      snapshotPath,
      [
        'button "Save"',
        'link "Docs" https://docs.openclaw.ai/browser-cdp-live',
        'generic "Clickable Card" cursor:pointer',
        'Iframe "Child"',
        'button "Inside"',
      ].join("\n"),
      "utf8",
    );

    const result = runAssertSnapshot(snapshotPath, {
      OPENCLAW_BROWSER_CDP_SNAPSHOT_MAX_BYTES: limit,
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toBe("ok\n");
    expect(result.stderr).toBe("");
  });

  it.each([" \t ", "0", "-1", "1.5", "1e3", "1kb", "9007199254740992"])(
    "rejects snapshot limit %j with the untrimmed value",
    (limit) => {
      const root = tempDirs.make("openclaw-browser-cdp-snapshot-");
      const result = runAssertSnapshot(path.join(root, "snapshot.txt"), {
        OPENCLAW_BROWSER_CDP_SNAPSHOT_MAX_BYTES: limit,
      });

      expect(result.status).toBe(1);
      expect(result.stderr.split("\n").find((line) => line.startsWith("Error: "))).toBe(
        `Error: OPENCLAW_BROWSER_CDP_SNAPSHOT_MAX_BYTES must be a positive integer; got: ${limit}`,
      );
    },
  );

  it.each([undefined, ""])("keeps the default snapshot limit for %j", (limit) => {
    const root = tempDirs.make("openclaw-browser-cdp-snapshot-");
    const snapshotPath = path.join(root, "snapshot.txt");
    writeFileSync(snapshotPath, "x".repeat(512 * 1024 + 1), "utf8");

    const result = runAssertSnapshot(snapshotPath, {
      OPENCLAW_BROWSER_CDP_SNAPSHOT_MAX_BYTES: limit,
    });

    expect(result.status).toBe(1);
    expect(result.stderr.split("\n").find((line) => line.startsWith("Error: "))).toBe(
      "Error: browser CDP snapshot exceeded 524288 bytes: 524289 bytes",
    );
  });

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
