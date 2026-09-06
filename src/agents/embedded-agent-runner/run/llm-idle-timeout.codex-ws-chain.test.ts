// Full embedded-runner stream wrapper chain around the real Codex Responses
// provider with a mocked WebSocket, proving the idle watchdog polices provider
// silence in the shapes seen live (fresh, cached, and consumer-parked streams).
import { defaultLlmRuntime } from "@openclaw/ai/internal/runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  closeOpenAICodexWebSocketSessions,
  resetOpenAICodexWebSocketStateForTest,
} from "../../../../packages/ai/src/providers/openai-chatgpt-responses.js";
import { createDiagnosticTraceContext } from "../../../infra/diagnostic-trace-context.js";
// Registers built-in providers on the default registry exactly like the runtime does.
import "../../../llm/stream.js";
import type { Model } from "../../../llm/types.js";
import type { StreamFn } from "../../runtime/index.js";
import { UNKNOWN_TOOL_THRESHOLD } from "../../tool-loop-detection.js";
import { wrapStreamFnCodeModeSource } from "../../transcript-code-mode-source.js";
import { resolveEmbeddedAgentStream } from "../stream-resolution.js";
import { wrapStreamFnHandleSensitiveStopReason } from "./attempt-stop-reason-recovery.js";
import { wrapStreamFnTrimToolCallNames } from "./attempt-tool-call-stream-normalization.js";
import { wrapStreamFnPromoteStandaloneTextToolCalls } from "./attempt-tool-call-text-promotion.js";
import { wrapStreamFnWithDiagnosticModelCallEvents } from "./attempt.model-diagnostic-events.js";
import { wrapStreamFnRepairMalformedToolCallArguments } from "./attempt.tool-call-argument-repair.js";
import {
  resolveLlmFirstEventTimeoutMs,
  resolveLlmIdleTimeoutMs,
  streamWithIdleTimeout,
} from "./llm-idle-timeout.js";

