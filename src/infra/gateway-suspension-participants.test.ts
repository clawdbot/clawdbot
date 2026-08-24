// Covers the optional plugin participant fence used by gateway suspension.
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  inspectGatewaySuspensionParticipants,
  prepareGatewaySuspensionParticipants,
  registerGatewaySuspensionParticipant,
  resetGatewaySuspensionParticipantsForTest,
  resumeGatewaySuspensionParticipants,
} from "./gateway-suspension-participants.js";

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

    expect(prepareGatewaySuspensionParticipants()).toEqual({ idle: true, blockers: [] });
    expect(first.prepare).toHaveBeenCalledOnce();
    expect(second.prepare).toHaveBeenCalledOnce();
    expect(first.resume).not.toHaveBeenCalled();
  });

  it("rolls every participant back when one is still busy", () => {
    const idle = participant("queue-a", 0);
    const busy = participant("queue-b", 2);
    registerGatewaySuspensionParticipant(idle);
    registerGatewaySuspensionParticipant(busy);

    const result = prepareGatewaySuspensionParticipants();

    expect(result.idle).toBe(false);
    expect(result.blockers).toEqual([
      { participantId: "queue-b", count: 2, message: "2 active queue-b operation(s)" },
    ]);
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

    const result = prepareGatewaySuspensionParticipants();

    expect(result.idle).toBe(false);
    expect(result.blockers[0]?.message).toBe("queue-a could not prepare for suspension");
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

    expect(prepareGatewaySuspensionParticipants().idle).toBe(false);

    unregister();

    expect(prepareGatewaySuspensionParticipants()).toEqual({ idle: true, blockers: [] });
    expect(inspectGatewaySuspensionParticipants()).toEqual([]);
  });

  it("replaces a participant re-registered under the same id", () => {
    const stale = participant("queue-a", 5);
    const fresh = participant("queue-a", 0);
    registerGatewaySuspensionParticipant(stale);
    registerGatewaySuspensionParticipant(fresh);

    expect(prepareGatewaySuspensionParticipants().idle).toBe(true);
    expect(stale.prepare).not.toHaveBeenCalled();
    expect(fresh.prepare).toHaveBeenCalledOnce();
  });

  it("rejects an empty participant id", () => {
    expect(() =>
      registerGatewaySuspensionParticipant({ ...participant("  ", 0), id: "  " }),
    ).toThrow(/non-empty id/);
  });
});
