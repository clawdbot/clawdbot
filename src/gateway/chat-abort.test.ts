import { afterEach, describe, expect, it, vi } from "vitest";
import {
  abortChatRunById,
  abortChatRunsForProvider,
  isChatStopCommandText,
  type ChatAbortOps,
  type ChatAbortControllerEntry,
  updateChatRunProvider,
} from "./chat-abort.js";

type ChatAbortPayload = {
  runId: string;
  sessionKey: string;
  seq: number;
  state: "aborted";
  stopReason?: string;
  message?: {
    role: "assistant";
    content: Array<{ type: "text"; text: string }>;
    timestamp: number;
  };
};

afterEach(() => {
  vi.useRealTimers();
});

function createActiveEntry(sessionKey: string): ChatAbortControllerEntry {
  const now = Date.now();
  return {
    controller: new AbortController(),
    sessionId: "sess-1",
    sessionKey,
    startedAtMs: now,
    expiresAtMs: now + 10_000,
  };
}

function createOps(params: {
  runId: string;
  entry: ChatAbortControllerEntry;
  buffer?: string;
}): ChatAbortOps & {
  broadcast: ReturnType<typeof vi.fn>;
  nodeSendToSession: ReturnType<typeof vi.fn>;
  removeChatRun: ReturnType<typeof vi.fn>;
} {
  const { runId, entry, buffer } = params;
  const broadcast = vi.fn();
  const nodeSendToSession = vi.fn();
  const removeChatRun = vi.fn();

  return {
    chatAbortControllers: new Map([[runId, entry]]),
    chatRunBuffers: new Map(buffer !== undefined ? [[runId, buffer]] : []),
    chatDeltaSentAt: new Map([[runId, Date.now()]]),
    chatDeltaLastBroadcastLen: new Map([[runId, buffer?.length ?? 0]]),
    chatDeltaLastBroadcastText: new Map(buffer !== undefined ? [[runId, buffer]] : []),
    agentDeltaSentAt: new Map([[`${runId}:assistant`, Date.now()]]),
    bufferedAgentEvents: new Map([
      [
        `${runId}:assistant`,
        {
          payload: {
            runId,
            seq: 1,
            stream: "assistant",
            ts: Date.now(),
            data: { text: "buffer", delta: "buffer" },
          },
        },
      ],
    ]),
    chatAbortedRuns: new Map(),
    removeChatRun,
    agentRunSeq: new Map(),
    broadcast,
    nodeSendToSession,
  };
}

function firstBroadcastPayload(ops: { broadcast: ReturnType<typeof vi.fn> }): unknown {
  const call = ops.broadcast.mock.calls[0];
  if (!call) {
    throw new Error("expected broadcast call");
  }
  return call[1];
}

describe("isChatStopCommandText", () => {
  it("matches slash and standalone multilingual stop forms", () => {
    expect(isChatStopCommandText(" /STOP!!! ")).toBe(true);
    expect(isChatStopCommandText("stop please")).toBe(true);
    expect(isChatStopCommandText("do not do that")).toBe(true);
    expect(isChatStopCommandText("停止")).toBe(true);
    expect(isChatStopCommandText("やめて")).toBe(true);
    expect(isChatStopCommandText("توقف")).toBe(true);
    expect(isChatStopCommandText("остановись")).toBe(true);
    expect(isChatStopCommandText("halt")).toBe(true);
    expect(isChatStopCommandText("stopp")).toBe(true);
    expect(isChatStopCommandText("pare")).toBe(true);
    expect(isChatStopCommandText("/status")).toBe(false);
    expect(isChatStopCommandText("please do not do that")).toBe(false);
    expect(isChatStopCommandText("keep going")).toBe(false);
  });
});

