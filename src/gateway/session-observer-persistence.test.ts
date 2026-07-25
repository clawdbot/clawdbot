import { describe, expect, it, vi } from "vitest";
import { createSessionActivityNoteState } from "../agents/session-activity-notes.js";
import type { SessionObserverState } from "./session-observer-model.js";
import { createSessionObserverDigestPersister } from "./session-observer-persistence.js";

function state(): SessionObserverState {
  return {
    ...createSessionActivityNoteState(),
    sessionKey: "agent:main:session-1",
    runId: "run-1",
    agentId: "main",
    startedAt: 0,
    lastActivityAt: 0,
    lastRunAt: 0,
    revision: 0,
    digestCount: 0,
    consecutiveFailures: 0,
    lastDigestNoteSequence: 0,
    inFlight: false,
    finalPending: false,
  };
}

const digest = {
  sessionKey: "agent:main:session-1",
  runId: "run-1",
  revision: 1,
  updatedAt: 0,
  headline: "Checking files",
  health: "on-track" as const,
};

describe("session observer digest persistence", () => {
  it("does not let preamble persistence throttle the first model digest", async () => {
    let now = 0;
    const persistDigest = vi.fn(async () => true);
    const persist = createSessionObserverDigestPersister({
      now: () => now,
      persistDigest,
      stillCurrent: () => () => true,
      onError: vi.fn(),
    });
    const session = state();

    await persist(session, digest, false, "preamble");
    now = 1_000;
    await persist(session, { ...digest, revision: 2, headline: "Reviewing implementation" }, false);
    now = 2_000;
    await persist(session, { ...digest, revision: 3, headline: "Still reviewing" }, false);

    expect(persistDigest).toHaveBeenCalledTimes(2);
  });
});
