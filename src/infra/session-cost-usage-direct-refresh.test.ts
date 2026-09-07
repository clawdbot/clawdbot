import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { withEnvAsync } from "../test-utils/env.js";
import { refreshCostUsageCacheForAgent } from "./session-cost-usage-aggregation.js";
import { loadSessionCostSummary } from "./session-cost-usage-reporting.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

vi.mock("./session-cost-usage-aggregation.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./session-cost-usage-aggregation.js")>();
  return {
    ...actual,
    refreshCostUsageCacheForAgent: vi.fn(async () => "busy" as const),
  };
});

describe("loadSessionCostSummary direct refresh wait", () => {
  it("stops polling a busy refresh lock after the wait budget", async () => {
    const root = tempDirs.make("openclaw-usage-busy-");
    const sessionFile = path.join(root, "transcript.jsonl");
    await fs.writeFile(
      sessionFile,
      `${JSON.stringify({ message: { role: "user", content: "hi", timestamp: Date.now() } })}\n`,
    );

    const startedAt = Date.now();
    let waitPhase: "start" | "expired" = "start";
    const now = vi
      .spyOn(Date, "now")
      .mockImplementation(() => (waitPhase === "start" ? startedAt : startedAt + 5_000));
    vi.mocked(refreshCostUsageCacheForAgent).mockImplementation(async () => {
      waitPhase = "expired";
      return "busy";
    });

    try {
      await withEnvAsync({ OPENCLAW_STATE_DIR: root }, async () => {
        await expect(
          loadSessionCostSummary({
            agentId: "main",
            sessionFile,
          }).then((summary) => summary ?? "empty"),
        ).resolves.toBe("empty");
      });
    } finally {
      now.mockRestore();
    }
  });
});
