import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
// End-to-end subscription tests cover usage, lifecycle, tool logging,
// messaging/media side effects, and replay-state behavior for embedded runs.
import { expectDefined } from "@openclaw/normalization-core";
import type { AssistantMessage } from "openclaw/plugin-sdk/llm";
import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { HEARTBEAT_RESPONSE_TOOL_NAME } from "../auto-reply/heartbeat-tool-response.js";
import { getReplyPayloadMetadata } from "../auto-reply/reply-payload.js";
import * as agentEvents from "../infra/agent-events.js";
import { flushLogger, resetLogger, setLoggerOverride } from "../logging/logger.js";
import { parseLogLine } from "../logging/parse-log-line.js";
import {
  THINKING_TAG_CASES,
  createSubscribedSessionHarness,
  emitAssistantLifecycleErrorAndEnd,
  emitMessageStartAndEndForAssistantText,
  expectSingleAgentEventText,
  extractAgentEventPayloads,
  findLifecycleErrorAgentEvent,
} from "./embedded-agent-subscribe.e2e-harness.js";
import {
  createOpenAiResponsesPartial,
  createOpenAiResponsesTextBlock,
  createOpenAiResponsesTextEvent,
} from "./embedded-agent-subscribe.openai-responses.test-helpers.js";
import { SessionManager } from "./sessions/session-manager.js";
import { recordSessionModelUsage } from "./sessions/session-model-usage.js";
import { markCoreTtsToolResult } from "./tools/tts-tool-result-provenance.js";
import { makeZeroUsageSnapshot } from "./usage.js";

const retryingCompactionEnd = () =>
  ({
    type: "compaction_end",
    reason: "overflow",
    outcome: { status: "completed", tokensBefore: 100, tokensAfter: 50, willRetry: true },
  }) as const;

