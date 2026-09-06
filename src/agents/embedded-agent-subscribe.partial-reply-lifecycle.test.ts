import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { onAgentEventForRun } from "../infra/agent-events.js";

const logger = vi.hoisted(() => ({
  debug: vi.fn(),
  error: vi.fn(),
  fatal: vi.fn(),
  info: vi.fn(),
  isEnabled: vi.fn(() => false),
  trace: vi.fn(),
  warn: vi.fn(),
}));

vi.mock("../logging/subsystem.js", () => ({
  createSubsystemLogger: () => logger,
}));

import {
  createStubSessionHarness,
  createSubscribedSessionHarness,
  emitAssistantTextDelta,
} from "./embedded-agent-subscribe.e2e-harness.js";
import {
  measureNativeReasoningSubscription,
  NATIVE_REASONING_BENCH_PREFIX,
} from "./embedded-agent-subscribe.native-reasoning.test-support.js";
import { createReplyDelivery } from "./embedded-agent-subscribe.reply-delivery.js";
import { createEmbeddedAgentSubscribeState } from "./embedded-agent-subscribe.run-state.js";
import type { SubscribeEmbeddedAgentSessionParams } from "./embedded-agent-subscribe.types.js";

function createDelivery(params: Omit<SubscribeEmbeddedAgentSessionParams, "session">) {
  const { session } = createStubSessionHarness();
  const options = { ...params, session };
  return createReplyDelivery({
    params: options,
    state: createEmbeddedAgentSubscribeState(options),
    log: logger,
  });
}

function emitPartialThenProviderFailure(emit: (event: unknown) => void): void {
  emit({
    type: "message_update",
    message: { role: "assistant" },
    assistantMessageEvent: { type: "text_delta", delta: "partial answer" },
  });
  const failedAssistant = {
    role: "assistant",
    content: [{ type: "text", text: "partial answer" }],
    stopReason: "error",
    errorMessage: "provider failed after partial",
    provider: "test-provider",
    model: "test-model",
  };
  emit({ type: "message_end", message: failedAssistant });
  emit({ type: "agent_end", messages: [failedAssistant], willRetry: false });
}

