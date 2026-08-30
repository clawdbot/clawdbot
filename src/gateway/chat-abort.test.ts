// Chat abort tests protect in-flight run tracking, stop-command parsing, provider
// abort fanout, history snapshots, and cleanup of buffered streaming state.
import { afterEach, describe, expect, it, vi } from "vitest";
import { isAgentRunRestartAbortReason } from "../agents/run-termination.js";
import { onAgentEvent } from "../infra/agent-events.js";
import { clearAgentRunContext, registerAgentRunContext } from "../infra/agent-run-registry.js";
import { jsonUtf8Bytes } from "../infra/json-utf8-bytes.js";
import {
  abortChatRunById,
  abortChatRunsForProvider,
  boundInFlightRunSnapshotForChatHistory,
  isChatStopCommandText,
  registerChatAbortController,
  resolveAgentRunExpiresAtMs,
  resolveChatRunExpiresAtMs,
  type ChatAbortOps,
  resolveInFlightRunSnapshot,
  updateChatRunProvider,
} from "./chat-abort.js";
import type { ChatAbortControllerEntry } from "./chat-abort.types.js";
import { createChatRunState, type ChatRunPlanSnapshot } from "./server-chat-state.js";

type ChatAbortPayload = {
  runId: string;
  sessionKey: string;
  agentId?: string;
  seq: number;
  state: "aborted";
  stopReason?: string;
  errorMessage?: string;
  message?: {
    role: "assistant";
    content: Array<{ type: "text"; text: string }>;
    timestamp: number;
  };
};

type CreatedChatAbortOps = ChatAbortOps & {
  broadcast: ReturnType<typeof vi.fn>;
  nodeSendToSession: ReturnType<typeof vi.fn>;
  removeChatRun: ReturnType<typeof vi.fn>;
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
}): CreatedChatAbortOps {
  const { runId, entry, buffer } = params;
  const broadcast = vi.fn();
  const nodeSendToSession = vi.fn();
  const removeChatRun = vi.fn();
  const chatRunState = createChatRunState();
  Object.assign(chatRunState.getOrCreate(runId), {
    ...(buffer !== undefined ? { buffer, deltaLastBroadcastText: buffer } : {}),
    deltaSentAt: Date.now(),
    assistantScope: { itemId: "assistant-1", prefix: "" },
    agentText: {
      assistant: {
        lastSentAt: Date.now(),
        bufferedEvent: {
          payload: {
            runId,
            seq: 1,
            stream: "assistant",
            ts: Date.now(),
            data: { text: "buffer", delta: "buffer" },
          },
        },
      },
    },
  });

  return {
    chatAbortControllers: new Map([[runId, entry]]),
    chatRunState,
    removeChatRun,
    agentRunSeq: new Map(),
    broadcast,
    nodeSendToSession,
  };
}

function createAbortRunFixture(params: {
  runId?: string;
  sessionKey?: string;
  entry?: ChatAbortControllerEntry;
  buffer?: string;
  now?: Date;
}): {
  runId: string;
  sessionKey: string;
  entry: ChatAbortControllerEntry;
  ops: CreatedChatAbortOps;
} {
  const runId = params.runId ?? "run-1";
  const sessionKey = params.sessionKey ?? "main";
  if (params.now) {
    vi.useFakeTimers();
    vi.setSystemTime(params.now);
  }
  const entry = params.entry ?? createActiveEntry(sessionKey);
  const ops = createOps({ runId, entry, buffer: params.buffer });
  return { runId, sessionKey, entry, ops };
}

function firstBroadcastPayload(ops: { broadcast: ReturnType<typeof vi.fn> }): unknown {
  const call = ops.broadcast.mock.calls[0];
  if (!call) {
    throw new Error("expected broadcast call");
  }
  return call[1];
}

function expectRunAborted(params: {
  result: ReturnType<typeof abortChatRunById>;
  entry: ChatAbortControllerEntry;
  ops: ChatAbortOps;
  runId: string;
}): void {
  expect(params.result).toEqual({ aborted: true });
  expect(params.entry.controller.signal.aborted).toBe(true);
  expect(params.ops.chatAbortControllers.has(params.runId)).toBe(false);
}

