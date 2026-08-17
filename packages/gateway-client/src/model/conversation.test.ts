import { describe, expect, it, vi } from "vitest";
import { getGatewaySessionMessageSubscriptionCoordinator } from "../session-subscriptions.js";
import { collectMessageUiArtifacts } from "./artifact-projection.js";
import {
  activatedConversation,
  createHarness,
  flush,
  message,
  messageIds,
  uiArtifact,
} from "./conversation.test-harness.js";
import { ControlModelCommandError, createControlModel } from "./index.js";

describe("Control Model conversations", () => {
  it("can defer canonical history to the selected route and retains startup metadata", async () => {
    const harness = createHarness({ status: "connected", epoch: 1 });
    harness.queue("chat.startup", {
      messages: [message(1)],
      sessionId: "session-one",
      sessionInfo: { key: "agent:main:one", kind: "direct" },
      defaults: { model: "test" },
      completeSnapshot: true,
    });
    const model = createControlModel({
      gateway: harness.gateway,
      autoRefreshSessionCatalog: false,
      autoLoadConversationHistory: false,
    });
    model.start();
    const conversation = model.conversation("agent:main:one");
    await flush();
    expect(harness.callsFor("sessions.list")).toHaveLength(0);
    expect(harness.callsFor("chat.history")).toHaveLength(0);

    await conversation.refreshHistory(undefined, "chat.startup");
    expect(harness.callsFor("chat.startup")).toHaveLength(1);
    expect(harness.callsFor("chat.history")).toHaveLength(0);
    expect(conversation.getSnapshot().metadata).toMatchObject({
      sessionId: "session-one",
      defaults: { model: "test" },
    });
    expect(conversation.getSnapshot().messages).toHaveLength(1);
  });

  it("bounds malformed startup metadata without retaining raw payloads", async () => {
    const harness = createHarness({ status: "connected", epoch: 1 });
    const oversized = "x".repeat(1_000);
    harness.queue("chat.startup", {
      messages: [],
      sessionId: "session-one",
      defaults: { model: oversized },
      agentsList: [],
      metadata: { commands: [] },
      inFlightRun: { runId: "run-one", events: [{ payload: oversized }] },
      completeSnapshot: true,
    });
    const model = createControlModel({
      gateway: harness.gateway,
      autoRefreshSessionCatalog: false,
      autoLoadConversationHistory: false,
      bounds: { maxConversationStartupMetadataBytes: 128 },
    });
    model.start();
    const conversation = model.conversation("agent:main:one");

    await conversation.refreshHistory(undefined, "chat.startup");

    const snapshot = conversation.getSnapshot();
    expect(snapshot.metadata?.defaults).toEqual({
      kind: "truncated",
      reason: "max-startup-metadata-bytes",
    });
    expect(snapshot.metadata?.agentsList).toBeUndefined();
    expect(snapshot.partialReasons).toEqual(
      expect.arrayContaining(["startup-metadata-truncated", "startup-metadata-malformed"]),
    );
    expect(JSON.stringify(snapshot.metadata)).not.toContain(oversized);
    expect(
      new TextEncoder().encode(JSON.stringify(snapshot.metadata)).byteLength,
    ).toBeLessThanOrEqual(128);
  });

  it("bounds oversized startup metadata strings", async () => {
    const harness = createHarness({ status: "connected", epoch: 1 });
    const oversized = "s".repeat(1_000);
    harness.queue("chat.startup", {
      messages: [],
      sessionId: oversized,
      completeSnapshot: true,
    });
    const model = createControlModel({
      gateway: harness.gateway,
      autoRefreshSessionCatalog: false,
      autoLoadConversationHistory: false,
      bounds: { maxConversationStartupMetadataBytes: 64 },
    });
    model.start();
    const conversation = model.conversation("agent:main:one");

    await conversation.refreshHistory(undefined, "chat.startup");

    const snapshot = conversation.getSnapshot();
    expect(snapshot.metadata?.sessionId).not.toBe(oversized);
    expect(snapshot.partialReasons).toEqual(
      expect.arrayContaining(["startup-metadata-truncated", "startup-metadata-malformed"]),
    );
    expect(
      new TextEncoder().encode(JSON.stringify(snapshot.metadata)).byteLength,
    ).toBeLessThanOrEqual(64);
  });

  it("accepts acyclic startup metadata with shared references", async () => {
    const harness = createHarness({ status: "connected", epoch: 1 });
    const shared = { model: "test" };
    harness.queue("chat.startup", {
      messages: [],
      defaults: shared,
      metadata: { shared },
      completeSnapshot: true,
    });
    const model = createControlModel({
      gateway: harness.gateway,
      autoRefreshSessionCatalog: false,
      autoLoadConversationHistory: false,
    });
    model.start();
    const conversation = model.conversation("agent:main:one");

    await conversation.refreshHistory(undefined, "chat.startup");

    expect(conversation.getSnapshot().partialReasons).not.toContain("startup-metadata-malformed");
    expect(conversation.getSnapshot().metadata).toMatchObject({
      defaults: { model: "test" },
      metadata: { shared: { model: "test" } },
    });
    model.dispose();
  });

  it("counts repeated shared metadata against the retention bound", async () => {
    const harness = createHarness({ status: "connected", epoch: 1 });
    const shared = { model: "x".repeat(100) };
    harness.queue("chat.startup", {
      messages: [],
      defaults: shared,
      metadata: { shared },
      completeSnapshot: true,
    });
    const model = createControlModel({
      gateway: harness.gateway,
      autoRefreshSessionCatalog: false,
      autoLoadConversationHistory: false,
      bounds: { maxConversationStartupMetadataBytes: 160 },
    });
    model.start();
    const conversation = model.conversation("agent:main:one");

    await conversation.refreshHistory(undefined, "chat.startup");

    expect(
      new TextEncoder().encode(JSON.stringify(conversation.getSnapshot().metadata)).byteLength,
    ).toBeLessThanOrEqual(160);
    expect(conversation.getSnapshot().partialReasons).toContain("startup-metadata-truncated");
    model.dispose();
  });

  it("refreshes returned metadata with ordinary history snapshots", async () => {
    const harness = createHarness({ status: "connected", epoch: 1 });
    harness.queue("chat.startup", {
      messages: [],
      sessionInfo: { key: "agent:main:one", activeLeafEntryId: "leaf-one" },
    });
    harness.queue("chat.history", {
      messages: [],
      sessionInfo: { key: "agent:main:one", activeLeafEntryId: "leaf-two" },
    });
    const model = createControlModel({
      gateway: harness.gateway,
      autoRefreshSessionCatalog: false,
      autoLoadConversationHistory: false,
    });
    model.start();
    const conversation = model.conversation("agent:main:one");

    await conversation.refreshHistory(undefined, "chat.startup");
    await conversation.refreshHistory();

    expect(conversation.getSnapshot().metadata?.sessionInfo).toMatchObject({
      activeLeafEntryId: "leaf-two",
    });
  });

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

  it("releases the final observer when a connected model is disposed", async () => {
    const harness = createHarness({ status: "connected", epoch: 1 });
    const model = createControlModel({ gateway: harness.gateway });
    model.start();
    model.conversation("agent:main:one");

    await vi.waitFor(() => expect(harness.callsFor("sessions.messages.subscribe")).toHaveLength(2));
    model.dispose();

    await vi.waitFor(() =>
      expect(harness.callsFor("sessions.messages.unsubscribe")).toHaveLength(1),
    );
  });

  it("shares one replacement coordinator when multiple models reconnect", async () => {
    const harness = createHarness({ status: "connected", epoch: 1 });
    const firstModel = createControlModel({ gateway: harness.gateway });
    const secondModel = createControlModel({ gateway: harness.gateway });
    firstModel.start();
    secondModel.start();
    const firstConversation = firstModel.conversation("agent:main:first");
    const secondConversation = secondModel.conversation("agent:main:second");

    await vi.waitFor(() => expect(harness.callsFor("sessions.messages.subscribe")).toHaveLength(4));
    harness.setConnection({ status: "connected", epoch: 2 });

    await vi.waitFor(() => expect(harness.callsFor("sessions.messages.subscribe")).toHaveLength(8));
    expect(firstConversation.getSnapshot().status).not.toBe("error");
    expect(secondConversation.getSnapshot().status).not.toBe("error");
    firstModel.dispose();
    secondModel.dispose();
  });

  it("shares observer refcounts with other owners of the same Gateway client", async () => {
    const harness = createHarness({ status: "connected", epoch: 1 });
    const coordinator = getGatewaySessionMessageSubscriptionCoordinator(
      harness.subscriptionClient,
      { keysEquivalent: harness.sessionMessageKeysEquivalent },
    );
    const external = await coordinator.acquire("agent:main:one");
    const model = createControlModel({ gateway: harness.gateway });
    model.start();
    model.conversation("agent:main:one");

    await vi.waitFor(() => expect(harness.callsFor("sessions.messages.subscribe")).toHaveLength(2));
    model.dispose();
    await flush();
    expect(harness.callsFor("sessions.messages.unsubscribe")).toHaveLength(0);

    await coordinator.release(external);
    expect(harness.callsFor("sessions.messages.unsubscribe")).toHaveLength(1);
  });

  it("allows later owners to configure the model's shared key matcher", async () => {
    const harness = createHarness({ status: "connected", epoch: 1 });
    const model = createControlModel({ gateway: harness.gateway });
    model.start();
    model.conversation("agent:main:one");
    await vi.waitFor(() => expect(harness.callsFor("sessions.messages.subscribe")).toHaveLength(2));

    const coordinator = getGatewaySessionMessageSubscriptionCoordinator(
      harness.subscriptionClient,
      { keysEquivalent: harness.sessionMessageKeysEquivalent },
    );
    const external = await coordinator.acquire("agent:main:one");
    expect(harness.callsFor("sessions.messages.subscribe")).toHaveLength(2);

    await coordinator.release(external);
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

  it("queues older history behind an active newest-history refresh", async () => {
    const harness = createHarness({ status: "connected", epoch: 1 });
    let resolveTail: (value: unknown) => void = () => undefined;
    harness.setHistory(
      0,
      new Promise((resolve) => {
        resolveTail = resolve;
      }),
    );
    harness.setHistory(2, {
      messages: [message(1), message(2)],
      hasMore: false,
      totalMessages: 4,
    });
    const model = createControlModel({
      gateway: harness.gateway,
      autoLoadConversationHistory: false,
    });
    model.start();
    const conversation = model.conversation("agent:main:one");

    const refresh = conversation.refreshHistory();
    const older = conversation.loadMoreHistory();
    const concurrentOlder = conversation.loadMoreHistory();
    resolveTail({
      messages: [message(3), message(4)],
      hasMore: true,
      nextOffset: 2,
      totalMessages: 4,
    });
    await Promise.all([refresh, older, concurrentOlder]);

    expect(harness.callsFor("chat.history").map((call) => call.params.offset ?? 0)).toEqual([0, 2]);
    expect(messageIds(conversation.getSnapshot())).toEqual([
      "message-1",
      "message-2",
      "message-3",
      "message-4",
    ]);
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
      [Object.assign(new Error("cancelled"), { name: "AbortError" }), "aborted"],
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
        runId: "constructor",
        stream: "tool",
        data: { phase: "start", name: "ignored", toolCallId: "prototype-key" },
      },
    });
    harness.emit({
      event: "session.approval",
      payload: {
        runId: "constructor",
        approval: { id: "prototype-approval", status: "pending" },
      },
    });
    harness.emit({
      event: "question.requested",
      payload: {
        runId: "constructor",
        question: { id: "prototype-question", status: "pending" },
      },
    });
    expect(conversation.getSnapshot().tools).toHaveLength(1);
    expect(conversation.getSnapshot().approvals).toEqual([]);
    expect(conversation.getSnapshot().questions).toEqual([]);
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

  it("accepts canonical-key events and artifacts for an equivalent route alias", async () => {
    const harness = createHarness(
      { status: "connected", epoch: 1 },
      {
        sessionMessageKeysEquivalent: (left, right) =>
          left === right ||
          (left === "global" && right === "agent:main:main") ||
          (right === "global" && left === "agent:main:main"),
        history: {
          messages: [
            {
              ...message(2),
              role: "toolResult",
              details: {
                uiArtifacts: [
                  uiArtifact(1, {
                    source: { sessionKey: "global" },
                  }),
                ],
              },
            },
          ],
          completeSnapshot: true,
        },
      },
    );
    harness.queue("sessions.messages.subscribe", { key: "global" });
    harness.queue("sessions.messages.subscribe", { key: "global" });
    const model = createControlModel({ gateway: harness.gateway });
    model.start();
    const conversation = model.conversation("agent:main:main", { agentId: "main" });

    await vi.waitFor(() => expect(conversation.getSnapshot().history.status).toBe("ready"));
    harness.emit({
      event: "chat",
      payload: { sessionKey: "global", runId: "alias-run", state: "delta" },
    });
    harness.emit({
      event: "session.approval",
      payload: {
        sessionKey: "global",
        approval: { id: "alias-approval", status: "pending", sessionKey: "global" },
      },
    });
    harness.emit({
      event: "question.requested",
      payload: {
        sessionKey: "global",
        question: { id: "alias-question", status: "pending", sessionKey: "global" },
      },
    });

    expect(conversation.getSnapshot().activeRun?.runId).toBe("alias-run");
    expect(conversation.getSnapshot().approvals).toContainEqual(
      expect.objectContaining({ id: "alias-approval" }),
    );
    expect(conversation.getSnapshot().questions).toContainEqual(
      expect.objectContaining({ id: "alias-question", sessionKey: "agent:main:main" }),
    );
    expect(conversation.getSnapshot().artifacts[0]).toMatchObject({
      id: "artifact-calendar",
      state: "ready",
      source: { sessionKey: "agent:main:main" },
    });
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

  it("projects canonical artifacts from history and associates them with messages and tools", async () => {
    const artifact = uiArtifact(1, {
      views: [
        {
          id: "calendar",
          templateUri: "clawpilot://widgets/calendar",
          dataVersion: 1,
          availability: "inline",
          data: { events: [] },
        },
        {
          id: "unknown",
          templateUri: "custom-view://vendor/unknown",
          dataVersion: 1,
          availability: "deferred",
          module: "https://attacker.invalid/component.js",
        },
      ],
      module: "https://attacker.invalid/component.js",
      registerComponent: "calendar",
    });
    const harness = createHarness(
      { status: "connected", epoch: 1 },
      {
        history: {
          messages: [
            {
              ...message(2),
              role: "toolResult",
              toolCallId: "tool-calendar",
              toolName: "calendar",
              details: { uiArtifacts: [artifact] },
            },
          ],
          completeSnapshot: true,
        },
      },
    );
    const { model, conversation } = await activatedConversation(harness);
    await vi.waitFor(() => expect(conversation.getSnapshot().artifacts).toHaveLength(1));
    expect(conversation.getSnapshot().artifacts[0]).toMatchObject({
      id: "artifact-calendar",
      revision: 1,
      state: "ready",
      source: { messageId: "message-2", toolCallId: "tool-calendar" },
      views: [
        { templateUri: "clawpilot://widgets/calendar" },
        { templateUri: "custom-view://vendor/unknown" },
      ],
    });
    expect(conversation.getSnapshot().artifacts[0]).not.toHaveProperty("module");
    expect(conversation.getSnapshot().messages[0]?.artifactIds).toEqual(["artifact-calendar"]);
    model.dispose();
  });

  it("reconciles live artifacts into persisted provenance and rejects forged source claims", async () => {
    const { harness, model, conversation } = await activatedConversation();
    const artifact = uiArtifact(1, {
      source: {
        sessionKey: "agent:main:one",
        messageId: "forged-message",
        toolCallId: "forged-tool",
        toolName: "forged-name",
      },
    });
    harness.emit({
      event: "agent",
      payload: {
        sessionKey: "agent:main:one",
        runId: "run-artifact",
        stream: "tool",
        data: {
          phase: "result",
          toolName: "calendar",
          uiArtifacts: [artifact],
        },
      },
    });
    expect(conversation.getSnapshot().artifacts[0]).toMatchObject({
      id: "artifact-calendar",
      state: "ready",
      source: {
        sessionKey: "agent:main:one",
        toolName: "calendar",
      },
    });
    expect(conversation.getSnapshot().artifacts[0]?.source).not.toHaveProperty("messageId");
    expect(conversation.getSnapshot().artifacts[0]?.source).not.toHaveProperty("toolCallId");

    harness.emit({
      event: "session.message",
      payload: {
        sessionKey: "agent:main:one",
        message: {
          ...message(2),
          role: "toolResult",
          toolCallId: "tool-calendar",
          toolName: "calendar",
          details: { uiArtifacts: [artifact] },
        },
      },
    });
    expect(conversation.getSnapshot().artifacts[0]).toMatchObject({
      id: "artifact-calendar",
      state: "ready",
      source: {
        sessionKey: "agent:main:one",
        messageId: "message-2",
        toolCallId: "tool-calendar",
        toolName: "calendar",
      },
    });
    expect(conversation.getSnapshot().artifacts[0]?.error).toBeUndefined();
    expect(conversation.getSnapshot().messages.at(-1)?.artifactIds).toEqual(["artifact-calendar"]);
    model.dispose();
  });

  it("materializes only the selected view and retires its data across epochs", async () => {
    const artifact = uiArtifact(4, {
      views: [
        {
          id: "calendar",
          templateUri: "clawpilot://widgets/calendar",
          dataVersion: 1,
          availability: "deferred",
        },
        {
          id: "list",
          templateUri: "clawpilot://widgets/list",
          dataVersion: 1,
          availability: "deferred",
        },
      ],
    });
    const harness = createHarness(
      { status: "connected", epoch: 1 },
      {
        history: {
          messages: [
            {
              ...message(2),
              role: "toolResult",
              details: { uiArtifacts: [artifact] },
            },
          ],
          completeSnapshot: true,
        },
      },
    );
    const { model, conversation } = await activatedConversation(harness);
    harness.queue("artifact.materialize", {
      artifactId: "artifact-calendar",
      artifactRevision: 4,
      view: {
        id: "list",
        templateUri: "clawpilot://widgets/list",
        dataVersion: 1,
        availability: "inline",
        data: { rows: [{ id: "one" }] },
      },
    });
    await expect(
      conversation.materializeView({
        artifactId: "artifact-calendar",
        artifactRevision: 4,
        viewId: "list",
      }),
    ).resolves.toMatchObject({ id: "list", availability: "inline" });
    expect(harness.callsFor("artifact.materialize")).toEqual([
      expect.objectContaining({
        params: {
          sessionKey: "agent:main:one",
          artifactId: "artifact-calendar",
          artifactRevision: 4,
          viewId: "list",
        },
      }),
    ]);
    expect(conversation.getSnapshot().artifacts[0]?.views).toMatchObject([
      { id: "calendar", availability: "deferred" },
      { id: "list", availability: "inline", data: { rows: [{ id: "one" }] } },
    ]);
    await expect(
      conversation.materializeView({
        artifactId: "artifact-calendar",
        artifactRevision: 3,
        viewId: "calendar",
      }),
    ).rejects.toMatchObject({ code: "STALE_ARTIFACT_REVISION" });
    expect(harness.callsFor("artifact.materialize")).toHaveLength(1);

    harness.setConnection({ status: "disconnected", epoch: 1 });
    await vi.waitFor(() =>
      expect(conversation.getSnapshot().artifacts[0]?.views[1]).toMatchObject({
        id: "list",
        availability: "deferred",
      }),
    );
    expect(conversation.getSnapshot().artifacts[0]?.views[1]).not.toHaveProperty("data");

    harness.setHistory(0, {
      messages: [
        {
          ...message(2),
          role: "toolResult",
          details: { uiArtifacts: [artifact] },
        },
      ],
      completeSnapshot: true,
    });
    harness.setConnection({ status: "connected", epoch: 2 });
    await vi.waitFor(() => expect(harness.callsFor("chat.history")).toHaveLength(2));
    expect(conversation.getSnapshot().artifacts[0]?.views[1]).toMatchObject({
      id: "list",
      availability: "deferred",
    });
    expect(conversation.getSnapshot().artifacts[0]?.views[1]).not.toHaveProperty("data");
    expect(harness.callsFor("artifact.materialize")).toHaveLength(1);

    harness.queue("artifact.materialize", {
      artifactId: "artifact-calendar",
      artifactRevision: 4,
      view: {
        id: "list",
        availability: "inline",
        templateUri: "clawpilot://widgets/list",
        dataVersion: 1,
        data: { rows: [{ id: "two" }] },
      },
    });
    await expect(
      conversation.materializeView({
        artifactId: "artifact-calendar",
        artifactRevision: 4,
        viewId: "list",
      }),
    ).resolves.toMatchObject({
      id: "list",
      availability: "inline",
      data: { rows: [{ id: "two" }] },
    });
    expect(harness.callsFor("artifact.materialize")).toHaveLength(2);
    expect(conversation.getSnapshot().artifacts[0]?.views[1]).toMatchObject({
      id: "list",
      availability: "inline",
      data: { rows: [{ id: "two" }] },
    });
    model.dispose();
  });

  it("rejects materialization when the selected same-revision view is invalidated", async () => {
    const artifact = uiArtifact(4, {
      views: [
        {
          id: "calendar",
          templateUri: "clawpilot://widgets/calendar",
          dataVersion: 1,
          availability: "deferred",
        },
      ],
    });
    const harness = createHarness(
      { status: "connected", epoch: 1 },
      {
        history: {
          messages: [
            {
              ...message(2),
              role: "toolResult",
              toolCallId: "tool-calendar",
              details: { uiArtifacts: [artifact] },
            },
          ],
          completeSnapshot: true,
        },
      },
    );
    const { model, conversation } = await activatedConversation(harness);
    const response = harness.defer("artifact.materialize");
    const materializing = conversation.materializeView({
      artifactId: "artifact-calendar",
      artifactRevision: 4,
      viewId: "calendar",
    });
    await flush();
    harness.emit({
      event: "agent",
      payload: {
        sessionKey: "agent:main:one",
        runId: "run-conflict",
        stream: "tool",
        data: {
          phase: "result",
          toolCallId: "tool-calendar",
          uiArtifacts: [uiArtifact(4, { structuredContent: { title: "conflict" } })],
        },
      },
    });
    expect(conversation.getSnapshot().artifacts[0]).toMatchObject({
      state: "failed",
      error: { code: "ARTIFACT_REVISION_CONFLICT" },
    });
    response.resolve({
      artifactId: "artifact-calendar",
      artifactRevision: 4,
      view: {
        id: "calendar",
        templateUri: "clawpilot://widgets/calendar",
        dataVersion: 1,
        availability: "inline",
        data: { events: [] },
      },
    });
    await expect(materializing).rejects.toMatchObject({ code: "STALE_ARTIFACT_VIEW" });
    expect(conversation.getSnapshot().artifacts[0]?.state).toBe("failed");
    model.dispose();
  });

  it("does not associate source-less artifacts with unrelated identity-less messages", async () => {
    const { harness, model, conversation } = await activatedConversation();
    harness.emit({
      event: "session.message",
      payload: {
        sessionKey: "agent:main:one",
        message: { role: "assistant", content: "identity-less" },
      },
    });
    harness.emit({
      event: "agent",
      payload: {
        sessionKey: "agent:main:one",
        runId: "run-artifact",
        stream: "tool",
        data: {
          phase: "result",
          toolCallId: "tool-calendar",
          uiArtifacts: [
            uiArtifact(1, {
              source: { sessionKey: "agent:main:one" },
            }),
          ],
        },
      },
    });
    expect(conversation.getSnapshot().artifacts).toHaveLength(1);
    expect(conversation.getSnapshot().messages.at(-1)?.artifactIds).toEqual([]);
    model.dispose();
  });

  it("reconciles artifact revisions, conflicts, bounds, and reconnect history", async () => {
    const harness = createHarness(
      { status: "connected", epoch: 1 },
      {
        history: {
          messages: [
            {
              ...message(2),
              role: "toolResult",
              details: { uiArtifacts: [uiArtifact(2)] },
            },
          ],
          completeSnapshot: true,
        },
      },
    );
    const { model, conversation } = await activatedConversation(harness, {
      maxConversationArtifacts: 2,
    });
    harness.emit({
      event: "agent",
      payload: {
        sessionKey: "agent:main:one",
        runId: "run-artifacts",
        stream: "tool",
        data: {
          phase: "result",
          toolCallId: "tool-calendar",
          uiArtifacts: [uiArtifact(1), uiArtifact(2, { structuredContent: { title: "conflict" } })],
        },
      },
    });
    expect(conversation.getSnapshot().artifacts[0]).toMatchObject({
      revision: 2,
      state: "failed",
      error: { code: "ARTIFACT_REVISION_CONFLICT" },
    });
    harness.emit({
      event: "agent",
      payload: {
        sessionKey: "agent:main:one",
        runId: "run-artifacts",
        stream: "tool",
        data: {
          phase: "result",
          toolCallId: "tool-calendar",
          uiArtifacts: [
            uiArtifact(3),
            uiArtifact(1, { id: "artifact-two" }),
            uiArtifact(1, { id: "artifact-three" }),
          ],
        },
      },
    });
    expect(conversation.getSnapshot().artifacts).toHaveLength(2);
    expect(conversation.getSnapshot().artifacts.map((artifact) => artifact.id)).toContain(
      "artifact-calendar",
    );
    expect(conversation.getSnapshot().bounds.artifactsTruncated).toBe(true);
    harness.emit({
      event: "session.message",
      payload: {
        sessionKey: "agent:main:one",
        message: {
          ...message(4),
          role: "toolResult",
          details: { uiArtifacts: [uiArtifact(4, { id: "artifact-retired-live" })] },
        },
      },
    });
    expect(conversation.getSnapshot().artifacts.map((artifact) => artifact.id)).toContain(
      "artifact-retired-live",
    );

    harness.setHistory(0, {
      messages: [
        {
          ...message(2),
          role: "toolResult",
          details: { uiArtifacts: [uiArtifact(3)] },
        },
      ],
      completeSnapshot: true,
    });
    harness.setConnection({ status: "connected", epoch: 2 });
    await vi.waitFor(() => expect(harness.callsFor("chat.history")).toHaveLength(2));
    await vi.waitFor(() =>
      expect(conversation.getSnapshot().artifacts).toEqual([
        expect.objectContaining({ id: "artifact-calendar", revision: 3, state: "ready" }),
      ]),
    );
    model.dispose();
  });

  it("adapts MCP App metadata and contains malformed artifact failure", async () => {
    const malformed = uiArtifact(1, {
      id: "artifact-malformed",
      structuredContent: { invalid: () => undefined },
    });
    const oversized = uiArtifact(1, {
      id: "artifact-oversized",
      structuredContent: {
        values: Array.from({ length: 100 }, () => "x".repeat(1_000)),
      },
    });
    const expired = uiArtifact(2, {
      id: "artifact-expired",
      state: "expired",
      error: { code: "ARTIFACT_EXPIRED", message: "The interactive view expired" },
    });
    const harness = createHarness(
      { status: "connected", epoch: 1 },
      {
        history: {
          messages: [
            {
              ...message(2),
              role: "toolResult",
              toolCallId: "call-1",
              toolName: "show",
              details: {
                structuredContent: { title: "MCP result" },
                mcpAppPreview: {
                  kind: "canvas",
                  view: { id: "mcp-app-view" },
                  mcpApp: {
                    viewId: "mcp-app-view",
                    serverName: "demo",
                    toolName: "show",
                    uiResourceUri: "ui://demo/calendar",
                    toolCallId: "call-1",
                  },
                },
                uiArtifacts: [malformed, oversized, expired],
              },
            },
          ],
          completeSnapshot: true,
        },
      },
    );
    const { model, conversation } = await activatedConversation(harness);
    await vi.waitFor(() => expect(conversation.getSnapshot().artifacts).toHaveLength(4));
    expect(conversation.getSnapshot().artifacts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "artifact-malformed",
          state: "failed",
          error: expect.objectContaining({ code: "ARTIFACT_MALFORMED" }),
        }),
        expect.objectContaining({
          id: "artifact-oversized",
          state: "failed",
          error: expect.objectContaining({ code: "ARTIFACT_OVERSIZED" }),
        }),
        expect.objectContaining({
          id: "artifact-expired",
          state: "expired",
          error: { code: "ARTIFACT_EXPIRED", message: "The interactive view expired" },
        }),
        expect.objectContaining({
          id: "mcp-app:call-1",
          structuredContent: { title: "MCP result" },
          views: [
            expect.objectContaining({
              templateUri: "ui://demo/calendar",
              availability: "inline",
              fallback: {
                kind: "mcp-app",
                viewId: "mcp-app-view",
                uiResourceUri: "ui://demo/calendar",
              },
            }),
          ],
        }),
      ]),
    );
    model.dispose();
  });

  it("bounds artifact candidate collection before normalization", () => {
    const artifacts = collectMessageUiArtifacts(
      {
        role: "toolResult",
        details: {
          uiArtifacts: Array.from({ length: 20 }, (_, index) =>
            uiArtifact(index + 1, { id: `artifact-${index + 1}` }),
          ),
        },
      },
      {
        sessionKey: "agent:main:one",
        messageId: "message-bounded",
        toolCallId: "tool-bounded",
      },
      {
        maxArtifacts: 2,
        maxBytes: 64_000,
        maxDepth: 12,
        maxCollectionItems: 256,
        maxStringBytes: 16_000,
        maxViews: 16,
      },
      3,
    );
    expect(artifacts.map((artifact) => artifact.id)).toEqual([
      "artifact-1",
      "artifact-2",
      "artifact-3",
    ]);
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
    const firstMessage = snapshot.messages[0];
    if (!firstMessage) {
      throw new Error("Expected a projected message");
    }
    expect(Object.isFrozen((firstMessage.raw as { nested?: unknown }).nested)).toBe(true);
    expect(later).not.toHaveBeenCalled();
    model.dispose();
  });
});

/* oxlint-disable max-lines -- TODO: split this grandfathered conversation test suite. */
