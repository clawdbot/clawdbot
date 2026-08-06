import { describe, expect, it } from "vitest";
import {
  createChatAbortMarker,
  createChatRunState,
  createSessionMessageSubscriberRegistry,
} from "./server-chat-state.js";

describe("createChatRunState", () => {
  it("clears transient projection state without dropping run ownership or abort tombstones", () => {
    const state = createChatRunState();
    state.registry.add("run-1", { sessionKey: "session-1", clientRunId: "client-1" });
    state.toolEventRecipients.add("run-1", "conn-1");
    const run = state.getOrCreate("run-1");
    Object.assign(run, {
      rawBuffer: "raw",
      buffer: "projected",
      planSnapshot: { steps: [{ step: "Inspect", status: "in_progress" }] },
      bufferUpdatedAt: 1,
      deltaSentAt: 2,
      deltaLastBroadcastLen: 9,
      deltaLastBroadcastText: "projected",
      agentText: { assistant: { lastSentAt: 3 } },
      abortMarker: createChatAbortMarker(4),
    });
    state.recordProgressEvent("run-1", {
      runId: "run-1",
      seq: 1,
      stream: "item",
      ts: 1,
      data: { kind: "preamble", progressText: "Inspecting" },
    });

    state.clearRun("run-1");

    expect(state.registry.peek("run-1")?.clientRunId).toBe("client-1");
    expect(state.toolEventRecipients.get("run-1")).toEqual(new Set(["conn-1"]));
    expect(state.runs.get("run-1")).toEqual({
      registrations: expect.any(Array),
      abortMarker: expect.any(Object),
      toolRecipient: expect.any(Object),
    });
  });

  it("keeps first-registration and first-record iteration order stable across updates", () => {
    const state = createChatRunState();
    state.registry.add("run-b", { sessionKey: "session-b", clientRunId: "client-b-1" });
    state.registry.add("run-a", { sessionKey: "session-a", clientRunId: "client-a" });
    state.registry.add("run-b", { sessionKey: "session-b", clientRunId: "client-b-2" });
    state.getOrCreate("run-b").buffer = "updated";

    expect([...state.runs.keys()]).toEqual(["run-b", "run-a"]);
    expect(state.registry.shift("run-b")?.clientRunId).toBe("client-b-1");
    expect(state.registry.shift("run-b")?.clientRunId).toBe("client-b-2");
  });

  it("keeps bounded active progress ordered and removes completed tools", () => {
    const state = createChatRunState();
    const event = (seq: number, stream: "item" | "tool", data: Record<string, unknown>) =>
      state.recordProgressEvent("run-1", {
        runId: "run-1",
        seq,
        stream,
        ts: 1_000 + seq,
        sessionKey: "main",
        data,
      });

    event(1, "item", { kind: "preamble", itemId: "p-1", progressText: "Inspecting" });
    event(2, "tool", {
      phase: "start",
      name: "read",
      toolCallId: "active",
      args: { path: "a" },
    });
    event(3, "tool", {
      phase: "update",
      name: "read",
      toolCallId: "active",
      partialResult: "halfway",
    });
    event(4, "tool", { phase: "start", name: "exec", toolCallId: "done", args: {} });
    event(5, "tool", {
      phase: "result",
      name: "exec",
      toolCallId: "done",
      result: "x".repeat(256_000),
    });
    event(3, "tool", { phase: "result", name: "read", toolCallId: "active" });

    expect(state.runs.get("run-1")?.progressSnapshot?.events).toMatchObject([
      { seq: 1, stream: "item", data: { itemId: "p-1", progressText: "Inspecting" } },
      { seq: 2, stream: "tool", data: { phase: "start", toolCallId: "active" } },
      { seq: 3, stream: "tool", data: { phase: "update", toolCallId: "active" } },
    ]);

    for (let seq = 6; seq <= 70; seq += 1) {
      event(seq, "tool", {
        phase: "start",
        name: "read",
        toolCallId: `tool-${seq}`,
        args: { payload: "y".repeat(80_000) },
      });
    }
    const snapshot = state.runs.get("run-1")?.progressSnapshot;
    expect(snapshot?.events).toHaveLength(50);
    expect(snapshot?.byteLength).toBeLessThanOrEqual(128 * 1024);
    expect(snapshot?.events.at(-1)?.data).toEqual({
      phase: "start",
      name: "read",
      toolCallId: "tool-70",
    });
  });
});

