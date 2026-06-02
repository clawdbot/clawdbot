import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { waitForProbePid } from "../../scripts/e2e/cron-mcp-cleanup-docker-client.ts";

describe("cron MCP cleanup docker client", () => {
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
});