describe("subscribeEmbeddedAgentSession partial reply lifecycle", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("joins a partial reply task created while terminal events settle", async () => {
    let resolvePartial: (() => void) | undefined;
    const onPartialReply = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolvePartial = resolve;
        }),
    );
    const { emit, subscription } = createSubscribedSessionHarness({
      runId: "run-partial-provider-failure",
      onBeforeTerminalDelivery: async () => undefined,
      onPartialReply,
    });

    emitPartialThenProviderFailure(emit);
    let settled = false;
    const settlement = subscription.waitForPendingEvents().then(() => {
      settled = true;
    });

    await vi.waitFor(() => expect(onPartialReply).toHaveBeenCalledOnce());
    await Promise.resolve();
    expect(settled).toBe(false);

    resolvePartial?.();
    await settlement;
    expect(settled).toBe(true);
  });

  it("contains and logs a rejected partial reply after unsubscribe", async () => {
    const callbackError = new Error("draft send rejected");
    let rejectPartial: ((reason: unknown) => void) | undefined;
    const onPartialReply = vi.fn(
      () =>
        new Promise<void>((_resolve, reject) => {
          rejectPartial = reject;
        }),
    );
    const { emit, subscription } = createSubscribedSessionHarness({
      runId: "run-partial-rejection",
      onPartialReply,
    });

    emit({
      type: "message_update",
      message: { role: "assistant" },
      assistantMessageEvent: { type: "text_delta", delta: "partial answer" },
    });

    await vi.waitFor(() => expect(onPartialReply).toHaveBeenCalledOnce());
    emitAssistantTextDelta({ emit, delta: " queued" });
    emitAssistantTextDelta({ emit, delta: " tail" });
    await subscription.waitForPendingEvents({ includePartialReplies: false });
    expect(onPartialReply).toHaveBeenCalledOnce();
    subscription.unsubscribe();
    rejectPartial?.(callbackError);
    await expect(subscription.waitForPendingEvents()).resolves.toBeUndefined();
    expect(logger.warn).toHaveBeenCalledWith(
      `assistant partial reply callback failed: ${String(callbackError)}`,
    );
    expect(onPartialReply).toHaveBeenCalledOnce();
  });

  it("queue-only drain coalesces a stalled partial and joins its latest successor", async () => {
    const first = createDeferred();
    const latest = createDeferred();
    const onPartialReply = vi.fn(() => latest.promise).mockImplementationOnce(() => first.promise);
    const onAgentEvent = vi.fn();
    const { emit, subscription } = createSubscribedSessionHarness({
      runId: "run-stalled-partial-callback",
      onPartialReply,
      onAgentEvent,
    });
    try {
      for (const delta of ["First", " second", " third"]) {
        emitAssistantTextDelta({ emit, delta });
      }
      let broadDrained = false;
      const broadDrain = subscription.waitForPendingEvents().then(() => {
        broadDrained = true;
      });
      // Timeout salvage joins only handlers that mutate the raw text buffer.
      await subscription.waitForPendingEvents({ includePartialReplies: false });
      expect(broadDrained).toBe(false);
      expect(onPartialReply).toHaveBeenCalledOnce();
      expect(onPartialReply).toHaveBeenLastCalledWith(
        expect.objectContaining({ text: "First", delta: "First" }),
      );
      const assistantEvents = onAgentEvent.mock.calls.filter(
        ([event]) => event.stream === "assistant",
      );
      expect(assistantEvents).toHaveLength(3);

      first.resolve();
      await vi.waitFor(() => expect(onPartialReply).toHaveBeenCalledTimes(2));
      expect(onPartialReply).toHaveBeenLastCalledWith(
        expect.objectContaining({ text: "First second third", delta: " second third" }),
      );
      expect(broadDrained).toBe(false);
      latest.resolve();
      await broadDrain;
      expect(broadDrained).toBe(true);
    } finally {
      first.resolve();
      latest.resolve();
      subscription.unsubscribe();
      await subscription.waitForPendingEvents();
    }
  });

  it.each(["provider", "nested"] as const)(
    "starts the latest partial before a %s tool without waiting for a stalled send",
    async (source) => {
      const pending = createDeferred();
      const starts: string[] = [];
      const { emit, subscription } = createSubscribedSessionHarness({
        runId: `run-partial-${source}-tool`,
        onPartialReply: (payload) => {
          starts.push(`partial:${payload.text}`);
          return pending.promise;
        },
        onAgentEvent: (event) => {
          if (event.stream === "tool" && event.data.phase === "start") {
            starts.push("tool");
          }
        },
      });
      try {
        for (const delta of ["First", " second", " third"]) {
          emitAssistantTextDelta({ emit, delta });
        }
        await subscription.waitForPendingEvents({ includePartialReplies: false });
        expect(starts).toEqual(["partial:First"]);
        const tool = {
          toolName: "read",
          toolCallId: "read-after-text",
          args: { path: "/tmp/input" },
        };
        if (source === "provider") {
          emit({ type: "tool_execution_start", ...tool });
        } else {
          await subscription.runToolLifecycle({
            ...tool,
            execute: async (onStart) => {
              onStart();
              return { content: [{ type: "text", text: "Read complete." }] };
            },
          });
        }
        await subscription.waitForPendingEvents({ includePartialReplies: false });
        expect(starts).toEqual(["partial:First", "partial:First second third", "tool"]);
        emitAssistantTextDelta({ emit, delta: " fourth" });
        await subscription.waitForPendingEvents({ includePartialReplies: false });
        expect(starts.at(-1)).toBe("partial:First second third fourth");
      } finally {
        pending.resolve();
        subscription.unsubscribe();
        await subscription.waitForPendingEvents();
      }
    },
  );

  it("preserves both delta domains when a retired callback reenters an unemitted scope", async () => {
    const first = createDeferred();
    const partials: Array<{ text?: string; delta?: string }> = [];
    const bus: Array<{ text: unknown; delta: unknown }> = [];
    let canReenter = false;
    const delivery: ReturnType<typeof createReplyDelivery> = createDelivery({
      runId: "run-partial-reentrant-phase",
      onAgentEvent: (event) => {
        if (event.stream === "assistant") {
          bus.push({ text: event.data.text, delta: event.data.delta });
        }
      },
      onPartialReply: (payload) => {
        partials.push({ text: payload.text, delta: payload.delta });
        if (payload.text === "A") {
          return first.promise;
        }
        if (payload.text === "AB" && canReenter) {
          delivery.emitAssistantStreamData(
            { text: "ABCD", delta: "D", phase: "final_answer" },
            { emitPartialReply: true },
          );
        }
        return undefined;
      },
    });
    try {
      delivery.emitAssistantStreamData({ text: "A", delta: "A" }, { emitPartialReply: true });
      delivery.emitAssistantStreamData({ text: "AB", delta: "B" }, { emitPartialReply: true });
      expect(partials).toEqual([{ text: "A", delta: "A" }]);
      canReenter = true;
      delivery.emitAssistantStreamData(
        { text: "ABC", delta: "C", phase: "final_answer" },
        { emitPartialReply: true },
      );
      expect(partials).toEqual([
        { text: "A", delta: "A" },
        { text: "AB", delta: "B" },
        { text: "ABCD", delta: "CD" },
      ]);
      expect(bus).toEqual(partials);
    } finally {
      first.resolve();
      await delivery.waitForPendingEvents();
    }
  });

  it("keeps reasoning deltas coherent when partial delivery reenters", async () => {
    const pending = createDeferred();
    const runId = "run-reasoning-reentrant-partial";
    const bus: Array<{ text: unknown; delta: unknown }> = [];
    const off = onAgentEventForRun(runId, (event) => {
      if (event.stream === "thinking") {
        bus.push({ text: event.data.text, delta: event.data.delta });
      }
    });
    let calls = 0;
    const { emit, subscription } = createSubscribedSessionHarness({
      runId,
      onPartialReply: () => {
        calls++;
        if (calls === 1) {
          return pending.promise;
        }
        if (calls === 2) {
          emitThinking("AX", "X");
        }
        return undefined;
      },
    });
    function emitThinking(thinking: string, delta: string): void {
      const message = { role: "assistant", content: [{ type: "thinking", thinking }] };
      emit({
        type: "message_update",
        message,
        assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta, partial: message },
      });
    }
    try {
      emit({ type: "message_start", message: { role: "assistant", content: [] } });
      emitThinking("A", "A");
      for (const delta of ["a", "b", "<think>AB"]) {
        emitAssistantTextDelta({ emit, delta });
      }
      expect(calls).toBe(2);
      expect(bus).toEqual([
        { text: "A", delta: "A" },
        { text: "AX", delta: "X" },
        { text: "AB", delta: "AB" },
      ]);
    } finally {
      pending.resolve();
      subscription.unsubscribe();
      await subscription.waitForPendingEvents();
      off();
    }
  });

  it("starts the first partial once before a reentrant block reply", async () => {
    const starts: string[] = [];
    const delivery: ReturnType<typeof createReplyDelivery> = createDelivery({
      runId: "run-partial-reentrant-block",
      onAgentEvent: (event) => {
        if (event.stream === "assistant") {
          delivery.emitBlockReply({ text: "Block." });
        }
      },
      onPartialReply: (payload) => {
        starts.push(`partial:${payload.text}`);
      },
      onBlockReply: (payload) => {
        starts.push(`block:${payload.text}`);
      },
    });
    delivery.emitAssistantStreamData({ text: "First", delta: "First" }, { emitPartialReply: true });
    await delivery.waitForPendingEvents();
    expect(starts).toEqual(["partial:First", "block:Block."]);
  });

  it.each([
    { name: "append", text: "Hello world", delta: " world", replace: undefined },
    { name: "correct", text: "Hi", delta: "", replace: true },
    { name: "clear", text: "", delta: "", replace: true },
  ])(
    "publishes an authoritative $name with normalized final media",
    async ({ text, delta, replace }) => {
      const onAgentEvent = vi.fn();
      const { emit, subscription } = createSubscribedSessionHarness({
        runId: `run-final-media-${text.length}`,
        onAgentEvent,
      });
      emitAssistantTextDelta({ emit, delta: "Hello" });
      emit({
        type: "message_end",
        message: {
          role: "assistant",
          content: [
            {
              type: "text",
              text: `${text}\nMEDIA:https://example.com/a.png`,
              textSignature: JSON.stringify({ v: 1, id: "answer", phase: "final_answer" }),
            },
          ],
        },
      });
      await subscription.waitForPendingEvents();
      const final = onAgentEvent.mock.calls.findLast(([event]) => event.stream === "assistant")?.[0]
        .data;
      expect(final?.text).toBe(text);
      expect(final?.delta).toBe(delta);
      expect(final?.replace).toBe(replace);
      expect(final?.mediaUrls).toEqual(["https://example.com/a.png"]);
      expect(final?.managedMediaUrls).toBeUndefined();
      expect(final?.phase).toBe("final_answer");
      subscription.unsubscribe();
    },
  );
  it.each([
    { name: "empty", text: "", preambles: 0 },
    { name: "sanitized empty", text: "<think>hidden reasoning</think>", preambles: 0 },
    { name: "duplicate", text: "Working.", preambles: 1 },
  ])(
    "retires pending partials at a $name generic commentary boundary",
    async ({ text, preambles }) => {
      const pending = createDeferred();
      const partials: Array<{ text?: string; delta?: string }> = [];
      const onAgentEvent = vi.fn();
      const { emit, subscription } = createSubscribedSessionHarness({
        runId: `run-commentary-boundary-${preambles}-${text.length}`,
        onAgentEvent,
        onPartialReply: (payload) => {
          partials.push({ text: payload.text, delta: payload.delta });
          return pending.promise;
        },
      });
      const message = {
        role: "assistant",
        content: [
          {
            type: "text",
            text,
            textSignature: JSON.stringify({ v: 1, id: "commentary", phase: "commentary" }),
          },
        ],
      };
      const commentary = {
        type: "message_update",
        message,
        assistantMessageEvent: { type: "text_delta", delta: "", partial: message },
      };
      try {
        emit(commentary);
        for (const delta of ["First", " second", " third"]) {
          emitAssistantTextDelta({ emit, delta });
        }
        await subscription.waitForPendingEvents({ includePartialReplies: false });
        expect(partials).toEqual([{ text: "First", delta: "First" }]);

        // Phase changes retire the old partial even if no new preamble is visible.
        emit(commentary);
        await subscription.waitForPendingEvents({ includePartialReplies: false });
        expect(partials).toEqual([
          { text: "First", delta: "First" },
          { text: "First second third", delta: " second third" },
        ]);
        emitAssistantTextDelta({ emit, delta: " fourth" });
        await subscription.waitForPendingEvents({ includePartialReplies: false });
        expect(partials.at(-1)).toEqual({
          text: "First second third fourth",
          delta: " fourth",
        });
        const preambleEvents = onAgentEvent.mock.calls.filter(
          ([event]) => event.stream === "item" && event.data.kind === "preamble",
        );
        expect(preambleEvents).toHaveLength(preambles);
      } finally {
        pending.resolve();
        subscription.unsubscribe();
        await subscription.waitForPendingEvents();
      }
    },
  );
});

