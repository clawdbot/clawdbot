// Covers the compaction planning worker boundary and timeout behavior.
import { MAX_TIMER_TIMEOUT_MS } from "@openclaw/normalization-core/number-coercion";
import { describe, expect, it, vi } from "vitest";
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
  // Synthetic data URLs let timeout/error tests exercise Worker plumbing
  // without relying on a bundled build artifact.
  return new URL(`data:text/javascript,${encodeURIComponent(source)}`);
}

describe("compaction planning worker", () => {
  it("resolves the packaged worker URL from stable and hashed dist modules", () => {
    // Hashed bundle names still resolve to the stable worker sibling emitted by
    // the build, so runtime imports do not depend on the main chunk hash.
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

  it("plans summary chunks in the packaged worker", async () => {
    const packagedSummaryChunks = await compactionPlanningWorkerTesting.runCompactionPlanningWorker(
      {
        input: {
          kind: "summaryChunks",
          messages: [makeMessage(1), makeMessage(2), makeMessage(3)],
          maxChunkTokens: 1200,
        },
        timeoutMs: 30_000,
      },
    );

    expect(packagedSummaryChunks.kind).toBe("summaryChunks");
    if (packagedSummaryChunks.kind !== "summaryChunks") {
      return;
    }
    expect(packagedSummaryChunks.chunks.flat().map((message) => message.timestamp)).toEqual([
      1, 2, 3,
    ]);
    expect(packagedSummaryChunks.chunks.length).toBeGreaterThan(1);
  }, 45_000);

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

  it("clamps oversized worker timeouts before scheduling", async () => {
    const workerUrl = createSyntheticWorkerUrl(`
      import { parentPort } from "node:worker_threads";
      parentPort.postMessage({
        status: "ok",
        value: {
          kind: "summaryChunks",
          chunks: [],
        },
      });
    `);
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
    try {
      await compactionPlanningWorkerTesting.runCompactionPlanningWorker({
        input: {
          kind: "summaryChunks",
          messages: [makeMessage(1), makeMessage(2), makeMessage(3)],
          maxChunkTokens: 1200,
        },
        timeoutMs: Number.MAX_SAFE_INTEGER,
        workerUrl,
      });
      // Node timers reject values above the signed 32-bit cap; clamping keeps
      // huge caller timeouts from firing immediately.
      expect(setTimeoutSpy.mock.calls).toContainEqual([expect.any(Function), MAX_TIMER_TIMEOUT_MS]);
    } finally {
      setTimeoutSpy.mockRestore();
    }
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
    // Planning large histories must happen off the main event loop; a 0ms timer
    // winning this race proves the worker path yielded control.
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