describe("subscribeEmbeddedAgentSession", () => {
  async function flushBlockReplyCallbacks(): Promise<void> {
    // Block replies can schedule nested microtasks; drain twice before checking
    // delivery state in broad subscription tests.
    await Promise.resolve();
    await Promise.resolve();
  }

  function createAgentEventHarness(options?: {
    runId?: string;
    sessionKey?: string;
    lifecycleGeneration?: string;
  }) {
    const onAgentEvent = vi.fn();
    const { emit } = createSubscribedSessionHarness({
      runId: options?.runId ?? "run",
      lifecycleGeneration: options?.lifecycleGeneration,
      onAgentEvent,
      sessionKey: options?.sessionKey,
    });

    return { emit, onAgentEvent };
  }

  function createToolErrorHarness(runId: string) {
    return createSubscribedSessionHarness({
      runId,
      sessionKey: "test-session",
    });
  }

  function emitAssistantTextDelta(
    emit: (evt: unknown) => void,
    delta: string,
    message: Record<string, unknown> = { role: "assistant" },
  ) {
    emit({
      type: "message_update",
      message,
      assistantMessageEvent: {
        type: "text_delta",
        delta,
      },
    });
  }

  function emitAssistantTextEnd(
    emit: (evt: unknown) => void,
    content: string,
    message: Record<string, unknown> = { role: "assistant" },
  ) {
    emit({
      type: "message_update",
      message,
      assistantMessageEvent: {
        type: "text_end",
        content,
      },
    });
  }

  function emitThinkingEvent(
    emit: (evt: unknown) => void,
    thinking: string,
    assistantMessageEvent: { type: "thinking_delta"; delta: string } | { type: "thinking_end" },
  ) {
    emit({
      type: "message_update",
      message: { role: "assistant", content: [{ type: "thinking", thinking }] },
      assistantMessageEvent,
    });
  }

  function createWriteFailureHarness(params: {
    runId: string;
    path: string;
    content: string;
  }): ReturnType<typeof createToolErrorHarness> {
    const harness = createToolErrorHarness(params.runId);
    emitToolRun({
      emit: harness.emit,
      toolName: "write",
      toolCallId: "w1",
      args: { path: params.path, content: params.content },
      isError: true,
      result: { error: "disk full" },
    });
    expect(harness.subscription.getLastToolError()?.toolName).toBe("write");
    return harness;
  }

  function emitToolRun(params: {
    emit: (evt: unknown) => void;
    toolName: string;
    toolCallId: string;
    args?: Record<string, unknown>;
    isError: boolean;
    result: unknown;
  }): void {
    params.emit({
      type: "tool_execution_start",
      toolName: params.toolName,
      toolCallId: params.toolCallId,
      args: params.args,
    });
    params.emit({
      type: "tool_execution_end",
      toolName: params.toolName,
      toolCallId: params.toolCallId,
      isError: params.isError,
      result: params.result,
    });
  }

  async function createGeneratedImageHarness(
    options: Pick<
      Parameters<typeof createSubscribedSessionHarness>[0],
      "blockReplyBreak" | "blockReplyChunking"
    > = {},
  ) {
    const onToolResult = vi.fn();
    const onBlockReply = vi.fn();
    const { emit, subscription } = createSubscribedSessionHarness({
      runId: "run",
      onToolResult,
      onBlockReply,
      verboseLevel: "full",
      blockReplyBreak: "message_end",
      builtinToolNames: new Set(["image_generate"]),
      ...options,
    });
    emitToolRun({
      emit,
      toolName: "image_generate",
      toolCallId: "tool-1",
      isError: false,
      result: {
        content: [
          {
            type: "text",
            text: "Generated 1 image with google/gemini-3.1-flash-image-preview.\nMEDIA:/tmp/generated.png",
          },
        ],
        details: { media: { mediaUrls: ["/tmp/generated.png"] } },
      },
    });
    await vi.waitFor(() => {
      expect(onToolResult).toHaveBeenCalledTimes(2);
    });
    return { emit, subscription, onToolResult, onBlockReply };
  }

  async function captureToolLifecycleLogSubsystems(messageChannel?: string): Promise<string[]> {
    // Use a temporary file-backed logger so subsystem attribution is verified
    // against real serialized log lines.
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-tool-log-attribution-"));
    const logFile = path.join(tempDir, "openclaw.log");
    try {
      setLoggerOverride({
        level: "debug",
        consoleLevel: "silent",
        file: logFile,
      });
      const { emit } = createSubscribedSessionHarness({
        runId: "run-log-attribution",
        messageChannel,
      });

      emitToolRun({
        emit,
        toolName: "exec",
        toolCallId: "tool-log-attribution",
        args: { command: "echo ok" },
        isError: false,
        result: { ok: true },
      });

      // The file transport appends asynchronously; drain it before reading.
      await flushLogger();
      const logText = await fs.readFile(logFile, "utf8");
      const subsystems: string[] = [];
      for (const line of logText.trim().split(/\n+/)) {
        const parsed = parseLogLine(line);
        if (parsed?.message.includes("embedded run tool")) {
          subsystems.push(parsed.subsystem ?? "");
        }
      }
      return subsystems;
    } finally {
      resetLogger();
      setLoggerOverride(null);
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  }

  function findBlockReplyPayload(
    onBlockReply: { mock: { calls: unknown[][] } },
    text: string,
  ): { mediaUrls?: unknown; trustedLocalMedia?: unknown } | undefined {
    return onBlockReply.mock.calls
      .map(
        (call) => call[0] as { text?: unknown; mediaUrls?: unknown; trustedLocalMedia?: unknown },
      )
      .find((payload) => payload.text === text);
  }

  function mockCallArg(mock: { mock: { calls: unknown[][] } }, callIndex = 0): unknown {
    const call = mock.mock.calls[callIndex];
    if (!call) {
      throw new Error(`expected mock call ${callIndex + 1}`);
    }
    return call[0];
  }

  function latestMockCallArg(mock: { mock: { calls: unknown[][] } }): unknown {
    return mockCallArg(mock, mock.mock.calls.length - 1);
  }

  function expectBlockReplyPayload(
    onBlockReply: { mock: { calls: unknown[][] } },
    expected: { text: string; mediaUrls?: string[]; trustedLocalMedia?: boolean },
  ): void {
    const payload = findBlockReplyPayload(onBlockReply, expected.text);
    if (!payload) {
      throw new Error(`Expected block reply text: ${expected.text}`);
    }
    if (expected.mediaUrls !== undefined) {
      expect(payload.mediaUrls).toStrictEqual(expected.mediaUrls);
    }
    expect(payload.trustedLocalMedia).toBe(expected.trustedLocalMedia);
  }

  function expectLifecyclePayload(
    payloads: Array<Record<string, unknown>>,
    expected: { phase: string; livenessState: string; replayInvalid: boolean },
  ): void {
    const payload = payloads.find(
      (item) =>
        item.phase === expected.phase &&
        item.livenessState === expected.livenessState &&
        item.replayInvalid === expected.replayInvalid,
    );
    if (!payload) {
      throw new Error(`Expected lifecycle payload for phase ${expected.phase}`);
    }
  }

  it("captures usage from completions timings on done events", () => {
    const { emit, subscription } = createSubscribedSessionHarness({ runId: "run" });

    emit({ type: "message_start", message: { role: "assistant" } });
    emit({
      type: "message_update",
      message: { role: "assistant" },
      assistantMessageEvent: {
        type: "done",
        timings: {
          prompt_n: 30_834,
          predicted_n: 34,
        },
      },
    });
    emit({
      type: "message_end",
      message: {
        role: "assistant",
        usage: makeZeroUsageSnapshot(),
      },
    });

    expect(subscription.getUsageTotals()).toEqual({
      input: 30_834,
      output: 34,
      cacheRead: undefined,
      cacheWrite: undefined,
      total: 30_868,
    });
  });

  it("emits cumulative run output usage once per completed assistant message", () => {
    const { emit, onAgentEvent } = createAgentEventHarness({
      runId: "usage-event-run",
      lifecycleGeneration: agentEvents.getAgentEventLifecycleGeneration(),
    });
    const emitAssistantUsage = (output: number) => {
      const usage = { input: 100, output, totalTokens: 100 + output };
      emit({ type: "message_start", message: { role: "assistant" } });
      emit({
        type: "message_update",
        message: { role: "assistant" },
        assistantMessageEvent: { type: "done", usage },
      });
      emit({ type: "message_end", message: { role: "assistant", usage } });
    };

    emitAssistantUsage(12);
    emitAssistantUsage(8);

    const usageEvents = onAgentEvent.mock.calls
      .map(([event]) => event)
      .filter((event) => event.stream === "usage");
    expect(usageEvents).toEqual([
      { stream: "usage", data: { outputTokens: 12 } },
      { stream: "usage", data: { outputTokens: 20 } },
    ]);
  });

  it.each([false, true])(
    "accounts each assistant message when block delivery queues usage across retry=%j",
    async (retry) => {
      const deliveryStarted = createDeferred();
      const releaseDelivery = createDeferred();
      const onAgentEvent = vi.fn();
      const onBlockReply = vi.fn().mockImplementationOnce(() => {
        deliveryStarted.resolve();
        return releaseDelivery.promise;
      });
      const { emit, subscription } = createSubscribedSessionHarness({
        runId: `queued-usage-${retry}`,
        lifecycleGeneration: agentEvents.getAgentEventLifecycleGeneration(),
        sessionPersistence: "detached",
        blockReplyBreak: "text_end",
        onBlockReply,
        onAgentEvent,
      });
      try {
        for (const [index, { text, input, output, cost }] of [
          { text: "First reply.", input: 100, output: 12, cost: 0.125 },
          { text: "Second reply.", input: 200, output: 8, cost: 0.5 },
        ].entries()) {
          const message = {
            role: "assistant",
            content: [{ type: "text", text }],
            usage: makeZeroUsageSnapshot(),
          };
          emit({ type: "message_start", message });
          emitAssistantTextDelta(emit, text, message);
          emitAssistantTextEnd(emit, text, message);
          if (index === 0) {
            await deliveryStarted.promise;
          }
          emit({
            type: "message_update",
            message,
            assistantMessageEvent: {
              type: "done",
              usage: {
                input,
                output,
                totalTokens: input + output,
                cost: { total: cost, totalOrigin: "provider-billed" },
              },
            },
          });
          emit({ type: "message_end", message });
          if (index === 0 && retry) {
            emit(retryingCompactionEnd());
          }
        }
      } finally {
        releaseDelivery.resolve();
        await subscription.waitForPendingEvents();
        subscription.unsubscribe();
      }
      expect(subscription.getUsageTotals()).toMatchObject({
        input: 300,
        output: 20,
        total: 320,
        cost: { total: 0.625 },
      });
      expect(subscription.getLastAssistantUsage()).toEqual({
        input: 200,
        output: 8,
        total: 208,
        cost: { total: 0.5, totalOrigin: "provider-billed" },
      });
      const usageEvents = onAgentEvent.mock.calls
        .map(([event]) => event)
        .filter((event) => event.stream === "usage");
      expect(usageEvents).toEqual([
        { stream: "usage", data: { outputTokens: 12 } },
        { stream: "usage", data: { outputTokens: 20 } },
      ]);
    },
  );

  it.each([
    ["telegram", "gateway/channels/telegram"],
    [undefined, "agent/embedded"],
    ["openclaw", "agent/embedded"],
    ["not a channel", "agent/embedded"],
  ] as const)(
    "attributes tool lifecycle logs for channel=%s",
    async (messageChannel, subsystem) => {
      await expect(captureToolLifecycleLogSubsystems(messageChannel)).resolves.toEqual([
        subsystem,
        subsystem,
      ]);
    },
  );

  it("delivers generated media after dropping malformed provider attachment metadata", async () => {
    const onBlockReply = vi.fn();
    const { emit, subscription } = createSubscribedSessionHarness({
      runId: "generated-malformed-metadata",
      onBlockReply,
      blockReplyBreak: "message_end",
      builtinToolNames: new Set(["music_generate"]),
    });
    const mediaPath = "/tmp/generated-song.mp3";

    emitToolRun({
      emit,
      toolName: "music_generate",
      toolCallId: "music-tool",
      isError: false,
      result: {
        content: [{ type: "text", text: "Generated media." }],
        details: {
          media: {
            mediaUrls: [mediaPath],
            attachments: [
              { type: "audio", path: mediaPath, name: 1, mimeType: null, durationMs: -1 },
            ],
          },
        },
      },
    });
    await subscription.waitForPendingEvents();
    emitMessageStartAndEndForAssistantText({ emit, text: "Here is your generated song." });
    emit({ type: "agent_end", messages: [], willRetry: false });
    await subscription.waitForPendingEvents();

    expect(onBlockReply).toHaveBeenCalledOnce();
    expect(onBlockReply.mock.calls[0]?.[0]).toMatchObject({
      text: "Here is your generated song.",
      mediaUrls: [mediaPath],
      attachments: [{ type: "audio", path: mediaPath }],
    });
  });

  it("does not double-count usage or cost when done and message_end carry the same snapshot", () => {
    const { emit, subscription } = createSubscribedSessionHarness({ runId: "run" });
    const usage = {
      input: 100,
      output: 20,
      totalTokens: 120,
      cost: { total: 0.125, totalOrigin: "provider-billed" },
    };

    emit({ type: "message_start", message: { role: "assistant" } });
    emit({
      type: "message_update",
      message: { role: "assistant" },
      assistantMessageEvent: {
        type: "done",
        message: {
          role: "assistant",
          usage,
        },
      },
    });
    emit({
      type: "message_end",
      message: {
        role: "assistant",
        usage,
      },
    });

    expect(subscription.getUsageTotals()).toEqual({
      input: 100,
      output: 20,
      cacheRead: undefined,
      cacheWrite: undefined,
      total: 120,
      cost: { total: 0.125 },
    });
    expect(subscription.getLastAssistantUsage()).toEqual({
      input: 100,
      output: 20,
      total: 120,
      cost: { total: 0.125, totalOrigin: "provider-billed" },
    });
  });

  it.each([
    { costTotal: 0, source: "done" },
    { costTotal: 0.125, source: "done" },
    { costTotal: undefined, source: "done" },
    { costTotal: 0, source: "text_end" },
    { costTotal: 0.125, source: "text_end" },
    { costTotal: undefined, source: "text_end" },
  ])(
    "preserves pending streamed cost $costTotal from $source when terminal usage is zeroed",
    ({ costTotal, source }) => {
      const { emit, subscription } = createSubscribedSessionHarness({ runId: "run-pending-cost" });
      const usage = {
        input: 100,
        output: 20,
        cacheWrite: 40,
        cacheWrite1h: 30,
        totalTokens: 160,
        ...(costTotal !== undefined
          ? { cost: { total: costTotal, totalOrigin: "provider-billed" as const } }
          : {}),
      };
      const message = { role: "assistant", usage: makeZeroUsageSnapshot() };
      emit({ type: "message_start", message: { role: "assistant" } });
      emit({
        type: "message_update",
        message: { role: "assistant" },
        assistantMessageEvent: { type: source, usage },
      });
      emit({ type: "message_end", message });

      expect(subscription.getUsageTotals()?.cost).toEqual(
        costTotal !== undefined ? { total: costTotal } : undefined,
      );
      expect(subscription.getLastAssistantUsage()).toMatchObject({
        input: 100,
        output: 20,
        cacheWrite: 40,
        cacheWrite1h: 30,
      });
      if (costTotal !== undefined) {
        expect(message.usage.cost).toMatchObject({
          total: costTotal,
          totalOrigin: "provider-billed",
        });
      }
      subscription.unsubscribe();
    },
  );

  it.each([
    { costTotal: 0, priorCall: false },
    { costTotal: 0.125, priorCall: false },
    { costTotal: 0, priorCall: true },
    { costTotal: 0.125, priorCall: true },
  ])(
    "retains billed cost-only $costTotal with prior call $priorCall",
    ({ costTotal, priorCall }) => {
      const { emit, session, subscription } = createSubscribedSessionHarness({
        runId: "run-cost-only",
        sessionExtras: { sessionManager: SessionManager.inMemory() },
      });
      const previousUsage = { input: 100, output: 20, totalTokens: 120, cost: { total: 0.25 } };
      if (priorCall) {
        emit({ type: "message_start", message: { role: "assistant" } });
        emit({ type: "message_end", message: { role: "assistant", usage: previousUsage } });
      }
      const lastCallUsage = subscription.getLastAssistantUsage();
      const usage = makeZeroUsageSnapshot();
      usage.cost.total = costTotal;
      usage.cost.totalOrigin = "provider-billed";
      const message = { role: "assistant", usage: makeZeroUsageSnapshot() };
      emit({ type: "message_start", message: { role: "assistant" } });
      emit({
        type: "message_update",
        message: { role: "assistant" },
        assistantMessageEvent: { type: "done", usage },
      });
      emit({ type: "message_end", message });

      const priorCost = priorCall ? 0.25 : 0;
      expect(subscription.getUsageTotals()?.cost).toEqual({ total: priorCost + costTotal });
      expect(subscription.getLastAssistantUsage()).toEqual(lastCallUsage);
      expect(message.usage.cost).toMatchObject({
        total: costTotal,
        totalOrigin: "provider-billed",
      });
      recordSessionModelUsage(session.sessionManager, usage);
      expect(subscription.getUsageTotals()?.cost).toEqual({ total: priorCost + costTotal * 2 });
      expect(subscription.getLastAssistantUsage()).toEqual(lastCallUsage);
      subscription.unsubscribe();
    },
  );

  it.each([
    { costTotal: 0, terminalTokens: false },
    { costTotal: 0.125, terminalTokens: false },
    { costTotal: 0, terminalTokens: true },
    { costTotal: 0.125, terminalTokens: true },
  ])(
    "merges cost-only billing $costTotal with terminal tokens $terminalTokens",
    ({ costTotal, terminalTokens }) => {
      const { emit, subscription } = createSubscribedSessionHarness({ runId: "run-late-billing" });
      const tokens = { input: 100, output: 20 };
      const message = {
        role: "assistant",
        usage: { ...makeZeroUsageSnapshot(), ...(terminalTokens ? tokens : {}) },
      };
      emit({ type: "message_start", message: { role: "assistant" } });
      emit({
        type: "message_update",
        message: { role: "assistant" },
        assistantMessageEvent: { type: "text_end", usage: tokens },
      });
      emit({
        type: "message_update",
        message: { role: "assistant" },
        assistantMessageEvent: {
          type: "done",
          usage: { cost: { total: costTotal, totalOrigin: "provider-billed" } },
        },
      });
      emit({ type: "message_end", message });

      expect(subscription.getUsageTotals()).toMatchObject({
        ...tokens,
        cost: { total: costTotal },
      });
      expect(subscription.getLastAssistantUsage()).toMatchObject(tokens);
      expect(message.usage.cost).toMatchObject({
        total: costTotal,
        totalOrigin: "provider-billed",
      });
      subscription.unsubscribe();
    },
  );

  it("sums per-call prices without selecting a tier from the tool-loop token total", () => {
    const { emit, subscription } = createSubscribedSessionHarness({ runId: "run-loop-cost" });
    for (const total of [0.125, 0.5]) {
      const message = {
        role: "assistant",
        usage: { input: 150_000, output: 100, totalTokens: 0, cost: { total } },
      };
      emit({ type: "message_start", message });
      emit({ type: "message_end", message });
    }

    expect(subscription.getUsageTotals()).toMatchObject({
      input: 300_000,
      output: 200,
      total: 300_200,
      cost: { total: 0.625 },
    });
    expect(subscription.getLastAssistantUsage()?.cost).toEqual({ total: 0.5 });
    subscription.unsubscribe();
  });

  it("retains the last nonzero call when a later aborted message reports zero usage", () => {
    const { emit, subscription } = createSubscribedSessionHarness({ runId: "run" });
    const usage = { input: 38_333, output: 66, cacheRead: 120_320, totalTokens: 158_719 };

    emit({ type: "message_start", message: { role: "assistant" } });
    emit({ type: "message_end", message: { role: "assistant", usage } });
    emit({ type: "message_start", message: { role: "assistant" } });
    emit({
      type: "message_end",
      message: { role: "assistant", stopReason: "aborted", usage: makeZeroUsageSnapshot() },
    });

    expect(subscription.getLastAssistantUsage()).toEqual({
      input: 38_333,
      output: 66,
      cacheRead: 120_320,
      total: 158_719,
    });
  });

  it.each([
    {
      name: "keeps a successful retry call when later post-call processing fails",
      retryUsage: { input: 240, output: 30, totalTokens: 270 },
      expected: { input: 240, output: 30, total: 270 },
    },
    {
      name: "restores the previous call when a retry fails before recording usage",
      retryUsage: undefined,
      expected: { input: 100, output: 20, total: 120 },
    },
  ])("$name", ({ retryUsage, expected }) => {
    const { emit, subscription } = createSubscribedSessionHarness({ runId: "run" });

    emit({ type: "message_start", message: { role: "assistant" } });
    emit({
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "Before retry." }],
        usage: { input: 100, output: 20, totalTokens: 120 },
      },
    });
    expect(subscription.assistantTexts).toEqual(["Before retry."]);
    expect(subscription.getLastAssistantTextMessageIndex()).toEqual(expect.any(Number));
    emit(retryingCompactionEnd());
    expect(subscription.assistantTexts).toEqual([]);
    expect(subscription.getLastAssistantTextMessageIndex()).toBeUndefined();
    if (retryUsage) {
      emit({ type: "message_start", message: { role: "assistant" } });
      emit({ type: "message_end", message: { role: "assistant", usage: retryUsage } });
    }
    emit({ type: "message_start", message: { role: "assistant" } });
    emit({
      type: "message_end",
      message: {
        role: "assistant",
        stopReason: "error",
        usage: makeZeroUsageSnapshot(),
      },
    });

    expect(subscription.getLastAssistantUsage()).toEqual(expected);
  });

  it.each(THINKING_TAG_CASES)(
    "streams <%s> reasoning via onReasoningStream without leaking into final text",
    async ({ open, close }) => {
      const onReasoningStream = vi.fn();
      const onBlockReply = vi.fn();

      const { emit } = createSubscribedSessionHarness({
        runId: "run",
        onReasoningStream,
        onBlockReply,
        blockReplyBreak: "message_end",
        reasoningMode: "stream",
      });

      emitAssistantTextDelta(emit, `${open}\nBecause`);
      emitAssistantTextDelta(emit, ` it helps\n${close}\n\nFinal answer`);

      const assistantMessage = {
        role: "assistant",
        content: [
          {
            type: "text",
            text: `${open}\nBecause it helps\n${close}\n\nFinal answer`,
          },
        ],
      } as AssistantMessage;

      emit({ type: "message_end", message: assistantMessage });
      await flushBlockReplyCallbacks();

      expect(onBlockReply).toHaveBeenCalledTimes(1);
      expect((mockCallArg(onBlockReply) as { text?: string }).text).toBe("Final answer");

      const streamTexts = onReasoningStream.mock.calls
        .map((call) => call[0]?.text)
        .filter((value): value is string => typeof value === "string");
      expect(streamTexts.at(-1)).toBe("Because it helps");

      expect(assistantMessage.content).toEqual([
        { type: "thinking", thinking: "Because it helps" },
        { type: "text", text: "Final answer" },
      ]);
    },
  );

  it("suppressLiveStreamOutput skips per-chunk preview but still delivers final text", () => {
    const onAgentEvent = vi.fn();
    const { emit } = createSubscribedSessionHarness({
      runId: "run",
      onAgentEvent,
      suppressLiveStreamOutput: true,
    });

    emit({ type: "message_start", message: { role: "assistant" } });
    emitAssistantTextDelta(emit, "Hello ");
    emitAssistantTextDelta(emit, "world");

    // No live preview events while suppressed (the per-chunk parsing path is skipped).
    expect(extractAgentEventPayloads(onAgentEvent.mock.calls)).toHaveLength(0);

    const assistantMessage = {
      role: "assistant",
      content: [{ type: "text", text: "Hello world" }],
    } as AssistantMessage;
    emit({ type: "message_end", message: assistantMessage });
    expectSingleAgentEventText(onAgentEvent.mock.calls, "Hello world");
  });

  it("blocks local MEDIA urls from case-variant tool names in verbose output", async () => {
    const onToolResult = vi.fn();
    const { emit } = createSubscribedSessionHarness({
      runId: "run",
      onToolResult,
      verboseLevel: "full",
      builtinToolNames: new Set(["web_search"]),
    });

    emitToolRun({
      emit,
      toolName: "Web_Search",
      toolCallId: "tool-1",
      isError: false,
      result: {
        content: [{ type: "text", text: "Fetched page\nMEDIA:/tmp/secret.png" }],
      },
    });

    await vi.waitFor(() => {
      expect(onToolResult).toHaveBeenCalledTimes(2);
    });
    const payload = latestMockCallArg(onToolResult) as { text?: string; mediaUrls?: string[] };
    expect(payload.text ?? "").toContain("Fetched page");
    expect(payload.mediaUrls).toBeUndefined();
  });

  it.each([false, true])("delivers generated image media once after text_end=%s", async (ended) => {
    const { emit, subscription, onToolResult, onBlockReply } = await createGeneratedImageHarness({
      blockReplyBreak: "text_end",
    });
    const toolPayload = latestMockCallArg(onToolResult) as {
      text?: string;
      mediaUrls?: string[];
    };
    expect(toolPayload.text ?? "").toContain("Generated 1 image");
    expect(toolPayload.mediaUrls).toBeUndefined();

    emit({ type: "message_start", message: { role: "assistant" } });
    emitAssistantTextDelta(emit, "Here is the image.");
    if (ended) {
      emitAssistantTextEnd(emit, "Here is the image.");
    }
    emit({
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "Here is the image." }],
      },
    });
    await subscription.waitForPendingEvents();

    const payloads = onBlockReply.mock.calls.map(([payload]) => payload);
    expect(payloads.map((payload) => payload.text).filter(Boolean)).toEqual(["Here is the image."]);
    expect(payloads.flatMap((payload) => payload.mediaUrls ?? [])).toEqual(["/tmp/generated.png"]);
  });

  it.each([
    {
      toolName: "image_generate",
      type: "image",
      mimeType: "image/png",
      metadata: { width: 640, height: 480 },
    },
    {
      toolName: "music_generate",
      type: "audio",
      mimeType: "audio/mpeg",
      metadata: { durationMs: 2_000 },
    },
    {
      toolName: "video_generate",
      type: "video",
      mimeType: "video/mp4",
      metadata: { durationMs: 5_000, width: 1280, height: 720 },
    },
  ] as const)(
    "delivers generated $type attachment metadata with the assistant reply",
    async ({ toolName, type, mimeType, metadata }) => {
      const onBlockReply = vi.fn();
      const { emit, subscription } = createSubscribedSessionHarness({
        runId: `generated-${type}`,
        onBlockReply,
        blockReplyBreak: "message_end",
        builtinToolNames: new Set([toolName]),
      });
      const attachment = {
        type,
        path: `/tmp/generated-${type}`,
        name: `friendly-${type}`,
        mimeType,
        sizeBytes: 137,
        ...metadata,
      };

      emitToolRun({
        emit,
        toolName,
        toolCallId: `${type}-tool`,
        isError: false,
        result: {
          content: [{ type: "text", text: "Generated media." }],
          details: { media: { mediaUrls: [attachment.path], attachments: [attachment] } },
        },
      });
      await subscription.waitForPendingEvents();
      expect(subscription.getPendingToolMediaReply()).toMatchObject({
        mediaUrls: [attachment.path],
        attachments: [attachment],
      });

      emitMessageStartAndEndForAssistantText({ emit, text: "Here is your generated file." });
      emit({ type: "agent_end", messages: [], willRetry: false });
      await subscription.waitForPendingEvents();

      expect(onBlockReply).toHaveBeenCalledOnce();
      expect(onBlockReply.mock.calls[0]?.[0]).toMatchObject({
        text: "Here is your generated file.",
        mediaUrls: [attachment.path],
        attachments: [attachment],
      });
    },
  );

  it.each(["streamed", "terminal Responses block", "ended Responses block"] as const)(
    "delivers the caption and selected media exactly once with %s MEDIA lines",
    async (mediaSource) => {
      const { emit, subscription, onBlockReply } = await createGeneratedImageHarness({
        blockReplyBreak: "text_end",
      });
      const caption = "Here is the selected image.";
      const media = "MEDIA:./selected.png";
      emit({ type: "message_start", message: { role: "assistant" } });
      if (mediaSource === "streamed") {
        emitAssistantTextDelta(emit, `${caption}\n${media}`);
        emit({
          type: "message_end",
          message: { role: "assistant", content: [{ type: "text", text: `${caption}\n${media}` }] },
        });
      } else {
        const first = { text: caption, id: "caption", signaturePhase: "final_answer" as const };
        emit(createOpenAiResponsesTextEvent({ type: "text_delta", ...first }));
        if (mediaSource === "ended Responses block") {
          emit(createOpenAiResponsesTextEvent({ type: "text_end", ...first }));
        }
        const message = createOpenAiResponsesPartial(first);
        message.content.push(
          createOpenAiResponsesTextBlock({ text: media, id: "media", phase: "final_answer" }),
        );
        emit({ type: "message_end", message });
      }
      await subscription.waitForPendingEvents();

      const payloads = onBlockReply.mock.calls.map(([payload]) => payload);
      expect({
        captions: payloads.map((payload) => payload.text).filter(Boolean),
        mediaUrls: payloads.flatMap((payload) => payload.mediaUrls ?? []),
      }).toEqual({ captions: [caption], mediaUrls: ["./selected.png"] });
    },
  );

  it("does not attach generated image media to an early streamed chunk before explicit MEDIA", async () => {
    const { emit, subscription, onBlockReply } = await createGeneratedImageHarness({
      blockReplyBreak: "text_end",
      blockReplyChunking: { minChars: 5, maxChars: 200, breakPreference: "newline" },
    });

    emit({ type: "message_start", message: { role: "assistant" } });
    emitAssistantTextDelta(emit, "Generated 1 image.\n");
    await subscription.waitForPendingEvents();

    expectBlockReplyPayload(onBlockReply, {
      text: "Generated 1 image.",
    });
    const earlyMediaPayloads = onBlockReply.mock.calls
      .map(([payload]) => payload)
      .filter((payload) => payload.mediaUrls?.length);
    expect(earlyMediaPayloads).toStrictEqual([]);

    emitAssistantTextDelta(emit, "MEDIA:/tmp/generated.png");
    emit({
      type: "message_update",
      message: { role: "assistant" },
      assistantMessageEvent: {
        type: "text_end",
        content: "Generated 1 image.\nMEDIA:/tmp/generated.png",
      },
    });
    emit({
      type: "message_end",
      message: {
        role: "assistant",
        content: [
          {
            type: "text",
            text: "Generated 1 image.\nMEDIA:/tmp/generated.png",
          },
        ],
      },
    });
    emit({ type: "agent_end" });
    await subscription.waitForPendingEvents();

    const mediaPayloads = onBlockReply.mock.calls
      .map(([payload]) => payload)
      .filter((payload) => payload.mediaUrls?.includes("/tmp/generated.png"));
    expect(mediaPayloads).toHaveLength(1);
    expect(subscription.hasToolMediaBlockReply()).toBe(true);
  });

  it("attaches media from internal completion events even when assistant omits MEDIA lines", async () => {
    const onBlockReply = vi.fn();
    const { emit } = createSubscribedSessionHarness({
      runId: "run",
      onBlockReply,
      blockReplyBreak: "message_end",
      internalEvents: [
        {
          type: "task_completion",
          source: "music_generation",
          childSessionKey: "music_generate:task-123",
          announceType: "music generation task",
          taskLabel: "lobster boss theme",
          status: "ok",
          statusLabel: "completed successfully",
          result: "Generated 1 track.\nMEDIA:/tmp/lobster-boss.mp3",
          mediaUrls: ["/tmp/lobster-boss.mp3"],
          replyInstruction: "Reply normally.",
        },
      ],
    });

    emit({
      type: "message_start",
      message: { role: "assistant" },
    });
    emitAssistantTextDelta(emit, "Here it is.");
    emit({
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "Here it is." }],
      },
    });
    emit({ type: "agent_end" });
    await flushBlockReplyCallbacks();

    expectBlockReplyPayload(onBlockReply, {
      text: "Here it is.",
      mediaUrls: ["/tmp/lobster-boss.mp3"],
      trustedLocalMedia: true,
    });
  });

  it("does not trust a mixed generated and non-generated pending media batch", async () => {
    const onBlockReply = vi.fn();
    const { emit } = createSubscribedSessionHarness({
      runId: "run",
      onBlockReply,
      blockReplyBreak: "message_end",
      internalEvents: [
        {
          type: "task_completion",
          source: "music_generation",
          childSessionKey: "music_generate:task-123",
          announceType: "music generation task",
          taskLabel: "theme",
          status: "ok",
          statusLabel: "completed successfully",
          result: "Generated music.",
          mediaUrls: ["/tmp/generated.mp3"],
          replyInstruction: "Reply normally.",
        },
        {
          type: "task_completion",
          source: "subagent",
          childSessionKey: "agent:child:main",
          announceType: "subagent task",
          taskLabel: "other",
          status: "ok",
          statusLabel: "completed successfully",
          result: "Other media.",
          mediaUrls: ["/tmp/untrusted.mp3"],
          replyInstruction: "Reply normally.",
        },
      ],
    });

    emit({ type: "message_start", message: { role: "assistant" } });
    emit({
      type: "message_end",
      message: { role: "assistant", content: [{ type: "text", text: "Done." }] },
    });
    emit({ type: "agent_end" });
    await flushBlockReplyCallbacks();

    expectBlockReplyPayload(onBlockReply, {
      text: "Done.",
      mediaUrls: ["/tmp/generated.mp3", "/tmp/untrusted.mp3"],
      trustedLocalMedia: undefined,
    });
  });

  it.each([
    {
      label: "music",
      source: "music_generation" as const,
      childSessionKey: "music_generate:task-123",
      announceType: "music generation task",
      taskLabel: "launch anthem",
      result: "Generated 1 track.\nMEDIA:/tmp/launch-anthem.mp3",
      mediaUrl: "/tmp/launch-anthem.mp3",
      firstChunk: "Generated 1 track.\n",
      finalText: "Generated 1 track.\nMEDIA:/tmp/launch-anthem.mp3",
    },
    {
      label: "video",
      source: "video_generation" as const,
      childSessionKey: "video_generate:task-123",
      announceType: "video generation task",
      taskLabel: "launch reel",
      result: "Generated 1 video.\nMEDIA:/tmp/launch-reel.mp4",
      mediaUrl: "/tmp/launch-reel.mp4",
      firstChunk: "Generated 1 video.\n",
      finalText: "Generated 1 video.\nMEDIA:/tmp/launch-reel.mp4",
    },
  ])(
    "does not attach $label internal completion media to an early streamed chunk before explicit MEDIA",
    async ({
      source,
      childSessionKey,
      announceType,
      taskLabel,
      result,
      mediaUrl,
      firstChunk,
      finalText,
    }) => {
      const onBlockReply = vi.fn();
      const { emit } = createSubscribedSessionHarness({
        runId: "run",
        onBlockReply,
        blockReplyBreak: "text_end",
        blockReplyChunking: { minChars: 5, maxChars: 200, breakPreference: "newline" },
        internalEvents: [
          {
            type: "task_completion",
            source,
            childSessionKey,
            announceType,
            taskLabel,
            status: "ok",
            statusLabel: "completed successfully",
            result,
            mediaUrls: [mediaUrl],
            replyInstruction: "Reply normally.",
          },
        ],
      });

      emit({ type: "message_start", message: { role: "assistant" } });
      emitAssistantTextDelta(emit, firstChunk);

      expectBlockReplyPayload(onBlockReply, {
        text: firstChunk.trim(),
      });
      const earlyMediaPayloads = onBlockReply.mock.calls
        .map(([payload]) => payload)
        .filter((payload) => payload.mediaUrls?.length);
      expect(earlyMediaPayloads).toStrictEqual([]);

      emitAssistantTextDelta(emit, `MEDIA:${mediaUrl}`);
      emit({
        type: "message_update",
        message: { role: "assistant" },
        assistantMessageEvent: {
          type: "text_end",
          content: finalText,
        },
      });
      emit({
        type: "message_end",
        message: {
          role: "assistant",
          content: [
            {
              type: "text",
              text: finalText,
            },
          ],
        },
      });
      emit({ type: "agent_end" });
      await flushBlockReplyCallbacks();

      const mediaPayloads = onBlockReply.mock.calls
        .map(([payload]) => payload)
        .filter((payload) => payload.mediaUrls?.includes(mediaUrl));
      expect(mediaPayloads).toHaveLength(1);
    },
  );

  it("keeps orphaned tool media available for non-block final payload assembly", async () => {
    const { emit, subscription } = createSubscribedSessionHarness({
      runId: "run",
      builtinToolNames: new Set(["tts"]),
      coreBuiltinToolNames: new Set(["tts"]),
    });

    emit({
      type: "tool_execution_end",
      toolName: "tts",
      toolCallId: "tc-1",
      isError: false,
      result: markCoreTtsToolResult(
        {
          details: {
            media: {
              mediaUrl: "/tmp/reply.opus",
              audioAsVoice: true,
              trustedLocalMedia: true,
            },
          },
        },
        ["/tmp/reply.opus"],
      ),
    });
    emit({ type: "agent_end" });
    await subscription.waitForPendingEvents();

    expect(subscription.getPendingToolMediaReply()).toEqual({
      mediaUrls: ["/tmp/reply.opus"],
      attachments: [{ trustedLocalMedia: true }],
      audioAsVoice: true,
      trustedLocalMedia: true,
    });
    expect(subscription.getToolAutoDeliveryMediaUrls()).toEqual(["/tmp/reply.opus"]);
  });

  it("counts orphaned tool media emitted through block replies", async () => {
    const onBlockReply = vi.fn();
    const { emit, subscription } = createSubscribedSessionHarness({
      runId: "run",
      builtinToolNames: new Set(["tts"]),
      coreBuiltinToolNames: new Set(["tts"]),
      sourceReplyDeliveryMode: "message_tool_only",
      onBlockReply,
    });

    emit({
      type: "tool_execution_end",
      toolName: "tts",
      toolCallId: "tc-1",
      isError: false,
      result: markCoreTtsToolResult(
        {
          details: {
            media: {
              mediaUrl: "/tmp/reply.opus",
              audioAsVoice: true,
              trustedLocalMedia: true,
            },
          },
        },
        ["/tmp/reply.opus"],
      ),
    });
    emit({ type: "agent_end" });
    await subscription.waitForPendingEvents();

    expect(onBlockReply).toHaveBeenCalledWith({
      mediaUrls: ["/tmp/reply.opus"],
      mediaUrl: "/tmp/reply.opus",
      attachments: [{ trustedLocalMedia: true }],
      audioAsVoice: true,
      trustedLocalMedia: true,
    });
    expect(subscription.getPendingToolMediaReply()).toBeNull();
    expect(subscription.getToolAutoDeliveryMediaUrls()).toEqual([]);
    expect(subscription.hasToolMediaBlockReply()).toBe(true);
    expect(subscription.getVisibleBlockReplyCount()).toBe(1);
    expect(getReplyPayloadMetadata(onBlockReply.mock.calls[0]?.[0] ?? {})).toMatchObject({
      deliverDespiteSourceReplySuppression: true,
    });
  });

  it.each(THINKING_TAG_CASES)(
    "suppresses <%s> blocks across chunk boundaries",
    async ({ open, close }) => {
      const onBlockReply = vi.fn();

      const { emit } = createSubscribedSessionHarness({
        runId: "run",
        onBlockReply,
        blockReplyBreak: "text_end",
        blockReplyChunking: {
          minChars: 5,
          maxChars: 50,
          breakPreference: "newline",
        },
      });

      emit({ type: "message_start", message: { role: "assistant" } });
      emitAssistantTextDelta(emit, `${open}Reasoning chunk that should not leak`);

      expect(onBlockReply).not.toHaveBeenCalled();

      emitAssistantTextDelta(emit, `${close}\n\nFinal answer`);
      emit({
        type: "message_update",
        message: { role: "assistant" },
        assistantMessageEvent: { type: "text_end" },
      });
      await flushBlockReplyCallbacks();

      const payloadTexts = onBlockReply.mock.calls
        .map((call) => call[0]?.text)
        .filter((value): value is string => typeof value === "string");
      expect(payloadTexts).toEqual(["Final answer"]);
      for (const text of payloadTexts) {
        expect(text).not.toContain("Reasoning");
        expect(text).not.toContain(open);
      }
    },
  );

  it("streams native thinking_delta events and signals reasoning end", () => {
    const onReasoningStream = vi.fn();
    const onReasoningEnd = vi.fn();

    const { emit } = createSubscribedSessionHarness({
      runId: "run",
      reasoningMode: "stream",
      onReasoningStream,
      onReasoningEnd,
    });

    emitThinkingEvent(emit, "Checking files", { type: "thinking_delta", delta: "Checking files" });
    emitThinkingEvent(emit, "Checking files done", { type: "thinking_end" });

    const streamTexts = onReasoningStream.mock.calls
      .map((call) => call[0]?.text)
      .filter((value): value is string => typeof value === "string");
    expect(streamTexts.at(-1)).toBe("Checking files done");
    expect(onReasoningEnd).toHaveBeenCalledTimes(1);
  });

  it.each([
    { label: "successful", stopReason: "stop", phase: undefined },
    { label: "failed", stopReason: "error", phase: undefined },
    { label: "aborted", stopReason: "aborted", phase: undefined },
    { label: "commentary", stopReason: "stop", phase: "commentary" },
  ] as const)(
    "closes a reasoning preview before the $label message ends without thinking_end",
    ({ stopReason, phase }) => {
      const visibleEvents: string[] = [];
      const onReasoningEnd = vi.fn(async () => {
        visibleEvents.push("reasoning-end");
      });
      const { emit } = createSubscribedSessionHarness({
        runId: "run-reasoning-terminal",
        reasoningMode: "stream",
        onReasoningStream: vi.fn(),
        onReasoningEnd,
        onAgentEvent: (event) => {
          if (event.stream === "assistant") {
            visibleEvents.push("assistant");
          }
        },
      });
      const thinkingMessage = {
        role: "assistant" as const,
        content: [{ type: "thinking" as const, thinking: "Checking files" }],
      };

      emit({ type: "message_start", message: thinkingMessage });
      emit({
        type: "message_update",
        message: thinkingMessage,
        assistantMessageEvent: { type: "thinking_delta", delta: "Checking files" },
      });
      emit({
        type: "message_end",
        message: {
          role: "assistant",
          stopReason,
          ...(phase ? { phase } : {}),
          content: [
            { type: "thinking", thinking: "Checking files" },
            { type: "text", text: "Final answer" },
          ],
        },
      });

      expect(onReasoningEnd).toHaveBeenCalledTimes(1);
      expect(visibleEvents[0]).toBe("reasoning-end");
    },
  );

  it("does not close a reasoning preview that was never opened", () => {
    const onReasoningEnd = vi.fn();
    const { emit } = createSubscribedSessionHarness({
      runId: "run-without-reasoning",
      reasoningMode: "stream",
      onReasoningEnd,
    });

    emit({
      type: "message_end",
      message: { role: "assistant", content: [{ type: "text", text: "Final answer" }] },
    });

    expect(onReasoningEnd).not.toHaveBeenCalled();
  });

  type ReasoningWindowGateCase = {
    label: string;
    reasoningMode: "off" | "stream";
    streamReasoningInNonStreamModes?: boolean;
    expected: boolean;
  };

  it.each<ReasoningWindowGateCase>([
    {
      label: "absent opt-in with off reasoning",
      reasoningMode: "off",
      expected: false,
    },
    {
      label: "false opt-in with off reasoning",
      reasoningMode: "off",
      streamReasoningInNonStreamModes: false,
      expected: false,
    },
    {
      label: "false opt-in with stream reasoning",
      reasoningMode: "stream",
      streamReasoningInNonStreamModes: false,
      expected: true,
    },
    {
      label: "true opt-in with off reasoning",
      reasoningMode: "off",
      streamReasoningInNonStreamModes: true,
      expected: true,
    },
  ])("gates reasoning-window streaming for $label", (params) => {
    const onReasoningStream = vi.fn();
    const { emit } = createSubscribedSessionHarness({
      runId: "run",
      reasoningMode: params.reasoningMode,
      ...(params.streamReasoningInNonStreamModes === undefined
        ? {}
        : { streamReasoningInNonStreamModes: params.streamReasoningInNonStreamModes }),
      onReasoningStream,
    });

    emitThinkingEvent(emit, "Checking files", { type: "thinking_delta", delta: "Checking files" });

    if (params.expected) {
      expect(onReasoningStream).toHaveBeenCalledWith({
        text: "Checking files",
        ...(params.reasoningMode === "stream" ? {} : { requiresReasoningProgressOptIn: true }),
      });
    } else {
      expect(onReasoningStream).not.toHaveBeenCalled();
    }
  });

  it("extracts correct reasoning delta for incremental stream updates", () => {
    const emitAgentEventSpy = vi.spyOn(agentEvents, "emitAgentEvent").mockImplementation(() => {});
    const { emit } = createSubscribedSessionHarness({
      runId: "run",
      reasoningMode: "stream",
      onReasoningStream: vi.fn(),
    });

    emitThinkingEvent(emit, "Step 1", { type: "thinking_delta", delta: "Step 1" });
    emitThinkingEvent(emit, "Step 1 and Step 2", { type: "thinking_delta", delta: " and Step 2" });

    const thinkingEvents = emitAgentEventSpy.mock.calls
      .map((call) => call[0])
      .filter((evt) => evt?.stream === "thinking");

    expect(thinkingEvents.length).toBe(2);
    expect(thinkingEvents[0]?.data?.delta).toBe("Step 1");
    expect(thinkingEvents[1]?.data?.delta).toBe(" and Step 2");
    emitAgentEventSpy.mockRestore();
  });

  it("emits live edit diff progress while tool arguments stream", () => {
    const emitAgentEventSpy = vi.spyOn(agentEvents, "emitAgentEvent").mockImplementation(() => {});
    const { emit } = createSubscribedSessionHarness({ runId: "run-live-edit-diff" });
    const partialJson =
      '{"path":"notes.md","edits":[{"oldText":"old\\nline","newText":"new\\nline\\n';
    const message = {
      role: "assistant",
      content: [
        {
          type: "toolCall",
          id: "tool-live-edit",
          name: "edit",
          arguments: {},
          partialJson,
        },
      ],
    };

    emit({
      type: "message_update",
      message,
      assistantMessageEvent: {
        type: "toolcall_delta",
        contentIndex: 0,
        delta: partialJson,
        partial: message,
      },
    });

    expect(
      emitAgentEventSpy.mock.calls
        .map(([event]) => event)
        .find((event) => event.stream === "tool" && event.data?.phase === "input_delta"),
    ).toMatchObject({
      runId: "run-live-edit-diff",
      stream: "tool",
      data: {
        phase: "input_delta",
        toolCallId: "tool-live-edit",
        name: "edit",
        diff: { added: 2, removed: 1 },
      },
    });
    emitAgentEventSpy.mockRestore();
  });

  it("emits reasoning end once when native and tagged reasoning end overlap", () => {
    const onReasoningEnd = vi.fn();

    const { emit } = createSubscribedSessionHarness({
      runId: "run",
      reasoningMode: "stream",
      onReasoningStream: vi.fn(),
      onReasoningEnd,
    });

    emit({ type: "message_start", message: { role: "assistant" } });
    emitAssistantTextDelta(emit, "<think>Checking");
    emitThinkingEvent(emit, "Checking", { type: "thinking_end" });

    emitAssistantTextDelta(emit, " files</think>\nFinal answer");

    expect(onReasoningEnd).toHaveBeenCalledTimes(1);
  });

  it.each([
    {
      name: "emits delta chunks in agent events for streaming assistant text",
      chunks: ["Hello", " world"],
      expected: [
        { text: "Hello", delta: "Hello" },
        { text: "Hello world", delta: " world" },
      ],
    },
    {
      name: "drops malformed streamed reasoning before orphan close tags when final text follows",
      chunks: ["private chain of thought </think> Visible answer"],
      expected: [{ text: "Visible answer", delta: "Visible answer" }],
    },
    {
      name: "replaces leaked MiniMax reasoning when its orphan close arrives in a later delta",
      chunks: ["private chain", "</mm:think>Visible answer"],
      expected: [
        { text: "private chain", delta: "private chain" },
        { text: "Visible answer", delta: "", replace: true },
      ],
    },
    {
      name: "replaces malformed streamed reasoning when orphan close tags split across deltas",
      chunks: ["private chain of thought </thi", "nk> Visible answer"],
      expected: [{ text: "Visible answer" }],
      noReplacement: true,
    },
    {
      name: "preserves visible text before a split orphan close when no final text follows",
      chunks: ["Done ", "</thi", "nk>"],
      expected: [{ text: "Done" }],
    },
    {
      name: "preserves media directives when orphan close replacement has no text",
      chunks: ["private chain of thought </thi", "nk>\nMEDIA:/tmp/a.png\n"],
      messageEnd: "private chain of thought </think>\nMEDIA:/tmp/a.png\n",
      last: { text: "", mediaUrls: ["/tmp/a.png"] },
      noReplacement: true,
    },
    {
      name: "preserves block tag literals inside fenced code split across deltas",
      chunks: ["```xml\n", "<thinking>literal</thinking>\n", "```"],
      textEnd: "```xml\n<thinking>literal</thinking>\n```",
      last: { text: "```xml\n<thinking>literal</thinking>\n```" },
    },
    {
      name: "does not infer a fence from a chunk-local line start before reasoning tags",
      chunks: ["abc", "~~~xml\n<think>secret"],
      first: { text: "abc" },
      last: { text: "abc~~~xml" },
      redacted: "secret",
    },
    {
      name: "preserves split fenced code openers while stripping later reasoning",
      chunks: ["``", "`xml\n<thinking>literal</thinking>\n```\n<think>secret</think>answer"],
      last: { text: "```xml\n<thinking>literal</thinking>\n```\nanswer" },
    },
    {
      name: "preserves long fenced code openers split after three markers",
      chunks: ["```", "`\n<thinking>literal</thinking>\n```\n````"],
      textEnd: "````\n<thinking>literal</thinking>\n```\n````",
      last: { text: "````\n<thinking>literal</thinking>\n```\n````" },
    },
    {
      name: "keeps close tag literals inside hidden fenced code stripped across deltas",
      chunks: ["<think>\n```ts\nliteral ", "</think> still private"],
      expected: [],
    },
    {
      name: "does not carry hidden fenced code state into visible text",
      chunks: ["<think>\n```ts\nscratch", "\n```\n</think>Visible answer"],
      last: { text: "Visible answer" },
    },
    {
      name: "preserves block tag literals inside tilde fenced code split across deltas",
      chunks: ["~~~xml\n", "<thinking>literal</thinking>\n", "~~~"],
      textEnd: "~~~xml\n<thinking>literal</thinking>\n~~~",
      last: { text: "~~~xml\n<thinking>literal</thinking>\n~~~" },
    },
  ] satisfies Array<{
    name: string;
    chunks: string[];
    expected?: Array<Record<string, unknown>>;
    first?: Record<string, unknown>;
    last?: Record<string, unknown>;
    messageEnd?: string;
    textEnd?: string;
    noReplacement?: boolean;
    redacted?: string;
  }>)("$name", (scenario) => {
    const { emit, onAgentEvent } = createAgentEventHarness();
    emit({ type: "message_start", message: { role: "assistant" } });
    for (const chunk of scenario.chunks) {
      emitAssistantTextDelta(emit, chunk);
    }
    if (scenario.textEnd !== undefined) {
      emitAssistantTextEnd(emit, scenario.textEnd);
    }
    if (scenario.messageEnd !== undefined) {
      emit({
        type: "message_end",
        message: {
          role: "assistant",
          content: [{ type: "text", text: scenario.messageEnd }],
        } as AssistantMessage,
      });
    }
    const payloads = extractAgentEventPayloads(onAgentEvent.mock.calls);
    if (scenario.expected !== undefined) {
      expect(payloads).toHaveLength(scenario.expected.length);
      expect(payloads).toMatchObject(scenario.expected);
    }
    if (scenario.first !== undefined) {
      expect(payloads[0]).toMatchObject(scenario.first);
    }
    if (scenario.last !== undefined) {
      expect(payloads.at(-1)).toMatchObject(scenario.last);
    }
    if (scenario.noReplacement) {
      expect(payloads.at(-1)?.replace).toBeUndefined();
    }
    if (scenario.redacted !== undefined) {
      expect(payloads.some((payload) => String(payload.text).includes(scenario.redacted))).toBe(
        false,
      );
    }
  });

  it.each([
    { replyToId: undefined, text: "Corrected", terminal: "text_end" },
    { replyToId: "new-target", text: "Corrected", terminal: "text_end" },
    { replyToId: undefined, text: "Draft", terminal: "text_end" },
    { replyToId: undefined, text: "Corrected", terminal: "message_end" },
    {
      replyToId: undefined,
      text: "Corrected",
      terminal: "message_end",
      priorText: "First block.",
    },
  ])(
    "replaces pending reply directives with authoritative checkpoint target %j",
    async ({ replyToId, text, terminal, priorText = "" }) => {
      const onBlockReply = vi.fn();
      const { emit, subscription } = createSubscribedSessionHarness({
        runId: "run-directive-replacement",
        onBlockReply,
        blockReplyBreak: terminal === "message_end" && !priorText ? "message_end" : "text_end",
        blockReplyChunking:
          terminal === "message_end"
            ? { minChars: 200, maxChars: 200, breakPreference: "sentence" }
            : undefined,
      });
      try {
        emit({ type: "message_start", message: { role: "assistant" } });
        if (priorText) {
          for (const type of ["text_delta", "text_end"] as const) {
            emit(
              createOpenAiResponsesTextEvent({
                type,
                text: priorText,
                id: "prior-answer",
                signaturePhase: "final_answer",
              }),
            );
          }
          await subscription.waitForPendingEvents();
          expect(onBlockReply.mock.calls.map(([reply]) => reply.text)).toEqual([priorText]);
        }
        emit(
          createOpenAiResponsesTextEvent({
            type: "text_delta",
            text: "[[reply_to:old-target]] [[audio_as_voice]] Draft",
            id: "answer",
            signaturePhase: "final_answer",
          }),
        );
        expect(onBlockReply).toHaveBeenCalledTimes(priorText ? 1 : 0);
        const checkpoint = {
          text: `${replyToId ? `[[reply_to:${replyToId}]] ` : ""}${text}`,
          id: "answer",
          signaturePhase: "final_answer" as const,
        };
        if (terminal === "message_end") {
          const message = createOpenAiResponsesPartial(checkpoint);
          if (priorText) {
            message.content.unshift(
              createOpenAiResponsesTextBlock({
                text: priorText,
                id: "prior-answer",
                phase: "final_answer",
              }),
            );
          }
          emit({ type: "message_end", message });
        } else {
          emit(createOpenAiResponsesTextEvent({ type: "text_end", ...checkpoint }));
        }
        await subscription.waitForPendingEvents();

        expect(onBlockReply.mock.calls.map(([reply]) => reply.text)).toEqual(
          priorText ? [priorText, text] : [text],
        );
        const reply = expectDefined(onBlockReply.mock.calls.at(-1)?.[0], "corrected block reply");
        expect({
          text: reply.text,
          replyToId: reply.replyToId,
          replyToTag: Boolean(reply.replyToTag),
          audioAsVoice: Boolean(reply.audioAsVoice),
        }).toEqual({
          text,
          replyToId,
          replyToTag: Boolean(replyToId),
          audioAsVoice: false,
        });
      } finally {
        subscription.unsubscribe();
      }
    },
  );

  it.each([
    { finalText: "First.\nDone.", deferred: true },
    { finalText: "", deferred: false },
  ])(
    "scopes tool-separated assistant snapshots and preserves authoritative final %j after a late block end",
    async ({ finalText, deferred }) => {
      const onAgentEvent = vi.fn();
      const { emit, subscription } = createSubscribedSessionHarness({
        runId: "run",
        onAgentEvent,
        onBeforeTerminalDelivery: deferred ? () => undefined : undefined,
      });
      const assistantPayloads = () =>
        extractAgentEventPayloads(
          onAgentEvent.mock.calls.filter(([event]) => event.stream === "assistant"),
        );
      const block = (text: string, index: number) =>
        createOpenAiResponsesTextBlock({ text, id: `answer-${index}`, phase: "final_answer" });
      const firstBlock = "First block still being revised.";
      const lastBlock = "Second block still being revised.";
      const partial = {
        role: "assistant",
        api: "openai-responses",
        provider: "openai",
        model: "gpt-5.2",
        stopReason: "stop",
        content: [block(firstBlock, 0), block(lastBlock, 1)],
      };

      try {
        emitMessageStartAndEndForAssistantText({ emit, text: "Before tool." });
        emitToolRun({
          emit,
          toolName: "read",
          toolCallId: "read-1",
          args: { path: "notes.txt" },
          isError: false,
          result: { content: [{ type: "text", text: "Read complete." }] },
        });
        await subscription.waitForPendingEvents();

        emit({ type: "message_start", message: { role: "assistant" } });
        for (const [contentIndex, delta] of [firstBlock, lastBlock].entries()) {
          const message = { ...partial, content: partial.content.slice(0, contentIndex + 1) };
          emit({
            type: "message_update",
            message,
            assistantMessageEvent: { type: "text_delta", contentIndex, delta, partial: message },
          });
        }
        const finalMessage = { ...partial, content: finalText.split("\n").map(block) };
        emit({ type: "message_end", message: finalMessage });
        await subscription.waitForPendingEvents();
        if (deferred) {
          expect(assistantPayloads()).toEqual([]);
        }
        emit({ type: "agent_end", messages: [finalMessage] });
        await subscription.waitForPendingEvents();

        const finalizedPayloads = assistantPayloads();
        const firstMessage = expectDefined(
          finalizedPayloads[0],
          "first assistant message snapshot",
        );
        expect(firstMessage).toMatchObject({ text: "Before tool.", itemId: expect.any(String) });
        expect(firstMessage.itemId).not.toBe("");
        const streamed = finalizedPayloads.slice(1, -1);
        expect(streamed.map((payload) => payload.text)).toEqual([
          firstBlock,
          `${firstBlock}\n${lastBlock}`,
        ]);
        const secondItemId = expectDefined(streamed[0], "second message preview").itemId;
        expect(secondItemId).toEqual(expect.any(String));
        expect(secondItemId).not.toBe("");
        expect(secondItemId).not.toBe(firstMessage.itemId);
        expect(streamed.every((payload) => payload.itemId === secondItemId)).toBe(true);
        expect(finalizedPayloads.at(-1)).toMatchObject({ text: finalText, itemId: secondItemId });

        emit({
          type: "message_update",
          message: partial,
          assistantMessageEvent: {
            type: "text_end",
            contentIndex: 1,
            content: lastBlock,
            partial,
          },
        });
        await subscription.waitForPendingEvents();
        expect(assistantPayloads()).toEqual(finalizedPayloads);
        const latestByMessage = new Map(
          assistantPayloads().map((payload) => [payload.itemId, payload.text]),
        );
        expect([...latestByMessage.values()]).toEqual(["Before tool.", finalText]);
      } finally {
        subscription.unsubscribe();
      }
    },
  );

  it.each([
    { firstBlockState: "delivered", firstText: "First answer." },
    { firstBlockState: "buffered", firstText: "First answer." },
    { firstBlockState: "buffered", firstText: "Hello [[" },
  ] as const)(
    "delivers final answer blocks first appearing at message_end after $firstBlockState $firstText",
    async ({ firstBlockState, firstText }) => {
      const onBlockReply = vi.fn();
      const onAgentEvent = vi.fn();
      const { emit, subscription } = createSubscribedSessionHarness({
        runId: "run-terminal-answer-block",
        onBlockReply,
        onAgentEvent,
        blockReplyBreak: "text_end",
        blockReplyChunking: { minChars: 200, maxChars: 200, breakPreference: "sentence" },
      });
      const first = {
        text: firstText,
        id: "first-answer",
        signaturePhase: "final_answer" as const,
      };
      const secondText = "Second answer revealed at completion.";
      const finalText = `${first.text}\n${secondText}`;

      try {
        emit({ type: "message_start", message: { role: "assistant" } });
        emit(createOpenAiResponsesTextEvent({ type: "text_delta", ...first }));
        if (firstBlockState === "delivered") {
          emit(createOpenAiResponsesTextEvent({ type: "text_end", ...first }));
        }
        await subscription.waitForPendingEvents();
        expect(onBlockReply.mock.calls.map(([reply]) => reply.text)).toEqual(
          firstBlockState === "delivered" ? [first.text] : [],
        );

        const message = createOpenAiResponsesPartial(first);
        message.content.push(
          createOpenAiResponsesTextBlock({
            text: secondText,
            id: "second-answer",
            phase: "final_answer",
          }),
        );
        emit({ type: "message_end", message });
        await subscription.waitForPendingEvents();

        expect(onBlockReply.mock.calls.map(([reply]) => reply.text).join("\n")).toBe(finalText);
        expect(subscription.assistantTexts.join("\n")).toBe(finalText);
        const assistantPayloads = extractAgentEventPayloads(
          onAgentEvent.mock.calls.filter(([event]) => event.stream === "assistant"),
        );
        expect(assistantPayloads.at(-1)).toMatchObject({ text: finalText });
      } finally {
        subscription.unsubscribe();
      }
    },
  );

  it("emits agent events on message_end for non-streaming assistant text", () => {
    const { emit, onAgentEvent } = createAgentEventHarness();
    emitMessageStartAndEndForAssistantText({ emit, text: "Hello world" });
    expectSingleAgentEventText(onAgentEvent.mock.calls, "Hello world");
  });

  it("does not emit duplicate agent events when message_end repeats", () => {
    const { emit, onAgentEvent } = createAgentEventHarness();

    const assistantMessage = {
      role: "assistant",
      content: [{ type: "text", text: "Hello world" }],
    } as AssistantMessage;

    emit({ type: "message_start", message: assistantMessage });
    emit({ type: "message_end", message: assistantMessage });
    emit({ type: "message_end", message: assistantMessage });

    const payloads = extractAgentEventPayloads(onAgentEvent.mock.calls);
    expect(payloads).toHaveLength(1);
  });

  it("emits one cleaned media snapshot when a streamed MEDIA line resolves to caption text", () => {
    const { emit, onAgentEvent } = createAgentEventHarness();

    emit({ type: "message_start", message: { role: "assistant" } });
    emitAssistantTextDelta(emit, "MEDIA:");
    emitAssistantTextDelta(emit, " https://example.com/a.png\nCaption");
    emit({
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "MEDIA: https://example.com/a.png\nCaption" }],
      } as AssistantMessage,
    });

    const payloads = extractAgentEventPayloads(onAgentEvent.mock.calls);
    expect(payloads.at(-1)?.text).toBe("Caption");
    expect(payloads.at(-1)?.mediaUrls).toEqual(["https://example.com/a.png"]);
  });

  it("emits agent events when media-only text is finalized", () => {
    const { emit, onAgentEvent } = createAgentEventHarness();

    emit({ type: "message_start", message: { role: "assistant" } });
    emitAssistantTextDelta(emit, "MEDIA: https://example.com/a.png");
    emit({
      type: "message_update",
      message: { role: "assistant" },
      assistantMessageEvent: {
        type: "text_end",
        content: "MEDIA: https://example.com/a.png",
      },
    });
    emit({
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "MEDIA: https://example.com/a.png" }],
      } as AssistantMessage,
    });

    const payloads = extractAgentEventPayloads(onAgentEvent.mock.calls);
    expect(payloads.at(-1)?.text).toBe("");
    expect(payloads.at(-1)?.mediaUrls).toEqual(["https://example.com/a.png"]);
  });

  it("keeps unresolved mutating failure when an unrelated tool succeeds", async () => {
    const { emit, subscription } = createWriteFailureHarness({
      runId: "run-tools-1",
      path: "/tmp/demo.txt",
      content: "next",
    });

    emitToolRun({
      emit,
      toolName: "read",
      toolCallId: "r1",
      args: { path: "/tmp/demo.txt" },
      isError: false,
      result: { text: "ok" },
    });

    await subscription.waitForPendingEvents();
    expect(subscription.getLastToolError()?.toolName).toBe("write");
  });

  it("clears unresolved mutating failure when the same action succeeds", async () => {
    const { emit, subscription } = createWriteFailureHarness({
      runId: "run-tools-2",
      path: "/tmp/demo.txt",
      content: "next",
    });

    emitToolRun({
      emit,
      toolName: "write",
      toolCallId: "w2",
      args: { path: "/tmp/demo.txt", content: "retry" },
      isError: false,
      result: { ok: true },
    });

    await subscription.waitForPendingEvents();
    expect(subscription.getLastToolError()).toBeUndefined();
  });

  it("preserves distinct mutation failures through compaction until each action recovers", async () => {
    const { emit, subscription } = createToolErrorHarness("run-tools-compaction-retry");

    for (const [toolCallId, filePath] of [
      ["write-a-failed", "/tmp/a.txt"],
      ["write-b-failed", "/tmp/b.txt"],
    ] as const) {
      emitToolRun({
        emit,
        toolName: "write",
        toolCallId,
        args: { path: filePath, content: "next" },
        isError: true,
        result: { error: "disk full" },
      });
    }

    emit(retryingCompactionEnd());
    emitToolRun({
      emit,
      toolName: "write",
      toolCallId: "write-b-recovered",
      args: { path: "/tmp/b.txt", content: "retry" },
      isError: false,
      result: { ok: true },
    });

    await subscription.waitForPendingEvents();
    expect(subscription.getLastToolError()).toBeUndefined();

    emitToolRun({
      emit,
      toolName: "write",
      toolCallId: "write-a-recovered",
      args: { path: "/tmp/a.txt", content: "retry" },
      isError: false,
      result: { ok: true },
    });

    await subscription.waitForPendingEvents();
    expect(subscription.getLastToolError()).toBeUndefined();
  });

  it("clears a failure when the same tool succeeds on a different target", async () => {
    const { emit, subscription } = createToolErrorHarness("run-tools-3");

    emitToolRun({
      emit,
      toolName: "write",
      toolCallId: "w1",
      args: { path: "/tmp/a.txt", content: "first" },
      isError: true,
      result: { error: "disk full" },
    });

    emitToolRun({
      emit,
      toolName: "write",
      toolCallId: "w2",
      args: { path: "/tmp/b.txt", content: "second" },
      isError: false,
      result: { ok: true },
    });

    await subscription.waitForPendingEvents();
    expect(subscription.getLastToolError()).toBeUndefined();
  });

  it("emits lifecycle:error event on agent_end when last assistant message was an error", () => {
    const { emit, onAgentEvent } = createAgentEventHarness({
      runId: "run-error",
      sessionKey: "test-session",
    });

    emitAssistantLifecycleErrorAndEnd({
      emit,
      errorMessage: "429 Rate limit exceeded",
    });

    // Look for lifecycle:error event
    const lifecycleError = findLifecycleErrorAgentEvent(onAgentEvent.mock.calls);

    if (!lifecycleError) {
      throw new Error("Expected lifecycle error event");
    }
    const error = (lifecycleError.data as { error?: unknown } | undefined)?.error;
    expect(typeof error).toBe("string");
    expect(error).toContain("API rate limit reached");
  });

  it("reads terminal abort state before emitting lifecycle:end", () => {
    const onAgentEvent = vi.fn();
    let terminalAborted = false;
    const { emit } = createSubscribedSessionHarness({
      runId: "run-aborted",
      sessionKey: "test-session",
      onAgentEvent,
      isTerminalAborted: () => terminalAborted,
    });
    const assistantMessage = {
      api: "test",
      provider: "test",
      model: "test",
      role: "assistant",
      stopReason: "aborted",
      content: [],
      usage: makeZeroUsageSnapshot(),
      timestamp: 0,
    } as AssistantMessage;

    emit({ type: "message_start", message: assistantMessage });
    emit({ type: "message_end", message: assistantMessage });
    terminalAborted = true;
    emit({ type: "agent_end", messages: [assistantMessage] });

    const payloads = extractAgentEventPayloads(onAgentEvent.mock.calls);
    expect(payloads).toContainEqual(
      expect.objectContaining({
        phase: "end",
        stopReason: "aborted",
        aborted: true,
      }),
    );
  });

  it("preserves replay-invalid lifecycle truth across compaction retries after mutating tools", async () => {
    const onAgentEvent = vi.fn();
    const { emit, subscription } = createSubscribedSessionHarness({
      runId: "run-replay-invalid-compaction",
      onAgentEvent,
      sessionKey: "test-session",
    });

    emitToolRun({
      emit,
      toolName: "edit",
      toolCallId: "edit-1",
      args: {
        file_path: "/tmp/demo.txt",
        old_string: "before",
        new_string: "after",
      },
      isError: false,
      result: { ok: true },
    });
    emit(retryingCompactionEnd());
    emit({ type: "agent_end" });
    await subscription.waitForPendingEvents();

    expect(subscription.getReplayState()).toEqual({
      replayInvalid: true,
      hadPotentialSideEffects: true,
    });
    const payloads = extractAgentEventPayloads(onAgentEvent.mock.calls);
    expectLifecyclePayload(payloads, {
      phase: "end",
      livenessState: "abandoned",
      replayInvalid: true,
    });
  });

  it("preserves successful cron evidence and liveness across compaction retries", async () => {
    const onAgentEvent = vi.fn();
    const { emit, subscription } = createSubscribedSessionHarness({
      runId: "run-cron-side-effect-compaction",
      onAgentEvent,
    });

    emitToolRun({
      emit,
      toolName: "cron",
      toolCallId: "cron-1",
      args: { action: "add", job: { name: "reminder" } },
      isError: false,
      result: { details: { status: "ok" } },
    });
    await subscription.waitForPendingEvents();
    expect(subscription.getSuccessfulCronAdds()).toBe(1);
    emit(retryingCompactionEnd());
    await subscription.waitForPendingEvents();
    expect(subscription.isCompacting()).toBe(true);
    expect(subscription.getSuccessfulCronAdds()).toBe(1);
    emit({ type: "agent_end" });

    const payloads = extractAgentEventPayloads(onAgentEvent.mock.calls);
    expectLifecyclePayload(payloads, {
      phase: "end",
      livenessState: "working",
      replayInvalid: true,
    });
  });

  it("preserves accepted session spawn terminal evidence across compaction retries", async () => {
    const onAgentEvent = vi.fn();
    const { emit, subscription } = createSubscribedSessionHarness({
      runId: "run-spawn-side-effect-compaction",
      onAgentEvent,
      sessionKey: "test-session",
    });

    emitToolRun({
      emit,
      toolName: "sessions_spawn",
      toolCallId: "spawn-1",
      args: { prompt: "continue in a child session" },
      isError: false,
      result: {
        details: {
          status: "accepted",
          runId: "run-child",
          childSessionKey: "agent:claude:subagent:child",
          expectsCompletionMessage: true,
        },
      },
    });
    emit(retryingCompactionEnd());
    await subscription.waitForPendingEvents();

    expect(subscription.getAcceptedSessionSpawns()).toEqual([
      {
        runId: "run-child",
        childSessionKey: "agent:claude:subagent:child",
        expectsCompletionMessage: true,
      },
    ]);

    emit({ type: "agent_end" });
    await subscription.waitForPendingEvents();

    const payloads = extractAgentEventPayloads(onAgentEvent.mock.calls);
    expectLifecyclePayload(payloads, {
      phase: "end",
      livenessState: "working",
      replayInvalid: true,
    });
  });

  it("notifies the runner once when a heartbeat response tool result is accepted", async () => {
    const onHeartbeatToolResponse = vi.fn();
    const { emit, subscription } = createSubscribedSessionHarness({
      runId: "run-heartbeat-terminal",
      sessionKey: "agent:main:main",
      onHeartbeatToolResponse,
    });

    const result = {
      details: {
        status: "accepted",
        outcome: "no_change",
        notify: false,
        summary: "Nothing needs attention.",
      },
    };
    emitToolRun({
      emit,
      toolName: HEARTBEAT_RESPONSE_TOOL_NAME,
      toolCallId: "heartbeat-1",
      args: {
        outcome: "no_change",
        notify: false,
        summary: "Nothing needs attention.",
      },
      isError: false,
      result,
    });
    emitToolRun({
      emit,
      toolName: HEARTBEAT_RESPONSE_TOOL_NAME,
      toolCallId: "heartbeat-2",
      args: {
        outcome: "no_change",
        notify: false,
        summary: "Nothing needs attention.",
      },
      isError: false,
      result,
    });
    await subscription.waitForPendingEvents();

    expect(subscription.getHeartbeatToolResponse()).toEqual({
      outcome: "no_change",
      notify: false,
      summary: "Nothing needs attention.",
    });
    expect(onHeartbeatToolResponse).toHaveBeenCalledTimes(1);
    expect(onHeartbeatToolResponse).toHaveBeenCalledWith({
      outcome: "no_change",
      notify: false,
      summary: "Nothing needs attention.",
    });
  });

  describe("flushPartialAssistantText", () => {
    it.each([false, true])(
      "keeps commentary out of timeout flush (final item: %s)",
      (hasFinalAnswer) => {
        const { emit, subscription } = createSubscribedSessionHarness({ runId: "run" });
        emit({ type: "message_start", message: { role: "assistant" } });
        emit(
          createOpenAiResponsesTextEvent({
            type: "text_delta",
            text: "Working...",
            delta: "Working...",
            id: "item-commentary",
            signaturePhase: "commentary",
            partialPhase: "commentary",
          }),
        );
        // A later final-answer item resets the buffer; salvage must never
        // commit commentary, with or without a visible item after it.
        if (hasFinalAnswer) {
          emit(
            createOpenAiResponsesTextEvent({
              type: "text_delta",
              text: "Final answer",
              delta: "Final answer",
              id: "item-final",
              signaturePhase: "final_answer",
              partialPhase: "final_answer",
            }),
          );
        }
        subscription.flushPartialAssistantText();
        expect(subscription.assistantTexts).toEqual(hasFinalAnswer ? ["Final answer"] : []);
      },
    );

    it.each([
      {
        name: "preserves normal visible text",
        chunks: ["Hello ", "world"],
        expected: ["Hello world"],
      },
      {
        name: "strips think tags before committing text",
        chunks: ["Before<think>", " secret", "</think>After"],
        expected: ["BeforeAfter"],
      },
      {
        name: "handles final tags matching enforceFinalTag param",
        enforceFinalTag: true,
        chunks: ["Discarded <final>", "preserved", "</final> also discarded"],
        expected: ["preserved"],
      },
      {
        name: "strips final tags but preserves visible text when enforceFinalTag is disabled",
        // Default policy: final-tag enforcement is off, so the timeout flush
        // must keep the same visible text the normal path would retain and
        // only strip the <final> markers themselves.
        enforceFinalTag: false,
        chunks: ["Discarded <final>", "preserved", "</final> also kept"],
        // Same normalization as normal completion with enforceFinalTag=false:
        // the final-tag markers are stripped, no surrounding visible text is lost.
        expected: ["Discarded preserved also kept"],
      },
      {
        name: "strips downgraded tool call text",
        chunks: ["Visible answer", " [Tool Call: some_fn]"],
        expected: ["Visible answer"],
      },
      {
        name: "is a no-op when deltaBuffer is empty",
        chunks: [],
        expected: [],
      },
      {
        name: "preserves visible prefix before unclosed think tag on flush",
        // Streaming path advances state.blockState.thinking to true on <think>,
        // then a timeout fires before </think>. flushPartialAssistantText must
        // use fresh filter state so "Before " is not treated as hidden content.
        chunks: ["Before ", "<think> reasoning without close"],
        // The visible prefix is preserved (trimEnd removes trailing space).
        expected: ["Before"],
      },
      {
        name: "preserves visible prefix before unclosed final tag on flush",
        enforceFinalTag: true,
        // Same boundary: streaming advances state.blockState.final to true
        // on <final>, then timeout fires. Flush must preserve text inside
        // the unclosed final block and hide text that appeared before <final>.
        chunks: ["Before ", "<final> content without close"],
        // enforceFinalTag hides text before <final>; text inside the
        // unclosed final block is preserved.
        expected: [" content without close"],
      },
    ])("$name", ({ chunks, enforceFinalTag, expected }) => {
      const { emit, subscription } = createSubscribedSessionHarness({
        runId: "run",
        enforceFinalTag,
      });
      if (chunks.length > 0) {
        emit({ type: "message_start", message: { role: "assistant" } });
      }
      for (const chunk of chunks) {
        emitAssistantTextDelta(emit, chunk);
      }
      subscription.flushPartialAssistantText();
      expect(subscription.assistantTexts).toEqual(expected);
    });

    it.each([
      {
        name: "does not re-append text already committed by an earlier flush",
        chunks: ["Hello world"],
        expected: ["Hello world"],
      },
      {
        name: "commits only the queued suffix on a second flush",
        chunks: ["Hello "],
        suffix: "world",
        expected: ["Hello world"],
      },
      {
        name: "retains hidden-tag context across flushes so a queued suffix inside an unclosed think tag never leaks",
        chunks: ["Before ", "<think> reasoning without close"],
        firstExpected: ["Before"],
        suffix: "secret continuation",
        expected: ["Before"],
      },
      {
        name: "replaces a flushed entry when a queued orphan reasoning close retracts the prefix",
        chunks: ["private chain"],
        firstExpected: ["private chain"],
        suffix: "</mm:think>Visible answer",
        expected: ["Visible answer"],
      },
    ])("$name", ({ chunks, firstExpected, suffix, expected }) => {
      const { emit, subscription } = createSubscribedSessionHarness({ runId: "run" });
      emit({ type: "message_start", message: { role: "assistant" } });
      for (const chunk of chunks) {
        emitAssistantTextDelta(emit, chunk);
      }
      subscription.flushPartialAssistantText();
      if (firstExpected) {
        expect(subscription.assistantTexts).toEqual(firstExpected);
      }
      // Updates queued behind abort may extend, hide, or retract the flushed
      // projection. Re-flushing must reconcile it without losing tag context.
      if (suffix) {
        emitAssistantTextDelta(emit, suffix);
      }
      subscription.flushPartialAssistantText();
      expect(subscription.assistantTexts).toEqual(expected);
    });

    it.each([false, true])(
      "reconciles live block chunks without duplication (flush before suffix: %s)",
      (flushBeforeSuffix) => {
        const onBlockReply = vi.fn();
        const { emit, subscription } = createSubscribedSessionHarness({
          runId: "run",
          onBlockReply,
          blockReplyChunking: {
            minChars: 8,
            maxChars: 200,
            breakPreference: "sentence",
          },
        });
        emit({ type: "message_start", message: { role: "assistant" } });
        emitAssistantTextDelta(emit, "Hello world. ");
        if (flushBeforeSuffix) {
          subscription.flushPartialAssistantText();
          expect(subscription.assistantTexts).toEqual(["Hello world."]);
        }
        emitAssistantTextDelta(emit, "Next sentence. ");
        // The live path commits both chunks before the timeout reconciles them.
        expect(subscription.assistantTexts).toEqual(["Hello world.", "Next sentence."]);
        subscription.flushPartialAssistantText();
        expect(subscription.assistantTexts).toEqual(["Hello world. Next sentence."]);
        expect(onBlockReply).toHaveBeenCalled();
      },
    );

    it.each(["Hello world", ""])(
      "replaces flushed partial text with authoritative final %j when message_end arrives",
      (finalText) => {
        const { emit, subscription } = createSubscribedSessionHarness({
          runId: "run",
        });

        emit({ type: "message_start", message: { role: "assistant" } });
        emitAssistantTextDelta(emit, "Hello");
        subscription.flushPartialAssistantText();
        expect(subscription.assistantTexts).toEqual(["Hello"]);

        // The abort raced completion: the authoritative final can replace or
        // withdraw the partial text already committed by timeout salvage.
        emit({
          type: "message_end",
          message: {
            role: "assistant",
            content: [{ type: "text", text: finalText }],
          },
        });

        expect(subscription.assistantTexts).toEqual(finalText ? [finalText] : []);
      },
    );
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
