import { afterEach, describe, expect, it } from "vitest";
import {
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import {
  assignSessionOwner,
  captureSessionRecipientAuthority,
  deleteSessionEntryLifecycle,
  isSessionRecipientAuthorityCurrent,
  patchSessionEntryCore,
  upsertSessionEntryCore,
} from "./session-accessor.js";
import { addSessionMember, removeSessionMember } from "./session-sharing-store.js";

afterEach(() => closeOpenClawAgentDatabasesForTest());

describe("session recipient authority", () => {
  it("preserves one logical mailbox across rollover, fallback, compaction, and reopen", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const scope = {
        agentId: "main",
        env: state.env,
        sessionKey: "agent:main:continuity",
      };
      await upsertSessionEntryCore(scope, {
        sessionId: "session-before",
        updatedAt: 1,
        lifecycleRevision: "lifecycle-before",
      });
      const authority = captureSessionRecipientAuthority(scope);
      expect(authority.state).toBe("bound");

      await upsertSessionEntryCore(scope, {
        sessionId: "session-after",
        updatedAt: 2,
        lifecycleRevision: "lifecycle-new-conversation",
      });
      expect(isSessionRecipientAuthorityCurrent(scope, authority)).toBe(true);

      await patchSessionEntryCore(scope, () => ({
        modelProvider: "fallback-provider",
        model: "fallback-model",
        compactionCount: 2,
      }));
      expect(isSessionRecipientAuthorityCurrent(scope, authority)).toBe(true);

      closeOpenClawAgentDatabasesForTest();
      expect(isSessionRecipientAuthorityCurrent(scope, authority)).toBe(true);
    });
  });

  it("rejects a deleted and recreated occupant while preserving absent-target materialization", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const scope = {
        agentId: "main",
        env: state.env,
        sessionKey: "agent:main:replacement",
      };
      await upsertSessionEntryCore(scope, { sessionId: "session-before", updatedAt: 1 });
      const deletedAuthority = captureSessionRecipientAuthority(scope);

      await deleteSessionEntryLifecycle({
        agentId: "main",
        archiveTranscript: false,
        storePath: openOpenClawAgentDatabase({
          agentId: "main",
          env: state.env,
        }).path,
        target: { canonicalKey: scope.sessionKey, storeKeys: [scope.sessionKey] },
      });
      await upsertSessionEntryCore(scope, { sessionId: "session-after", updatedAt: 2 });

      expect(isSessionRecipientAuthorityCurrent(scope, deletedAuthority)).toBe(false);
      const replacementAuthority = captureSessionRecipientAuthority(scope);
      expect(replacementAuthority).not.toEqual(deletedAuthority);

      const absentScope = { ...scope, sessionKey: "agent:main:late-materialization" };
      const absentAuthority = captureSessionRecipientAuthority(absentScope);
      expect(absentAuthority).toEqual({ state: "absent" });
      await upsertSessionEntryCore(absentScope, { sessionId: "session-late", updatedAt: 3 });
      expect(isSessionRecipientAuthorityCurrent(absentScope, absentAuthority)).toBe(true);
    });
  });

  it("advances only for effective owner reassignment and actual member removal", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const scope = {
        agentId: "main",
        env: state.env,
        sessionKey: "agent:main:revocation",
      };
      const ownerA = { type: "human" as const, id: "owner-a" };
      await upsertSessionEntryCore(scope, {
        sessionId: "session-revocation",
        updatedAt: 1,
        createdActor: ownerA,
      });
      const initialAuthority = captureSessionRecipientAuthority(scope);

      assignSessionOwner(scope, {
        owner: ownerA,
        assignedBy: ownerA,
        assignedAt: 2,
      });
      expect(isSessionRecipientAuthorityCurrent(scope, initialAuthority)).toBe(true);

      assignSessionOwner(scope, {
        owner: { type: "human", id: "owner-b" },
        assignedBy: ownerA,
        assignedAt: 3,
      });
      expect(isSessionRecipientAuthorityCurrent(scope, initialAuthority)).toBe(false);

      const reassignedAuthority = captureSessionRecipientAuthority(scope);
      expect(
        addSessionMember(scope, {
          identityId: "member-a",
          addedBy: "owner-b",
          addedAt: 4,
        }).inserted,
      ).toBe(true);
      expect(isSessionRecipientAuthorityCurrent(scope, reassignedAuthority)).toBe(true);

      expect(removeSessionMember(scope, "member-a")).not.toBeNull();
      expect(isSessionRecipientAuthorityCurrent(scope, reassignedAuthority)).toBe(false);

      const revokedAuthority = captureSessionRecipientAuthority(scope);
      expect(removeSessionMember(scope, "member-a")).toBeNull();
      expect(isSessionRecipientAuthorityCurrent(scope, revokedAuthority)).toBe(true);
    });
  });

  it("initializes missing legacy state and fails closed on malformed persisted epochs", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const scope = {
        agentId: "main",
        env: state.env,
        sessionKey: "agent:main:malformed",
      };
      await upsertSessionEntryCore(scope, { sessionId: "session-malformed", updatedAt: 1 });
      const initialized = captureSessionRecipientAuthority(scope);
      expect(initialized.state).toBe("bound");

      await patchSessionEntryCore(scope, () => ({
        recipientAuthorityEpoch: "not-an-epoch",
      }));
      expect(isSessionRecipientAuthorityCurrent(scope, initialized)).toBe(false);
      expect(() => captureSessionRecipientAuthority(scope)).toThrow(
        /Invalid recipient authority epoch/,
      );
    });
  });
});
