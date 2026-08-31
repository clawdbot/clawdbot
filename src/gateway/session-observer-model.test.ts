import { describe, expect, it } from "vitest";
import type { SessionObserverDigest } from "../../packages/gateway-protocol/src/schema/sessions.js";
import {
  loadSessionEntryReadOnly,
  upsertSessionEntryCore,
} from "../config/sessions/session-accessor.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { defaultPersistDigest } from "./session-observer-model.js";

function digest(overrides: Partial<SessionObserverDigest> = {}): SessionObserverDigest {
  return {
    sessionKey: "agent:main:persist-digest",
    runId: "run-1",
    revision: 1,
    updatedAt: 1,
    headline: "Reviewing changes",
    health: "on-track",
    ...overrides,
  };
}

describe("defaultPersistDigest", () => {
  it("returns null for an unpersistable session whose entry no longer exists", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const sessionKey = "agent:main:persist-digest-missing";
      const result = await defaultPersistDigest({
        sessionKey,
        agentId: "main",
        digest: digest({ sessionKey }),
      });
      expect(result).toBeNull();
    });
  });

  it("returns false without persisting when the mutator rejects a stale revision", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const sessionKey = "agent:main:persist-digest-stale";
      await upsertSessionEntryCore(
        { sessionKey, agentId: "main" },
        {
          sessionId: "session-1",
          updatedAt: 1,
          observerDigest: digest({ sessionKey, revision: 5 }),
        },
      );

      const result = await defaultPersistDigest({
        sessionKey,
        sessionId: "session-1",
        agentId: "main",
        digest: digest({ sessionKey, revision: 1 }),
      });

      expect(result).toBe(false);
      const entry = loadSessionEntryReadOnly({ sessionKey, agentId: "main" });
      expect(entry?.observerDigest?.revision).toBe(5);
    });
  });

  it("returns true and persists when the digest is accepted", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const sessionKey = "agent:main:persist-digest-accept";
      await upsertSessionEntryCore(
        { sessionKey, agentId: "main" },
        { sessionId: "session-1", updatedAt: 1 },
      );

      const result = await defaultPersistDigest({
        sessionKey,
        sessionId: "session-1",
        agentId: "main",
        digest: digest({ sessionKey, revision: 2 }),
      });

      expect(result).toBe(true);
      const entry = loadSessionEntryReadOnly({ sessionKey, agentId: "main" });
      expect(entry?.observerDigest?.revision).toBe(2);
    });
  });
});
