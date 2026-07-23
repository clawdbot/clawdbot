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

  it("does not advance generation when the headline already matches the digest", () => {
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

    expect(publisher.generation(session)).toBe(0);
    publisher.dispose();
  });

  it("does not restore an unchanged preamble after a richer digest replaces it", () => {
    const session = state("Earlier headline");
    const publish = vi.fn();
    const publisher = createSessionObserverPreamblePublisher({
      now: () => 1_000,
      setTimeoutFn: setTimeout,
      clearTimeoutFn: clearTimeout,
      isCurrent: () => true,
      publish,
    });
    const event = {
      runId: "run-1",
      seq: 1,
      stream: "item",
      ts: 1_000,
      sessionKey: session.sessionKey,
      agentId: session.agentId,
      data: { kind: "preamble", progressText: "Checking files" },
    };

    publisher.handle(session, event);
    publisher.clear(session);
    const previousDigest = session.previousDigest;
    if (!previousDigest) {
      throw new Error("expected previous digest");
    }
    session.previousDigest = {
      ...previousDigest,
      revision: 2,
      headline: "Reviewing the implementation",
      updatedAt: 2_000,
    };
    publisher.handle(session, { ...event, seq: 2, ts: 2_001 });

    expect(publish).toHaveBeenCalledOnce();
    expect(publisher.generation(session)).toBe(1);
    publisher.dispose();
  });

  it("preserves duplicate suppression across dormant-state revival", () => {
    const original = state("Earlier headline");
    const publish = vi.fn();
    const publisher = createSessionObserverPreamblePublisher({
      now: () => 1_000,
      setTimeoutFn: setTimeout,
      clearTimeoutFn: clearTimeout,
      isCurrent: () => true,
      publish,
    });
    publisher.handle(original, {
      runId: "run-1",
      seq: 1,
      stream: "item",
      ts: 1_000,
      sessionKey: original.sessionKey,
      agentId: original.agentId,
      data: { kind: "preamble", progressText: "Checking files" },
    });

    const revived = state("Reviewing the implementation");
    revived.lastPreambleHeadline = original.lastPreambleHeadline;
    publisher.handle(revived, {
      runId: "run-1",
      seq: 2,
      stream: "item",
      ts: 2_000,
      sessionKey: revived.sessionKey,
      agentId: revived.agentId,
      data: { kind: "preamble", progressText: "Checking files" },
    });

    expect(publish).toHaveBeenCalledOnce();
    publisher.dispose();
  });
});
