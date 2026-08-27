import { afterEach, describe, expect, it } from "vitest";
import { FIRST_USE_ADDITIVE_AGENT_COLUMN_DEFINITIONS } from "../../state/openclaw-agent-db-additive-columns.js";
import {
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
  runOpenClawAgentWriteTransaction,
} from "../../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import {
  applySessionEntryLifecycleMutation,
  assignSessionOwner,
  loadSessionEntry,
  patchSessionEntryTarget,
  resetSessionEntryLifecycle,
  updateSessionEntry,
  upsertSessionEntryCore,
} from "./session-accessor.js";

afterEach(() => {
  closeOpenClawAgentDatabasesForTest();
});

describe("SQLite session owner assignment", () => {
  it("gives consecutive assignments a monotonic timestamp", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const scope = {
        agentId: "main",
        env: state.env,
        sessionKey: "agent:main:monotonic-owner",
      };
      await upsertSessionEntryCore(scope, {
        sessionId: "session-monotonic-owner",
        updatedAt: 1,
      });

      expect(
        assignSessionOwner(scope, {
          owner: { type: "human", id: "profile-ada" },
          assignedBy: { type: "human", id: "profile-assigner" },
          assignedAt: 100,
        }),
      ).toMatchObject({ actor: { id: "profile-ada" }, assignedAt: 100 });
      expect(
        assignSessionOwner(scope, {
          owner: { type: "human", id: "profile-carol" },
          assignedBy: { type: "human", id: "profile-assigner" },
          assignedAt: 100,
        }),
      ).toMatchObject({ actor: { id: "profile-carol" }, assignedAt: 101 });
      expect(loadSessionEntry(scope)?.owner).toMatchObject({
        actor: { id: "profile-carol" },
        assignedAt: 101,
      });
    });
  });

  it("lazily adds bare columns and preserves the assignment across reopen", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const scope = {
        agentId: "main",
        env: state.env,
        sessionKey: "agent:main:owned-session",
      };
      await upsertSessionEntryCore(scope, {
        sessionId: "session-owned",
        updatedAt: 1,
        createdActor: { type: "human", id: "profile-creator" },
      });
      const initial = openOpenClawAgentDatabase({ agentId: "main", env: state.env });
      for (const { columnName } of FIRST_USE_ADDITIVE_AGENT_COLUMN_DEFINITIONS) {
        initial.db.exec(`ALTER TABLE session_nodes DROP COLUMN ${columnName};`);
      }
      closeOpenClawAgentDatabasesForTest();

      expect(loadSessionEntry(scope)).toMatchObject({
        createdActor: { type: "human", id: "profile-creator" },
      });
      expect(loadSessionEntry(scope)?.owner).toBeUndefined();

      expect(() =>
        runOpenClawAgentWriteTransaction(
          () => {
            expect(
              assignSessionOwner(scope, {
                owner: { type: "agent", id: "rolled-back-owner" },
                assignedBy: { type: "human", id: "profile-assigner" },
                assignedAt: 1233,
              }),
            ).not.toBeNull();
            throw new Error("roll back owner schema");
          },
          { agentId: "main", env: state.env },
        ),
      ).toThrow("roll back owner schema");
      expect(loadSessionEntry(scope)?.owner).toBeUndefined();

      expect(
        assignSessionOwner(scope, {
          owner: { type: "agent", id: "research" },
          assignedBy: { type: "human", id: "profile-assigner" },
          assignedAt: 1234,
        }),
      ).toEqual({
        actor: { type: "agent", id: "research" },
        assignedBy: { type: "human", id: "profile-assigner" },
        assignedAt: 1234,
      });
      expect(loadSessionEntry(scope)?.owner).toEqual({
        actor: { type: "agent", id: "research" },
        assignedBy: { type: "human", id: "profile-assigner" },
        assignedAt: 1234,
      });

      closeOpenClawAgentDatabasesForTest();
      expect(loadSessionEntry(scope)?.owner).toEqual({
        actor: { type: "agent", id: "research" },
        assignedBy: { type: "human", id: "profile-assigner" },
        assignedAt: 1234,
      });
      const reopened = openOpenClawAgentDatabase({ agentId: "main", env: state.env });
      const columns = reopened.db.prepare("PRAGMA table_info(session_nodes)").all() as Array<{
        name: string;
        notnull: number;
        dflt_value: unknown;
        type: string;
      }>;
      for (const definition of FIRST_USE_ADDITIVE_AGENT_COLUMN_DEFINITIONS) {
        expect(columns.find((column) => column.name === definition.columnName)).toMatchObject({
          type: definition.dataType,
          notnull: 0,
          dflt_value: null,
        });
      }
    });
  });

  it("allows lifecycle updates after assigning an owner", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const scope = {
        agentId: "main",
        env: state.env,
        sessionKey: "agent:main:owned-lifecycle-session",
      };
      await upsertSessionEntryCore(scope, {
        sessionId: "session-owned-lifecycle",
        updatedAt: 1,
      });
      let releaseBuilder: () => void = () => undefined;
      const builderGate = new Promise<void>((resolve) => {
        releaseBuilder = resolve;
      });
      let markBuilderStarted: () => void = () => undefined;
      const builderStarted = new Promise<void>((resolve) => {
        markBuilderStarted = resolve;
      });
      const mutation = applySessionEntryLifecycleMutation({
        agentId: scope.agentId,
        storePath: state.statePath("agents", "main", "sessions", "sessions.json"),
        upserts: [
          {
            sessionKey: scope.sessionKey,
            buildEntry: async ({ currentEntry }) => {
              markBuilderStarted();
              await builderGate;
              return currentEntry ? { ...currentEntry, label: "updated", updatedAt: 3 } : null;
            },
          },
        ],
        skipMaintenance: true,
      });

      await builderStarted;
      assignSessionOwner(scope, {
        owner: { type: "human", id: "profile-owner" },
        assignedBy: { type: "human", id: "profile-assigner" },
        assignedAt: 2,
      });
      releaseBuilder();

      await expect(mutation).resolves.toMatchObject({ afterCount: 1 });

      expect(loadSessionEntry(scope)).toMatchObject({
        label: "updated",
        owner: {
          actor: { type: "human", id: "profile-owner" },
          assignedBy: { type: "human", id: "profile-assigner" },
          assignedAt: 2,
        },
        sessionId: "session-owned-lifecycle",
        updatedAt: 3,
      });
    });
  });

  it("rejects a lifecycle replacement planned before assigning an owner", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const scope = {
        agentId: "main",
        env: state.env,
        sessionKey: "agent:main:owned-lifecycle-replacement",
      };
      await upsertSessionEntryCore(scope, {
        sessionId: "session-owned-lifecycle-replacement",
        updatedAt: 1,
      });
      let releaseBuilder: () => void = () => undefined;
      const builderGate = new Promise<void>((resolve) => {
        releaseBuilder = resolve;
      });
      let markBuilderStarted: () => void = () => undefined;
      const builderStarted = new Promise<void>((resolve) => {
        markBuilderStarted = resolve;
      });
      const mutation = applySessionEntryLifecycleMutation({
        agentId: scope.agentId,
        storePath: state.statePath("agents", "main", "sessions", "sessions.json"),
        upserts: [
          {
            sessionKey: scope.sessionKey,
            buildEntry: async ({ currentEntry }) => {
              markBuilderStarted();
              await builderGate;
              return currentEntry
                ? { ...currentEntry, sessionId: "replacement-session", updatedAt: 3 }
                : null;
            },
          },
        ],
        skipMaintenance: true,
      });

      await builderStarted;
      assignSessionOwner(scope, {
        owner: { type: "human", id: "profile-owner" },
        assignedBy: { type: "human", id: "profile-assigner" },
        assignedAt: 2,
      });
      releaseBuilder();

      await expect(mutation).rejects.toThrow("changed before lifecycle upsert");
      expect(loadSessionEntry(scope)).toMatchObject({
        owner: {
          actor: { type: "human", id: "profile-owner" },
          assignedBy: { type: "human", id: "profile-assigner" },
          assignedAt: 2,
        },
        sessionId: "session-owned-lifecycle-replacement",
      });
    });
  });

  it("rejects a lifecycle removal planned before assigning an owner", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const scope = {
        agentId: "main",
        env: state.env,
        sessionKey: "agent:main:owned-lifecycle-removal",
      };
      const blockerKey = "agent:main:lifecycle-removal-blocker";
      const storePath = state.statePath("agents", "main", "sessions", "sessions.json");
      await upsertSessionEntryCore(scope, {
        sessionId: "session-owned-lifecycle-removal",
        updatedAt: 1,
      });
      const expectedEntry = loadSessionEntry(scope);
      if (!expectedEntry) {
        throw new Error("expected persisted lifecycle removal entry");
      }
      let releaseBuilder: () => void = () => undefined;
      const builderGate = new Promise<void>((resolve) => {
        releaseBuilder = resolve;
      });
      let markBuilderStarted: () => void = () => undefined;
      const builderStarted = new Promise<void>((resolve) => {
        markBuilderStarted = resolve;
      });
      const mutation = applySessionEntryLifecycleMutation({
        agentId: scope.agentId,
        storePath,
        removals: [{ expectedEntry, sessionKey: scope.sessionKey }],
        upserts: [
          {
            sessionKey: blockerKey,
            buildEntry: async () => {
              markBuilderStarted();
              await builderGate;
              return { sessionId: "lifecycle-removal-blocker", updatedAt: 1 };
            },
          },
        ],
        skipMaintenance: true,
      });

      await builderStarted;
      assignSessionOwner(scope, {
        owner: { type: "human", id: "profile-owner" },
        assignedBy: { type: "human", id: "profile-assigner" },
        assignedAt: 2,
      });
      releaseBuilder();

      await expect(mutation).rejects.toThrow("changed before lifecycle removal");
      expect(loadSessionEntry(scope)).toMatchObject({
        owner: {
          actor: { type: "human", id: "profile-owner" },
          assignedBy: { type: "human", id: "profile-assigner" },
          assignedAt: 2,
        },
        sessionId: "session-owned-lifecycle-removal",
      });
    });
  });

  it("rejects a lifecycle reset prepared before assigning an owner", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const scope = {
        agentId: "main",
        env: state.env,
        sessionKey: "agent:main:owned-lifecycle-reset",
      };
      const storePath = state.statePath("agents", "main", "sessions", "sessions.json");
      await upsertSessionEntryCore(scope, {
        sessionId: "session-owned-lifecycle-reset",
        updatedAt: 1,
      });
      let releaseBuilder: () => void = () => undefined;
      const builderGate = new Promise<void>((resolve) => {
        releaseBuilder = resolve;
      });
      let markBuilderStarted: () => void = () => undefined;
      const builderStarted = new Promise<void>((resolve) => {
        markBuilderStarted = resolve;
      });
      const mutation = resetSessionEntryLifecycle({
        agentId: scope.agentId,
        storePath,
        target: { canonicalKey: scope.sessionKey, storeKeys: [scope.sessionKey] },
        buildNextEntry: async () => {
          markBuilderStarted();
          await builderGate;
          return { sessionId: "replacement-session", updatedAt: 3 };
        },
      });

      await builderStarted;
      assignSessionOwner(scope, {
        owner: { type: "human", id: "profile-owner" },
        assignedBy: { type: "human", id: "profile-assigner" },
        assignedAt: 2,
      });
      releaseBuilder();

      await expect(mutation).rejects.toThrow("changed before reset lifecycle mutation");
      expect(loadSessionEntry(scope)).toMatchObject({
        owner: {
          actor: { type: "human", id: "profile-owner" },
          assignedBy: { type: "human", id: "profile-assigner" },
          assignedAt: 2,
        },
        sessionId: "session-owned-lifecycle-reset",
      });
    });
  });

  it("allows an owner-preserving entry patch after assigning an owner", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const scope = {
        agentId: "main",
        env: state.env,
        sessionKey: "agent:main:owned-reply-patch",
      };
      await upsertSessionEntryCore(scope, {
        sessionId: "session-owned-reply-patch",
        updatedAt: 1,
      });
      let releasePatch: () => void = () => undefined;
      const patchGate = new Promise<void>((resolve) => {
        releasePatch = resolve;
      });
      let markPatchStarted: () => void = () => undefined;
      const patchStarted = new Promise<void>((resolve) => {
        markPatchStarted = resolve;
      });
      const patch = updateSessionEntry(
        scope,
        async () => {
          markPatchStarted();
          await patchGate;
          return { label: "updated", updatedAt: 3 };
        },
        { preserveOwnerProjection: true },
      );

      await patchStarted;
      assignSessionOwner(scope, {
        owner: { type: "human", id: "profile-owner" },
        assignedBy: { type: "human", id: "profile-assigner" },
        assignedAt: 2,
      });
      releasePatch();

      await expect(patch).resolves.toMatchObject({
        label: "updated",
        owner: {
          actor: { type: "human", id: "profile-owner" },
          assignedBy: { type: "human", id: "profile-assigner" },
          assignedAt: 2,
        },
        sessionId: "session-owned-reply-patch",
      });
    });
  });

  it("does not add an undefined owner to an owner-preserving patch result", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const scope = {
        agentId: "main",
        env: state.env,
        sessionKey: "agent:main:unowned-reply-patch",
      };
      await upsertSessionEntryCore(scope, {
        sessionId: "session-unowned-reply-patch",
        updatedAt: 1,
      });

      const patched = await updateSessionEntry(scope, () => ({ label: "updated", updatedAt: 2 }), {
        preserveOwnerProjection: true,
      });

      expect(patched).not.toHaveProperty("owner");
      expect(loadSessionEntry(scope)).not.toHaveProperty("owner");
    });
  });

  it("rejects a target replacement prepared before assigning an owner", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const sessionKey = "agent:main:owned-target-patch";
      const scope = { agentId: "main", env: state.env, sessionKey };
      const storePath = state.statePath("agents", "main", "sessions", "sessions.json");
      await upsertSessionEntryCore(scope, {
        sessionId: "session-owned-target-patch",
        updatedAt: 1,
      });

      const patch = patchSessionEntryTarget(
        {
          agentId: "main",
          storePath,
          target: { canonicalKey: sessionKey, storeKeys: [sessionKey] },
        },
        (entry) => {
          assignSessionOwner(scope, {
            owner: { type: "human", id: "profile-owner" },
            assignedBy: { type: "human", id: "profile-assigner" },
            assignedAt: 2,
          });
          return { ...entry, label: "stale replacement", updatedAt: 3 };
        },
        { replaceEntry: true },
      );

      await expect(patch).rejects.toThrow(
        "SQLite session state changed while preparing session-entry-target.patch",
      );
      expect(loadSessionEntry(scope)).toMatchObject({
        owner: {
          actor: { type: "human", id: "profile-owner" },
          assignedBy: { type: "human", id: "profile-assigner" },
          assignedAt: 2,
        },
        sessionId: "session-owned-target-patch",
      });
      expect(loadSessionEntry(scope)).not.toHaveProperty("label");
    });
  });
});
