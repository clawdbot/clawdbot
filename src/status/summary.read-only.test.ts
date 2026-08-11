import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { getStatusSummary } from "./summary.js";

describe("getStatusSummary read-only session access", () => {
  it("does not create the heartbeat session database while checking its route", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-status-heartbeat-"));
    const databasePath = path.join(tempDir, "openclaw-agent.sqlite");

    try {
      const summary = await getStatusSummary({
        includeChannelSummary: false,
        config: { session: { store: databasePath } },
      });

      expect(summary.heartbeat.agents[0]?.waitingForRoute).toBe(true);
      expect(fs.existsSync(databasePath)).toBe(false);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
