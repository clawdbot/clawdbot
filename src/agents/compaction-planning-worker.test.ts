import { describe, expect, it } from "vitest";
import { compactionPlanningWorkerTesting } from "./compaction-planning-worker.js";
import { runCompactionPlanningWorkerInput } from "./compaction-planning.worker.js";
import type { AgentMessage } from "./runtime/index.js";

function makeMessage(id: number, text = "x".repeat(4000)): AgentMessage {
  return {
    role: "user",
    content: text,
    timestamp: id,
  };
}

describe("compaction planning worker", () => {
  it("resolves the packaged worker URL from stable and hashed dist modules", () => {
    expect(
      compactionPlanningWorkerTesting.resolveCompactionPlanningWorkerUrl(
        "file:///repo/dist/agents/compaction-planning-worker.js",
      ).pathname,
    ).toBe("/repo/dist/agents/compaction-planning.worker.js");
    expect(
      compactionPlanningWorkerTesting.resolveCompactionPlanningWorkerUrl(
        "file:///repo/dist/selection-abc123.js",
      ).pathname,
    ).toBe("/repo/dist/agents/compaction-planning.worker.js");
  });

  it("rejects invalid worker input", () => {
    expect(runCompactionPlanningWorkerInput({ kind: "summaryChunks" })).toEqual({
      status: "failed",
      error: "invalid compaction planning worker input",
    });
  });

  it("plans summary chunks in the worker", async () => {
    const value = await compactionPlanningWorkerTesting.runCompactionPlanningWorker({
      input: {
        kind: "summaryChunks",
        messages: [makeMessage(1), makeMessage(2), makeMessage(3)],
        maxChunkTokens: 1200,
      },
      timeoutMs: 10_000,
    });

    expect(value.kind).toBe("summaryChunks");
    if (value.kind !== "summaryChunks") {
      return;
    }
    expect(value.chunks.flat().map((message) => message.timestamp)).toEqual([1, 2, 3]);
    expect(value.chunks.length).toBeGreaterThan(1);
  });

  it("classifies missing worker runtime as unavailable", async () => {
    await expect(
      compactionPlanningWorkerTesting.runCompactionPlanningWorker({
        input: {
          kind: "summaryChunks",
          messages: [makeMessage(1)],
          maxChunkTokens: 1200,
        },
        timeoutMs: 500,
        workerUrl: new URL("./missing-compaction-planning.worker.js", import.meta.url),
      }),
    ).rejects.toMatchObject({
      code: "unavailable",
    });
  });

  it("keeps timers responsive while planning large histories", async () => {
    const timer = new Promise<"timer">((resolve) => {
      setTimeout(() => resolve("timer"), 0);
    });
    const planning = compactionPlanningWorkerTesting
      .runCompactionPlanningWorker({
        input: {
          kind: "stageSplit",
          messages: Array.from({ length: 180 }, (_, index) =>
            makeMessage(index + 1, "x".repeat(12_000)),
          ),
          maxChunkTokens: 8000,
          parts: 4,
        },
        timeoutMs: 30_000,
      })
      .then(() => "planning" as const);

    await expect(Promise.race([timer, planning])).resolves.toBe("timer");
    await expect(planning).resolves.toBe("planning");
  }, 30_000);
});
