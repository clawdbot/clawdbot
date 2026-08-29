import { describe, expect, it } from "vitest";
import { createSessionActivityNoteState } from "../agents/session-activity-notes.js";
import { upsertSessionEntryCore } from "../config/sessions/session-accessor.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import {
  defaultPersistDigest,
  readSessionObserverDigestVersion,
  synthesizeSessionObserverTerminalDigest,
  type SessionObserverState,
} from "./session-observer-model.js";
import { createSessionObserverDigestPersister } from "./session-observer-persistence.js";

function state(overrides: Partial<SessionObserverState> = {}): SessionObserverState {
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
    ...overrides,
  };
}

describe("session observer digest fence", () => {
  it("bumps the shared fence version on a live/preamble persist", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      await upsertSessionEntryCore(
        { agentId: "main", sessionKey: "agent:main:session-1" },
        { sessionId: "session-1", updatedAt: 0 },
      );
      const before = readSessionObserverDigestVersion();
      const persist = createSessionObserverDigestPersister({
        now: () => 0,
        persistDigest: defaultPersistDigest,
        stillCurrent: () => () => true,
        onMissingEntry: () => {},
        onError: () => {},
      });

      await persist(
        state({ sessionId: "session-1" }),
        {
          sessionKey: "agent:main:session-1",
          runId: "run-1",
          revision: 1,
          updatedAt: 0,
          headline: "Checking files",
          health: "on-track",
        },
        true,
      );

      expect(readSessionObserverDigestVersion()).toBe(before + 1);
    });
  });

  it("bumps the same fence version on terminal-digest synthesis", async () => {
    // Discriminating counterexample from the Phase 0 design closure: this path
    // calls persistDigest directly and bypasses createSessionObserverDigestPersister
    // entirely, so it must be proven to land on the same seam/fence as the live path.
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      await upsertSessionEntryCore(
        { agentId: "main", sessionKey: "agent:main:session-2" },
        { sessionId: "session-2", updatedAt: 0 },
      );
      const before = readSessionObserverDigestVersion();

      const digest = await synthesizeSessionObserverTerminalDigest({
        source: {
          state: {
            ...state({ sessionKey: "agent:main:session-2", sessionId: "session-2" }),
            previousDigest: {
              sessionKey: "agent:main:session-2",
              runId: "run-1",
              revision: 1,
              updatedAt: 0,
              headline: "Checking files",
              health: "on-track",
            },
            terminalHealth: "done",
          },
        },
        readSession: () => undefined,
        persistDigest: defaultPersistDigest,
        now: () => 1,
      });

      expect(digest?.health).toBe("done");
      expect(readSessionObserverDigestVersion()).toBe(before + 1);
    });
  });
});
