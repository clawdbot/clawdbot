import { afterEach, describe, expect, it } from "vitest";
import {
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import { withTempDir } from "../../test-helpers/temp-dir.js";
import {
  deleteSessionEntryLifecycle,
  loadSessionEntry,
  upsertSessionEntry,
} from "./session-accessor.js";
import {
  addSessionMember,
  isSessionMember,
  listSessionMembershipKeys,
  listSessionMembers,
  removeSessionMember,
} from "./session-sharing-store.js";

afterEach(() => closeOpenClawAgentDatabasesForTest());

describe("session sharing store", () => {
  it("lazily ensures the additive membership table and keeps deterministic rows", async () => {
    await withTempDir({ prefix: "openclaw-session-sharing-" }, async (dir) => {
      const env = { ...process.env, OPENCLAW_STATE_DIR: dir };
      const scope = { agentId: "main", env, sessionKey: "agent:main:main" };
      await upsertSessionEntry(scope, {
        sessionId: "session-main",
        updatedAt: 1,
        visibility: "shared",
      });
      expect(loadSessionEntry(scope)?.visibility).toBe("shared");
      const database = openOpenClawAgentDatabase({ agentId: "main", env });
      database.db.exec("DROP TABLE session_members;");
      expect(
        database.db
          .prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'session_members'")
          .get(),
      ).toBeUndefined();

      expect(listSessionMembers(scope)).toEqual([]);
      expect(
        addSessionMember(scope, { identityId: "zoe", addedBy: "owner", addedAt: 2 }).inserted,
      ).toBe(true);
      expect(
        addSessionMember(scope, { identityId: "alice", addedBy: "owner", addedAt: 3 }).inserted,
      ).toBe(true);

      expect(listSessionMembers(scope)).toEqual([
        { identityId: "alice", addedBy: "owner", addedAt: 3 },
        { identityId: "zoe", addedBy: "owner", addedAt: 2 },
      ]);
      expect(isSessionMember(scope, "alice")).toBe(true);
      expect(
        listSessionMembershipKeys(
          scope,
          [scope.sessionKey, ...Array.from({ length: 450 }, (_, index) => `session-${index}`)],
          "zoe",
        ),
      ).toEqual(new Set([scope.sessionKey]));
      expect(removeSessionMember(scope, "alice")).toEqual({
        identityId: "alice",
        addedBy: "owner",
        addedAt: 3,
      });
      expect(removeSessionMember(scope, "alice")).toBeNull();
    });
  });

  it("refuses member writes whose expected session instance no longer matches", async () => {
    await withTempDir({ prefix: "openclaw-session-sharing-instance-" }, async (dir) => {
      const env = { ...process.env, OPENCLAW_STATE_DIR: dir };
      const scope = { agentId: "main", env, sessionKey: "agent:main:main" };
      await upsertSessionEntry(scope, { sessionId: "session-b", updatedAt: 1 });

      // A write authorized against a now-replaced instance must not mutate the
      // live one under the same key.
      expect(() =>
        addSessionMember(scope, {
          identityId: "stale",
          addedBy: "owner",
          expectedSessionId: "session-a",
        }),
      ).toThrow(/session changed/);
      expect(listSessionMembers(scope)).toEqual([]);

      expect(
        addSessionMember(scope, {
          identityId: "ok",
          addedBy: "owner",
          addedAt: 2,
          expectedSessionId: "session-b",
        }).inserted,
      ).toBe(true);
      expect(() => removeSessionMember(scope, "ok", undefined, "session-a")).toThrow(
        /session changed/,
      );
      expect(isSessionMember(scope, "ok")).toBe(true);
    });
  });

  it("drops members when the session instance is replaced under the same key", async () => {
    await withTempDir({ prefix: "openclaw-session-sharing-recreate-" }, async (dir) => {
      const env = { ...process.env, OPENCLAW_STATE_DIR: dir };
      const scope = { agentId: "main", env, sessionKey: "agent:main:main" };
      await upsertSessionEntry(scope, {
        sessionId: "session-a",
        updatedAt: 1,
        visibility: "read-only",
      });
      expect(
        addSessionMember(scope, { identityId: "guest", addedBy: "owner", addedAt: 2 }).inserted,
      ).toBe(true);
      expect(isSessionMember(scope, "guest")).toBe(true);

      // Reusing the canonical key with a new sessionId is a fresh session; a
      // stale member must not inherit access, and the replacement must start
      // shared even if the recreated entry copied a restricted visibility.
      await upsertSessionEntry(scope, {
        sessionId: "session-b",
        updatedAt: 3,
        visibility: "read-only",
      });
      expect(listSessionMembers(scope)).toEqual([]);
      expect(isSessionMember(scope, "guest")).toBe(false);
      // Replacement drops the copied restriction; absent visibility reads as
      // shared, so the fresh instance is not hidden or read-only.
      expect(loadSessionEntry(scope)?.visibility).toBeUndefined();

      // An in-place update that keeps the same sessionId preserves membership.
      expect(
        addSessionMember(scope, { identityId: "guest", addedBy: "owner", addedAt: 4 }).inserted,
      ).toBe(true);
      await upsertSessionEntry(scope, { sessionId: "session-b", updatedAt: 5 });
      expect(isSessionMember(scope, "guest")).toBe(true);
    });
  });

  it("rejects stale member writes after entry-only deletion leaves a placeholder", async () => {
    await withTempDir({ prefix: "openclaw-session-sharing-placeholder-" }, async (dir) => {
      const env = { ...process.env, OPENCLAW_STATE_DIR: dir };
      const scope = { agentId: "main", env, sessionKey: "agent:main:main" };
      await upsertSessionEntry(scope, { sessionId: "session-a", updatedAt: 1 });
      expect(
        addSessionMember(scope, { identityId: "guest", addedBy: "owner", addedAt: 2 }).inserted,
      ).toBe(true);

      await deleteSessionEntryLifecycle({
        agentId: "main",
        archiveTranscript: false,
        storePath: openOpenClawAgentDatabase({ agentId: "main", env }).path,
        target: { canonicalKey: scope.sessionKey, storeKeys: [scope.sessionKey] },
      });

      expect(loadSessionEntry(scope)).toBeUndefined();
      expect(listSessionMembers(scope)).toEqual([]);
      expect(() =>
        addSessionMember(scope, {
          identityId: "stale",
          addedBy: "owner",
          expectedSessionId: "session-a",
        }),
      ).toThrow(/session changed/);
      expect(() =>
        addSessionMember(scope, {
          identityId: "planted",
          addedBy: "owner",
        }),
      ).toThrow(/session changed/);

      await upsertSessionEntry(scope, { sessionId: "session-b", updatedAt: 3 });
      expect(listSessionMembers(scope)).toEqual([]);
    });
  });
});
