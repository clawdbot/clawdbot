// Covers the compaction planning worker boundary and timeout behavior.
import { createAssistantMessageEventStream } from "@openclaw/llm-core";
import { MAX_TIMER_TIMEOUT_MS } from "@openclaw/normalization-core/number-coercion";
import { serializeConversation } from "openclaw/plugin-sdk/agent-core";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { estimateTokens } from "../../packages/agent-core/src/harness/compaction/compaction.js";
import * as compactionPlanningWorkerRuntime from "./compaction-planning-worker-runtime.js";
import {
  CompactionPlanningWorkerError,
  runCompactionPlanningWorker,
} from "./compaction-planning-worker-runtime.js";
import {
  buildOversizedFallbackPlanWithWorker,
  buildStageSplitPlanWithWorker,
  buildSummaryChunksWithWorker,
  computeAdaptiveChunkRatioWithWorker,
} from "./compaction-planning-worker.js";
import { buildSummaryChunks, estimateMessagesTokens } from "./compaction-planning.js";
import { runCompactionPlanningWorkerInput } from "./compaction-planning.worker.js";
import { summarizeInStages } from "./compaction.js";
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

const cancellablePlanningOperations = [
  {
    operation: "summary chunks",
    run: (messages: AgentMessage[], signal: AbortSignal) =>
      buildSummaryChunksWithWorker({ messages, maxChunkTokens: 1_200, signal }),
  },
  {
    operation: "oversized fallback",
    run: (messages: AgentMessage[], signal: AbortSignal) =>
      buildOversizedFallbackPlanWithWorker({ messages, contextWindow: 1_200, signal }),
  },
  {
    operation: "stage splitting",
    run: (messages: AgentMessage[], signal: AbortSignal) =>
      buildStageSplitPlanWithWorker({ messages, maxChunkTokens: 1_200, signal }),
  },
  {
    operation: "adaptive chunk sizing",
    run: (messages: AgentMessage[], signal: AbortSignal) =>
      computeAdaptiveChunkRatioWithWorker({ messages, contextWindow: 1_200, signal }),
  },
];

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

  it.each(
    cancellablePlanningOperations.flatMap(({ operation, run }) =>
      [63, 64].map((messageCount) => ({ operation, run, messageCount })),
    ),
  )(
    "honors cancellation for $operation with $messageCount messages",
    async ({ run, messageCount }) => {
      const reason = new Error("operator cancelled compaction");
      const signal = AbortSignal.abort(reason);
      const messages = Array.from({ length: messageCount }, (_, index) =>
        makeMessage(index + 1, "active user request"),
      );

      await expect(run(messages, signal)).rejects.toBe(reason);
    },
  );

  it("does not resume cancelled compaction when its worker becomes unavailable", async () => {
    const controller = new AbortController();
    const reason = new Error("operator cancelled compaction");
    const worker = vi
      .spyOn(compactionPlanningWorkerRuntime, "runCompactionPlanningWorker")
      .mockImplementationOnce(async () => {
        controller.abort(reason);
        throw new CompactionPlanningWorkerError("worker disappeared", "unavailable");
      });

    try {
      await expect(
        buildSummaryChunksWithWorker({
          messages: Array.from({ length: 64 }, (_, index) => makeMessage(index + 1, "request")),
          maxChunkTokens: 1_200,
          signal: controller.signal,
        }),
      ).rejects.toBe(reason);
    } finally {
      worker.mockRestore();
    }
  });

  it("does not restore a worker plan after its compaction has been cancelled", async () => {
    const controller = new AbortController();
    const reason = new Error("operator cancelled compaction");
    const worker = vi
      .spyOn(compactionPlanningWorkerRuntime, "runCompactionPlanningWorker")
      .mockImplementationOnce(async () => {
        controller.abort(reason);
        return { kind: "summaryChunks", chunkIndexes: [[0]] };
      });

    try {
      await expect(
        buildSummaryChunksWithWorker({
          messages: Array.from({ length: 64 }, (_, index) => makeMessage(index + 1, "request")),
          maxChunkTokens: 1_200,
          signal: controller.signal,
        }),
      ).rejects.toBe(reason);
    } finally {
      worker.mockRestore();
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

  it.each(
    [
      { script: "ASCII", glyph: "x" },
      { script: "common CJK", glyph: "漢" },
      { script: "rare BMP CJK", glyph: "㐀" },
      { script: "supplementary CJK", glyph: "𠀀" },
    ].flatMap(({ script, glyph }) =>
      ["text", "arguments"].map((source) => ({ script, glyph, source })),
    ),
  )(
    "preserves $script $source chunk budgets after restoring originals",
    async ({ glyph, source }) => {
      const hugeText = glyph.repeat(40_000);
      const messages: AgentMessage[] =
        source === "text"
          ? Array.from({ length: 64 }, (_, index) =>
              index === 0
                ? {
                    role: "toolResult",
                    toolCallId: "call_large",
                    toolName: "browser",
                    isError: false,
                    content: [{ type: "text", text: hugeText }],
                    timestamp: 0,
                  }
                : makeMessage(index, hugeText),
            )
          : Array.from({ length: 32 }, (_, index) => [
              makeAgentAssistantMessage({
                content: [
                  {
                    type: "toolCall",
                    id: `call_${index}`,
                    name: "write",
                    arguments: { [hugeText]: { nested: [hugeText] } },
                  },
                ],
                stopReason: "toolUse",
                timestamp: index * 2,
              }),
              {
                role: "toolResult" as const,
                toolCallId: `call_${index}`,
                toolName: "write",
                isError: false,
                content: [{ type: "text" as const, text: "ok" }],
                timestamp: index * 2 + 1,
              },
            ]).flat();
      const groupSize = source === "text" ? 1 : 2;
      const groupTokens = estimateMessagesTokens(messages.slice(0, groupSize));
      const maxChunkTokens = Math.ceil(groupTokens * 1.75);
      const chunks = await buildSummaryChunksWithWorker({ messages, maxChunkTokens });

      expect(chunks.map((chunk) => chunk.length)).toEqual(
        buildSummaryChunks({ messages, maxChunkTokens }).map((chunk) => chunk.length),
      );
      expect(chunks).toHaveLength(messages.length / groupSize);
      expect(Math.max(...chunks.map(estimateMessagesTokens))).toBeLessThanOrEqual(maxChunkTokens);
      chunks.flat().forEach((message, index) => expect(message).toBe(messages[index]));
      const fallback = await buildOversizedFallbackPlanWithWorker({
        messages,
        contextWindow: maxChunkTokens,
      });
      expect(fallback.smallMessages).toEqual([]);
      expect(fallback.oversizedNotes).toHaveLength(messages.length / groupSize);
    },
    45_000,
  );

  it("summarizes CJK history after ASCII exhausts the worker projection budget", async () => {
    const model = {
      id: "gpt-5.6-luna",
      name: "Synthetic context-limit model",
      api: "openai-responses",
      provider: "openai",
      baseUrl: "https://unused.invalid",
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 1_000_000,
      maxTokens: 8_192,
    } satisfies Parameters<typeof summarizeInStages>[0]["model"];
    const markers = Array.from(
      { length: 64 },
      (_, index) => `[history-${String(index).padStart(2, "0")}]`,
    );
    // The ASCII prefix fills the 256 KiB payload budget. Without weighted omitted
    // pressure, stage planning keeps all 64 messages and restores an overflowing chunk.
    const messages = markers.map((marker, index) =>
      makeMessage(
        index + 1,
        index < 32 ? "x".repeat(8_192 - marker.length) + marker : "漢".repeat(40_000) + marker,
      ),
    );
    const inputTokens: number[] = [];
    const seen = new Set<string>();
    let omissionNotes = false;
    const maxChunkTokens = 395_904;

    const summary = await summarizeInStages({
      messages,
      model,
      apiKey: "synthetic-no-credential", // pragma: allowlist secret
      signal: AbortSignal.timeout(45_000),
      reserveTokens: 4_096,
      maxChunkTokens,
      contextWindow: model.contextWindow,
      streamFn: (_model, context) => {
        const tokens = context.messages.reduce(
          (sum, message) => sum + estimateTokens(message),
          estimateTokens(makeMessage(0, context.systemPrompt ?? "")),
        );
        inputTokens.push(tokens);
        const text = context.messages
          .map((message) =>
            typeof message.content === "string"
              ? message.content
              : message.content
                  .filter((block) => block.type === "text")
                  .map((block) => block.text)
                  .join("\n"),
          )
          .join("\n");
        for (const marker of markers) {
          if (text.includes(marker)) {
            seen.add(marker);
          }
        }
        omissionNotes ||= /\[Large .*omitted from summary\]|\[Partial summary:/.test(text);
        if (tokens > model.contextWindow) {
          throw new Error(`context length exceeded: ${tokens} > ${model.contextWindow}`);
        }
        const stream = createAssistantMessageEventStream();
        stream.push({
          type: "done",
          reason: "stop",
          message: makeAgentAssistantMessage({
            content: [{ type: "text", text: "Compact summary." }],
          }),
        });
        stream.end();
        return stream;
      },
    });

    expect(summary).toBe("Compact summary.");
    expect(inputTokens.length).toBeGreaterThan(0);
    expect(Math.max(...inputTokens)).toBeLessThanOrEqual(model.contextWindow);
    expect(Math.max(...inputTokens)).toBeLessThanOrEqual(maxChunkTokens);
    expect([...seen].toSorted()).toEqual(markers.toSorted());
    expect(omissionNotes).toBe(false);
    expect(summary).not.toMatch(/\[Large .*omitted from summary\]|\[Partial summary:/);
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
