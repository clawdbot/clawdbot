import { describe, expect, it, vi } from "vitest";
import { createSessionActivityNoteState } from "../agents/session-activity-notes.js";
import type { SessionObserverState } from "./session-observer-model.js";
import { createSessionObserverPreamblePublisher } from "./session-observer-preamble.js";

function state(headline: string): SessionObserverState {
  return {
    ...createSessionActivityNoteState(),
    sessionKey: "agent:main:session-1",
    runId: "run-1",
    agentId: "main",
    startedAt: 0,
    lastActivityAt: 0,
    lastRunAt: 0,
    revision: 1,
    digestCount: 0,
    consecutiveFailures: 0,
    lastDigestNoteSequence: 0,
    previousDigest: {
      sessionKey: "agent:main:session-1",
      runId: "run-1",
      revision: 1,
      updatedAt: 1,
      headline,
      health: "on-track",
    },
    inFlight: false,
    finalPending: false,
  };
}

describe("session observer preamble publisher", () => {
  it("keeps generation stable for duplicate snapshots while clearing publication state", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const session = state("Earlier headline");
    const publish = vi.fn();
    const publisher = createSessionObserverPreamblePublisher({
      now: Date.now,
      setTimeoutFn: setTimeout,
      clearTimeoutFn: clearTimeout,
      isCurrent: () => true,
      publish,
    });

    publisher.handle(session, {
      runId: "run-1",
      seq: 1,
      stream: "item",
      ts: 1_000,
      sessionKey: session.sessionKey,
      agentId: session.agentId,
      data: { kind: "preamble", progressText: "Current headline" },
    });
    publisher.handle(session, {
      runId: "run-1",
      seq: 2,
      stream: "item",
      ts: 1_000,
      sessionKey: session.sessionKey,
      agentId: session.agentId,
      data: { kind: "preamble", progressText: "Current headline" },
    });
    expect(publisher.generation(session)).toBe(1);

    vi.advanceTimersByTime(2_000);
    expect(publisher.generation(session)).toBe(1);
    publisher.dispose();
    vi.useRealTimers();
  });

  it("retains newer mutation generations when publication matches the current digest", () => {
    const session = state("Same headline");
    const publisher = createSessionObserverPreamblePublisher({
      now: () => 1_000,
      setTimeoutFn: setTimeout,
      clearTimeoutFn: clearTimeout,
      isCurrent: () => true,
      publish: vi.fn(),
    });

    for (let sequence = 1; sequence <= 2; sequence += 1) {
      publisher.handle(session, {
        runId: "run-1",
        seq: sequence,
        stream: "item",
        ts: 1_000,
        sessionKey: session.sessionKey,
        agentId: session.agentId,
        data: { kind: "preamble", progressText: "Same headline" },
      });
    }

    expect(publisher.generation(session)).toBe(2);
    publisher.dispose();
  });
});
