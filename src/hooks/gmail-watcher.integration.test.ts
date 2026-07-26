/**
 * Integration proof for issue #106612.
 *
 * Runs startGmailWatcher and stopGmailWatcher with NO mocks for spawn or
 * killProcessTree. A fake `gog` binary is placed on PATH; it spawns a
 * credential-helper child and deliberately does NOT kill it on SIGTERM,
 * simulating the real bug. The test asserts that stopGmailWatcher removes
 * both the gog process and its descendant via the process-group signal.
 */
import { execSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync, readFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// Only run when explicitly opted in — requires real subprocess spawning.
const RUN = process.env["OPENCLAW_INTEGRATION_TEST"] === "1";

function alive(pid: number): boolean {
  try {
    execSync(`kill -0 ${pid} 2>/dev/null`);
    return true;
  } catch {
    return false;
  }
}

describe.skipIf(!RUN)("gmail-watcher process-tree shutdown (integration)", () => {
  let tmpDir: string;
  let savedPath: string | undefined;

  beforeAll(() => {
    tmpDir = join(tmpdir(), `gog-integration-${process.pid}`);
    mkdirSync(tmpDir, { recursive: true });

    // fake gog: handles `watch start` (exits 0) and `watch serve`
    // (spawns a credential-helper sleep and does NOT kill it on SIGTERM)
    const gogScript = join(tmpDir, "gog");
    writeFileSync(
      gogScript,
      [
        "#!/bin/bash",
        'case "$*" in',
        '  *"watch start"*) echo "[gog] watch registered"; exit 0 ;;',
        '  *"watch serve"*)',
        '    echo "[gog] serve started pid=$$"',
        `    echo $$ > ${tmpDir}/gog.pid`,
        "    sleep 99999 &",
        "    HELPER=$!",
        '    echo "[gog] credential-helper spawned pid=$HELPER"',
        `    echo $HELPER > ${tmpDir}/helper.pid`,
        "    trap 'echo \"[gog] SIGTERM (child NOT killed)\"; exit 0' TERM",
        "    while true; do sleep 0.3; done ;;",
        "esac",
      ].join("\n"),
    );
    chmodSync(gogScript, 0o755);

    savedPath = process.env["PATH"];
    process.env["PATH"] = `${tmpDir}:${savedPath ?? ""}`;
  });

  afterAll(() => {
    if (savedPath !== undefined) {
      process.env["PATH"] = savedPath;
    }
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("stopGmailWatcher removes gog and its credential-helper descendant", async () => {
    const { startGmailWatcher, stopGmailWatcher } = await import("./gmail-watcher.js");

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
    } as never);

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

    const gogPid = Number.parseInt(readFileSync(join(tmpDir, "gog.pid"), "utf8").trim(), 10);
    const helperPid = Number.parseInt(readFileSync(join(tmpDir, "helper.pid"), "utf8").trim(), 10);

    console.log(`\ngog pid=${gogPid}, credential-helper pid=${helperPid}`);
    expect(alive(gogPid)).toBe(true);
    expect(alive(helperPid)).toBe(true);

    console.log("calling stopGmailWatcher...");
    await stopGmailWatcher();
    await new Promise<void>((r) => {
      setTimeout(r, 400);
    });

    console.log(`gog alive after stop: ${alive(gogPid)}`);
    console.log(`credential-helper alive after stop: ${alive(helperPid)}`);

    expect(alive(gogPid)).toBe(false);
    expect(alive(helperPid)).toBe(false); // descendant must also be gone
  }, 15_000);
});
