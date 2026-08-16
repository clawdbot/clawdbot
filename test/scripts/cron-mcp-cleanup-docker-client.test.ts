// Cron Mcp Cleanup Docker Client tests cover cron mcp cleanup docker client script behavior.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  assertCronFinishedOk,
  readCronMcpCleanupProbePidWaitMs,
  waitForProbePid,
} from "../../scripts/e2e/cron-mcp-cleanup-docker-client.ts";

describe("cron MCP cleanup docker client", () => {
  it("rejects malformed probe pid wait limits", () => {
    expect(readCronMcpCleanupProbePidWaitMs({})).toBe(120_000);
    expect(readCronMcpCleanupProbePidWaitMs({ OPENCLAW_CRON_MCP_CLEANUP_PID_WAIT_MS: "250" })).toBe(
      250,
    );
    for (const value of ["1.5", "1e3", "10ms", "0"]) {
      expect(() =>
        readCronMcpCleanupProbePidWaitMs({
          OPENCLAW_CRON_MCP_CLEANUP_PID_WAIT_MS: value,
        }),
      ).toThrow("invalid OPENCLAW_CRON_MCP_CLEANUP_PID_WAIT_MS");
    }
  });

  it("bounds missing probe pid waits", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-cron-mcp-client-"));
    try {
      const startedAt = Date.now();
      await expect(
        waitForProbePid(path.join(root, "missing.pid"), { pollMs: 1, timeoutMs: 20 }),
      ).resolves.toBeUndefined();
      expect(Date.now() - startedAt).toBeLessThan(1000);
    } finally {
      fs.rmSync(root, { force: true, recursive: true });
    }
  });

  it("does not parse malformed probe pid prefixes", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-cron-mcp-client-"));
    try {
      const pidPath = path.join(root, "probe.pid");
      fs.writeFileSync(pidPath, "123abc\n", "utf8");

      const startedAt = Date.now();
      await expect(waitForProbePid(pidPath, { pollMs: 1, timeoutMs: 20 })).resolves.toBeUndefined();
      expect(Date.now() - startedAt).toBeLessThan(1000);
    } finally {
      fs.rmSync(root, { force: true, recursive: true });
    }
  });

  it("accepts cron finished events only when the run status is ok", () => {
    expect(() => assertCronFinishedOk({ status: "ok" })).not.toThrow();
    expect(() => assertCronFinishedOk({ status: "error" })).toThrow(
      /cron cleanup run did not finish ok/u,
    );
    expect(() => assertCronFinishedOk({})).toThrow(/cron cleanup run did not finish ok/u);
  });
});
