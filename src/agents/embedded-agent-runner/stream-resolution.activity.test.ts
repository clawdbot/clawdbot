import { getEventListeners } from "node:events";
import {
  defaultLlmRuntime,
  notifyLlmRequestActivity,
  onLlmRequestActivity,
} from "@openclaw/ai/internal/runtime";
import {
  createAssistantMessageEventStream,
  type AssistantMessageEventStream,
} from "openclaw/plugin-sdk/llm";
import { createRequireRecord } from "openclaw/plugin-sdk/test-fixtures";
import { afterEach, describe, expect, it, vi } from "vitest";
import { streamWithIdleTimeout } from "./run/llm-idle-timeout.js";
import { resolveEmbeddedAgentStream } from "./stream-resolution.js";

const model = {
  api: "openai-completions",
  provider: "openai",
  id: "gpt-5.4",
} as never;
const requireRecord = createRequireRecord("record", "expected-label-object");

function resolveProviderStream(
  providerStreamFn: Parameters<typeof resolveEmbeddedAgentStream>[0]["providerStreamFn"],
  runSignal: AbortSignal,
) {
  return resolveEmbeddedAgentStream({
    llmRuntime: defaultLlmRuntime,
    currentStreamFn: undefined,
    providerStreamFn,
    sessionId: "session-1",
    signal: runSignal,
    model,
  }).streamFn;
}

afterEach(() => {
  vi.useRealTimers();
});

describe("embedded provider stream activity", () => {
  it("keeps provider request activity reaching the caller signal after the run signal merge", async () => {
    const providerStreamFn = vi.fn(async (_model, _context, options) => options);
    const runController = new AbortController();
    const callerController = new AbortController();
    const streamFn = resolveProviderStream(providerStreamFn, runController.signal);
    const result = requireRecord(
      await streamFn(model, {} as never, { signal: callerController.signal }),
      "merged activity signal result",
    );
    const mergedSignal = result.signal as AbortSignal;
    expect(mergedSignal).not.toBe(callerController.signal);

    const onCallerActivity = vi.fn();
    const unsubscribe = onLlmRequestActivity(callerController.signal, onCallerActivity);
    try {
      notifyLlmRequestActivity(mergedSignal);
      expect(onCallerActivity).toHaveBeenCalledTimes(1);

      runController.abort();
      notifyLlmRequestActivity(mergedSignal);
      expect(onCallerActivity).toHaveBeenCalledTimes(1);
    } finally {
      unsubscribe();
    }
  });

  it("does not retain completed provider streams on a reused caller signal", async () => {
    const requestSignals: AbortSignal[] = [];
    const providerStreamFn = vi.fn(
      (_model: unknown, _context: unknown, options?: { signal?: AbortSignal }) => {
        if (!options?.signal) {
          throw new Error("expected a composed provider request signal");
        }
        requestSignals.push(options.signal);
        const stream = createAssistantMessageEventStream();
        stream.push({ type: "text_delta", contentIndex: 0, delta: "done" });
        stream.end({
          role: "assistant",
          content: [{ type: "text", text: "done" }],
          api: "openai-completions",
          provider: "openai",
          model: "gpt-5.4",
          usage: {
            input: 1,
            output: 1,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 2,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
          stopReason: "stop",
          timestamp: 1,
        });
        return stream;
      },
    );
    const runController = new AbortController();
    const callerController = new AbortController();
    const streamFn = resolveProviderStream(providerStreamFn as never, runController.signal);
    const initialListenerCount = getEventListeners(callerController.signal, "abort").length;
    const onCallerActivity = vi.fn();
    const unsubscribe = onLlmRequestActivity(callerController.signal, onCallerActivity);

    try {
      for (let turn = 0; turn < 2; turn += 1) {
        const stream = streamFn(model, {} as never, {
          signal: callerController.signal,
        }) as AssistantMessageEventStream;
        const requestSignal = requestSignals[turn];
        expect(requestSignal).toBeDefined();
        notifyLlmRequestActivity(requestSignal);
        expect(onCallerActivity).toHaveBeenCalledTimes(turn + 1);

        const events = [];
        for await (const event of stream) {
          events.push(event);
        }
        expect(events).toEqual([{ type: "text_delta", contentIndex: 0, delta: "done" }]);
        await expect(stream.result()).resolves.toMatchObject({
          stopReason: "stop",
          content: [{ type: "text", text: "done" }],
        });
        expect(getEventListeners(callerController.signal, "abort")).toHaveLength(
          initialListenerCount,
        );
      }
      expect(requestSignals[0]).not.toBe(requestSignals[1]);
    } finally {
      unsubscribe();
    }
  });

  it("does not bridge provider request activity from a pre-aborted run", async () => {
    const providerStreamFn = vi.fn(async (_model, _context, options) => options);
    const runController = new AbortController();
    const callerController = new AbortController();
    runController.abort();
    const streamFn = resolveProviderStream(providerStreamFn, runController.signal);
    const result = requireRecord(
      await streamFn(model, {} as never, { signal: callerController.signal }),
      "pre-aborted merged activity signal result",
    );
    const mergedSignal = result.signal as AbortSignal;
    expect(mergedSignal).toMatchObject({ aborted: true });

    const onCallerActivity = vi.fn();
    const unsubscribe = onLlmRequestActivity(callerController.signal, onCallerActivity);
    try {
      notifyLlmRequestActivity(mergedSignal);
      expect(onCallerActivity).not.toHaveBeenCalled();
    } finally {
      unsubscribe();
    }
  });

  it("keeps the idle watchdog armed when a merged run signal turn only reports hidden progress", async () => {
    vi.useFakeTimers();
    const runController = new AbortController();
    let requestSignal: AbortSignal | undefined;
    const providerStreamFn = vi.fn(
      (_model: unknown, _context: unknown, options?: { signal?: AbortSignal }) => {
        requestSignal = options?.signal;
        const stream = createAssistantMessageEventStream();
        setTimeout(() => {
          stream.push({ type: "text_delta", contentIndex: 0, delta: "done" });
        }, 120);
        return stream;
      },
    );
    const streamFn = resolveProviderStream(providerStreamFn as never, runController.signal);
    const guarded = streamWithIdleTimeout(streamFn, 50);
    const stream = guarded(model, {} as never, {} as never) as AssistantMessageEventStream;
    const iterator = stream[Symbol.asyncIterator]();
    const next = iterator.next();

    setTimeout(() => notifyLlmRequestActivity(requestSignal), 40);
    setTimeout(() => notifyLlmRequestActivity(requestSignal), 80);
    await vi.advanceTimersByTimeAsync(120);

    await expect(next).resolves.toEqual({
      done: false,
      value: { type: "text_delta", contentIndex: 0, delta: "done" },
    });
    await iterator.return?.();
  });
});
