import { describe, expect, it, vi } from "vitest";
import {
  createChatAbortMarker,
  createChatRunState,
  createSessionMessageSubscriberRegistry,
} from "./server-chat-state.js";

describe("createChatRunState", () => {
  it.each([false, true])(
    "stops returning finalized recipients at expiry (other state: %s)",
    (keepState) => {
      let now = 1_000;
      const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
      try {
        const state = createChatRunState();
        state.toolEventRecipients.add("finished", "conn-finished");
        state.toolEventRecipients.add("active", "conn-active");
        if (keepState) {
          state.getOrCreate("finished").buffer = "retained";
        }
        state.toolEventRecipients.markFinal("finished");
        now += 29_999;
        expect(state.toolEventRecipients.get("finished")).toEqual(new Set(["conn-finished"]));
        now += 1;
        expect(state.toolEventRecipients.get("finished")).toBeUndefined();
        expect(state.toolEventRecipients.get("finished")).toBeUndefined();
        expect(state.toolEventRecipients.get("active")).toEqual(new Set(["conn-active"]));
        expect(state.runs.has("finished")).toBe(keepState);
      } finally {
        clock.mockRestore();
      }
    },
  );

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

  it.each(["full", "summary"] as const)(
    "retains the latest usage through %s reconnect eviction",
    (mode) => {
      const state = createChatRunState();
      const event = (seq: number, stream: string, data: Record<string, unknown>) =>
        state.recordProgressEvent("run-1", { runId: "run-1", seq, stream, ts: seq, data }, mode);
      event(1, "usage", { outputTokens: 100 });
      event(2, "usage", { outputTokens: 170 });
      event(1, "usage", { outputTokens: 100 });
      event(3, "usage", { activeContextTokens: 900 });
      for (let seq = 4; seq < 65; seq += 1) {
        event(seq, "tool", { phase: "start", toolCallId: `tool-${seq}`, name: "read" });
      }
      const snapshot = state.runs.get("run-1")?.progressSnapshot;
      expect(snapshot?.events.filter((candidate) => candidate.stream === "usage")).toEqual([
        {
          runId: "run-1",
          seq: 3,
          stream: "usage",
          ts: 3,
          data: { outputTokens: 170, activeContextTokens: 900 },
        },
      ]);
      expect(snapshot?.events).toHaveLength(50);
      expect(snapshot?.byteLength).toBeLessThanOrEqual(128 * 1024);
      state.clearRun("run-1");
      expect(state.runs.has("run-1")).toBe(false);
    },
  );

  it.each(["naming_worktree", "creating_worktree", "running_setup", "preparing_context"])(
    "retains only the latest startup status (%s) until observable run activity begins",
    (phase) => {
      const state = createChatRunState();
      const event = (seq: number, stream: string, data: Record<string, unknown>) =>
        state.recordProgressEvent("run-1", {
          runId: "run-1",
          seq,
          stream,
          ts: 1_000 + seq,
          sessionKey: "main",
          data,
        });

      event(1, "run_status", { phase: "preparing_workspace" });
      event(2, "run_status", { phase });
      expect(state.runs.get("run-1")?.progressSnapshot?.events).toMatchObject([
        { seq: 2, stream: "run_status", data: { phase } },
      ]);

      event(3, "tool", { phase: "start", name: "read", toolCallId: "read-1" });
      event(4, "run_status", { phase: "starting_model" });
      expect(state.runs.get("run-1")?.progressSnapshot?.events).toMatchObject([
        { seq: 3, stream: "tool", data: { phase: "start", toolCallId: "read-1" } },
      ]);
    },
  );

  it("keeps completed owners and standalone notices reconstructable until bounded eviction", () => {
    const state = createChatRunState();
    const event = (seq: number, stream: string, data: Record<string, unknown>) =>
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
      phase: "input_delta",
      name: "edit",
      toolCallId: "active",
      diff: { added: 3, removed: 1 },
    });
    event(4, "tool", {
      phase: "update",
      name: "read",
      toolCallId: "active",
      partialResult: "halfway",
    });
    event(5, "tool", {
      phase: "review",
      toolCallId: "active",
      review: { id: "review-1", label: "Guardian", status: "in_progress" },
    });
    event(6, "tool", {
      phase: "review",
      toolCallId: "active",
      review: { id: "review-1", label: "Guardian", status: "approved" },
    });
    event(7, "tool", {
      phase: "review",
      toolCallId: "active",
      review: { id: "review-2", label: "Guardian", status: "denied" },
    });
    event(8, "tool", { phase: "start", name: "exec", toolCallId: "done", args: {} });
    event(9, "tool", {
      phase: "result",
      name: "exec",
      toolCallId: "done",
      result: "x".repeat(256_000),
    });
    event(10, "item", {
      kind: "preamble",
      itemId: "p-1",
      progressText: "Inspection complete",
    });
    event(11, "item", {
      kind: "preamble",
      itemId: "p-2",
      progressText: "Running autoreview",
    });
    event(4, "tool", { phase: "result", name: "read", toolCallId: "active" });

    expect(state.runs.get("run-1")?.progressSnapshot?.events).toMatchObject([
      { seq: 2, stream: "tool", data: { phase: "start", toolCallId: "active" } },
      {
        seq: 3,
        stream: "tool",
        data: { phase: "input_delta", toolCallId: "active", diff: { added: 3, removed: 1 } },
      },
      { seq: 4, stream: "tool", data: { phase: "update", toolCallId: "active" } },
      {
        seq: 6,
        stream: "tool",
        data: {
          phase: "review",
          toolCallId: "active",
          review: { id: "review-1", status: "approved" },
        },
      },
      {
        seq: 7,
        stream: "tool",
        data: {
          phase: "review",
          toolCallId: "active",
          review: { id: "review-2", status: "denied" },
        },
      },
      { seq: 8, stream: "tool", data: { phase: "start", toolCallId: "done" } },
      { seq: 9, stream: "tool", data: { phase: "result", toolCallId: "done" } },
      {
        seq: 10,
        stream: "item",
        ts: 1_001,
        data: { itemId: "p-1", progressText: "Inspection complete" },
      },
      { seq: 11, stream: "item", data: { itemId: "p-2", progressText: "Running autoreview" } },
    ]);

    event(12, "tool", { phase: "result", name: "read", toolCallId: "active" });
    expect(
      state.runs
        .get("run-1")
        ?.progressSnapshot?.events.filter((candidate) => candidate.data.toolCallId === "active")
        .map((candidate) => candidate.data.phase),
    ).toEqual(["start", "input_delta", "update", "review", "review", "result"]);

    event(13, "codex_app_server.guardian", {
      phase: "completed",
      reviewId: "targeted-review",
      targetItemId: "active",
      status: "approved",
    });
    event(14, "codex_app_server.guardian", {
      phase: "warning",
      message: "Guardian rejection limit reached; ending turn as interrupted.",
    });
    event(15, "codex_app_server.guardian", {
      phase: "completed",
      reviewId: "network-review",
      targetItemId: null,
      status: "denied",
    });
    expect(state.runs.get("run-1")?.progressSnapshot?.events.slice(-2)).toMatchObject([
      { seq: 14, data: { phase: "warning" } },
      { seq: 15, data: { reviewId: "network-review", targetItemId: null } },
    ]);

    for (let seq = 16; seq <= 78; seq += 1) {
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
      toolCallId: "tool-78",
    });
  });

  it("keeps a review-heavy reconnect bounded, adverse, and attached to its owner", () => {
    const state = createChatRunState();
    const event = (seq: number, data: Record<string, unknown>) =>
      state.recordProgressEvent("run-1", {
        runId: "run-1",
        seq,
        stream: "tool",
        ts: 1_000 + seq,
        data,
      });
    event(1, {
      phase: "start",
      name: "exec",
      toolCallId: "reviewed",
      args: { command: "printf reviewed" },
    });
    for (let index = 0; index < 60; index += 1) {
      event(index + 2, {
        phase: "review",
        toolCallId: "reviewed",
        approvalReviewOutcome: "denied",
        review: {
          id: `review-${index}`,
          label: "Guardian",
          status: index === 0 ? "denied" : "approved",
        },
      });
    }

    const events = state.runs.get("run-1")?.progressSnapshot?.events ?? [];
    expect(events[0]?.data).toMatchObject({ phase: "start", toolCallId: "reviewed" });
    const reviews = events.filter((candidate) => candidate.data.phase === "review");
    expect(reviews).toHaveLength(16);
    expect(reviews.map((candidate) => candidate.data.review)).toEqual(
      Array.from({ length: 16 }, (_, index) =>
        expect.objectContaining({ id: `review-${index + 44}` }),
      ),
    );
    expect(reviews.at(-1)?.data.approvalReviewOutcome).toBe("denied");
    expect(
      events.every(
        (candidate) =>
          candidate.data.phase === "start" ||
          events.some(
            (owner) =>
              owner.data.phase === "start" && owner.data.toolCallId === candidate.data.toolCallId,
          ),
      ),
    ).toBe(true);
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
    expect([...subscribers.get("agent:main:main")]).toEqual([]);
    expect([...subscribers.getApprovals("agent:main:main")]).toEqual([]);
    expect([...subscribers.get("agent:main:child")]).toEqual(["conn-other"]);
    expect([...subscribers.getApprovals("agent:main:child")]).toEqual(["conn-other"]);
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

      expect([...subscribers.get("agent:main:other")]).toEqual(["conn"]);
      expect([...subscribers.get("agent:main:main")]).toEqual(["conn"]);
    },
  );

  it("retains the committed recency when a re-subscribe replay fails", () => {
    const subscribers = createSessionMessageSubscriberRegistry();
    subscribers.subscribe("conn", "agent:main:main");
    subscribers.subscribe("conn", "agent:main:child");
    const rollback = subscribers.subscribe("conn", "agent:main:main", { provisional: true })!;

    rollback();

    expect([...subscribers.get("agent:main:main")]).toEqual(["conn"]);
    expect([...subscribers.get("agent:main:child")]).toEqual(["conn"]);
  });

  it("does not restore a replay invalidated by unsubscribe", () => {
    const subscribers = createSessionMessageSubscriberRegistry();
    const subscription = subscribers.subscribe("conn", "agent:main:main", {
      provisional: true,
    })!;

    subscribers.unsubscribe("conn", "agent:main:main");
    subscription.commit();

    expect([...subscribers.get("agent:main:main")]).toEqual([]);
  });
});