describe("createSessionMessageSubscriberRegistry", () => {
  it("keeps approval delivery opt-in and updates it on resubscribe", () => {
    const subscribers = createSessionMessageSubscriberRegistry();

    subscribers.subscribe("conn-plain", "agent:main:main");
    subscribers.subscribe("conn-reviewer", "agent:main:main", { includeApprovals: true });

    expect([...subscribers.get("agent:main:main")]).toEqual(["conn-plain", "conn-reviewer"]);
    expect([...subscribers.getApprovals("agent:main:main")]).toEqual(["conn-reviewer"]);

    subscribers.subscribe("conn-reviewer", "agent:main:main");
    expect([...subscribers.get("agent:main:main")]).toEqual(["conn-plain", "conn-reviewer"]);
    expect([...subscribers.getApprovals("agent:main:main")]).toEqual([]);

    subscribers.subscribe("conn-reviewer", "agent:main:main", { includeApprovals: true });
    expect([...subscribers.getApprovals("agent:main:main")]).toEqual(["conn-reviewer"]);

    subscribers.unsubscribe("conn-reviewer", "agent:main:main");
    expect([...subscribers.get("agent:main:main")]).toEqual(["conn-plain"]);
    expect([...subscribers.getApprovals("agent:main:main")]).toEqual([]);
  });

  it("removes approval subscriptions through connection cleanup and registry reset", () => {
    const subscribers = createSessionMessageSubscriberRegistry();

    subscribers.subscribe("conn-reviewer", "agent:main:main", { includeApprovals: true });
    subscribers.subscribe("conn-reviewer", "agent:main:child", { includeApprovals: true });
    subscribers.subscribe("conn-other", "agent:main:child", { includeApprovals: true });

    subscribers.unsubscribeAll("conn-reviewer");
    expect([...subscribers.getForConnection("conn-reviewer")]).toEqual([]);
    expect([...subscribers.get("agent:main:main")]).toEqual([]);
    expect([...subscribers.getApprovals("agent:main:main")]).toEqual([]);
    expect([...subscribers.get("agent:main:child")]).toEqual(["conn-other"]);
    expect([...subscribers.getApprovals("agent:main:child")]).toEqual(["conn-other"]);

    subscribers.clear();
    expect([...subscribers.get("agent:main:child")]).toEqual([]);
    expect([...subscribers.getApprovals("agent:main:child")]).toEqual([]);
  });

  it.each(["first", "second"])(
    "removes a first-time subscription when both concurrent replays fail (%s rollback first)",
    (firstRollback) => {
      const subscribers = createSessionMessageSubscriberRegistry();
      const first = subscribers.subscribe("conn", "agent:main:main", { provisional: true })!;
      const second = subscribers.subscribe("conn", "agent:main:main", { provisional: true })!;

      if (firstRollback === "first") {
        first();
        second();
      } else {
        second();
        first();
      }

      expect([...subscribers.get("agent:main:main")]).toEqual([]);
      expect([...subscribers.getForConnection("conn")]).toEqual([]);
    },
  );

  it.each(["first", "second"])(
    "keeps the successful concurrent replay recency (%s resolution first)",
    (firstResolution) => {
      const subscribers = createSessionMessageSubscriberRegistry();
      subscribers.subscribe("conn", "agent:main:other");
      const first = subscribers.subscribe("conn", "agent:main:main", { provisional: true })!;
      const second = subscribers.subscribe("conn", "agent:main:main", { provisional: true })!;

      if (firstResolution === "first") {
        first();
        second.commit();
      } else {
        second.commit();
        first();
      }

      expect([...subscribers.getForConnection("conn")]).toEqual([
        "agent:main:other",
        "agent:main:main",
      ]);
    },
  );

  it("retains the committed recency when a re-subscribe replay fails", () => {
    const subscribers = createSessionMessageSubscriberRegistry();
    subscribers.subscribe("conn", "agent:main:main");
    subscribers.subscribe("conn", "agent:main:child");
    const rollback = subscribers.subscribe("conn", "agent:main:main", { provisional: true })!;

    rollback();

    expect([...subscribers.getForConnection("conn")]).toEqual([
      "agent:main:main",
      "agent:main:child",
    ]);
  });

  it("does not restore a replay invalidated by unsubscribe", () => {
    const subscribers = createSessionMessageSubscriberRegistry();
    const subscription = subscribers.subscribe("conn", "agent:main:main", {
      provisional: true,
    })!;

    subscribers.unsubscribe("conn", "agent:main:main");
    subscription.commit();

    expect([...subscribers.getForConnection("conn")]).toEqual([]);
    expect([...subscribers.get("agent:main:main")]).toEqual([]);
  });
});