function createJwt(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${header}.${body}.signature`;
}

const apiKey = createJwt({ "https://api.openai.com/auth": { chatgpt_account_id: "acct-1" } });

const model = {
  id: "test-codex-model",
  name: "test-codex-model",
  api: "openai-chatgpt-responses",
  provider: "openai",
  baseUrl: "https://chatgpt.com/backend-api/codex",
  reasoning: true,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 372_000,
  maxTokens: 16_000,
} as unknown as Model;

const context = {
  systemPrompt: "You are a test.",
  messages: [{ role: "user", content: "hi", timestamp: 1 }],
} as Parameters<StreamFn>[1];

type Frame = Record<string, unknown>;

class ControlledWebSocket extends EventTarget {
  static instances: ControlledWebSocket[] = [];
  static onSend?: (socket: ControlledWebSocket, payload: string) => void;
  readyState = 1;
  sent: string[] = [];
  closeCalls: Array<[number | undefined, string | undefined]> = [];

  constructor() {
    super();
    ControlledWebSocket.instances.push(this);
    queueMicrotask(() => this.dispatchEvent(new Event("open")));
  }

  send(payload: string): void {
    this.sent.push(payload);
    ControlledWebSocket.onSend?.(this, payload);
  }

  close(code?: number, reason?: string): void {
    this.closeCalls.push([code, reason]);
    this.readyState = 3;
  }

  deliver(frame: Frame): void {
    this.dispatchEvent(Object.assign(new Event("message"), { data: JSON.stringify(frame) }));
  }

  fail(): void {
    this.dispatchEvent(Object.assign(new Event("error"), { message: "WebSocket error" }));
  }
}

function completedFrame(id: string): Frame {
  return {
    type: "response.completed",
    response: {
      id,
      status: "completed",
      output: [],
      usage: { input_tokens: 5, output_tokens: 3, total_tokens: 8 },
    },
  };
}

function buildRunnerChain(params: {
  runId: string;
  sessionId: string;
  runSignal: AbortSignal;
  onIdleTimeout: (error: Error) => void;
  codeMode: boolean;
}): { streamFn: StreamFn; idleTimeoutMs: number; firstEventTimeoutMs: number; strategy: string } {
  const cfg = { agents: { defaults: { timeoutSeconds: 3600 } } };
  const { streamFn: base, strategy } = resolveEmbeddedAgentStream({
    llmRuntime: defaultLlmRuntime,
    currentStreamFn: undefined,
    sessionId: params.sessionId,
    signal: params.runSignal,
    model: model as never,
    resolvedApiKey: apiKey,
    authProfileId: "openai:default",
  });
  const allowed = new Set(["exec", "read"]);
  let streamFn: StreamFn = base;
  streamFn = wrapStreamFnPromoteStandaloneTextToolCalls(streamFn, allowed);
  streamFn = wrapStreamFnTrimToolCallNames(streamFn, allowed, {
    unknownToolThreshold: UNKNOWN_TOOL_THRESHOLD,
  });
  streamFn = wrapStreamFnRepairMalformedToolCallArguments(streamFn);
  streamFn = wrapStreamFnHandleSensitiveStopReason(streamFn);
  const timeoutOptions = {
    cfg,
    runTimeoutMs: undefined,
    modelRequestTimeoutMs: undefined,
    model: { baseUrl: model.baseUrl, id: model.id, provider: model.provider },
  };
  const idleTimeoutMs = resolveLlmIdleTimeoutMs({ ...timeoutOptions, trigger: "user" });
  const firstEventTimeoutMs = resolveLlmFirstEventTimeoutMs(timeoutOptions);
  streamFn = streamWithIdleTimeout(streamFn, idleTimeoutMs, params.onIdleTimeout, {
    runId: params.runId,
  });
  const beforeFirstEvent = streamFn;
  streamFn = (m, c, options) =>
    beforeFirstEvent(m, c, {
      ...options,
      firstEventTimeoutMs,
      onFirstEventTimeout: params.onIdleTimeout,
    } as typeof options);
  let seq = 0;
  streamFn = wrapStreamFnWithDiagnosticModelCallEvents(streamFn, {
    runId: params.runId,
    sessionId: params.sessionId,
    provider: model.provider,
    model: model.id,
    api: model.api,
    transport: "auto",
    requestTimeoutMs: idleTimeoutMs,
    trace: createDiagnosticTraceContext(),
    nextCallId: () => `${params.runId}:model:${(seq += 1)}`,
  });
  if (params.codeMode) {
    streamFn = wrapStreamFnCodeModeSource(streamFn, new Set(["exec"]));
  }
  return { streamFn, idleTimeoutMs, firstEventTimeoutMs, strategy };
}

async function consumeLikeAgentCore(
  streamFn: StreamFn,
  executionSignal: AbortSignal,
  onEvent?: (type: string) => Promise<void> | void,
) {
  const response = await streamFn(model as never, context, {
    apiKey,
    signal: executionSignal,
    asyncToolExecution: true,
  } as Parameters<StreamFn>[2]);
  const events: string[] = [];
  let thrown: unknown;
  try {
    for await (const event of response) {
      events.push(event.type);
      await onEvent?.(event.type);
      if (event.type === "done" || event.type === "error") {
        break;
      }
    }
  } catch (error) {
    // The runner surfaces idle timeouts as a thrown error from next(), not as an event.
    thrown = error;
  }
  const result = thrown ? undefined : await response.result();
  return { events, result, thrown };
}

describe("codex websocket idle watchdog through the embedded runner chain", () => {
  afterEach(() => {
    closeOpenAICodexWebSocketSessions();
    resetOpenAICodexWebSocketStateForTest();
    ControlledWebSocket.instances = [];
    ControlledWebSocket.onSend = undefined;
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it.each([{ codeMode: false }, { codeMode: true }])(
    "A: fresh socket that never sends is aborted at the idle timeout (codeMode=$codeMode)",
    async ({ codeMode }) => {
      vi.useFakeTimers();
      vi.stubGlobal("WebSocket", ControlledWebSocket);
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => new Response("", { status: 500 })),
      );
      const onIdleTimeout = vi.fn();
      const runAbort = new AbortController();
      const { streamFn, idleTimeoutMs, firstEventTimeoutMs, strategy } = buildRunnerChain({
        runId: "run-A",
        sessionId: "session-A",
        runSignal: runAbort.signal,
        onIdleTimeout,
        codeMode,
      });
      expect(strategy).toBe("openclaw-native-codex-responses");
      expect([idleTimeoutMs, firstEventTimeoutMs]).toEqual([120_000, 120_000]);

      const consumed = consumeLikeAgentCore(streamFn, runAbort.signal);
      await vi.advanceTimersByTimeAsync(10);
      const socket = ControlledWebSocket.instances[0];
      expect(socket?.sent).toHaveLength(1);

      await vi.advanceTimersByTimeAsync(119_000);
      expect(onIdleTimeout).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(2_000);
      expect(onIdleTimeout).toHaveBeenCalledTimes(1);
      expect(String(onIdleTimeout.mock.calls[0]?.[0]?.message)).toMatch(
        /idle timeout|first-event timeout/,
      );

      const { events, result, thrown } = await consumed;
      // Idle timeout surfaces as a thrown error from next(); the provider stream is aborted.
      expect(String((thrown as Error | undefined)?.message ?? result?.errorMessage)).toMatch(
        /idle timeout|first-event timeout/,
      );
      // Depending on wrapper ordering the abort surfaces as a throw or as an error event.
      expect(events.length).toBeLessThanOrEqual(1);
      expect(socket?.closeCalls.length).toBeGreaterThan(0);
    },
  );

  it("B: fresh socket that sends one response.created frame then stalls is aborted at the idle timeout", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("WebSocket", ControlledWebSocket);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("", { status: 500 })),
    );
    ControlledWebSocket.onSend = (socket) => {
      queueMicrotask(() =>
        socket.deliver({
          type: "response.created",
          response: { id: "resp_b", status: "in_progress" },
        }),
      );
    };
    const onIdleTimeout = vi.fn();
    const runAbort = new AbortController();
    const { streamFn } = buildRunnerChain({
      runId: "run-B",
      sessionId: "session-B",
      runSignal: runAbort.signal,
      onIdleTimeout,
      codeMode: true,
    });

    const seen: string[] = [];
    const consumed = consumeLikeAgentCore(streamFn, runAbort.signal, (type) => {
      seen.push(type);
    });
    await vi.advanceTimersByTimeAsync(10);
    expect(seen).toEqual(["start"]);

    await vi.advanceTimersByTimeAsync(119_000);
    expect(onIdleTimeout).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(onIdleTimeout).toHaveBeenCalledTimes(1);
    expect(String(onIdleTimeout.mock.calls[0]?.[0]?.message)).toMatch(/idle timeout/);

    const { result, thrown } = await consumed;
    expect(String((thrown as Error | undefined)?.message ?? result?.errorMessage)).toMatch(
      /idle timeout/,
    );
    expect(ControlledWebSocket.instances[0]?.closeCalls.length).toBeGreaterThan(0);
  });

  it("C: cached session socket reused from a previous call, then one frame and a stall, is aborted at the idle timeout", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("WebSocket", ControlledWebSocket);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("", { status: 500 })),
    );
    let call = 0;
    ControlledWebSocket.onSend = (socket) => {
      call += 1;
      const current = call;
      queueMicrotask(() => {
        if (current === 1) {
          socket.deliver({ type: "response.created", response: { id: "resp_1" } });
          socket.deliver(completedFrame("resp_1"));
          return;
        }
        socket.deliver({ type: "response.created", response: { id: "resp_2" } });
      });
    };
    const onIdleTimeout = vi.fn();
    const runAbort = new AbortController();
    const { streamFn } = buildRunnerChain({
      runId: "run-C",
      sessionId: "session-C",
      runSignal: runAbort.signal,
      onIdleTimeout,
      codeMode: true,
    });

    const first = await consumeLikeAgentCore(streamFn, runAbort.signal);
    expect(first.result?.stopReason).toBe("stop");
    expect(ControlledWebSocket.instances).toHaveLength(1);

    const consumed = consumeLikeAgentCore(streamFn, runAbort.signal);
    await vi.advanceTimersByTimeAsync(10);
    // Same socket object reused for the second call.
    expect(ControlledWebSocket.instances).toHaveLength(1);
    expect(ControlledWebSocket.instances[0]?.sent).toHaveLength(2);

    await vi.advanceTimersByTimeAsync(119_000);
    expect(onIdleTimeout).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(onIdleTimeout).toHaveBeenCalledTimes(1);
    const { result, thrown } = await consumed;
    expect(String((thrown as Error | undefined)?.message ?? result?.errorMessage)).toMatch(
      /idle timeout/,
    );
  });

  it("D: consumer parked in emit() after start is still policed by the idle watchdog", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("WebSocket", ControlledWebSocket);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("", { status: 500 })),
    );
    ControlledWebSocket.onSend = (socket) => {
      queueMicrotask(() =>
        socket.deliver({ type: "response.created", response: { id: "resp_d" } }),
      );
    };
    const onIdleTimeout = vi.fn();
    const runAbort = new AbortController();
    const { streamFn } = buildRunnerChain({
      runId: "run-D",
      sessionId: "session-D",
      runSignal: runAbort.signal,
      onIdleTimeout,
      codeMode: true,
    });
    let releaseEmit: (() => void) | undefined;
    const parked = new Promise<void>((resolve) => {
      releaseEmit = resolve;
    });
    const consumed = consumeLikeAgentCore(streamFn, runAbort.signal, async (type) => {
      if (type === "start") {
        await parked;
      }
    });
    await vi.advanceTimersByTimeAsync(10);
    await vi.advanceTimersByTimeAsync(119_000);
    expect(onIdleTimeout).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2_000);
    // The consumer is still parked; the dead socket is aborted anyway.
    expect(onIdleTimeout).toHaveBeenCalledTimes(1);
    expect(String(onIdleTimeout.mock.calls[0]?.[0]?.message)).toMatch(/idle timeout/);
    expect(ControlledWebSocket.instances[0]?.closeCalls.length).toBeGreaterThan(0);

    releaseEmit?.();
    await vi.advanceTimersByTimeAsync(10);
    const { result, thrown } = await consumed;
    expect(String((thrown as Error | undefined)?.message ?? result?.errorMessage)).toMatch(
      /idle timeout|aborted/,
    );
  });

  it("F: frames arriving while the consumer is parked keep the watchdog alive", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("WebSocket", ControlledWebSocket);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("", { status: 500 })),
    );
    ControlledWebSocket.onSend = (socket) => {
      queueMicrotask(() =>
        socket.deliver({ type: "response.created", response: { id: "resp_f" } }),
      );
    };
    const onIdleTimeout = vi.fn();
    const runAbort = new AbortController();
    const { streamFn } = buildRunnerChain({
      runId: "run-F",
      sessionId: "session-F",
      runSignal: runAbort.signal,
      onIdleTimeout,
      codeMode: true,
    });
    let releaseEmit: (() => void) | undefined;
    const parked = new Promise<void>((resolve) => {
      releaseEmit = resolve;
    });
    const consumed = consumeLikeAgentCore(streamFn, runAbort.signal, async (type) => {
      if (type === "start") {
        await parked;
      }
    });
    await vi.advanceTimersByTimeAsync(10);
    const socket = ControlledWebSocket.instances[0];
    // The provider keeps streaming bookkeeping frames every 60s (under the 120s budget).
    const progress = setInterval(() => {
      socket?.deliver({ type: "response.in_progress", response: { id: "resp_f" } });
    }, 60_000);
    await vi.advanceTimersByTimeAsync(300_000);
    clearInterval(progress);
    expect(onIdleTimeout).not.toHaveBeenCalled();

    socket?.deliver(completedFrame("resp_f"));
    releaseEmit?.();
    await vi.advanceTimersByTimeAsync(10);
    const { result, thrown } = await consumed;
    expect(thrown).toBeUndefined();
    expect(result?.stopReason).toBe("stop");
    expect(onIdleTimeout).not.toHaveBeenCalled();
  });
});