describe("abortChatRunById", () => {
  it("broadcasts aborted payload with partial message when buffered text exists", () => {
    const now = new Date("2026-01-02T03:04:05.000Z");
    vi.useFakeTimers();
    vi.setSystemTime(now);
    const runId = "run-1";
    const sessionKey = "main";
    const entry = createActiveEntry(sessionKey);
    const ops = createOps({ runId, entry, buffer: "  Partial reply  " });
    ops.agentRunSeq.set(runId, 2);
    ops.agentRunSeq.set("client-run-1", 4);
    ops.removeChatRun.mockReturnValue({ sessionKey, clientRunId: "client-run-1" });

    const result = abortChatRunById(ops, { runId, sessionKey, stopReason: "user" });

    expect(result).toEqual({ aborted: true });
    expect(entry.controller.signal.aborted).toBe(true);
    expect(ops.chatAbortControllers.has(runId)).toBe(false);
    expect(ops.chatRunBuffers.has(runId)).toBe(false);
    expect(ops.chatDeltaSentAt.has(runId)).toBe(false);
    expect(ops.chatDeltaLastBroadcastLen.has(runId)).toBe(false);
    expect(ops.chatDeltaLastBroadcastText.has(runId)).toBe(false);
    expect(ops.agentDeltaSentAt?.has(`${runId}:assistant`)).toBe(false);
    expect(ops.bufferedAgentEvents?.has(`${runId}:assistant`)).toBe(false);
    expect(ops.removeChatRun).toHaveBeenCalledWith(runId, runId, sessionKey);
    expect(ops.agentRunSeq.has(runId)).toBe(false);
    expect(ops.agentRunSeq.has("client-run-1")).toBe(false);

    expect(ops.broadcast).toHaveBeenCalledTimes(1);
    const payload = firstBroadcastPayload(ops) as ChatAbortPayload;
    expect(payload).toEqual({
      runId,
      sessionKey,
      seq: 3,
      state: "aborted",
      stopReason: "user",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "  Partial reply  " }],
        timestamp: now.getTime(),
      },
    });
    expect(ops.nodeSendToSession).toHaveBeenCalledWith(sessionKey, "chat", payload);
  });

  it("omits aborted message when buffered text is empty", () => {
    const runId = "run-1";
    const sessionKey = "main";
    const entry = createActiveEntry(sessionKey);
    const ops = createOps({ runId, entry, buffer: "   " });

    const result = abortChatRunById(ops, { runId, sessionKey });

    expect(result).toEqual({ aborted: true });
    const payload = firstBroadcastPayload(ops) as Record<string, unknown>;
    expect(payload.message).toBeUndefined();
  });

  it("preserves partial message even when abort listeners clear buffers synchronously", () => {
    const now = new Date("2026-01-02T03:04:05.000Z");
    vi.useFakeTimers();
    vi.setSystemTime(now);
    const runId = "run-1";
    const sessionKey = "main";
    const entry = createActiveEntry(sessionKey);
    const ops = createOps({ runId, entry, buffer: "streamed text" });

    // Simulate synchronous cleanup triggered by AbortController listeners.
    entry.controller.signal.addEventListener("abort", () => {
      ops.chatRunBuffers.delete(runId);
    });

    const result = abortChatRunById(ops, { runId, sessionKey });

    expect(result).toEqual({ aborted: true });
    const payload = firstBroadcastPayload(ops) as ChatAbortPayload;
    expect(payload).toEqual({
      runId,
      sessionKey,
      seq: 1,
      state: "aborted",
      stopReason: undefined,
      message: {
        role: "assistant",
        content: [{ type: "text", text: "streamed text" }],
        timestamp: now.getTime(),
      },
    });
  });
});

describe("abortChatRunsForProvider", () => {
  it("uses updated provider metadata after model fallback", () => {
    const runId = "run-1";
    const sessionKey = "main";
    const entry = createActiveEntry(sessionKey);
    entry.providerId = "openai";
    entry.authProviderId = "openai";
    const ops = createOps({ runId, entry });

    const updated = updateChatRunProvider(ops.chatAbortControllers, {
      runId,
      providerId: "openrouter",
      authProviderId: "openrouter",
    });
    const result = abortChatRunsForProvider(ops, {
      providerId: "openrouter",
      stopReason: "auth-revoked",
    });

    expect(updated).toBe(true);
    expect(result.runIds).toEqual([runId]);
    expect(entry.controller.signal.aborted).toBe(true);
    expect(ops.broadcast).toHaveBeenCalledWith(
      "chat",
      expect.objectContaining({
        runId,
        state: "aborted",
        stopReason: "auth-revoked",
      }),
    );
  });
});
