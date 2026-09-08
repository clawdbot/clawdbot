// Real-storage regression for defaultPersistDigest's tri-state contract and
// the sessions.list cache fence shared by live and terminal writers.
import { describe, expect, it } from "vitest";
import type { SessionObserverDigest } from "../../packages/gateway-protocol/src/schema/sessions.js";
import { createSessionActivityNoteState } from "../agents/session-activity-notes.js";
import {
  loadSessionEntryReadOnly,
  upsertSessionEntryCore,
} from "../config/sessions/session-accessor.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import {
  defaultPersistDigest,
  readSessionObserverDigestVersion,
  synthesizeSessionObserverTerminalDigest,
  type SessionObserverState,
} from "./session-observer-model.js";
import { createSessionObserverDigestPersister } from "./session-observer-persistence.js";

const agentId = "main";

function makeDigest(sessionKey: string, revision: number): SessionObserverDigest {
  return {
    sessionKey,
    runId: "run-1",
    revision,
    updatedAt: 0,
    headline: "Checking files",
    health: "on-track",
  };
}

function state(overrides: Partial<SessionObserverState> = {}): SessionObserverState {
  return {
    ...createSessionActivityNoteState(),
    sessionKey: "agent:main:session-1",
    runId: "run-1",
    agentId,
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

describe("defaultPersistDigest tri-state contract", () => {
  it("returns null when the session row is gone", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const sessionKey = "agent:main:persist-digest-missing";
      const before = readSessionObserverDigestVersion();
      const accepted = await defaultPersistDigest({
        sessionKey,
        agentId,
        digest: makeDigest(sessionKey, 1),
      });
      expect(accepted).toBeNull();
      expect(readSessionObserverDigestVersion()).toBe(before);
    });
  });

  it("returns true and advances the fence when the digest is applied", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const sessionKey = "agent:main:persist-digest-accept";
      await upsertSessionEntryCore(
        { sessionKey, agentId, env: process.env },
        { sessionId: "sess-1", updatedAt: 1 },
      );
      const before = readSessionObserverDigestVersion();
      const accepted = await defaultPersistDigest({
        sessionKey,
        agentId,
        sessionId: "sess-1",
        digest: makeDigest(sessionKey, 1),
      });
      expect(accepted).toBe(true);
      expect(readSessionObserverDigestVersion()).toBe(before + 1);
      expect(loadSessionEntryReadOnly({ sessionKey, agentId })?.observerDigest?.revision).toBe(1);
    });
  });

  it.each([
    ["stale digest revision", { seedRevision: 2, digestRevision: 1, sessionId: "sess-1" }],
    ["session id mismatch", { seedRevision: 1, digestRevision: 2, sessionId: "other" }],
  ] as const)(
    "returns false without advancing the fence on rejected write (%s)",
    async (_label, { seedRevision, digestRevision, sessionId }) => {
      await withOpenClawTestState({ scenario: "minimal" }, async () => {
        const sessionKey = "agent:main:persist-digest-reject";
        await upsertSessionEntryCore(
          { sessionKey, agentId, env: process.env },
          {
            sessionId: "sess-1",
            updatedAt: 1,
            observerDigest: makeDigest(sessionKey, seedRevision),
          },
        );
        const before = readSessionObserverDigestVersion();
        const accepted = await defaultPersistDigest({
          sessionKey,
          agentId,
          sessionId,
          digest: makeDigest(sessionKey, digestRevision),
        });
        expect(accepted).toBe(false);
        expect(readSessionObserverDigestVersion()).toBe(before);
        expect(loadSessionEntryReadOnly({ sessionKey, agentId })?.observerDigest?.revision).toBe(
          seedRevision,
        );
      });
    },
  );

  it("returns false without advancing the fence for a superseded run", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const sessionKey = "agent:main:persist-digest-stale-run";
      await upsertSessionEntryCore(
        { sessionKey, agentId, env: process.env },
        {
          sessionId: "sess-1",
          updatedAt: 1,
          observerDigest: makeDigest(sessionKey, 0),
        },
      );
      const before = readSessionObserverDigestVersion();
      const accepted = await defaultPersistDigest({
        sessionKey,
        agentId,
        sessionId: "sess-1",
        digest: makeDigest(sessionKey, 1),
        stillCurrent: () => false,
      });
      expect(accepted).toBe(false);
      expect(readSessionObserverDigestVersion()).toBe(before);
      expect(loadSessionEntryReadOnly({ sessionKey, agentId })?.observerDigest?.revision).toBe(0);
    });
  });

  it.each([
    ["default", undefined],
    ["default", "lifecycle-a"],
    ["configured", undefined],
    ["configured", "lifecycle-a"],
  ] as const)(
    "%s store rejects lifecycle %s after reset keeps the session id",
    async (store, lifecycleRevision) => {
      await withOpenClawTestState({ scenario: "minimal" }, async (fixture) => {
        const sessionKey = "agent:main:persist-digest-reset";
        const sessionId = "sess-1";
        const scope = {
          sessionKey,
          agentId,
          ...(store === "configured"
            ? { storePath: fixture.path("observer-sessions", "sessions.json") }
            : {}),
        };
        await upsertSessionEntryCore(scope, {
          sessionId,
          lifecycleRevision: "lifecycle-b",
          updatedAt: 1,
        });
        const before = readSessionObserverDigestVersion();
        const previousDigest = {
          ...makeDigest(sessionKey, 10),
          sessionId,
          lifecycleRevision,
        };

        expect(await defaultPersistDigest({ ...scope, sessionId, digest: previousDigest })).toBe(
          false,
        );
        expect(readSessionObserverDigestVersion()).toBe(before);
        expect(loadSessionEntryReadOnly(scope)?.observerDigest).toBeUndefined();

        const currentDigest = {
          ...makeDigest(sessionKey, 1),
          sessionId,
          lifecycleRevision: "lifecycle-b",
        };
        expect(await defaultPersistDigest({ ...scope, sessionId, digest: currentDigest })).toBe(
          true,
        );
        expect(readSessionObserverDigestVersion()).toBe(before + 1);
        expect(loadSessionEntryReadOnly(scope)?.observerDigest).toEqual(currentDigest);
        if (store === "configured") {
          expect(loadSessionEntryReadOnly({ sessionKey, agentId })).toBeUndefined();
        }
      });
    },
  );
});

describe("session observer digest fence", () => {
  it("advances on a live/preamble persist", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      await upsertSessionEntryCore(
        { agentId, sessionKey: "agent:main:session-1" },
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

  it("advances on terminal-digest synthesis through the same seam", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const sessionKey = "agent:main:session-2";
      await upsertSessionEntryCore(
        { agentId, sessionKey },
        { sessionId: "session-2", updatedAt: 0 },
      );
      const before = readSessionObserverDigestVersion();

      const digest = await synthesizeSessionObserverTerminalDigest({
        source: {
          state: {
            ...state({ sessionKey, sessionId: "session-2" }),
            previousDigest: {
              sessionKey,
              runId: "run-1",
              revision: 1,
              updatedAt: 0,
              headline: "Checking files",
              health: "on-track",
            },
            terminalHealth: "done",
          },
        },
        readSession: () => loadSessionEntryReadOnly({ sessionKey, agentId }),
        persistDigest: defaultPersistDigest,
        now: () => 1,
      });

      expect(digest?.health).toBe("done");
      expect(readSessionObserverDigestVersion()).toBe(before + 1);
    });
  });
});
