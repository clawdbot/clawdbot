import { describe, expect, it } from "vitest";
import type { EmbeddedAgentRunResult } from "../../agents/embedded-agent.js";
import {
  classifyNoOpRearmTurnOutcome,
  classifyNoOpRearmWake,
  NoOpRearmGuard,
  type NoOpRearmWakeClass,
  type NoOpRearmWakeInput,
  resolveNoOpRearmKey,
  summarizeEmbeddedRunOutcome,
} from "./no-op-rearm-guard.js";

function roomEventWake(overrides: Partial<NoOpRearmWakeInput> = {}): NoOpRearmWakeInput {
  return {
    sessionKey: "agent:main:discord:channel:000000000000000001",
    inboundEventKind: "room_event",
    ...overrides,
  };
}

function freshHumanWake(overrides: Partial<NoOpRearmWakeInput> = {}): NoOpRearmWakeInput {
  return {
    sessionKey: "agent:main:discord:channel:000000000000000001",
    inboundEventKind: "user_request",
    provenance: { kind: "external_user" },
    messageId: "msg-1",
    ...overrides,
  };
}

function continuationWake(overrides: Partial<NoOpRearmWakeInput> = {}): NoOpRearmWakeInput {
  return {
    sessionKey: "agent:main:discord:channel:000000000000000001",
    isContinuationWake: true,
    ...overrides,
  };
}

function noOpResult(toolNames: string[] = ["continue_work"]): EmbeddedAgentRunResult {
  return {
    payloads: [],
    meta: { durationMs: 1, toolSummary: { calls: toolNames.length, tools: toolNames } },
  };
}

function blankWithSubstantiveToolResult(): EmbeddedAgentRunResult {
  // Textless assistant turn that made a real tool call (continuation-signal edge case).
  return {
    payloads: [],
    meta: { durationMs: 1, toolSummary: { calls: 1, tools: ["exec"] } },
  };
}

function visibleReplyResult(): EmbeddedAgentRunResult {
  return {
    payloads: [{ text: "here is the answer" }],
    meta: { durationMs: 1, finalAssistantVisibleText: "here is the answer" },
  };
}

describe("resolveNoOpRearmKey", () => {
  it("prefers flowId, then chainId, then sessionKey", () => {
    expect(resolveNoOpRearmKey({ flowId: "f", chainId: "c", sessionKey: "s" })).toBe("f");
    expect(resolveNoOpRearmKey({ chainId: "c", sessionKey: "s" })).toBe("c");
    expect(resolveNoOpRearmKey({ sessionKey: "s" })).toBe("s");
    expect(resolveNoOpRearmKey({ flowId: "  ", sessionKey: "s" })).toBe("s");
  });
});

