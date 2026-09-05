/**
 * Runs startGmailWatcher and stopGmailWatcher with NO mocks for spawn or
 * killProcessTree. A fake `gog` binary is placed on PATH; it spawns a
 * credential-helper child and deliberately does NOT kill it on SIGTERM,
 * simulating the real bug. The test asserts that stopGmailWatcher removes
 * both the gog process and its descendant via the process-group signal.
 */
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startGmailWatcher, stopGmailWatcher } from "./gmail-watcher.js";

const describePosix = process.platform === "win32" ? describe.skip : describe;

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describePosix("gmail-watcher process-tree shutdown (integration)", () => {
  let tmpDir: string;
  let savedPath: string | undefined;
  let gogPid: number | undefined;
  let helperPid: number | undefined;

  beforeAll(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "openclaw-gog-integration-"));

    // fake gog: handles `watch start` (exits 0) and `watch serve`
    // (spawns a credential-helper that ignores SIGTERM)
    const gogScript = join(tmpDir, "gog");
    writeFileSync(
      gogScript,
      [
        "#!/bin/bash",
        'SCRIPT_DIR="$(cd -- "$(dirname -- "$0")" && pwd)"',
        'case "$*" in',
        '  *"watch start"*) echo "[gog] watch registered"; exit 0 ;;',
        '  *"watch serve"*)',
        '    echo "[gog] serve started pid=$$"',
        // The reader polls existence, so publish only complete PID files.
        '    echo $$ > "$SCRIPT_DIR/gog.pid.tmp"',
        '    mv "$SCRIPT_DIR/gog.pid.tmp" "$SCRIPT_DIR/gog.pid"',
        `    /bin/bash -c 'trap "" TERM; while true; do sleep 1; done' &`,
        "    HELPER=$!",
        '    echo "[gog] credential-helper spawned pid=$HELPER"',
        '    echo $HELPER > "$SCRIPT_DIR/helper.pid.tmp"',
        '    mv "$SCRIPT_DIR/helper.pid.tmp" "$SCRIPT_DIR/helper.pid"',
        "    trap 'echo \"[gog] SIGTERM (child NOT killed)\"; exit 0' TERM",
        "    while true; do sleep 0.3; done ;;",
        "esac",
      ].join("\n"),
    );
    chmodSync(gogScript, 0o755);

    savedPath = process.env["PATH"];
    process.env["PATH"] = `${tmpDir}:${savedPath ?? ""}`;
  });

  afterAll(async () => {
    try {
      await stopGmailWatcher();
    } catch {
      // Force cleanup below; this test must not leave subprocesses behind on failure.
    }
    if (gogPid !== undefined) {
      try {
        process.kill(-gogPid, "SIGKILL");
      } catch {
        // The process group may already be gone.
      }
    }
    if (helperPid !== undefined) {
      try {
        process.kill(helperPid, "SIGKILL");
      } catch {
        // The helper may already be gone with its process group.
      }
    }
    if (savedPath !== undefined) {
      process.env["PATH"] = savedPath;
    }
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("stopGmailWatcher removes gog and its credential-helper descendant", async () => {
    const result = await startGmailWatcher({
      hooks: {
        enabled: true,
        token: "integration-token",
        gmail: {
          account: "integration@example.com",
          topic: "projects/integration/topics/gmail",
          pushToken: "integration-push-token",
        },
      },
    });

    expect(result.started).toBe(true);

    // Wait for both pid files
    for (let i = 0; i < 50; i++) {
      if (existsSync(join(tmpDir, "helper.pid")) && existsSync(join(tmpDir, "gog.pid"))) {
        break;
      }
      await new Promise<void>((r) => {
        setTimeout(r, 100);
      });
    }

    gogPid = Number.parseInt(readFileSync(join(tmpDir, "gog.pid"), "utf8").trim(), 10);
    helperPid = Number.parseInt(readFileSync(join(tmpDir, "helper.pid"), "utf8").trim(), 10);

    console.log(`\ngog pid=${gogPid}, credential-helper pid=${helperPid}`);
    expect(alive(gogPid)).toBe(true);
    expect(alive(helperPid)).toBe(true);

    console.log("calling stopGmailWatcher...");
    await stopGmailWatcher();

    await expect.poll(() => alive(gogPid!), { interval: 25, timeout: 1_500 }).toBe(false);
    await expect.poll(() => alive(helperPid!), { interval: 25, timeout: 1_500 }).toBe(false);

    console.log(`gog alive after stop: ${alive(gogPid)}`);
    console.log(`credential-helper alive after stop: ${alive(helperPid)}`);
  }, 15_000);
});