describe("isChatStopCommandText", () => {
  it("matches slash and standalone multilingual stop forms", () => {
    expect(isChatStopCommandText(" /STOP!!! ")).toBe(true);
    expect(isChatStopCommandText("stop please")).toBe(true);
    expect(isChatStopCommandText("do not do that")).toBe(true);
    expect(isChatStopCommandText("停止")).toBe(true);
    expect(isChatStopCommandText("停下来")).toBe(true);
    expect(isChatStopCommandText("暂停")).toBe(true);
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

describe("registerChatAbortController", () => {
  it("expires registrations immediately when the process clock is invalid", () => {
    const chatAbortControllers = new Map<string, ChatAbortControllerEntry>();
    const registration = registerChatAbortController({
      chatAbortControllers,
      runId: "run-invalid-clock",
      sessionId: "sess-1",
      sessionKey: "main",
      timeoutMs: 60_000,
      now: Number.NaN,
    });

    expect(registration.registered).toBe(true);
    expect(registration.entry).toMatchObject({
      startedAtMs: 0,
      expiresAtMs: 0,
    });
    expect(chatAbortControllers.get("run-invalid-clock")?.expiresAtMs).toBe(0);
  });

  it("expires registrations immediately when explicit expiry is invalid", () => {
    const chatAbortControllers = new Map<string, ChatAbortControllerEntry>();
    const registration = registerChatAbortController({
      chatAbortControllers,
      runId: "run-invalid-expiry",
      sessionId: "sess-1",
      sessionKey: "main",
      timeoutMs: 60_000,
      now: 1_800_000_000_000,
      expiresAtMs: Number.POSITIVE_INFINITY,
    });

    expect(registration.entry?.expiresAtMs).toBe(0);
  });

  it("bounds default and agent run expiry calculations to valid Date timestamps", () => {
    expect(resolveChatRunExpiresAtMs({ now: Number.NaN, timeoutMs: 60_000 })).toBe(0);
    expect(resolveChatRunExpiresAtMs({ now: 8_640_000_000_000_000, timeoutMs: 60_000 })).toBe(0);
    expect(resolveAgentRunExpiresAtMs({ now: Number.NaN, timeoutMs: 60_000 })).toBe(0);
  });

  it("records hidden/internal visibility for agent registrations", () => {
    const chatAbortControllers = new Map<string, ChatAbortControllerEntry>();
    const registration = registerChatAbortController({
      chatAbortControllers,
      runId: "run-internal-agent",
      sessionId: "sess-1",
      sessionKey: "main",
      timeoutMs: 60_000,
      controlUiVisible: false,
      kind: "agent",
    });

    expect(registration.entry).toMatchObject({
      controlUiVisible: false,
      kind: "agent",
    });
    expect(chatAbortControllers.get("run-internal-agent")?.controlUiVisible).toBe(false);
  });

  it("re-arms agent expiry from execution admission exactly once", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_800_000_000_000);
    const chatAbortControllers = new Map<string, ChatAbortControllerEntry>();
    const registration = registerChatAbortController({
      chatAbortControllers,
      runId: "run-queued-agent",
      sessionId: "sess-1",
      sessionKey: "main",
      timeoutMs: 120_000,
      kind: "agent",
    });
    const startedAtMs = registration.entry?.startedAtMs;

    vi.advanceTimersByTime(90_000);
    registration.markExecutionStarted();
    const executionExpiresAtMs = resolveAgentRunExpiresAtMs({
      now: Date.now(),
      timeoutMs: 120_000,
    });

    expect(registration.entry?.startedAtMs).toBe(startedAtMs);
    expect(registration.entry?.expiresAtMs).toBe(executionExpiresAtMs);

    vi.advanceTimersByTime(30_000);
    registration.markExecutionStarted();
    expect(registration.entry?.expiresAtMs).toBe(executionExpiresAtMs);
  });

  it("does not re-arm an agent after its unswept queue deadline", () => {
    vi.useFakeTimers();
    for (const [runId, offsetMs] of [
      ["run-agent-at-queue-deadline", 0],
      ["run-agent-after-queue-deadline", 1],
    ] as const) {
      vi.setSystemTime(1_800_000_000_000);
      const chatAbortControllers = new Map<string, ChatAbortControllerEntry>();
      const registration = registerChatAbortController({
        chatAbortControllers,
        runId,
        sessionId: "sess-1",
        sessionKey: "main",
        timeoutMs: 120_000,
        kind: "agent",
      });
      const queueExpiresAtMs = registration.entry?.expiresAtMs;
      const startedAtMs = registration.entry?.startedAtMs;
      expect(queueExpiresAtMs).toBeTypeOf("number");

      vi.setSystemTime((queueExpiresAtMs as number) + offsetMs);
      registration.markExecutionStarted();
      registration.markExecutionStarted();

      expect(registration.entry?.startedAtMs).toBe(startedAtMs);
      expect(registration.entry?.expiresAtMs).toBe(queueExpiresAtMs);
      expect(registration.controller.signal.aborted).toBe(false);
    }
  });

  it("does not re-arm stale, aborted, or non-agent registrations", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_800_000_000_000);

    const staleControllers = new Map<string, ChatAbortControllerEntry>();
    const stale = registerChatAbortController({
      chatAbortControllers: staleControllers,
      runId: "run-stale",
      sessionId: "sess-1",
      sessionKey: "main",
      timeoutMs: 60_000,
      kind: "agent",
    });
    const staleExpiry = stale.entry?.expiresAtMs;
    staleControllers.delete("run-stale");

    const abortedControllers = new Map<string, ChatAbortControllerEntry>();
    const aborted = registerChatAbortController({
      chatAbortControllers: abortedControllers,
      runId: "run-aborted",
      sessionId: "sess-1",
      sessionKey: "main",
      timeoutMs: 60_000,
      kind: "agent",
    });
    const abortedExpiry = aborted.entry?.expiresAtMs;
    aborted.controller.abort();

    const chatControllers = new Map<string, ChatAbortControllerEntry>();
    const chat = registerChatAbortController({
      chatAbortControllers: chatControllers,
      runId: "run-chat",
      sessionId: "sess-1",
      sessionKey: "main",
      timeoutMs: 60_000,
      kind: "chat-send",
    });
    const chatExpiry = chat.entry?.expiresAtMs;

    vi.advanceTimersByTime(30_000);
    stale.markExecutionStarted();
    aborted.markExecutionStarted();
    chat.markExecutionStarted();

    expect(stale.entry?.expiresAtMs).toBe(staleExpiry);
    expect(aborted.entry?.expiresAtMs).toBe(abortedExpiry);
    expect(chat.entry?.expiresAtMs).toBe(chatExpiry);
  });

  it("retains completed registrations until terminal persistence succeeds", async () => {
    const chatAbortControllers = new Map<string, ChatAbortControllerEntry>();
    const onRemoved = vi.fn();
    const registration = registerChatAbortController({
      chatAbortControllers,
      runId: "run-persisting",
      sessionId: "sess-1",
      sessionKey: "main",
      timeoutMs: 60_000,
      onRemoved,
    });
    let resolvePersistence: () => void = () => undefined;
    const persistence = new Promise<void>((resolve) => {
      resolvePersistence = resolve;
    });
    if (!registration.entry) {
      throw new Error("expected registered entry");
    }
    registration.entry.projectSessionActive = false;
    registration.entry.projectSessionTerminalPersistence = persistence;

    registration.cleanup();

    expect(chatAbortControllers.has("run-persisting")).toBe(true);
    expect(onRemoved).not.toHaveBeenCalled();
    resolvePersistence();
    await persistence;
    await Promise.resolve();
    expect(chatAbortControllers.has("run-persisting")).toBe(false);
    expect(onRemoved).toHaveBeenCalledTimes(1);
  });

  it("retains registrations when terminal lifecycle was observed before caller cleanup", () => {
    const chatAbortControllers = new Map<string, ChatAbortControllerEntry>();
    const registration = registerChatAbortController({
      chatAbortControllers,
      runId: "run-awaiting-terminal",
      sessionId: "sess-1",
      sessionKey: "main",
      timeoutMs: 60_000,
    });

    if (!registration.entry) {
      throw new Error("expected registered entry");
    }
    registration.entry.projectSessionTerminalPending = true;
    registration.cleanup();

    expect(chatAbortControllers.has("run-awaiting-terminal")).toBe(true);
    expect(registration.entry?.registrationCleanupRequested).toBe(true);
  });

  it("force-cleans registrations when dispatch fails before lifecycle starts", () => {
    const chatAbortControllers = new Map<string, ChatAbortControllerEntry>();
    const registration = registerChatAbortController({
      chatAbortControllers,
      runId: "run-before-dispatch",
      sessionId: "sess-1",
      sessionKey: "main",
      timeoutMs: 60_000,
    });

    registration.cleanup({ force: true });

    expect(chatAbortControllers.has("run-before-dispatch")).toBe(false);
  });
});

