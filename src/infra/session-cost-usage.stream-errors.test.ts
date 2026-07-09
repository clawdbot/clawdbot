// Regression test: session-cost readline stream errors are swallowed instead of
// crashing the caller's async iteration.
import nodeFs from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { withEnvAsync } from "../test-utils/env.js";
import {
  loadCostUsageSummaryFromCache,
  loadSessionLogs,
  refreshCostUsageCache,
} from "./session-cost-usage.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe("session cost usage stream errors", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("does not crash when the transcript stream emits an error mid-read", async () => {
    const tempDir = tempDirs.make("openclaw-session-cost-stream-");
    const sessionsDir = path.join(tempDir, "agents", "main", "sessions");
    await fs.mkdir(sessionsDir, { recursive: true });
    const sessionFile = path.join(sessionsDir, "sess-stream-error.jsonl");
    await fs.writeFile(
      sessionFile,
      [
        JSON.stringify({ type: "session", version: 1, id: "sess-stream-error" }),
        JSON.stringify({
          type: "message",
          timestamp: new Date().toISOString(),
          message: { role: "user", content: "hello" },
        }),
        "",
      ].join("\n"),
      "utf-8",
    );

    vi.spyOn(nodeFs, "createReadStream").mockImplementationOnce(() => {
      const stream = new PassThrough();
      stream.write(`${JSON.stringify({ type: "session", version: 1, id: "sess-stream-error" })}\n`);
      process.nextTick(() => {
        stream.destroy(new Error("stream read failed"));
      });
      return stream as unknown as nodeFs.ReadStream;
    });

    const logs = await loadSessionLogs({ sessionFile });

    expect(logs).toEqual([]);
  });

  it("does not persist a partial durable cache entry after a stream error", async () => {
    const tempDir = tempDirs.make("openclaw-session-cost-cache-stream-");
    const sessionsDir = path.join(tempDir, "agents", "main", "sessions");
    await fs.mkdir(sessionsDir, { recursive: true });
    const sessionFile = path.join(sessionsDir, "sess-cache-stream-error.jsonl");
    const usageEntry = (timestamp: string, input: number) =>
      JSON.stringify({
        type: "message",
        timestamp,
        message: {
          role: "assistant",
          usage: { input, output: 0, totalTokens: input, cost: { total: input / 1000 } },
        },
      });
    await fs.writeFile(sessionFile, `${usageEntry("2026-07-06T12:00:00.000Z", 10)}\n`, "utf-8");

    await withEnvAsync({ OPENCLAW_STATE_DIR: tempDir }, async () => {
      await refreshCostUsageCache();
      const cachePath = path.join(sessionsDir, ".usage-cost-cache.json");
      const cacheBefore = await fs.readFile(cachePath, "utf-8");

      const appendedEntry = `${usageEntry("2026-07-06T12:01:00.000Z", 20)}\n`;
      await fs.appendFile(sessionFile, appendedEntry, "utf-8");
      vi.spyOn(nodeFs, "createReadStream").mockImplementationOnce(() => {
        const stream = new PassThrough();
        stream.write(appendedEntry);
        process.nextTick(() => {
          stream.destroy(new Error("stream read failed"));
        });
        return stream as unknown as nodeFs.ReadStream;
      });

      await expect(refreshCostUsageCache()).rejects.toThrow("stream read failed");
      expect(await fs.readFile(cachePath, "utf-8")).toBe(cacheBefore);

      const summary = await loadCostUsageSummaryFromCache({
        startMs: Date.UTC(2026, 6, 6),
        endMs: Date.UTC(2026, 6, 7),
        requestRefresh: false,
      });
      expect(summary.totals.totalTokens).toBe(10);
      expect(summary.cacheStatus?.status).toBe("partial");
      expect(summary.cacheStatus?.pendingFiles).toBe(1);
    });
  });
});