describe("classifyNoOpRearmWake", () => {
  it("treats a direct external_user request as a fresh human edge", () => {
    const wake = classifyNoOpRearmWake(freshHumanWake());
    expect(wake).toEqual({ kind: "fresh_human_edge", messageId: "msg-1" });
  });

  it("treats a direct user_request without provenance as a fresh human edge", () => {
    const wake = classifyNoOpRearmWake({
      sessionKey: "agent:main:discord:channel:000000000000000001",
      inboundEventKind: "user_request",
      messageId: "msg-no-provenance",
    });
    expect(wake).toEqual({ kind: "fresh_human_edge", messageId: "msg-no-provenance" });
  });

  it("treats room-event activity as neutral, not streak-building backlog", () => {
    const wake = classifyNoOpRearmWake(
      roomEventWake({
        provenance: { kind: "external_user" },
        messageId: "msg-2",
        eventTimestampMs: 10_000,
      }),
    );
    expect(wake).toEqual({ kind: "neutral", reason: "room-event", messageId: "msg-2" });
  });

  it("treats timestamp-less room-event activity as neutral room life", () => {
    const wake = classifyNoOpRearmWake(
      roomEventWake({ provenance: { kind: "external_user" }, messageId: "msg-2" }),
    );
    expect(wake).toEqual({ kind: "neutral", reason: "room-event", messageId: "msg-2" });
  });

  it("treats old room-event timestamps as neutral unless the wake is continuation-owned", () => {
    const wake = classifyNoOpRearmWake(
      roomEventWake({
        provenance: { kind: "external_user" },
        messageId: "msg-2",
        eventTimestampMs: 0,
      }),
    );
    expect(wake).toEqual({ kind: "neutral", reason: "room-event", messageId: "msg-2" });
  });

  it("treats inter-session preserved completion tools as structured completion", () => {
    for (const sourceTool of [
      "agent_harness_task",
      "image_generate",
      "music_generate",
      "video_generate",
      "subagent_announce",
      "subagent_interrupted_resume",
    ]) {
      const wake = classifyNoOpRearmWake({
        sessionKey: "s",
        provenance: { kind: "inter_session", sourceTool },
      });
      expect(wake.kind).toBe("structured_completion");
    }
  });

  it("treats an explicit awaited-completion marker as structured completion", () => {
    const wake = classifyNoOpRearmWake({ sessionKey: "s", awaitedCompletion: true });
    expect(wake.kind).toBe("structured_completion");
  });

  it("treats a plain heartbeat timer as an exempt backend wake", () => {
    const wake = classifyNoOpRearmWake({ sessionKey: "s", isHeartbeat: true });
    expect(wake).toEqual({ kind: "exempt_backend_wake", source: "heartbeat" });
  });

  it("treats a heartbeat that carries room-event work as neutral room life", () => {
    const wake = classifyNoOpRearmWake(roomEventWake({ isHeartbeat: true }));
    expect(wake).toEqual({ kind: "neutral", reason: "room-event" });
  });

  it("classifies only continuation-owned wakes as self-rearm sources", () => {
    expect(classifyNoOpRearmWake(continuationWake({ sessionKey: "s" }))).toEqual({
      kind: "self_rearm",
      source: "continuation",
    });
    expect(
      classifyNoOpRearmWake({
        sessionKey: "s",
        provenance: { kind: "internal_system", sourceTool: "restart-sentinel" },
      }),
    ).toEqual({ kind: "neutral", reason: "unmarked-wake" });
    expect(
      classifyNoOpRearmWake({ sessionKey: "s", provenance: { kind: "internal_system" } }),
    ).toEqual({ kind: "neutral", reason: "unmarked-wake" });
  });

  it("ignores parentRunId: aligned parent/main continuation wake keeps its guard key", () => {
    const base = continuationWake({ sessionKey: "agent:main" });
    const withParent = classifyNoOpRearmWake({ ...base, parentRunId: "run-parent" });
    const withoutParent = classifyNoOpRearmWake(base);
    expect(withParent).toEqual(withoutParent);
    expect(resolveNoOpRearmKey({ sessionKey: base.sessionKey })).toBe(base.sessionKey);
  });

  it("treats a direct external_user edge as fresh even when it has an old timestamp", () => {
    const wake = classifyNoOpRearmWake({ ...freshHumanWake(), eventTimestampMs: 0 });
    expect(wake).toEqual({ kind: "fresh_human_edge", messageId: "msg-1" });
  });

  it("treats an unmarked wake (no provenance or markers) as neutral", () => {
    const wake = classifyNoOpRearmWake({ sessionKey: "s" });
    expect(wake).toEqual({ kind: "neutral", reason: "unmarked-wake" });
  });
});

