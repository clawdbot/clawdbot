// Covers the optional plugin participant fence used by gateway suspension.
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  inspectGatewaySuspensionParticipants,
  prepareGatewaySuspensionParticipants,
  registerGatewaySuspensionParticipant,
  resumeGatewaySuspensionParticipants,
} from "./gateway-suspension-participants.js";
import { resetGatewaySuspensionParticipantsForTest } from "./gateway-suspension-participants.test-support.js";

function participant(id: string, activeCount: number) {
  return {
    id,
    prepare: vi.fn(() => ({ activeCount })),
    status: vi.fn(() => ({ activeCount })),
    resume: vi.fn(),
  };
}

afterEach(() => {
  resetGatewaySuspensionParticipantsForTest();
});

describe("gateway suspension participants", () => {
  it("reports idle when every participant closed with no work", () => {
    const first = participant("queue-a", 0);
    const second = participant("queue-b", 0);
    registerGatewaySuspensionParticipant(first);
    registerGatewaySuspensionParticipant(second);

    expect(prepareGatewaySuspensionParticipants()).toEqual([]);
    expect(first.prepare).toHaveBeenCalledOnce();
    expect(second.prepare).toHaveBeenCalledOnce();
    expect(first.resume).not.toHaveBeenCalled();
  });

  it("keeps every participant fenced until the caller resumes", () => {
    const idle = participant("queue-a", 0);
    const busy = participant("queue-b", 2);
    registerGatewaySuspensionParticipant(idle);
    registerGatewaySuspensionParticipant(busy);

    const blockers = prepareGatewaySuspensionParticipants();

    expect(blockers).toEqual([
      { participantId: "queue-b", count: 2, message: "2 active queue-b operation(s)" },
    ]);
    // Reopening belongs to the coordinator so a drain lease can stay fenced.
    expect(idle.resume).not.toHaveBeenCalled();

    resumeGatewaySuspensionParticipants();

    // The idle participant must reopen too, or its queue stays fenced with no lease.
    expect(idle.resume).toHaveBeenCalledOnce();
    expect(busy.resume).toHaveBeenCalledOnce();
  });

  it("fails closed when a participant cannot prepare", () => {
    const throwing = {
      id: "queue-a",
      prepare: vi.fn(() => {
        throw new Error("boom");
      }),
      status: vi.fn(() => ({ activeCount: 0 })),
      resume: vi.fn(),
    };
    registerGatewaySuspensionParticipant(throwing);

    const blockers = prepareGatewaySuspensionParticipants();

    expect(blockers[0]?.message).toBe("queue-a could not prepare for suspension");

    // A throwing prepare may still have closed admission, so it is owed a resume.
    resumeGatewaySuspensionParticipants();
    expect(throwing.resume).toHaveBeenCalledOnce();
  });

  it("treats an unavailable status as busy rather than idle", () => {
    registerGatewaySuspensionParticipant({
      id: "queue-a",
      prepare: vi.fn(() => ({ activeCount: 0 })),
      status: vi.fn(() => {
        throw new Error("boom");
      }),
      resume: vi.fn(),
    });

    expect(inspectGatewaySuspensionParticipants()).toEqual([
      { participantId: "queue-a", count: 1, message: "queue-a suspension status unavailable" },
    ]);
  });

  // A participant whose report cannot be trusted must never let prepare reach
  // ready: that would freeze the host over a queue that never actually fenced.
  it.each([
    ["a promise", () => Promise.resolve({ activeCount: 0 })],
    ["a missing count", () => ({}) as never],
    ["NaN", () => ({ activeCount: Number.NaN })],
    ["a negative count", () => ({ activeCount: -1 })],
    ["a fractional count", () => ({ activeCount: 1.5 })],
    ["a non-object", () => 0 as never],
    ["null", () => null as never],
  ])("refuses suspension when a participant reports %s", (_label, prepare) => {
    registerGatewaySuspensionParticipant({
      id: "queue-a",
      prepare: prepare as unknown as () => { activeCount: number },
      status: prepare as unknown as () => { activeCount: number },
      resume: vi.fn(),
    });

    expect(prepareGatewaySuspensionParticipants()).toHaveLength(1);
    expect(inspectGatewaySuspensionParticipants()).toHaveLength(1);
  });

  it("accepts an explicit zero count as idle", () => {
    registerGatewaySuspensionParticipant(participant("queue-a", 0));

    expect(prepareGatewaySuspensionParticipants()).toEqual([]);
    expect(inspectGatewaySuspensionParticipants()).toEqual([]);
  });

  it("reopens prepared participants exactly once on resume", () => {
    const entry = participant("queue-a", 0);
    registerGatewaySuspensionParticipant(entry);
    prepareGatewaySuspensionParticipants();

    resumeGatewaySuspensionParticipants();
    resumeGatewaySuspensionParticipants();

    expect(entry.resume).toHaveBeenCalledOnce();
  });

  it("throws on resume failure and retries only the failed participant", () => {
    const healthy = participant("queue-a", 0);
    let failResume = true;
    const flaky = {
      id: "queue-b",
      prepare: vi.fn(() => ({ activeCount: 0 })),
      status: vi.fn(() => ({ activeCount: 0 })),
      resume: vi.fn(() => {
        if (failResume) {
          throw new Error("boom");
        }
      }),
    };
    registerGatewaySuspensionParticipant(healthy);
    registerGatewaySuspensionParticipant(flaky);
    prepareGatewaySuspensionParticipants();

    expect(() => resumeGatewaySuspensionParticipants()).toThrow(/queue-b/);
    expect(healthy.resume).toHaveBeenCalledOnce();

    failResume = false;
    resumeGatewaySuspensionParticipants();

    // The healthy participant already released; only the failure is retried.
    expect(healthy.resume).toHaveBeenCalledOnce();
    expect(flaky.resume).toHaveBeenCalledTimes(2);
  });

  it("stops fencing once a participant unregisters", () => {
    const entry = participant("queue-a", 3);
    const unregister = registerGatewaySuspensionParticipant(entry);

    expect(prepareGatewaySuspensionParticipants()).toHaveLength(1);
    resumeGatewaySuspensionParticipants();

    unregister();

    expect(prepareGatewaySuspensionParticipants()).toEqual([]);
    expect(inspectGatewaySuspensionParticipants()).toEqual([]);
  });

  // Prepare closes the registered instance, so only that instance can reopen it.
  // Unregister or a reload during a held lease must not strand its queue closed.
  it("resumes a participant unregistered while the lease was held", () => {
    const entry = participant("queue-a", 0);
    const unregister = registerGatewaySuspensionParticipant(entry);
    prepareGatewaySuspensionParticipants();

    unregister();
    resumeGatewaySuspensionParticipants();

    expect(entry.resume).toHaveBeenCalledOnce();
  });

  it("resumes the prepared instance after a re-registration replaces it", () => {
    const prepared = participant("queue-a", 0);
    const replacement = participant("queue-a", 0);
    registerGatewaySuspensionParticipant(prepared);
    prepareGatewaySuspensionParticipants();

    registerGatewaySuspensionParticipant(replacement);
    resumeGatewaySuspensionParticipants();

    expect(prepared.resume).toHaveBeenCalledOnce();
    // The replacement never closed anything, so reopening it would be wrong.
    expect(replacement.resume).not.toHaveBeenCalled();
  });

  it("replaces a participant re-registered under the same id", () => {
    const stale = participant("queue-a", 5);
    const fresh = participant("queue-a", 0);
    registerGatewaySuspensionParticipant(stale);
    registerGatewaySuspensionParticipant(fresh);

    expect(prepareGatewaySuspensionParticipants()).toEqual([]);
    expect(stale.prepare).not.toHaveBeenCalled();
    expect(fresh.prepare).toHaveBeenCalledOnce();
  });

  it("rejects an empty participant id", () => {
    expect(() =>
      registerGatewaySuspensionParticipant({ ...participant("  ", 0), id: "  " }),
    ).toThrow(/non-empty id/);
  });
});
