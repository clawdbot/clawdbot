// Covers the compaction planning worker boundary and timeout behavior.
import { MAX_TIMER_TIMEOUT_MS } from "@openclaw/normalization-core/number-coercion";
import { serializeConversation } from "openclaw/plugin-sdk/agent-core";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { runCompactionPlanningWorker } from "./compaction-planning-worker-runtime.js";
import {
  buildOversizedFallbackPlanWithWorker,
  buildSummaryChunksWithWorker,
} from "./compaction-planning-worker.js";
import { estimateMessagesTokens } from "./compaction-planning.js";
import { runCompactionPlanningWorkerInput } from "./compaction-planning.worker.js";
import type { AgentMessage } from "./runtime/index.js";
import { makeAgentAssistantMessage } from "./test-helpers/agent-message-fixtures.js";

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
  let packagedSummaryChunks: Awaited<ReturnType<typeof runCompactionPlanningWorker>>;

  beforeAll(async () => {
    packagedSummaryChunks = await runCompactionPlanningWorker({
      input: {
        kind: "summaryChunks",
        messages: [makeMessage(1), makeMessage(2), makeMessage(3)],
        maxChunkTokens: 1200,
      },
      timeoutMs: 30_000,
    });
  });

  it("rejects invalid and retired worker input", () => {
    for (const input of [
      { kind: "summaryChunks" },
      {
        kind: "historyPrune",
        messagesToSummarize: [],
        turnPrefixMessages: [],
        tokensBefore: 0,
        contextWindowTokens: 1,
        maxHistoryShare: 0.5,
      },
    ]) {
      expect(runCompactionPlanningWorkerInput(input)).toEqual({
        status: "failed",
        error: "invalid compaction planning worker input",
      });
    }
  });

  it("plans summary chunks in the packaged worker", () => {
    expect(packagedSummaryChunks.kind).toBe("summaryChunks");
    if (packagedSummaryChunks.kind !== "summaryChunks") {
      return;
    }
    expect(packagedSummaryChunks.chunkIndexes.flat()).toEqual([0, 1, 2]);
    expect(packagedSummaryChunks.chunkIndexes.length).toBeGreaterThan(1);
  }, 45_000);

  it("bounds image data in worker planning without changing returned summary input", async () => {
    const imageData = "a".repeat(1_000_000);
    const imageMessage = {
      role: "toolResult",
      toolCallId: "call_image",
      toolName: "browser",
      isError: false,
      content: [{ type: "image", data: imageData, mimeType: "image/png" }],
      timestamp: 1,
    } satisfies AgentMessage;
    const messages = [
      {
        role: "user" as const,
        content: [{ type: "image" as const, data: imageData, mimeType: "image/png" }],
        timestamp: 0,
      },
      imageMessage,
      ...Array.from({ length: 62 }, (_, index) => makeMessage(index + 2)),
    ];

    const chunks = await buildSummaryChunksWithWorker({ messages, maxChunkTokens: 8_000 });
    const plannedMessages = chunks.flat();
    const plannedImageMessage = plannedMessages.find(
      (message) => message.role === "toolResult" && message.toolCallId === "call_image",
    );
    const plannedUserImageMessage = plannedMessages.find(
      (message) => message.role === "user" && message.timestamp === 0,
    );
    expect(plannedImageMessage?.role).toBe("toolResult");
    if (!plannedImageMessage || plannedImageMessage.role !== "toolResult") {
      throw new Error("expected planned tool result");
    }

    expect(plannedImageMessage.content[0]).toEqual({
      type: "image",
      data: imageData,
      mimeType: "image/png",
    });
    expect(plannedUserImageMessage?.role).toBe("user");
    if (!plannedUserImageMessage || plannedUserImageMessage.role !== "user") {
      throw new Error("expected planned user message");
    }
    expect(plannedUserImageMessage.content).toEqual([
      { type: "image", data: imageData, mimeType: "image/png" },
    ]);
    expect(estimateMessagesTokens([plannedImageMessage])).toBe(
      estimateMessagesTokens([imageMessage]),
    );
    expect(serializeConversation([plannedImageMessage])).toBe(
      serializeConversation([imageMessage]),
    );
  }, 45_000);

  it("preserves oversized tool-result text in returned summary input", async () => {
    const hugeText = "x".repeat(120_000);
    const messages: AgentMessage[] = [
      {
        role: "toolResult",
        toolCallId: "call_large",
        toolName: "browser",
        isError: false,
        content: [{ type: "text", text: hugeText }],
        timestamp: 1,
      },
      ...Array.from({ length: 63 }, (_, index) => makeMessage(index + 2)),
    ];

    const chunks = await buildSummaryChunksWithWorker({ messages, maxChunkTokens: 8_000 });
    const returnedMessages = chunks.flat();

    expect(JSON.stringify(returnedMessages)).toBe(JSON.stringify(messages));
    expect(JSON.stringify(returnedMessages)).toContain(hugeText);
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
    expect(value.chunkIndexes.flat()).toEqual([0, 1, 2]);
    expect(value.chunkIndexes.length).toBeGreaterThan(1);
  });

  it.each([
    { kind: "oversizedFallback", messages: [makeMessage(1)], contextWindow: 1200 },
    { kind: "stageSplit", messages: [makeMessage(1)], maxChunkTokens: 1200 },
    { kind: "adaptiveChunkRatio", messages: [makeMessage(1)], contextWindow: 1200 },
  ])("plans $kind for worker input", (input) => {
    expect(runCompactionPlanningWorkerInput(input)).toMatchObject({
      status: "ok",
      value: { kind: input.kind },
    });
  });

  it("preserves original user identity while worker fallback omits an oversized tool batch", async () => {
    const displacedUser = makeMessage(2, "keep the latest real user request");
    const messages: AgentMessage[] = [
      makeAgentAssistantMessage({
        content: [
          { type: "text", text: "x".repeat(12_000) },
          { type: "toolCall", id: "call_large", name: "read", arguments: {} },
        ],
        model: "gpt-5.6-luna",
        stopReason: "stop",
        timestamp: 1,
      }),
      displacedUser,
      {
        role: "toolResult",
        toolCallId: "call_large",
        toolName: "read",
        content: [{ type: "text", text: "small result" }],
        isError: false,
        timestamp: 3,
      },
      ...Array.from({ length: 61 }, (_, index) => makeMessage(index + 4, "keep")),
    ];

    const plan = await buildOversizedFallbackPlanWithWorker({ messages, contextWindow: 2_000 });

    expect(plan.smallMessages).toHaveLength(62);
    expect(plan.smallMessages[0]).toBe(displacedUser);
    expect(plan.smallMessages.every((message) => message.role === "user")).toBe(true);
    expect(plan.oversizedNotes).toEqual([expect.stringContaining("Large assistant")]);
  }, 45_000);

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
      await runCompactionPlanningWorker({
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
      runCompactionPlanningWorker({
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
    const planning = runCompactionPlanningWorker({
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
    }).then(() => "planning" as const);

    await expect(Promise.race([timer, planning])).resolves.toBe("timer");
    await expect(planning).resolves.toBe("planning");
  }, 30_000);
});