describe("turn outcome classification", () => {
  it("classifies a blank turn with substantive tool calls as substantive", () => {
    const facts = summarizeEmbeddedRunOutcome(blankWithSubstantiveToolResult());
    expect(facts.hasVisibleReply).toBe(false);
    expect(classifyNoOpRearmTurnOutcome(facts).kind).toBe("substantive");
  });

  it("classifies a blank/silent turn with only low-value tools as no-op", () => {
    const facts = summarizeEmbeddedRunOutcome(noOpResult(["continue_work", "sessions_yield"]));
    expect(classifyNoOpRearmTurnOutcome(facts).kind).toBe("no_op");
  });

  it("classifies a read/react-only message turn (no delivery) as no-op", () => {
    const facts = summarizeEmbeddedRunOutcome(noOpResult(["message"]));
    expect(classifyNoOpRearmTurnOutcome(facts).kind).toBe("no_op");
  });

  it("classifies a delivered visible reply as substantive", () => {
    const facts = summarizeEmbeddedRunOutcome(visibleReplyResult());
    expect(classifyNoOpRearmTurnOutcome(facts).kind).toBe("substantive");
  });

  it("classifies a delivered message-tool send as substantive even with blank text", () => {
    const result: EmbeddedAgentRunResult = {
      payloads: [],
      didSendViaMessagingTool: true,
      messagingToolSentTexts: ["sent it"],
      meta: { durationMs: 1, toolSummary: { calls: 1, tools: ["message"] } },
    };
    expect(classifyNoOpRearmTurnOutcome(summarizeEmbeddedRunOutcome(result)).kind).toBe(
      "substantive",
    );
  });

  it("classifies a child spawn / cron add / approval prompt as structured completion", () => {
    const spawn: EmbeddedAgentRunResult = {
      payloads: [],
      acceptedSessionSpawns: [{ sessionKey: "agent:main:subagent:child" } as never],
      meta: { durationMs: 1 },
    };
    expect(classifyNoOpRearmTurnOutcome(summarizeEmbeddedRunOutcome(spawn)).kind).toBe(
      "structured_completion",
    );
    const cron: EmbeddedAgentRunResult = {
      payloads: [],
      successfulCronAdds: 1,
      meta: { durationMs: 1 },
    };
    expect(classifyNoOpRearmTurnOutcome(summarizeEmbeddedRunOutcome(cron)).kind).toBe(
      "structured_completion",
    );
  });

  it("classifies NO_REPLY terminal text as no-op", () => {
    const result: EmbeddedAgentRunResult = {
      payloads: [],
      meta: { durationMs: 1, finalAssistantVisibleText: "NO_REPLY" },
    };
    expect(classifyNoOpRearmTurnOutcome(summarizeEmbeddedRunOutcome(result)).kind).toBe("no_op");
  });

  it("does not treat exact silent payload text as a visible reply", () => {
    const result: EmbeddedAgentRunResult = {
      payloads: [{ text: "  NO_REPLY  " }],
      meta: { durationMs: 1 },
    };
    const facts = summarizeEmbeddedRunOutcome(result);
    expect(facts.hasVisibleReply).toBe(false);
    expect(classifyNoOpRearmTurnOutcome(facts).kind).toBe("no_op");
  });

  it("does not treat reasoning-prefixed silent payload text as a visible reply", () => {
    const result: EmbeddedAgentRunResult = {
      payloads: [{ text: "<think>internal notes</think>\nNO_REPLY" }],
      meta: { durationMs: 1 },
    };
    const facts = summarizeEmbeddedRunOutcome(result);
    expect(facts.hasVisibleReply).toBe(false);
    expect(classifyNoOpRearmTurnOutcome(facts).kind).toBe("no_op");
  });

  it("does not treat structural continuation markers as visible replies", () => {
    for (const text of ["CONTINUE_WORK", "[[CONTINUE_WORK]]", "[[CONTINUE_DELEGATE: hold]]"]) {
      const result: EmbeddedAgentRunResult = {
        payloads: [{ text }],
        meta: { durationMs: 1 },
      };
      const facts = summarizeEmbeddedRunOutcome(result);
      expect(facts.hasVisibleReply).toBe(false);
      expect(classifyNoOpRearmTurnOutcome(facts).kind).toBe("no_op");
    }
  });

  it("classifies an error-only turn with no output as error_no_gain", () => {
    const result: EmbeddedAgentRunResult = {
      payloads: [],
      meta: { durationMs: 1, error: { kind: "retry_limit", message: "boom" } },
    };
    expect(classifyNoOpRearmTurnOutcome(summarizeEmbeddedRunOutcome(result)).kind).toBe(
      "error_no_gain",
    );
  });
});