describe("native reasoning projection", () => {
  it.for([
    { name: "trailing whitespace", chunks: ["a ", "b"] },
    { name: "whitespace-only chunk", chunks: ["abc", " ", "def"] },
    { name: "whitespace-only reasoning", chunks: ["  ", " ", "\n"] },
    { name: "leading and trailing whitespace", chunks: ["  ", "a  ", "b ", "  ", "c"] },
  ])("preserves $name through transport and subscription", async ({ chunks }, { signal }) => {
    const measurement = await measureNativeReasoningSubscription({ chunks, signal });
    expect(measurement.textMatches).toBe(true);
    expect(measurement.deltaMatches).toBe(true);
  });

  it("does not rescan the growing reasoning prefix on every provider delta", async ({ signal }) => {
    const runId = "native-reasoning-prefix-work";
    const probe = vi.spyOn(String.prototype, "startsWith");
    let comparedPrefixChars = 0;
    const collectPrefixWork = () => {
      for (const [index, [search, position]] of probe.mock.calls.entries()) {
        const text = probe.mock.contexts[index];
        if (
          typeof text === "string" &&
          typeof search === "string" &&
          (position ?? 0) === 0 &&
          text.slice(0, NATIVE_REASONING_BENCH_PREFIX.length) === NATIVE_REASONING_BENCH_PREFIX &&
          search.length > NATIVE_REASONING_BENCH_PREFIX.length
        ) {
          comparedPrefixChars += search.length;
        }
      }
      // Keeping every argument would itself retain all historical prefixes.
      probe.mockClear();
    };
    const off = onAgentEventForRun(runId, collectPrefixWork);
    try {
      const measurement = await measureNativeReasoningSubscription({ signal, runId });
      collectPrefixWork();
      console.log("native-reasoning-work", JSON.stringify({ ...measurement, comparedPrefixChars }));
      expect(measurement.textMatches).toBe(true);
      expect(measurement.deltaMatches).toBe(true);
      expect(measurement.events).toBe(measurement.chunks);
      expect(comparedPrefixChars).toBeLessThan(measurement.chars * 4);
    } finally {
      off();
      probe.mockRestore();
    }
  });
});
