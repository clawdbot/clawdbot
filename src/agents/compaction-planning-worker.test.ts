import { MAX_TIMER_TIMEOUT_MS } from "@openclaw/normalization-core/number-coercion";
import { beforeAll, describe, expect, it, vi } from "vitest";
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

function createSyntheticWorkerUrl(source: string): URL {
  return new URL(`data:text/javascript,${encodeURIComponent(source)}`);
}

describe("compaction planning worker", () => {
  let packagedSummaryChunks: Awaited<
    ReturnType<typeof compactionPlanningWorkerTesting.runCompactionPlanningWorker>
  >;
  let oversizedWorkerTimeoutCalls: unknown[][];

  beforeAll(async () => {
    packagedSummaryChunks = await compactionPlanningWorkerTesting.runCompactionPlanningWorker({
      input: {
        kind: "summaryChunks",
        messages: [makeMessage(1), makeMessage(2), makeMessage(3)],
        maxChunkTokens: 1200,
      },
      timeoutMs: 10_000,
    });

    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
    try {
      await compactionPlanningWorkerTesting.runCompactionPlanningWorker({
        input: {
          kind: "summaryChunks",
          messages: [makeMessage(1), makeMessage(2), makeMessage(3)],
          maxChunkTokens: 1200,
        },
        timeoutMs: Number.MAX_SAFE_INTEGER,
      });
      oversizedWorkerTimeoutCalls = [...setTimeoutSpy.mock.calls];
    } finally {
      setTimeoutSpy.mockRestore();
    }
  }, 10_000);

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

  it("plans summary chunks in the packaged worker", () => {
    expect(packagedSummaryChunks.kind).toBe("summaryChunks");
    if (packagedSummaryChunks.kind !== "summaryChunks") {
      return;
    }
    expect(packagedSummaryChunks.chunks.flat().map((message) => message.timestamp)).toEqual([
      1, 2, 3,
    ]);
    expect(packagedSummaryChunks.chunks.length).toBeGreaterThan(1);
  });

  it("plans summary chunks for worker input", () => {
    const result = runCompactionPlanningWorkerInput({
      kind: "summaryChunks",
      messages: [makeMessage(1), makeMessage(2), makeMessage(3)],
      maxChunkTokens: 1200,
    });

    expect(result.status).toBe("ok");
    if (result.status !== "ok") {
      return;
    }
    const value = result.value;
    expect(value.kind).toBe("summaryChunks");
    if (value.kind !== "summaryChunks") {
      return;
    }
    expect(value.chunks.flat().map((message) => message.timestamp)).toEqual([1, 2, 3]);
    expect(value.chunks.length).toBeGreaterThan(1);
  });

  it("clamps oversized worker timeouts before scheduling", () => {
    expect(oversizedWorkerTimeoutCalls).toContainEqual([
      expect.any(Function),
      MAX_TIMER_TIMEOUT_MS,
    ]);
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
    const workerUrl = createSyntheticWorkerUrl(`
      import { parentPort } from "node:worker_threads";
      parentPort.postMessage({
        status: "ok",
        value: {
          kind: "stageSplit",
          mode: "single",
        },
      });
    `);
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
        workerUrl,
      })
      .then(() => "planning" as const);

    await expect(Promise.race([timer, planning])).resolves.toBe("timer");
    await expect(planning).resolves.toBe("planning");
  }, 30_000);
});