describe("NoOpRearmGuard admission + recording", () => {
  function makeGuard(now: () => number) {
    return new NoOpRearmGuard({ threshold: 3, windowMs: 60_000, now });
  }

  function recordSelfRearmNoOps(guard: NoOpRearmGuard, sessionKey: string, count: number): void {
    const wake: NoOpRearmWakeClass = { kind: "self_rearm", source: "continuation" };
    for (let i = 0; i < count; i += 1) {
      guard.record({ sessionKey, wakeClass: wake, runId: `run-${i}`, result: noOpResult() });
    }
  }

  it("blocks a self-rearm wake after the streak crosses the threshold", () => {
    const t = 1_000;
    const guard = makeGuard(() => t);
    const sessionKey = "s";

    // Below threshold: admitted.
    expect(guard.evaluate(continuationWake({ sessionKey })).admit).toBe(true);

    // Three rapid self-rearm no-op outcomes trip the streak.
    recordSelfRearmNoOps(guard, sessionKey, 3);
    expect(guard.peekStreak({ sessionKey })).toBe(3);

    const blocked = guard.evaluate(continuationWake({ sessionKey }));
    expect(blocked.admit).toBe(false);
    if (!blocked.admit) {
      expect(blocked.diagnostic?.code).toBe("noop-rearm-suppressed");
      expect(blocked.diagnostic?.wakeSource).toBe("continuation");
    }
  });

  it("emits exactly one diagnostic per episode even if many gates evaluate it", () => {
    const t = 1_000;
    const guard = makeGuard(() => t);
    const sessionKey = "s";
    recordSelfRearmNoOps(guard, sessionKey, 3);

    const first = guard.evaluate(continuationWake({ sessionKey }));
    const second = guard.evaluate(continuationWake({ sessionKey }));
    const third = guard.evaluate(continuationWake({ sessionKey }));
    expect(first.admit).toBe(false);
    expect(second.admit).toBe(false);
    expect(third.admit).toBe(false);
    if (!first.admit && !second.admit && !third.admit) {
      expect(first.diagnostic).toBeDefined();
      expect(second.diagnostic).toBeUndefined();
      expect(third.diagnostic).toBeUndefined();
    }
  });

  it("resets and admits on a fresh human message id", () => {
    const t = 1_000;
    const guard = makeGuard(() => t);
    const sessionKey = "s";
    recordSelfRearmNoOps(guard, sessionKey, 3);
    expect(guard.evaluate(continuationWake({ sessionKey })).admit).toBe(false);

    const fresh = guard.evaluate(freshHumanWake({ sessionKey, messageId: "fresh-1" }));
    expect(fresh.admit).toBe(true);
    expect(guard.peekStreak({ sessionKey })).toBe(0);
    // After reset, a self-rearm wake is admitted again and re-emits one diagnostic next episode.
    expect(guard.evaluate(continuationWake({ sessionKey })).admit).toBe(true);
  });

  it("admits old/timestamp-less room events without accruing or resetting continuation streaks", () => {
    const t = 1_000;
    const guard = makeGuard(() => t);
    const sessionKey = "s";
    recordSelfRearmNoOps(guard, sessionKey, 3);

    const oldRoom = guard.evaluate(
      roomEventWake({
        sessionKey,
        provenance: { kind: "external_user" },
        messageId: "old",
        eventTimestampMs: 0,
      }),
    );
    expect(oldRoom).toEqual({
      admit: true,
      reason: "neutral",
      wake: { kind: "neutral", reason: "room-event", messageId: "old" },
    });
    expect(guard.peekStreak({ sessionKey })).toBe(3);
  });

  it("resets on a structured inter-session completion wake", () => {
    const t = 1_000;
    const guard = makeGuard(() => t);
    const sessionKey = "s";
    recordSelfRearmNoOps(guard, sessionKey, 3);

    const completion = guard.evaluate({
      sessionKey,
      provenance: { kind: "inter_session", sourceTool: "subagent_announce" },
    });
    expect(completion.admit).toBe(true);
    expect(guard.peekStreak({ sessionKey })).toBe(0);
  });

  it("resets the streak when a self-rearm turn produces a substantive outcome", () => {
    const t = 1_000;
    const guard = makeGuard(() => t);
    const sessionKey = "s";
    const wake: NoOpRearmWakeClass = { kind: "self_rearm", source: "continuation" };
    guard.record({ sessionKey, wakeClass: wake, runId: "a", result: noOpResult() });
    guard.record({ sessionKey, wakeClass: wake, runId: "b", result: noOpResult() });
    expect(guard.peekStreak({ sessionKey })).toBe(2);
    guard.record({ sessionKey, wakeClass: wake, runId: "c", result: visibleReplyResult() });
    expect(guard.peekStreak({ sessionKey })).toBe(0);
  });

  it("does not double-increment the streak for the same runId", () => {
    const t = 1_000;
    const guard = makeGuard(() => t);
    const sessionKey = "s";
    const wake: NoOpRearmWakeClass = { kind: "self_rearm", source: "continuation" };
    guard.record({ sessionKey, wakeClass: wake, runId: "dup", result: noOpResult() });
    guard.record({ sessionKey, wakeClass: wake, runId: "dup", result: noOpResult() });
    expect(guard.peekStreak({ sessionKey })).toBe(1);
  });

  it("does not accrue a streak for no-op outcomes on fresh-edge or heartbeat wakes", () => {
    const t = 1_000;
    const guard = makeGuard(() => t);
    const sessionKey = "s";
    guard.record({
      sessionKey,
      wakeClass: { kind: "fresh_human_edge", messageId: "m" },
      runId: "a",
      result: noOpResult(),
    });
    guard.record({
      sessionKey,
      wakeClass: { kind: "exempt_backend_wake", source: "heartbeat" },
      runId: "b",
      result: noOpResult(),
    });
    expect(guard.peekStreak({ sessionKey })).toBe(0);
  });

  it("does not accrue or block neutral (unmarked) wakes even when repeated", () => {
    const t = 1_000;
    const guard = makeGuard(() => t);
    const sessionKey = "s";
    for (let i = 0; i < 10; i += 1) {
      const decision = guard.evaluate({ sessionKey });
      expect(decision.admit).toBe(true);
      guard.record({
        sessionKey,
        wakeClass: { kind: "neutral", reason: "unmarked-wake" },
        runId: `run-${i}`,
        result: noOpResult(),
      });
    }
    expect(guard.peekStreak({ sessionKey })).toBe(0);
  });

  it("does not accrue or block fresh room events or reaction-only acknowledgements", () => {
    const t = 1_000;
    const guard = makeGuard(() => t);
    const sessionKey = "s";
    const first = guard.evaluate(
      roomEventWake({ sessionKey, messageId: "reaction-1", eventTimestampMs: t }),
    );
    expect(first).toEqual({
      admit: true,
      reason: "neutral",
      wake: { kind: "neutral", reason: "room-event", messageId: "reaction-1" },
    });

    guard.record({
      sessionKey,
      wakeClass: first.wake,
      runId: "reaction-run",
      result: noOpResult(["message_react"]),
    });

    expect(guard.peekStreak({ sessionKey })).toBe(0);
  });

  it("admits replayed room-event ids without bleeding or accruing across sessions", () => {
    const t = 1_000;
    const guard = new NoOpRearmGuard({ threshold: 1, windowMs: 60_000, now: () => t });
    const sessionKey = "room-a";
    const otherSessionKey = "room-b";
    recordSelfRearmNoOps(guard, sessionKey, 1);
    const first = guard.evaluate(
      roomEventWake({ sessionKey, messageId: "same-room-event", eventTimestampMs: t }),
    );
    expect(first.admit).toBe(true);
    expect(first.wake.kind).toBe("neutral");

    const replay = guard.evaluate(
      roomEventWake({ sessionKey, messageId: "same-room-event", eventTimestampMs: t }),
    );
    expect(replay.admit).toBe(true);
    expect(replay.wake).toEqual({
      kind: "neutral",
      reason: "room-event",
      messageId: "same-room-event",
    });
    guard.record({
      sessionKey,
      wakeClass: replay.wake,
      runId: "room-replay",
      result: noOpResult(["message_react"]),
    });
    expect(guard.evaluate(roomEventWake({ sessionKey, messageId: "same-room-event" })).admit).toBe(
      true,
    );
    expect(guard.peekStreak({ sessionKey })).toBe(1);

    const otherRoom = guard.evaluate(
      roomEventWake({
        sessionKey: otherSessionKey,
        messageId: "same-room-event",
        eventTimestampMs: t,
      }),
    );
    expect(otherRoom.admit).toBe(true);
    expect(otherRoom.wake.kind).toBe("neutral");
  });

  it("starts a fresh streak when no-ops are spaced beyond the cadence window", () => {
    let t = 1_000;
    const guard = makeGuard(() => t);
    const sessionKey = "s";
    const wake: NoOpRearmWakeClass = { kind: "self_rearm", source: "continuation" };
    guard.record({ sessionKey, wakeClass: wake, runId: "a", result: noOpResult() });
    guard.record({ sessionKey, wakeClass: wake, runId: "b", result: noOpResult() });
    expect(guard.peekStreak({ sessionKey })).toBe(2);
    t += 120_000; // beyond the 60s window
    guard.record({ sessionKey, wakeClass: wake, runId: "c", result: noOpResult() });
    expect(guard.peekStreak({ sessionKey })).toBe(1);
  });

  it("does not block self-rearm wakes after a tripped streak expires", () => {
    let t = 1_000;
    const guard = makeGuard(() => t);
    const sessionKey = "s";
    recordSelfRearmNoOps(guard, sessionKey, 3);
    expect(guard.evaluate(continuationWake({ sessionKey })).admit).toBe(false);

    t += 120_000; // beyond the 60s window
    const later = guard.evaluate(continuationWake({ sessionKey }));
    expect(later).toMatchObject({ admit: true, reason: "below-threshold" });
    expect(guard.peekStreak({ sessionKey })).toBe(0);
  });

  it("admits a repeated direct human message id as a fresh edge rather than continuation replay", () => {
    const t = 1_000;
    const guard = makeGuard(() => t);
    const sessionKey = "s";
    // First delivery of msg id resets/admits and is remembered.
    const first = guard.evaluate(freshHumanWake({ sessionKey, messageId: "same" }));
    expect(first.admit).toBe(true);
    expect(first.wake.kind).toBe("fresh_human_edge");
    // Trip the streak via self-rearm no-ops.
    recordSelfRearmNoOps(guard, sessionKey, 3);
    // A duplicate direct human id is not continuation-owned, so it stays admitted.
    const replay = guard.evaluate(freshHumanWake({ sessionKey, messageId: "same" }));
    expect(replay).toEqual({
      admit: true,
      reason: "fresh-human-edge",
      wake: { kind: "fresh_human_edge", messageId: "same" },
    });
    expect(guard.peekStreak({ sessionKey })).toBe(0);
  });

  it("admits same-turn fanout and concrete awaited completion", () => {
    const t = 1_000;
    const guard = makeGuard(() => t);
    const sessionKey = "s";
    recordSelfRearmNoOps(guard, sessionKey, 3);
    expect(guard.evaluate({ sessionKey, awaitedCompletion: true }).admit).toBe(true);
    expect(guard.peekStreak({ sessionKey })).toBe(0);
  });
});
