import { afterEach, describe, expect, it } from "vitest";
import {
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import {
  deleteSessionEntryLifecycle,
  listSessionParticipantsReadOnly,
  loadSessionEntry,
  MAX_SESSION_PARTICIPANTS,
  recordSessionParticipant,
  upsertSessionEntryCore,
} from "./session-accessor.js";
import { copySessionNodeArtifactsForRepair } from "./session-accessor.sqlite-node-artifacts.js";

afterEach(() => {
  closeOpenClawAgentDatabasesForTest();
});

describe("SQLite session participants", () => {
  it("lazily creates, deduplicates, caps, projects, and deletes participant history", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const sessionKey = "agent:main:participants";
      const scope = { agentId: "main", env: state.env, sessionKey };
      await upsertSessionEntryCore(scope, {
        sessionId: "session-participants",
        updatedAt: 1,
        createdActor: { type: "human", id: "profile-owner" },
      });
      const initial = openOpenClawAgentDatabase({ agentId: "main", env: state.env });
      const storePath = initial.path;
      initial.db.exec(`
        DROP TABLE session_participants;
        CREATE TABLE session_participants (
          session_key TEXT NOT NULL,
          actor_type TEXT NOT NULL,
          actor_id TEXT NOT NULL,
          first_prompted_at INTEGER NOT NULL,
          last_prompted_at INTEGER NOT NULL,
          PRIMARY KEY (session_key, actor_type, actor_id),
          FOREIGN KEY (session_key) REFERENCES session_nodes(session_key) ON DELETE CASCADE
        ) STRICT;
      `);
      initial.db
        .prepare(
          `INSERT INTO session_participants
            (session_key, actor_type, actor_id, first_prompted_at, last_prompted_at)
           VALUES (?, 'human', 'profile-legacy', 0, 0)`,
        )
        .run(sessionKey);
      const schemaVersion = initial.db.prepare("PRAGMA user_version").get()?.user_version;
      closeOpenClawAgentDatabasesForTest();

      expect(listSessionParticipantsReadOnly(scope).get(sessionKey)).toEqual([
        {
          actor: { type: "human", id: "profile-legacy" },
          contributionCount: 1,
          firstPromptedAt: 0,
          lastPromptedAt: 0,
        },
      ]);
      expect(loadSessionEntry(scope)?.participants).toEqual([
        { type: "human", id: "profile-legacy" },
      ]);
      openOpenClawAgentDatabase({ agentId: "main", env: state.env })
        .db.prepare("DELETE FROM session_participants WHERE actor_id = 'profile-legacy'")
        .run();
      closeOpenClawAgentDatabasesForTest();
      expect(
        recordSessionParticipant(scope, {
          actor: { type: "human", id: "profile-owner" },
          promptedAt: 1,
          sessionAgentId: "main",
          source: "profile",
        }),
      ).toBe("inserted");
      for (let index = 0; index < MAX_SESSION_PARTICIPANTS - 1; index += 1) {
        expect(
          recordSessionParticipant(scope, {
            actor: { type: "human", id: `profile-${String(index).padStart(2, "0")}` },
            promptedAt: index + 10,
            sessionAgentId: "main",
            source: "profile",
          }),
        ).toBe("inserted");
      }
      expect(
        recordSessionParticipant(scope, {
          actor: { type: "human", id: "profile-over-cap" },
          promptedAt: 100,
          sessionAgentId: "main",
          source: "profile",
        }),
      ).toBe("capped");
      expect(
        recordSessionParticipant(scope, {
          actor: { type: "human", id: "profile-00" },
          promptedAt: 200,
          sessionAgentId: "main",
          source: "profile",
        }),
      ).toBe("updated");
      expect(
        recordSessionParticipant(scope, {
          actor: { type: "human", id: "profile-00" },
          promptedAt: 50,
          sessionAgentId: "main",
          source: "channel",
        }),
      ).toBe("updated");
      expect(
        recordSessionParticipant(scope, {
          actor: { type: "agent", id: "main" },
          promptedAt: 300,
          sessionAgentId: "main",
          source: "agent",
        }),
      ).toBeNull();

      const participantDatabase = openOpenClawAgentDatabase({ agentId: "main", env: state.env });
      participantDatabase.db
        .prepare(
          "UPDATE session_participants SET actor_source = NULL WHERE actor_id = 'profile-01'",
        )
        .run();

      const records = listSessionParticipantsReadOnly(scope).get(sessionKey) ?? [];
      expect(records).toHaveLength(MAX_SESSION_PARTICIPANTS);
      expect(records.find((record) => record.actor.id === "profile-00")).toMatchObject({
        contributionCount: 2,
        firstPromptedAt: 10,
        lastPromptedAt: 200,
        source: "profile",
      });
      expect(
        participantDatabase.db.prepare("PRAGMA table_info(session_participants)").all(),
      ).toContainEqual(
        expect.objectContaining({
          name: "contribution_count",
          type: "INTEGER",
          notnull: 0,
          dflt_value: null,
        }),
      );
      const legacyRecord = records.find((record) => record.actor.id === "profile-01");
      expect(legacyRecord?.actor).toEqual({ type: "human", id: "profile-01" });
      expect(legacyRecord).not.toHaveProperty("source");
      const projected = loadSessionEntry(scope);
      expect(projected?.participantCount).toBe(MAX_SESSION_PARTICIPANTS - 1);
      expect(projected?.participants).toHaveLength(MAX_SESSION_PARTICIPANTS - 1);
      expect(projected?.participants?.slice(0, 4)).toEqual([
        { type: "human", id: "profile-00", source: "profile" },
        { type: "human", id: "profile-01" },
        { type: "human", id: "profile-02", source: "profile" },
        { type: "human", id: "profile-03", source: "profile" },
      ]);

      closeOpenClawAgentDatabasesForTest();
      const reopened = openOpenClawAgentDatabase({ agentId: "main", env: state.env });
      expect(reopened.db.prepare("PRAGMA user_version").get()?.user_version).toBe(schemaVersion);
      expect(loadSessionEntry(scope)?.participantCount).toBe(MAX_SESSION_PARTICIPANTS - 1);

      await deleteSessionEntryLifecycle({
        agentId: "main",
        storePath,
        target: { canonicalKey: sessionKey, storeKeys: [sessionKey] },
        archiveTranscript: false,
      });
      expect(listSessionParticipantsReadOnly(scope).get(sessionKey)).toBeUndefined();
    });
  });

  it("counts only authoritative profile prompts after a channel identity collision", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const sessionKey = "agent:main:participant-collision";
      const scope = { agentId: "main", env: state.env, sessionKey };
      await upsertSessionEntryCore(scope, { sessionId: "participant-collision", updatedAt: 1 });

      for (const [source, promptedAt] of [
        ["channel", 10],
        ["channel", 20],
        ["profile", 30],
        ["profile", 40],
        ["channel", 50],
        ["channel", 5],
      ] as const) {
        recordSessionParticipant(scope, {
          actor: { type: "human", id: "profile-collision" },
          promptedAt,
          sessionAgentId: "main",
          source,
        });
      }

      expect(listSessionParticipantsReadOnly(scope).get(sessionKey)).toEqual([
        {
          actor: { type: "human", id: "profile-collision" },
          contributionCount: 2,
          firstPromptedAt: 30,
          lastPromptedAt: 50,
          source: "profile",
        },
      ]);

      const database = openOpenClawAgentDatabase({ agentId: "main", env: state.env });
      database.db
        .prepare(
          `INSERT INTO session_participants
            (session_key, actor_type, actor_id, actor_source, first_prompted_at, last_prompted_at)
           VALUES (?, 'human', 'profile-older-reader', 'profile', 15, 15)`,
        )
        .run(sessionKey);
      expect(
        listSessionParticipantsReadOnly(scope)
          .get(sessionKey)
          ?.find((participant) => participant.actor.id === "profile-older-reader"),
      ).toMatchObject({ contributionCount: 1, firstPromptedAt: 15 });
      recordSessionParticipant(scope, {
        actor: { type: "human", id: "profile-older-reader" },
        promptedAt: 60,
        sessionAgentId: "main",
        source: "profile",
      });
      expect(
        listSessionParticipantsReadOnly(scope)
          .get(sessionKey)
          ?.find((participant) => participant.actor.id === "profile-older-reader"),
      ).toMatchObject({ contributionCount: 2, firstPromptedAt: 15 });
    });
  });

  it("does not double-count a retried cross-store participant repair", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const sourceKey = "agent:source:shared";
      const destinationKey = "agent:main:shared";
      const sourceScope = { agentId: "source", env: state.env, sessionKey: sourceKey };
      const destinationScope = { agentId: "main", env: state.env, sessionKey: destinationKey };
      await upsertSessionEntryCore(sourceScope, { sessionId: "source-shared", updatedAt: 1 });
      await upsertSessionEntryCore(destinationScope, {
        sessionId: "destination-shared",
        updatedAt: 1,
      });
      for (const promptedAt of [10, 20, 30]) {
        recordSessionParticipant(sourceScope, {
          actor: { type: "human", id: "profile-shared" },
          promptedAt,
          source: "profile",
        });
      }
      for (const promptedAt of [40, 50]) {
        recordSessionParticipant(destinationScope, {
          actor: { type: "human", id: "profile-shared" },
          promptedAt,
          source: "profile",
        });
      }

      const source = openOpenClawAgentDatabase({ agentId: "source", env: state.env });
      const destination = openOpenClawAgentDatabase({ agentId: "main", env: state.env });
      copySessionNodeArtifactsForRepair(source, destination, [sourceKey], destinationKey);
      copySessionNodeArtifactsForRepair(source, destination, [sourceKey], destinationKey);

      expect(listSessionParticipantsReadOnly(destinationScope).get(destinationKey)).toEqual([
        expect.objectContaining({
          actor: { type: "human", id: "profile-shared" },
          contributionCount: 3,
          source: "profile",
        }),
      ]);
    });
  });
});
