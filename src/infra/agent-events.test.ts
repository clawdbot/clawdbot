import { beforeEach, describe, expect, test, vi } from "vitest";
import {
  clearAgentRunContext,
  emitAgentEvent,
  getAgentRunContext,
  onAgentEvent,
  registerAgentRunContext,
  resetAgentEventsForTest,
  resetAgentRunContextForTest,
  sweepStaleRunContexts,
} from "./agent-events.js";

type AgentEventsModule = typeof import("./agent-events.js");

const agentEventsModuleUrl = new URL("./agent-events.ts", import.meta.url).href;

async function importAgentEventsModule(cacheBust: string): Promise<AgentEventsModule> {
  return (await import(`${agentEventsModuleUrl}?t=${cacheBust}`)) as AgentEventsModule;
}

describe("agent-events sequencing", () => {
  beforeEach(() => {
    resetAgentEventsForTest();
  });

  test("stores and clears run context", async () => {
    registerAgentRunContext("run-1", { sessionKey: "main" });
    expect(getAgentRunContext("run-1")?.sessionKey).toBe("main");
    clearAgentRunContext("run-1");
    expect(getAgentRunContext("run-1")).toBeUndefined();
  });

  test("maintains monotonic seq per runId", async () => {
    const seen: Record<string, number[]> = {};
    const stop = onAgentEvent((evt) => {
      const list = seen[evt.runId] ?? [];
      seen[evt.runId] = list;
      list.push(evt.seq);
    });

    emitAgentEvent({ runId: "run-1", stream: "lifecycle", data: {} });
    emitAgentEvent({ runId: "run-1", stream: "lifecycle", data: {} });
    emitAgentEvent({ runId: "run-2", stream: "lifecycle", data: {} });
    emitAgentEvent({ runId: "run-1", stream: "lifecycle", data: {} });

    stop();

    expect(seen["run-1"]).toEqual([1, 2, 3]);
    expect(seen["run-2"]).toEqual([1]);
  });

  test("preserves compaction ordering on the event bus", async () => {
    const phases: Array<string> = [];
    const stop = onAgentEvent((evt) => {
      if (evt.runId !== "run-1") {
        return;
      }
      if (evt.stream !== "compaction") {
        return;
      }
      if (typeof evt.data?.phase === "string") {
        phases.push(evt.data.phase);
      }
    });

    emitAgentEvent({ runId: "run-1", stream: "compaction", data: { phase: "start" } });
    emitAgentEvent({
      runId: "run-1",
      stream: "compaction",
      data: { phase: "end", willRetry: false },
    });

    stop();

    expect(phases).toEqual(["start", "end"]);
  });

  test("omits sessionKey for non-lifecycle runs hidden from Control UI", async () => {
    resetAgentRunContextForTest();
    registerAgentRunContext("run-hidden", {
      sessionKey: "session-quietchat",
      isControlUiVisible: false,
    });

    let receivedSessionKey: string | undefined;
    const stop = onAgentEvent((evt) => {
      receivedSessionKey = evt.sessionKey;
    });
    emitAgentEvent({
      runId: "run-hidden",
      stream: "assistant",
      data: { text: "hi" },
      sessionKey: "session-quietchat",
    });
    stop();

    expect(receivedSessionKey).toBeUndefined();
  });

  test("preserves sessionKey for lifecycle events hidden from Control UI", async () => {
    resetAgentRunContextForTest();
    registerAgentRunContext("run-hidden-lifecycle", {
      sessionKey: "session-quietchat",
      isControlUiVisible: false,
    });

    let receivedSessionKey: string | undefined;
    const stop = onAgentEvent((evt) => {
      receivedSessionKey = evt.sessionKey;
    });
    emitAgentEvent({
      runId: "run-hidden-lifecycle",
      stream: "lifecycle",
      data: { phase: "end" },
      sessionKey: "session-quietchat",
    });
    stop();

    expect(receivedSessionKey).toBe("session-quietchat");
  });

  test("falls back to registered sessionKey for hidden lifecycle events", async () => {
    resetAgentRunContextForTest();
    registerAgentRunContext("run-hidden-lifecycle-context", {
      sessionKey: "session-quietchat-context",
      isControlUiVisible: false,
    });

    let receivedSessionKey: string | undefined;
    const stop = onAgentEvent((evt) => {
      receivedSessionKey = evt.sessionKey;
    });
    emitAgentEvent({
      runId: "run-hidden-lifecycle-context",
      stream: "lifecycle",
      data: { phase: "error", error: "boom" },
    });
    stop();

    expect(receivedSessionKey).toBe("session-quietchat-context");
  });

  test("merges later run context updates into existing runs", async () => {
    resetAgentRunContextForTest();
    registerAgentRunContext("run-ctx", {
      sessionKey: "session-main",
      isControlUiVisible: true,
    });
    registerAgentRunContext("run-ctx", {
      verboseLevel: "full",
      isHeartbeat: true,
      lastActiveAt: 12_345,
    });

    expect(getAgentRunContext("run-ctx")).toMatchObject({
      sessionKey: "session-main",
      verboseLevel: "full",
      isHeartbeat: true,
      isControlUiVisible: true,
      lastActiveAt: 12_345,
    });
  });

  test("falls back to registered sessionKey when event sessionKey is blank", async () => {
    resetAgentRunContextForTest();
    registerAgentRunContext("run-ctx", { sessionKey: "session-main" });

    let receivedSessionKey: string | undefined;
    const stop = onAgentEvent((evt) => {
      receivedSessionKey = evt.sessionKey;
    });
    emitAgentEvent({
      runId: "run-ctx",
      stream: "assistant",
      data: { text: "hi" },
      sessionKey: "   ",
    });
    stop();

    expect(receivedSessionKey).toBe("session-main");
  });

  test("keeps notifying later listeners when one throws", async () => {
    const seen: string[] = [];
    const stopBad = onAgentEvent(() => {
      throw new Error("boom");
    });
    const stopGood = onAgentEvent((evt) => {
      seen.push(evt.runId);
    });

    expect(() =>
      emitAgentEvent({
        runId: "run-safe",
        stream: "assistant",
        data: { text: "hi" },
      }),
    ).not.toThrow();

    stopGood();
    stopBad();

    expect(seen).toEqual(["run-safe"]);
  });

  test("shares run context, listeners, and sequence state across duplicate module instances", async () => {
    const first = await importAgentEventsModule(`first-${Date.now()}`);
    const second = await importAgentEventsModule(`second-${Date.now()}`);

    first.resetAgentEventsForTest();
    first.registerAgentRunContext("run-dup", { sessionKey: "session-dup" });

    const seen: Array<{ seq: number; sessionKey?: string }> = [];
    const stop = first.onAgentEvent((evt) => {
      if (evt.runId === "run-dup") {
        seen.push({ seq: evt.seq, sessionKey: evt.sessionKey });
      }
    });

    second.emitAgentEvent({
      runId: "run-dup",
      stream: "assistant",
      data: { text: "from second" },
      sessionKey: "   ",
    });
    first.emitAgentEvent({
      runId: "run-dup",
      stream: "assistant",
      data: { text: "from first" },
      sessionKey: "   ",
    });

    stop();

    expect(second.getAgentRunContext("run-dup")).toMatchObject({ sessionKey: "session-dup" });
    expect(seen).toEqual([
      { seq: 1, sessionKey: "session-dup" },
      { seq: 2, sessionKey: "session-dup" },
    ]);

    first.resetAgentEventsForTest();
  });

  test("sweeps stale run contexts and clears their sequence state", async () => {
    const stop = vi.spyOn(Date, "now");
    stop.mockReturnValue(100);
    registerAgentRunContext("run-stale", { sessionKey: "session-stale", registeredAt: 100 });
    registerAgentRunContext("run-active", { sessionKey: "session-active", registeredAt: 100 });

    stop.mockReturnValue(200);
    emitAgentEvent({ runId: "run-stale", stream: "assistant", data: { text: "stale" } });

    stop.mockReturnValue(900);
    emitAgentEvent({ runId: "run-active", stream: "assistant", data: { text: "active" } });

    stop.mockReturnValue(1_000);
    expect(sweepStaleRunContexts(500)).toBe(1);
    expect(getAgentRunContext("run-stale")).toBeUndefined();
    expect(getAgentRunContext("run-active")).toMatchObject({ sessionKey: "session-active" });

    const seen: Array<{ runId: string; seq: number }> = [];
    const unsubscribe = onAgentEvent((evt) => {
      if (evt.runId === "run-stale" || evt.runId === "run-active") {
        seen.push({ runId: evt.runId, seq: evt.seq });
      }
    });

    emitAgentEvent({ runId: "run-stale", stream: "assistant", data: { text: "restarted" } });
    emitAgentEvent({ runId: "run-active", stream: "assistant", data: { text: "continued" } });

    unsubscribe();
    stop.mockRestore();

    expect(seen).toEqual([
      { runId: "run-stale", seq: 1 },
      { runId: "run-active", seq: 2 },
    ]);
  });
});

test("clearAgentRunContext also cleans up seqByRun to prevent memory leak (#63643)", () => {
  // Regression test: seqByRun entries were never deleted when a run ended,
  // causing unbounded growth over time.
  registerAgentRunContext("run-leak", { sessionKey: "main" });
  emitAgentEvent({ runId: "run-leak", stream: "lifecycle", data: {} });
  emitAgentEvent({ runId: "run-leak", stream: "lifecycle", data: {} });

  // After clearing run context, the sequence counter should also be removed.
  clearAgentRunContext("run-leak");

  // Emitting a new event on the same runId should start seq from 1 again,
  // proving the old entry was deleted.
  const seqs: number[] = [];
  const stop = onAgentEvent((evt) => {
    if (evt.runId === "run-leak") {
      seqs.push(evt.seq);
    }
  });
  emitAgentEvent({ runId: "run-leak", stream: "lifecycle", data: {} });
  stop();

  expect(seqs).toEqual([1]);
});
