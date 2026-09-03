// Real-storage regression for defaultPersistDigest's tri-state contract.
// The persister disables the utility model only when persistDigest returns
// null (entry gone), advances the persistence clock only for true, and treats
// false as a no-op — so the default adapter must actually be able to deliver
// all three states against the real SQLite session store.
import { describe, expect, it } from "vitest";
import type { SessionObserverDigest } from "../../packages/gateway-protocol/src/schema/sessions.js";
import {
  loadSessionEntryReadOnly,
  upsertSessionEntryCore,
} from "../config/sessions/session-accessor.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { defaultPersistDigest } from "./session-observer-model.js";

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

describe("defaultPersistDigest tri-state contract", () => {
  it("returns null when the session row is gone (unpersistable)", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      // No seed: the store has no entry for this session key, so the SQLite
      // owner skips the updater and the contract must surface null.
      const sessionKey = "agent:main:persist-digest-missing";
      const accepted = await defaultPersistDigest({
        sessionKey,
        agentId,
        digest: makeDigest(sessionKey, 1),
      });
      expect(accepted).toBeNull();
    });
  });

  it("returns true when the digest is applied", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const sessionKey = "agent:main:persist-digest-accept";
      await upsertSessionEntryCore(
        { sessionKey, agentId, env: process.env },
        { sessionId: "sess-1", updatedAt: 1 },
      );
      const accepted = await defaultPersistDigest({
        sessionKey,
        agentId,
        sessionId: "sess-1",
        digest: makeDigest(sessionKey, 1),
      });
      expect(accepted).toBe(true);
      // Side effect: the digest revision was actually written.
      const entry = loadSessionEntryReadOnly({ sessionKey, agentId });
      expect(entry?.observerDigest?.revision).toBe(1);
    });
  });

  it.each([
    // stale: seed revision outranks the incoming digest, so the updater rejects.
    ["stale digest revision", { seedRevision: 2, digestRevision: 1, sessionId: "sess-1" }],
    // mismatch: incoming digest outranks the seed (2 > 1), so it would apply —
    // except the sessionId differs, which must reject before the write.
    ["session id mismatch", { seedRevision: 1, digestRevision: 2, sessionId: "other" }],
  ] as const)(
    "returns false on rejected write (%s)",
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
        const accepted = await defaultPersistDigest({
          sessionKey,
          agentId,
          sessionId,
          digest: makeDigest(sessionKey, digestRevision),
        });
        // The updater rejects (stale revision or sessionId mismatch); the store
        // returns a clone of the existing entry, which must NOT be reported as
        // persisted.
        expect(accepted).toBe(false);
        // Side effect: the existing digest was not overwritten.
        const entry = loadSessionEntryReadOnly({ sessionKey, agentId });
        expect(entry?.observerDigest?.revision).toBe(seedRevision);
      });
    },
  );

  it("returns false when stillCurrent reports the run is no longer active", async () => {
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
      const accepted = await defaultPersistDigest({
        sessionKey,
        agentId,
        sessionId: "sess-1",
        digest: makeDigest(sessionKey, 1),
        stillCurrent: () => false,
      });
      expect(accepted).toBe(false);
      // Side effect: the digest was not advanced by the superseded run.
      const entry = loadSessionEntryReadOnly({ sessionKey, agentId });
      expect(entry?.observerDigest?.revision).toBe(0);
    });
  });
});