describe("abortChatRunById", () => {
  it("notifies the run-bound approval owner only after an active run abort wins", () => {
    const { runId, sessionKey, ops } = createAbortRunFixture({});
    const onRunAborted = vi.fn();
    ops.onRunAborted = onRunAborted;

    expect(abortChatRunById(ops, { runId: "other-run", sessionKey })).toEqual({
      aborted: false,
    });
    expect(onRunAborted).not.toHaveBeenCalled();

    expect(abortChatRunById(ops, { runId, sessionKey, stopReason: "user" })).toEqual({
      aborted: true,
    });
    expect(onRunAborted).toHaveBeenCalledOnce();
    expect(onRunAborted).toHaveBeenCalledWith(runId);
  });

  it("retains terminal persistence ownership observed during abort", () => {
    const { runId, sessionKey, entry, ops } = createAbortRunFixture({});
    let terminalEvents = 0;
    const unsubscribe = onAgentEvent((event) => {
      if (event.runId === runId && event.stream === "lifecycle" && event.data.phase === "end") {
        terminalEvents += 1;
        entry.projectSessionTerminalPending = true;
        entry.projectSessionTerminalObservedAt = event.ts;
      }
    });

    try {
      const result = abortChatRunById(ops, { runId, sessionKey, stopReason: "user" });

      expect(result).toEqual({ aborted: true });
      expect(entry.controller.signal.aborted).toBe(true);
      expect(entry.projectSessionActive).toBe(false);
      expect(entry.registrationCleanupRequested).toBe(true);
      expect(entry.projectSessionTerminalPending).toBe(true);
      expect(entry.projectSessionTerminalObservedAt).toEqual(expect.any(Number));
      expect(ops.chatAbortControllers.get(runId)).toBe(entry);

      expect(abortChatRunById(ops, { runId, sessionKey, stopReason: "user" })).toEqual({
        aborted: false,
      });
      expect(terminalEvents).toBe(1);
      expect(ops.broadcast).toHaveBeenCalledOnce();
      expect(ops.removeChatRun).toHaveBeenCalledOnce();
    } finally {
      unsubscribe();
    }
  });

  it("preserves the owning session identity when synchronous abort cleanup clears run context", () => {
    const { runId, sessionKey, entry, ops } = createAbortRunFixture({
      runId: "run-pre-reset-abort",
    });
    registerAgentRunContext(runId, { sessionKey, sessionId: entry.sessionId });
    entry.controller.signal.addEventListener("abort", () => clearAgentRunContext(runId));
    const events: Array<{ sessionId?: string }> = [];
    const unsubscribe = onAgentEvent((event) => {
      if (event.runId === runId && event.stream === "lifecycle") {
        events.push({ sessionId: event.sessionId });
      }
    });

    try {
      expect(abortChatRunById(ops, { runId, sessionKey, stopReason: "rpc" })).toEqual({
        aborted: true,
      });
      expect(events).toEqual([{ sessionId: entry.sessionId }]);
    } finally {
      unsubscribe();
      clearAgentRunContext(runId);
    }
  });

  it("broadcasts aborted payload with partial message when buffered text exists", () => {
    const now = new Date("2026-01-02T03:04:05.000Z");
    const { runId, sessionKey, entry, ops } = createAbortRunFixture({
      buffer: "  Partial reply  ",
      now,
    });
    ops.agentRunSeq.set(runId, 2);
    ops.agentRunSeq.set("client-run-1", 4);
    ops.removeChatRun.mockReturnValue({ sessionKey, clientRunId: "client-run-1" });

    const result = abortChatRunById(ops, { runId, sessionKey, stopReason: "user" });

    expectRunAborted({ result, entry, ops, runId });
    expect(ops.chatRunState.runs.get(runId)?.buffer).toBeUndefined();
    expect(ops.chatRunState.runs.get(runId)?.deltaSentAt).toBeUndefined();
    expect(ops.chatRunState.runs.get(runId)?.assistantScope).toBeUndefined();
    expect(ops.chatRunState.runs.get(runId)?.deltaLastBroadcastText).toBeUndefined();
    expect(ops.chatRunState.runs.get(runId)?.agentText).toBeUndefined();
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

  it("includes the active run's safe validation diagnostic", () => {
    const runId = "run-validation-abort";
    const sessionKey = "main";
    const entry = {
      ...createActiveEntry(sessionKey),
      toolErrorSummary: "edit tool validation failed: edits: must be an array",
    };
    const ops = createOps({ runId, entry });

    abortChatRunById(ops, { runId, sessionKey, stopReason: "user" });

    expect(firstBroadcastPayload(ops)).toMatchObject({
      runId,
      state: "aborted",
      errorMessage: "edit tool validation failed: edits: must be an array",
    });
  });

  it("preserves finalizing runs when the owning reply operation rejects aborts", () => {
    const { runId, sessionKey, entry, ops } = createAbortRunFixture({
      buffer: "completed reply",
      entry: {
        ...createActiveEntry("main"),
        isAbortable: () => false,
      },
    });

    const result = abortChatRunById(ops, { runId, sessionKey, stopReason: "user" });

    expect(result).toEqual({ aborted: false });
    expect(entry.controller.signal.aborted).toBe(false);
    expect(ops.chatAbortControllers.get(runId)).toBe(entry);
    expect(ops.chatRunState.runs.get(runId)?.buffer).toBe("completed reply");
    expect(ops.chatRunState.runs.get(runId)?.abortMarker).toBeUndefined();
    expect(ops.removeChatRun).not.toHaveBeenCalled();
    expect(ops.broadcast).not.toHaveBeenCalled();
    expect(ops.nodeSendToSession).not.toHaveBeenCalled();
  });

  it("aborts hidden internal runs without broadcasting chat events", () => {
    const sessionKey = "main";
    const { runId, entry, ops } = createAbortRunFixture({
      runId: "run-hidden",
      sessionKey,
      entry: { ...createActiveEntry(sessionKey), controlUiVisible: false },
      buffer: "hidden partial",
    });

    const result = abortChatRunById(ops, { runId, sessionKey, stopReason: "timeout" });

    expectRunAborted({ result, entry, ops, runId });
    expect(ops.broadcast).not.toHaveBeenCalled();
    expect(ops.nodeSendToSession).not.toHaveBeenCalled();
  });

  for (const testCase of [
    {
      name: "fans out default-agent global aborts to scoped and legacy global subscribers",
      runId: "run-main-global",
      createEntry: () => ({ ...createActiveEntry("global"), agentId: "main" }),
      abort: abortChatRunById,
    },
    {
      name: "resolves unscoped global aborts to the default agent subscribers",
      runId: "run-unscoped-global",
      createEntry: () => createActiveEntry("global"),
      abort: abortChatRunById,
    },
    {
      name: "preserves default-agent global delivery through tracked maintenance aborts",
      runId: "run-tracked-global",
      createEntry: () => ({ ...createActiveEntry("global"), agentId: "main" }),
      abort: abortChatRunById,
    },
  ]) {
    it(testCase.name, () => {
      const ops = createOps({ runId: testCase.runId, entry: testCase.createEntry() });
      ops.getRuntimeConfig = () => ({ agents: { list: [{ id: "main", default: true }] } });

      const result = testCase.abort(ops, { runId: testCase.runId, sessionKey: "global" });

      expect(result).toEqual({ aborted: true });
      const payload = firstBroadcastPayload(ops) as ChatAbortPayload;
      expect(payload.agentId).toBe("main");
      const delivery = { sessionKeys: ["agent:main:global", "global"] };
      expect(ops.broadcast).toHaveBeenCalledWith("chat", payload, delivery);
      expect(ops.nodeSendToSession).toHaveBeenCalledWith("agent:main:global", "chat", payload);
      expect(ops.nodeSendToSession).toHaveBeenCalledWith("global", "chat", payload);
    });
  }

  it("tags maintenance timeouts as timeout abort reasons", () => {
    const runId = "run-timeout";
    const sessionKey = "main";
    const entry = createActiveEntry(sessionKey);
    const ops = createOps({ runId, entry });

    const result = abortChatRunById(ops, { runId, sessionKey, stopReason: "timeout" });

    expect(result).toEqual({ aborted: true });
    expect(entry.abortStopReason).toBe("timeout");
    expect(entry.controller.signal.aborted).toBe(true);
    expect(entry.controller.signal.reason).toBeInstanceOf(Error);
    expect((entry.controller.signal.reason as Error).name).toBe("TimeoutError");
  });

  it("tags restart abort signals with a restart-specific reason", () => {
    const runId = "run-restart";
    const sessionKey = "main";
    const entry = createActiveEntry(sessionKey);
    const ops = createOps({ runId, entry });

    const result = abortChatRunById(ops, { runId, sessionKey, stopReason: "restart" });

    expect(result).toEqual({ aborted: true });
    expect(isAgentRunRestartAbortReason(entry.controller.signal.reason)).toBe(true);
  });

  it("preserves partial message even when abort listeners clear buffers synchronously", () => {
    const now = new Date("2026-01-02T03:04:05.000Z");
    const { runId, sessionKey, entry, ops } = createAbortRunFixture({
      buffer: "streamed text",
      now,
    });

    // Simulate synchronous cleanup triggered by AbortController listeners.
    entry.controller.signal.addEventListener("abort", () => {
      delete ops.chatRunState.runs.get(runId)?.buffer;
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
      cfg: { agents: { list: [{ id: "main" }, { id: "writer" }] } },
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
      { sessionKeys: [sessionKey] },
    );
  });

  it("derives missing entry agent ids from canonical session keys", () => {
    const writerEntry = createActiveEntry("agent:writer:main");
    writerEntry.providerId = "openrouter";
    const mainEntry = createActiveEntry("agent:main:main");
    mainEntry.providerId = "openrouter";
    const ops = createOps({ runId: "run-writer", entry: writerEntry });
    ops.chatAbortControllers.set("run-main", mainEntry);

    const result = abortChatRunsForProvider(ops, {
      cfg: { agents: { list: [{ id: "main" }, { id: "writer" }] } },
      providerId: "openrouter",
      agentId: "writer",
      stopReason: "auth-revoked",
    });

    expect(result.runIds).toEqual(["run-writer"]);
    expect(writerEntry.controller.signal.aborted).toBe(true);
    expect(mainEntry.controller.signal.aborted).toBe(false);
  });
});

describe("resolveInFlightRunSnapshot", () => {
  const inFlightEntry = (
    sessionKey: string,
    opts?: {
      agentId?: string;
      aborted?: boolean;
      controlUiVisible?: boolean;
      projectSessionActive?: boolean;
      startedAtMs?: number;
      kind?: ChatAbortControllerEntry["kind"];
    },
  ): ChatAbortControllerEntry => {
    const now = Date.now();
    const controller = new AbortController();
    if (opts?.aborted) {
      controller.abort();
    }
    const startedAtMs = opts?.startedAtMs ?? now;
    return {
      controller,
      sessionId: "sess-1",
      sessionKey,
      agentId: opts?.agentId,
      startedAtMs,
      expiresAtMs: startedAtMs + 10_000,
      controlUiVisible: opts?.controlUiVisible,
      projectSessionActive: opts?.projectSessionActive ?? true,
      kind: opts?.kind,
    };
  };

  // Most cases request with requestedKey === canonicalKey; default canonical to
  // the requested key unless a case exercises the requested/canonical split.
  const resolveSnap = (p: {
    chatAbortControllers: Map<string, ChatAbortControllerEntry>;
    chatRunBuffers: Map<string, string>;
    chatRunPlanSnapshots?: Map<string, ChatRunPlanSnapshot>;
    sessionKey: string;
    canonicalSessionKey?: string;
    agentId?: string;
    defaultAgentId?: string;
  }) => {
    const chatRunState = createChatRunState();
    for (const [runId, buffer] of p.chatRunBuffers ?? []) {
      chatRunState.getOrCreate(runId).buffer = buffer;
    }
    for (const [runId, plan] of p.chatRunPlanSnapshots ?? []) {
      chatRunState.getOrCreate(runId).planSnapshot = plan;
    }
    return resolveInFlightRunSnapshot({
      chatAbortControllers: p.chatAbortControllers,
      chatRunState,
      requestedSessionKey: p.sessionKey,
      canonicalSessionKey: p.canonicalSessionKey ?? p.sessionKey,
      agentId: p.agentId,
      defaultAgentId: p.defaultAgentId,
    });
  };
  const snap = (p: Parameters<typeof resolveSnap>[0]) => {
    const result = resolveSnap(p);
    if (result) {
      Reflect.deleteProperty(result, "startedAt");
    }
    return result;
  };

  it("returns live assistant text with the authoritative run start timestamp", () => {
    const result = resolveSnap({
      chatAbortControllers: new Map([["run-1", inFlightEntry("s", { startedAtMs: 1_234 })]]),
      chatRunBuffers: new Map([["run-1", "partial answer so far"]]),
      sessionKey: "s",
    });
    expect(result).toEqual({ runId: "run-1", text: "partial answer so far", startedAt: 1_234 });
  });

  it("returns the active run plan snapshot with buffered text", () => {
    const plan = {
      explanation: "Current work",
      steps: [{ step: "Implement replay", status: "in_progress" as const }],
    };
    expect(
      snap({
        chatAbortControllers: new Map([["run-1", inFlightEntry("agent:main:s")]]),
        chatRunBuffers: new Map([["run-1", "partial"]]),
        chatRunPlanSnapshots: new Map([["run-1", plan]]),
        sessionKey: "agent:main:s",
      }),
    ).toEqual({ runId: "run-1", text: "partial", plan });
  });

  it("returns an explicit empty plan snapshot for dismissal", () => {
    expect(
      snap({
        chatAbortControllers: new Map([["run-1", inFlightEntry("agent:main:s")]]),
        chatRunBuffers: new Map(),
        chatRunPlanSnapshots: new Map([["run-1", { steps: [] }]]),
        sessionKey: "agent:main:s",
      }),
    ).toEqual({ runId: "run-1", text: "", plan: { steps: [] } });
  });

  it("is a no-op when chatAbortControllers is not a Map (unpopulated context)", () => {
    expect(
      snap({
        chatAbortControllers: undefined as never,
        chatRunBuffers: undefined as never,
        sessionKey: "agent:main:s",
      }),
    ).toBeUndefined();
  });

  it("matches a run stored under the canonical key when requested with a different key", () => {
    // Abort entry holds the canonical store key; the client requests history with
    // a different (requested) key for the same logical session.
    const result = snap({
      chatAbortControllers: new Map([["run-1", inFlightEntry("agent:main:main")]]),
      chatRunBuffers: new Map([["run-1", "partial"]]),
      sessionKey: "main",
      canonicalSessionKey: "agent:main:main",
    });
    expect(result).toEqual({ runId: "run-1", text: "partial" });
  });

  it("ignores aborted, completed (not projected active), and other-session runs", () => {
    const variants: ChatAbortControllerEntry[] = [
      inFlightEntry("agent:main:s", { aborted: true }),
      inFlightEntry("agent:main:s", { projectSessionActive: false }),
      inFlightEntry("agent:main:s", { controlUiVisible: false }),
      inFlightEntry("agent:main:other"),
    ];
    for (const entry of variants) {
      expect(
        snap({
          chatAbortControllers: new Map([["run", entry]]),
          chatRunBuffers: new Map([["run", "text"]]),
          sessionKey: "agent:main:s",
        }),
      ).toBeUndefined();
    }
  });

  it("ignores hidden agent runs that are not visible chat sends", () => {
    expect(
      snap({
        chatAbortControllers: new Map([
          ["run-agent", inFlightEntry("agent:main:s", { kind: "agent" })],
        ]),
        chatRunBuffers: new Map([["run-agent", "hidden partial"]]),
        sessionKey: "agent:main:s",
      }),
    ).toBeUndefined();
  });

  it("treats an entry with undefined projectSessionActive as active (sessions.list contract)", () => {
    const entry = inFlightEntry("agent:main:s");
    delete (entry as { projectSessionActive?: boolean }).projectSessionActive;
    expect(
      snap({
        chatAbortControllers: new Map([["run", entry]]),
        chatRunBuffers: new Map([["run", "live partial"]]),
        sessionKey: "agent:main:s",
      }),
    ).toEqual({ runId: "run", text: "live partial" });
  });

  it("returns an active run with empty text (Codex streams no incremental text mid-run)", () => {
    expect(
      snap({
        chatAbortControllers: new Map([["run", inFlightEntry("agent:main:s")]]),
        chatRunBuffers: new Map(),
        sessionKey: "agent:main:s",
      }),
    ).toEqual({ runId: "run", text: "" });
  });

  it("does not surface suppressed control-token lead fragments from the live buffer", () => {
    expect(
      snap({
        chatAbortControllers: new Map([["run", inFlightEntry("agent:main:s")]]),
        chatRunBuffers: new Map([["run", "NO_"]]),
        sessionKey: "agent:main:s",
      }),
    ).toEqual({ runId: "run", text: "" });
  });

  it("scopes the shared global session by agent so one agent's run is not restored into another", () => {
    const controllers = new Map<string, ChatAbortControllerEntry>([
      ["run-a", inFlightEntry("global", { agentId: "main" })],
      ["run-b", inFlightEntry("global", { agentId: "work" })],
    ]);
    const buffers = new Map([
      ["run-a", "main agent global text"],
      ["run-b", "work agent global text"],
    ]);
    expect(
      snap({
        chatAbortControllers: controllers,
        chatRunBuffers: buffers,
        sessionKey: "global",
        agentId: "work",
      }),
    ).toEqual({ runId: "run-b", text: "work agent global text" });
    expect(
      snap({
        chatAbortControllers: controllers,
        chatRunBuffers: buffers,
        sessionKey: "global",
        agentId: "main",
      }),
    ).toEqual({ runId: "run-a", text: "main agent global text" });
  });

  it("resolves bare global history snapshots to the default agent", () => {
    const controllers = new Map<string, ChatAbortControllerEntry>([
      ["run-main", inFlightEntry("global", { agentId: "main", startedAtMs: 1_000 })],
      ["run-work", inFlightEntry("global", { agentId: "work", startedAtMs: 2_000 })],
    ]);
    const buffers = new Map([
      ["run-main", "main default text"],
      ["run-work", "work global text"],
    ]);

    expect(
      snap({
        chatAbortControllers: controllers,
        chatRunBuffers: buffers,
        sessionKey: "global",
        defaultAgentId: "main",
      }),
    ).toEqual({ runId: "run-main", text: "main default text" });
  });

  it("prefers the newest startedAtMs when several runs match the same session+agent", () => {
    // A fast restart/retry/stale-controller race can leave two active entries for
    // the same key; selection must not depend on Map insertion order. Insert the
    // older run first so a first-match selector would return the wrong one.
    const controllers = new Map<string, ChatAbortControllerEntry>([
      ["run-old", inFlightEntry("agent:main:s", { startedAtMs: 1_000 })],
      ["run-new", inFlightEntry("agent:main:s", { startedAtMs: 2_000 })],
    ]);
    const buffers = new Map([
      ["run-old", "stale partial"],
      ["run-new", "current partial"],
    ]);
    expect(
      snap({
        chatAbortControllers: controllers,
        chatRunBuffers: buffers,
        sessionKey: "agent:main:s",
      }),
    ).toEqual({ runId: "run-new", text: "current partial" });
  });

  it("breaks startedAtMs ties deterministically by runId regardless of insertion order", () => {
    const buffers = new Map([
      ["run-a", "a"],
      ["run-b", "b"],
    ]);
    const ascending = new Map<string, ChatAbortControllerEntry>([
      ["run-a", inFlightEntry("agent:main:s", { startedAtMs: 5_000 })],
      ["run-b", inFlightEntry("agent:main:s", { startedAtMs: 5_000 })],
    ]);
    const descending = new Map<string, ChatAbortControllerEntry>([
      ["run-b", inFlightEntry("agent:main:s", { startedAtMs: 5_000 })],
      ["run-a", inFlightEntry("agent:main:s", { startedAtMs: 5_000 })],
    ]);
    // Same winner ("run-b" > "run-a") no matter which order the map was built in.
    expect(
      snap({
        chatAbortControllers: ascending,
        chatRunBuffers: buffers,
        sessionKey: "agent:main:s",
      }),
    ).toEqual({ runId: "run-b", text: "b" });
    expect(
      snap({
        chatAbortControllers: descending,
        chatRunBuffers: buffers,
        sessionKey: "agent:main:s",
      }),
    ).toEqual({ runId: "run-b", text: "b" });
  });

  it("keeps in-flight text and plan when they fit the chat history budget", () => {
    const plan = {
      steps: [{ step: "Keep this", status: "pending" as const }],
    };
    expect(
      boundInFlightRunSnapshotForChatHistory({
        snapshot: { runId: "run-1", text: "partial", startedAt: 1_000, plan },
        messages: [],
        maxBytes: 1_000,
      }),
    ).toEqual({ runId: "run-1", text: "partial", startedAt: 1_000, plan });
  });

  it("drops oversized in-flight text but keeps the run id for adoption", () => {
    const plan = {
      steps: [{ step: "Keep this", status: "pending" as const }],
    };
    expect(
      boundInFlightRunSnapshotForChatHistory({
        snapshot: { runId: "run-1", text: "x".repeat(1_000), startedAt: 1_000, plan },
        messages: [],
        maxBytes: 200,
      }),
    ).toEqual({ runId: "run-1", text: "", startedAt: 1_000, plan });
  });

  it("drops startedAt when the former minimal fallback exactly fills the budget", () => {
    const messages = [{ role: "user", content: "near budget" }];
    const minimal = { runId: "run-1", text: "" };
    const maxBytes = jsonUtf8Bytes(messages) + jsonUtf8Bytes(minimal);
    const result = boundInFlightRunSnapshotForChatHistory({
      snapshot: { runId: "run-1", text: "x", startedAt: 1_000 },
      messages,
      maxBytes,
    });
    expect(result).toEqual(minimal);
    expect(jsonUtf8Bytes(messages) + jsonUtf8Bytes(result)).toBeLessThanOrEqual(maxBytes);
  });

  it("drops an oversized plan after dropping text", () => {
    expect(
      boundInFlightRunSnapshotForChatHistory({
        snapshot: {
          runId: "run-1",
          text: "",
          plan: {
            steps: [{ step: "x".repeat(500), status: "pending" }],
          },
        },
        messages: [{ role: "user", content: "near budget" }],
        maxBytes: 160,
      }),
    ).toEqual({ runId: "run-1", text: "", plan: { steps: [] } });
  });

  it("keeps small buffered text and clears an oversized plan explicitly", () => {
    // Absence means legacy-gateway unknown to clients; a budget drop must send
    // an explicit empty plan so retained stale checklists cannot survive.
    expect(
      boundInFlightRunSnapshotForChatHistory({
        snapshot: {
          runId: "run-1",
          text: "short answer",
          plan: {
            steps: [{ step: "x".repeat(500), status: "pending" }],
          },
        },
        messages: [],
        maxBytes: 200,
      }),
    ).toEqual({ runId: "run-1", text: "short answer", plan: { steps: [] } });
  });

  it("prioritizes active progress and explicitly clears budget-dropped projections", () => {
    const event = {
      runId: "run-1",
      seq: 2,
      stream: "tool" as const,
      ts: 1_000,
      data: { phase: "start", name: "read", toolCallId: "tool-1", args: {} },
    };
    const expected = {
      runId: "run-1",
      text: "",
      events: [event],
      plan: { steps: [] },
    };
    expect(
      boundInFlightRunSnapshotForChatHistory({
        snapshot: {
          runId: "run-1",
          text: "x".repeat(1_000),
          events: [event],
          plan: { steps: [{ step: "y".repeat(1_000), status: "in_progress" }] },
        },
        messages: [],
        maxBytes: jsonUtf8Bytes([]) + jsonUtf8Bytes(expected),
      }),
    ).toEqual(expected);

    expect(
      boundInFlightRunSnapshotForChatHistory({
        snapshot: { runId: "run-1", text: "", events: [event] },
        messages: [],
        maxBytes: jsonUtf8Bytes([]) + jsonUtf8Bytes({ runId: "run-1", text: "", events: [] }),
      }),
    ).toEqual({ runId: "run-1", text: "", events: [] });
  });
});
