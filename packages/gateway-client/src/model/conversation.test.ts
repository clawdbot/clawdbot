import { describe, expect, it, vi } from "vitest";
import {
  activatedConversation,
  createHarness,
  flush,
  message,
  messageIds,
} from "./conversation.test-support.js";
import { ControlModelCommandError, createControlModel } from "./index.js";

describe("Control Model conversations", () => {
  it("activates exactly once per epoch and retires/release leases safely", async () => {
    const harness = createHarness();
    const model = createControlModel({ gateway: harness.gateway });
    model.start();
    const conversation = model.conversation(" agent:main:one ");

    harness.setConnection({ status: "connected", epoch: 1 });
    await vi.waitFor(() => expect(harness.callsFor("sessions.messages.subscribe")).toHaveLength(2));
    expect(
      harness.callsFor("sessions.messages.subscribe").map((call) => call.params.includeApprovals),
    ).toEqual([undefined, true]);
    expect(harness.callsFor("chat.history")).toHaveLength(1);
    expect(harness.callsFor("question.list")).toHaveLength(1);

    expect(model.conversation("agent:main:one")).toBe(conversation);
    harness.pingConnection(3);
    await flush();
    expect(harness.callsFor("sessions.messages.subscribe")).toHaveLength(2);
    expect(harness.callsFor("chat.history")).toHaveLength(1);
    expect(harness.callsFor("sessions.list")).toHaveLength(1);

    harness.setConnection({ status: "connected", epoch: 2 });
    await vi.waitFor(() => expect(harness.callsFor("sessions.messages.subscribe")).toHaveLength(4));
    expect(harness.callsFor("chat.history")).toHaveLength(2);
    harness.pingConnection(2);
    await flush();
    expect(harness.callsFor("sessions.messages.subscribe")).toHaveLength(4);
    expect(harness.callsFor("sessions.messages.unsubscribe")).toHaveLength(0);

    await conversation.release();
    await vi.waitFor(() =>
      expect(harness.callsFor("sessions.messages.unsubscribe")).toHaveLength(1),
    );
    expect(model.conversation("agent:main:one")).not.toBe(conversation);
    model.dispose();
  });

  it("retries a failed observer activation within the same connection epoch", async () => {
    const harness = createHarness({ status: "connected", epoch: 1 });
    harness.queue(
      "sessions.messages.subscribe",
      Object.assign(new Error("observer unavailable"), {
        code: "UNAVAILABLE",
        retryable: true,
      }),
    );
    const model = createControlModel({ gateway: harness.gateway });
    model.start();
    const conversation = model.conversation("agent:main:one");
    await vi.waitFor(() => expect(conversation.getSnapshot().status).toBe("error"));

    expect(model.conversation("agent:main:one")).toBe(conversation);
    await vi.waitFor(() => expect(harness.callsFor("sessions.messages.subscribe")).toHaveLength(3));
    expect(harness.callsFor("chat.history")).toHaveLength(1);
    model.dispose();
  });

  it("does not let a retired activation overwrite the current epoch", async () => {
    const harness = createHarness({ status: "connected", epoch: 1 });
    harness.queue("sessions.messages.subscribe", { key: "agent:main:one" });
    const retiredApprovals = harness.defer("sessions.messages.subscribe");
    const model = createControlModel({ gateway: harness.gateway });
    model.start();
    const conversation = model.conversation("agent:main:one");
    await vi.waitFor(() => expect(harness.callsFor("sessions.messages.subscribe")).toHaveLength(2));

    harness.setConnection({ status: "connected", epoch: 2 });
    await vi.waitFor(() => expect(conversation.getSnapshot().status).toBe("ready"));
    retiredApprovals.reject(Object.assign(new Error("retired"), { code: "UNAVAILABLE" }));
    await flush();
    expect(conversation.getSnapshot().status).toBe("ready");
    expect(conversation.getSnapshot().partialReasons).not.toContain("approvals-unavailable");
    model.dispose();
  });

  it("uses the host coordinator and accepts its acknowledged canonical session key", async () => {
    const harness = createHarness(
      { status: "connected", epoch: 1 },
      {
        keysEquivalent: (left, right) =>
          left.replace("agent:main:main", "main") === right.replace("agent:main:main", "main"),
      },
    );
    const hostLease = await harness.coordinator.acquire("agent:main:main");
    const model = createControlModel({ gateway: harness.gateway });
    model.start();
    const conversation = model.conversation("main");
    await vi.waitFor(() => expect(harness.callsFor("chat.history")).toHaveLength(1));

    harness.emitProtocol({
      type: "event",
      event: "session.message",
      payload: { sessionKey: "agent:main:main", message: message(1) },
    });
    await flush();

    expect(harness.callsFor("sessions.messages.subscribe")).toHaveLength(2);
    expect(messageIds(conversation.getSnapshot())).toEqual(["message-1"]);
    model.dispose();
    await harness.coordinator.release(hostLease);
  });

  it("bounds only inactive handles, pins subscriptions, and enforces subscriber limits", () => {
    const harness = createHarness();
    const model = createControlModel({
      gateway: harness.gateway,
      bounds: { maxInactiveConversations: 1, maxSubscribers: 1 },
      now: (() => {
        let now = 0;
        return () => ++now;
      })(),
    });
    model.start();
    const first = model.conversation("agent:main:one");
    const second = model.conversation("agent:main:two");
    expect(first.getSnapshot().status).toBe("disposed");

    const unsubscribe = second.subscribe(() => undefined);
    const third = model.conversation("agent:main:three");
    expect(third.sessionKey).toBe("agent:main:three");
    expect(second.getSnapshot().status).not.toBe("disposed");
    expect(() => second.subscribe(() => undefined)).toThrow(ControlModelCommandError);
    try {
      second.subscribe(() => undefined);
    } catch (error) {
      expect(error).toMatchObject({ code: "SUBSCRIBER_LIMIT" });
    }
    unsubscribe();
    const fourth = model.conversation("agent:main:four");
    expect(fourth.sessionKey).toBe("agent:main:four");
    expect(third.getSnapshot().status).toBe("disposed");
    model.dispose();
  });

  it("keeps ordered unique live/history messages across overlap and out-of-order snapshots", async () => {
    const harness = createHarness(
      { status: "connected", epoch: 1 },
      {
        history: { messages: [message(2)], completeSnapshot: true, totalMessages: 1 },
      },
    );
    const { model, conversation } = await activatedConversation(harness);
    const refresh = harness.defer("chat.history");
    harness.emit({
      event: "session.message",
      payload: { sessionKey: "agent:main:one", message: message(3) },
    });
    harness.emit({
      event: "session.message",
      payload: { sessionKey: "agent:main:one", message: message(1) },
    });
    refresh.resolve({
      messages: [message(3), message(2), message(1), message(3)],
      completeSnapshot: true,
      totalMessages: 3,
    });
    await vi.waitFor(() =>
      expect(messageIds(conversation.getSnapshot())).toEqual([
        "message-1",
        "message-2",
        "message-3",
      ]),
    );
    model.dispose();
  });

  it("preserves overflow evidence when authoritative history retains a live entry", async () => {
    const harness = createHarness({ status: "connected", epoch: 1 });
    const history = harness.defer("chat.history");
    const { model, conversation } = await activatedConversation(harness, {
      maxConversationMessages: 2,
    });
    harness.emit({
      event: "session.message",
      payload: { sessionKey: "agent:main:one", message: message(3) },
    });
    history.resolve({
      messages: [message(1), message(2)],
      completeSnapshot: true,
      totalMessages: 2,
    });
    await vi.waitFor(() => expect(conversation.getSnapshot().history.status).toBe("ready"));
    expect(messageIds(conversation.getSnapshot())).toEqual(["message-2", "message-3"]);
    expect(conversation.getSnapshot().history).toMatchObject({
      truncatedBefore: true,
      completeSnapshot: false,
    });
    expect(conversation.getSnapshot().partialReasons).toContain("messages-truncated");
    model.dispose();
  });

  it("keeps a bounded observable older history window and restores the newest tail", async () => {
    const harness = createHarness({ status: "connected", epoch: 1 });
    const tail = {
      messages: [message(3), message(4)],
      hasMore: true,
      nextOffset: 2,
      totalMessages: 4,
    };
    harness.setHistory(0, tail);
    harness.setHistory(2, {
      messages: [message(1), message(2)],
      hasMore: false,
      totalMessages: 4,
    });
    const { model, conversation } = await activatedConversation(harness, {
      maxConversationMessages: 2,
    });
    expect(messageIds(conversation.getSnapshot())).toEqual(["message-3", "message-4"]);
    expect(conversation.getSnapshot().history).toMatchObject({
      window: "newest",
      truncatedBefore: true,
      truncatedAfter: false,
      completeSnapshot: false,
    });
    harness.emit({
      event: "session.message",
      payload: { sessionKey: "agent:main:one", message: message(3) },
    });
    harness.emit({
      event: "session.message",
      payload: { sessionKey: "agent:main:one", message: message(4) },
    });
    await conversation.loadMoreHistory();
    expect(messageIds(conversation.getSnapshot())).toEqual(["message-1", "message-2"]);
    expect(conversation.getSnapshot().history).toMatchObject({
      window: "older",
      hasMore: false,
      truncatedBefore: false,
      truncatedAfter: true,
      completeSnapshot: false,
    });
    expect(conversation.getSnapshot().status).toBe("partial");

    const historyCalls = harness.callsFor("chat.history").length;
    harness.emit({
      event: "session.message",
      payload: { sessionKey: "agent:main:one", message: message(5) },
    });
    await flush();
    expect(messageIds(conversation.getSnapshot())).toEqual(["message-1", "message-2"]);
    expect(conversation.getSnapshot().history.window).toBe("older");
    expect(harness.callsFor("chat.history")).toHaveLength(historyCalls);

    harness.setHistory(0, tail);
    await conversation.refreshHistory();
    expect(messageIds(conversation.getSnapshot())).toEqual(["message-3", "message-4"]);
    expect(conversation.getSnapshot().history).toMatchObject({
      window: "newest",
      truncatedBefore: true,
      truncatedAfter: false,
    });
    model.dispose();
  });

  it("marks a gap partial, schedules authoritative history, and ignores retired event/history failures", async () => {
    const harness = createHarness({ status: "connected", epoch: 1 });
    const backgroundErrors: unknown[] = [];
    const model = createControlModel({
      gateway: harness.gateway,
      onBackgroundError: (error) => backgroundErrors.push(error),
    });
    model.start();
    const conversation = model.conversation("agent:main:one");
    await vi.waitFor(() => expect(harness.callsFor("chat.history")).toHaveLength(1));

    const authoritative = harness.defer("chat.history");
    harness.emit({
      event: "session.message",
      gap: true,
      payload: { sessionKey: "agent:main:one", message: message(2) },
    });
    await vi.waitFor(() => expect(harness.callsFor("chat.history")).toHaveLength(2));
    expect(conversation.getSnapshot().partialReasons).toContain("transport-gap");
    authoritative.resolve({ messages: [message(2)], completeSnapshot: true, totalMessages: 1 });
    await vi.waitFor(() => expect(conversation.getSnapshot().history.status).toBe("ready"));
    expect(conversation.getSnapshot().partialReasons).toContain("transport-gap");

    const oldHistory = harness.defer("chat.history");
    harness.emit({
      event: "session.message",
      payload: { sessionKey: "agent:main:one" },
    });
    await vi.waitFor(() => expect(harness.callsFor("chat.history")).toHaveLength(3));
    harness.setConnection({ status: "connected", epoch: 2 });
    harness.emit({
      connectionEpoch: 1,
      event: "session.message",
      payload: { sessionKey: "agent:main:one", message: message(99) },
    });
    oldHistory.reject(Object.assign(new Error("retired"), { code: "UNAVAILABLE" }));
    await vi.waitFor(() => expect(harness.callsFor("chat.history")).toHaveLength(4));
    await flush();
    expect(messageIds(conversation.getSnapshot())).not.toContain("message-99");
    expect(conversation.getSnapshot().history.error).toBeNull();
    expect(backgroundErrors).toEqual([]);
    model.dispose();
  });

  it("treats an explicit frame gap as global even when its payload targets another session", async () => {
    const { harness, model, conversation } = await activatedConversation();
    const refresh = harness.defer("chat.history");
    harness.emit({
      event: "session.message",
      gap: true,
      payload: { sessionKey: "agent:main:other", message: message(9) },
    });
    await vi.waitFor(() => expect(harness.callsFor("chat.history")).toHaveLength(2));
    expect(conversation.getSnapshot().partialReasons).toContain("transport-gap");
    expect(messageIds(conversation.getSnapshot())).not.toContain("message-9");
    refresh.resolve({ messages: [], completeSnapshot: true, totalMessages: 0 });
    model.dispose();
  });

  it("projects pending sends before acknowledgement, rekeys them, removes failures, and forwards signals", async () => {
    const { harness, model, conversation } = await activatedConversation();
    const pending = harness.defer("chat.send");
    const controller = new AbortController();
    const send = conversation.send(
      { message: "hello", idempotencyKey: "idem-1" },
      {
        signal: controller.signal,
      },
    );
    expect(conversation.getSnapshot().messages).toHaveLength(1);
    expect(conversation.getSnapshot().messages[0]).toMatchObject({
      pending: true,
      runId: "idem-1",
    });
    expect(harness.callsFor("chat.send")[0]?.options?.signal).toBe(controller.signal);
    pending.resolve({ runId: "run-1", status: "accepted" });
    await expect(send).resolves.toEqual({
      runId: "run-1",
      status: "accepted",
      idempotencyKey: "idem-1",
    });
    expect(conversation.getSnapshot().messages[0]).toMatchObject({ pending: true, runId: "run-1" });
    harness.emit({
      event: "session.message",
      payload: {
        sessionKey: "agent:main:one",
        message: {
          ...message(1, "hello"),
          __openclaw: { id: "sent-1", seq: 1 },
        },
        runId: "run-1",
      },
    });
    expect(conversation.getSnapshot().messages).toHaveLength(1);
    expect(conversation.getSnapshot().messages[0]).toMatchObject({ pending: false });

    harness.queue("chat.send", Object.assign(new Error("forbidden"), { code: "FORBIDDEN" }));
    await expect(conversation.send("not allowed")).rejects.toMatchObject({ category: "forbidden" });
    expect(conversation.getSnapshot().messages).toHaveLength(1);
    model.dispose();
  });

  it("normalizes command errors for forbidden, conflict, timeout, abort, disconnected, stale, and disposal", async () => {
    const { harness, model, conversation } = await activatedConversation();
    for (const [error, category] of [
      [Object.assign(new Error("forbidden"), { code: "FORBIDDEN" }), "forbidden"],
      [Object.assign(new Error("conflict"), { code: "CONFLICT" }), "conflict"],
      [Object.assign(new Error("timeout"), { code: "TIMEOUT" }), "timeout"],
      [
        Object.assign(new Error("opaque failure"), {
          code: "UNAVAILABLE",
          details: { reason: "maintenance" },
        }),
        "retryable",
      ],
      [
        Object.assign(new Error("opaque failure"), {
          code: "AUTH_UNAUTHORIZED",
          details: { reason: "token expired" },
        }),
        "forbidden",
      ],
      [
        Object.assign(new Error("opaque failure"), {
          code: "DEADLINE_EXCEEDED",
          details: { reason: "upstream busy" },
        }),
        "timeout",
      ],
      [
        Object.assign(new Error("opaque failure"), {
          code: "GATEWAY_ERROR",
          details: { reason: "unavailable" },
        }),
        "retryable",
      ],
      [Object.assign(new Error("opaque failure"), { name: "AbortError" }), "aborted"],
    ] as const) {
      harness.queue("chat.send", error);
      await expect(conversation.send("test")).rejects.toMatchObject({ category });
    }
    await expect(conversation.abort()).rejects.toMatchObject({ category: "conflict" });
    harness.setConnection({ status: "disconnected", epoch: 1 });
    await expect(conversation.send("offline")).rejects.toMatchObject({ category: "disconnected" });

    harness.setConnection({ status: "connected", epoch: 2 });
    await vi.waitFor(() => expect(harness.callsFor("chat.history")).toHaveLength(2));
    const stale = harness.defer("chat.send");
    const staleSend = conversation.send("stale");
    harness.setConnection({ status: "connected", epoch: 3 });
    stale.resolve({ runId: "old-run" });
    await expect(staleSend).rejects.toMatchObject({ category: "stale", code: "STALE_EPOCH" });

    await conversation.release();
    await expect(conversation.send("disposed")).rejects.toMatchObject({ category: "disposed" });
    model.dispose();
  });

  it("projects chat delta, final, and abort run states", async () => {
    const { harness, model, conversation } = await activatedConversation();
    harness.emit({
      event: "chat",
      payload: {
        sessionKey: "agent:main:one",
        runId: "run-1",
        state: "delta",
        message: message(2),
      },
    });
    expect(conversation.getSnapshot().activeRun).toMatchObject({
      runId: "run-1",
      status: "streaming",
    });
    harness.emit({
      event: "chat",
      payload: {
        sessionKey: "agent:main:one",
        runId: "run-1",
        state: "final",
        message: message(2, "final"),
      },
    });
    expect(conversation.getSnapshot().runs).toContainEqual(
      expect.objectContaining({
        runId: "run-1",
        status: "completed",
      }),
    );

    harness.emit({
      event: "chat",
      payload: { sessionKey: "agent:main:one", runId: "run-2", state: "delta" },
    });
    await conversation.abort("run-2");
    expect(conversation.getSnapshot().runs).toContainEqual(
      expect.objectContaining({
        runId: "run-2",
        status: "aborted",
      }),
    );
    model.dispose();
  });

  it("does not report an abort when the Gateway confirms that no run was aborted", async () => {
    const { harness, model, conversation } = await activatedConversation();
    harness.emit({
      event: "chat",
      payload: { sessionKey: "agent:main:one", runId: "run-raced", state: "delta" },
    });
    harness.queue("chat.abort", { aborted: false, runIds: [] });
    await conversation.abort("run-raced");
    expect(conversation.getSnapshot().activeRun).toMatchObject({
      runId: "run-raced",
      status: "streaming",
    });
    model.dispose();
  });

  it("retires epoch-local runs and tools, then restores the authoritative in-flight run", async () => {
    const { harness, model, conversation } = await activatedConversation();
    harness.emit({
      event: "chat",
      payload: { sessionKey: "agent:main:one", runId: "run-old", state: "delta" },
    });
    harness.emit({
      event: "agent",
      payload: {
        sessionKey: "agent:main:one",
        runId: "run-old",
        stream: "tool",
        data: { phase: "start", toolCallId: "tool-old", name: "read" },
      },
    });
    harness.setHistory(0, {
      messages: [],
      completeSnapshot: true,
      inFlightRun: { runId: "run-current", text: "restored" },
    });
    harness.setConnection({ status: "connected", epoch: 2 });
    await vi.waitFor(() => expect(conversation.getSnapshot().activeRun?.runId).toBe("run-current"));
    expect(conversation.getSnapshot().runs.some((run) => run.runId === "run-old")).toBe(false);
    expect(conversation.getSnapshot().tools).toEqual([]);
    model.dispose();
  });

  it("bounds retained live projection entries instead of only slicing the public snapshot", async () => {
    const { harness, model, conversation } = await activatedConversation(undefined, {
      maxConversationMessages: 3,
    });
    for (let sequence = 1; sequence <= 10; sequence += 1) {
      harness.emit({
        event: "session.message",
        payload: { sessionKey: "agent:main:one", message: message(sequence) },
      });
    }
    expect(messageIds(conversation.getSnapshot())).toEqual([
      "message-8",
      "message-9",
      "message-10",
    ]);
    expect(conversation.getSnapshot().bounds.messagesTruncated).toBe(true);
    expect(conversation.getSnapshot().partialReasons).toContain("messages-truncated");
    model.dispose();
  });

  it("retains an active run ahead of newer terminal diagnostics", async () => {
    const { harness, model, conversation } = await activatedConversation(undefined, {
      maxConversationRuns: 1,
    });
    harness.emit({
      event: "chat",
      payload: { sessionKey: "agent:main:one", runId: "run-active", state: "delta" },
    });
    harness.emit({
      event: "chat",
      payload: { sessionKey: "agent:main:one", runId: "run-terminal", state: "final" },
    });

    expect(conversation.getSnapshot().runs).toEqual([
      expect.objectContaining({ runId: "run-active", status: "streaming" }),
    ]);
    expect(conversation.getSnapshot().activeRun?.runId).toBe("run-active");
    expect(conversation.getSnapshot().commandAvailability.abort).toBe(true);
    model.dispose();
  });

  it("rejects global-session events carrying a different explicit agent identity", async () => {
    const harness = createHarness({ status: "connected", epoch: 1 });
    const model = createControlModel({ gateway: harness.gateway, agentId: "alpha" });
    model.start();
    const conversation = model.conversation("global");
    await vi.waitFor(() => expect(harness.callsFor("chat.history")).toHaveLength(1));
    harness.emit({
      event: "chat",
      payload: {
        sessionKey: "global",
        agentId: "beta",
        runId: "wrong-agent",
        state: "delta",
      },
    });
    expect(conversation.getSnapshot().activeRun).toBeNull();
    harness.emit({
      event: "session.approval",
      payload: {
        sessionKey: "global",
        approval: {
          id: "wrong-agent-approval",
          status: "pending",
          presentation: { agentId: "beta" },
        },
      },
    });
    expect(conversation.getSnapshot().approvals).toEqual([]);
    harness.emit({
      event: "chat",
      payload: {
        sessionKey: "global",
        agentId: "ALPHA",
        runId: "right-agent",
        state: "delta",
      },
    });
    expect(conversation.getSnapshot().activeRun?.runId).toBe("right-agent");
    model.dispose();
  });

  it("accepts scoped early tool events, rejects unscoped unknown runs, and projects terminal states", async () => {
    const { harness, model, conversation } = await activatedConversation();
    harness.emit({
      event: "agent",
      payload: {
        sessionKey: "agent:main:one",
        runId: "early-run",
        stream: "tool",
        data: { phase: "start", name: "read", toolCallId: "tool-1", args: { path: "a" } },
      },
    });
    expect(conversation.getSnapshot().tools).toContainEqual(
      expect.objectContaining({
        runId: "early-run",
        toolCallId: "tool-1",
        status: "running",
      }),
    );
    harness.emit({
      event: "agent",
      payload: {
        runId: "unknown-run",
        stream: "tool",
        data: { phase: "start", name: "ignored", toolCallId: "ignored" },
      },
    });
    expect(conversation.getSnapshot().tools).toHaveLength(1);
    harness.emit({
      event: "agent",
      payload: {
        sessionKey: "agent:main:one",
        runId: "early-run",
        stream: "tool",
        data: { phase: "update", name: "read", toolCallId: "tool-1", partialResult: { stage: 1 } },
      },
    });
    harness.emit({
      event: "chat",
      payload: { sessionKey: "agent:main:one", runId: "known-run", state: "delta" },
    });
    harness.emit({
      event: "agent",
      payload: {
        runId: "known-run",
        stream: "tool",
        data: { phase: "start", name: "known", toolCallId: "known-tool" },
      },
    });
    expect(conversation.getSnapshot().tools).toContainEqual(
      expect.objectContaining({
        runId: "known-run",
        toolCallId: "known-tool",
      }),
    );

    harness.emit({
      event: "agent",
      payload: {
        sessionKey: "agent:main:one",
        runId: "early-run",
        stream: "tool",
        data: { phase: "result", name: "read", toolCallId: "tool-1", result: { ok: true } },
      },
    });
    harness.emit({
      event: "agent",
      payload: {
        sessionKey: "agent:main:one",
        runId: "early-run",
        stream: "tool",
        data: { phase: "error", name: "write", toolCallId: "tool-2", error: "nope" },
      },
    });
    harness.emit({
      event: "agent",
      payload: {
        sessionKey: "agent:main:one",
        runId: "early-run",
        stream: "tool",
        data: { phase: "cancel", name: "exec", toolCallId: "tool-3" },
      },
    });
    expect(conversation.getSnapshot().tools).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ toolCallId: "tool-1", status: "succeeded" }),
        expect.objectContaining({ toolCallId: "tool-2", status: "failed" }),
        expect.objectContaining({ toolCallId: "tool-3", status: "cancelled" }),
      ]),
    );
    model.dispose();
  });

  it("bounds tool progress by retained values and keeps oversized structured values typed", async () => {
    const { harness, model, conversation } = await activatedConversation(undefined, {
      maxConversationProgressBytes: 64,
      maxConversationProgressUpdates: 2,
    });
    const emitTool = (data: Record<string, unknown>) =>
      harness.emit({
        event: "agent",
        payload: { sessionKey: "agent:main:one", runId: "tool-run", stream: "tool", data },
      });
    emitTool({ phase: "start", toolCallId: "structured", args: { secret: "x".repeat(200) } });
    emitTool({ phase: "input_delta", toolCallId: "structured", input_delta: "later" });
    const structured = conversation
      .getSnapshot()
      .tools.find((tool) => tool.toolCallId === "structured");
    expect(structured).toMatchObject({
      truncated: true,
      input: { kind: "truncated", reason: "max-progress-bytes" },
    });
    expect(structured?.progress).toMatchObject({ bytes: expect.any(Number), truncated: true });
    expect(structured?.progress.bytes).toBeLessThanOrEqual(64);
    expect(Object.isFrozen(structured?.input)).toBe(true);

    emitTool({ phase: "start", toolCallId: "replacement", args: "i" });
    emitTool({ phase: "update", toolCallId: "replacement", output: "first" });
    emitTool({ phase: "result", toolCallId: "replacement", output: "second" });
    const replacement = conversation
      .getSnapshot()
      .tools.find((tool) => tool.toolCallId === "replacement");
    expect(replacement).toMatchObject({ output: "second" });
    expect(replacement?.progress.bytes).toBe(
      JSON.stringify("i").length + JSON.stringify("second").length,
    );
    model.dispose();
  });

  it("hydrates approvals, rejects forbidden decisions locally, and projects terminal approval events", async () => {
    const approval = {
      id: "approval-1",
      status: "pending",
      sessionKey: "agent:main:one",
      presentation: { kind: "exec", allowedDecisions: ["allow-once", "deny"] },
    };
    const harness = createHarness(
      { status: "connected", epoch: 1 },
      {
        approvalReplay: { approvals: [approval], truncated: false },
      },
    );
    const { model, conversation } = await activatedConversation(harness);
    expect(conversation.getSnapshot().approvals).toContainEqual(
      expect.objectContaining({ id: "approval-1" }),
    );
    await expect(conversation.resolveApproval("approval-1", "maybe")).rejects.toMatchObject({
      category: "forbidden",
    });
    await expect(conversation.resolveApproval("approval-1", "allow-once")).resolves.toEqual({
      applied: true,
    });
    harness.emit({
      event: "session.approval",
      payload: { approval: { ...approval, status: "expired" } },
    });
    expect(conversation.getSnapshot().approvals).toContainEqual(
      expect.objectContaining({
        id: "approval-1",
        status: "expired",
      }),
    );
    model.dispose();
  });

  it("hydrates questions, processes requested/resolved events, and preflights answers and cancellation", async () => {
    const question = { id: "question-1", status: "pending", sessionKey: "agent:main:one" };
    const harness = createHarness({ status: "connected", epoch: 1 }, { questions: [question] });
    const { model, conversation } = await activatedConversation(harness);
    expect(conversation.getSnapshot().questions).toContainEqual(
      expect.objectContaining({ id: "question-1" }),
    );
    await expect(conversation.answerQuestion("missing", { choice: ["yes"] })).rejects.toMatchObject(
      {
        category: "not-found",
      },
    );
    await conversation.answerQuestion("question-1", { choice: ["yes"] });
    expect(harness.callsFor("question.resolve")[0]?.params).toMatchObject({
      id: "question-1",
      answers: { answers: { choice: ["yes"] } },
    });
    harness.emit({
      event: "question.requested",
      payload: { question: { id: "question-2", status: "pending", sessionKey: "agent:main:one" } },
    });
    await conversation.cancelQuestion("question-2");
    expect(harness.callsFor("question.resolve")[1]?.params).toMatchObject({
      id: "question-2",
      cancel: true,
    });
    harness.emit({
      event: "question.resolved",
      payload: { id: "question-2", status: "cancelled" },
    });
    expect(conversation.getSnapshot().questions).toContainEqual(
      expect.objectContaining({
        id: "question-2",
        status: "cancelled",
      }),
    );
    harness.setConnection({ status: "connected", epoch: 2 });
    await vi.waitFor(() => expect(harness.callsFor("question.list")).toHaveLength(2));
    model.dispose();
  });

  it("removes stale pending approvals and questions from authoritative reconnect sets", async () => {
    const approval = {
      id: "approval-stale",
      status: "pending",
      sessionKey: "agent:main:one",
      presentation: { kind: "exec", allowedDecisions: ["allow-once", "deny"] },
    };
    const question = {
      id: "question-stale",
      status: "pending",
      sessionKey: "agent:main:one",
    };
    const harness = createHarness(
      { status: "connected", epoch: 1 },
      {
        approvalReplay: { approvals: [approval], truncated: false },
        questions: [question],
      },
    );
    const { model, conversation } = await activatedConversation(harness);
    expect(conversation.getSnapshot().approvals).toHaveLength(1);
    expect(conversation.getSnapshot().questions).toHaveLength(1);

    harness.queue("sessions.messages.subscribe", { key: "agent:main:one" });
    harness.queue("sessions.messages.subscribe", {
      key: "agent:main:one",
      approvalReplay: { approvals: [], truncated: false },
    });
    harness.queue("question.list", { questions: [] });
    harness.setConnection({ status: "connected", epoch: 2 });
    await vi.waitFor(() => expect(harness.callsFor("question.list")).toHaveLength(2));
    await vi.waitFor(() => expect(conversation.getSnapshot().approvals).toEqual([]));
    expect(conversation.getSnapshot().questions).toEqual([]);
    model.dispose();
  });

  it("starts fresh question hydration when reconnect retires a pending epoch", async () => {
    const harness = createHarness({ status: "connected", epoch: 1 });
    const retired = harness.defer("question.list");
    const { model, conversation } = await activatedConversation(harness);
    harness.queue("question.list", { questions: [] });
    harness.setConnection({ status: "connected", epoch: 2 });
    await vi.waitFor(() => expect(harness.callsFor("question.list")).toHaveLength(2));
    await vi.waitFor(() => expect(conversation.getSnapshot().status).toBe("ready"));
    expect(conversation.getSnapshot().questions).toEqual([]);
    retired.resolve({
      questions: [{ id: "stale", status: "pending", sessionKey: "agent:main:one" }],
    });
    await flush();
    expect(conversation.getSnapshot().questions).toEqual([]);
    model.dispose();
  });

  it("reports partial status when question hydration fails", async () => {
    const harness = createHarness({ status: "connected", epoch: 1 });
    harness.queue(
      "question.list",
      Object.assign(new Error("questions unavailable"), { code: "UNAVAILABLE" }),
    );
    const { model, conversation } = await activatedConversation(harness);
    await vi.waitFor(() =>
      expect(conversation.getSnapshot().partialReasons).toContain("questions-unavailable"),
    );
    expect(conversation.getSnapshot().status).toBe("partial");
    model.dispose();
  });

  it("keeps an initial authoritative history failure in error status", async () => {
    const harness = createHarness({ status: "connected", epoch: 1 });
    harness.queue(
      "chat.history",
      Object.assign(new Error("history unavailable"), {
        code: "UNAVAILABLE",
        details: { reason: "gateway restarting" },
      }),
    );
    const { model, conversation } = await activatedConversation(harness);
    await vi.waitFor(() => expect(conversation.getSnapshot().history.status).toBe("error"));
    expect(conversation.getSnapshot().status).toBe("error");
    model.dispose();
  });

  it("deep-freezes snapshots and stops copied subscriber delivery after disposal", async () => {
    const { harness, model, conversation } = await activatedConversation();
    const later = vi.fn();
    conversation.subscribe(() => conversation.dispose());
    conversation.subscribe(later);
    harness.emit({
      event: "session.message",
      payload: { sessionKey: "agent:main:one", message: { ...message(1), nested: { value: 1 } } },
    });
    await flush();
    const snapshot = conversation.getSnapshot();
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.messages)).toBe(true);
    expect(Object.isFrozen(snapshot.messages[0]?.raw)).toBe(true);
    const raw = snapshot.messages[0]?.raw as { nested?: unknown } | undefined;
    expect(Object.isFrozen(raw?.nested)).toBe(true);
    expect(later).not.toHaveBeenCalled();
    model.dispose();
  });
});
