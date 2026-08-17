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
      initial.db.exec("DROP TABLE session_participants;");
      const schemaVersion = initial.db.prepare("PRAGMA user_version").get()?.user_version;
      closeOpenClawAgentDatabasesForTest();

      expect(listSessionParticipantsReadOnly(scope)).toEqual(new Map());
      expect(
        recordSessionParticipant(scope, {
          actor: { type: "human", id: "profile-owner" },
          promptedAt: 1,
          sessionAgentId: "main",
        }),
      ).toBe("inserted");
      for (let index = 0; index < MAX_SESSION_PARTICIPANTS - 1; index += 1) {
        expect(
          recordSessionParticipant(scope, {
            actor: { type: "human", id: `profile-${String(index).padStart(2, "0")}` },
            promptedAt: index + 10,
            sessionAgentId: "main",
          }),
        ).toBe("inserted");
      }
      expect(
        recordSessionParticipant(scope, {
          actor: { type: "human", id: "profile-over-cap" },
          promptedAt: 100,
          sessionAgentId: "main",
        }),
      ).toBe("capped");
      expect(
        recordSessionParticipant(scope, {
          actor: { type: "human", id: "profile-00" },
          promptedAt: 200,
          sessionAgentId: "main",
        }),
      ).toBe("updated");
      expect(
        recordSessionParticipant(scope, {
          actor: { type: "human", id: "profile-00" },
          promptedAt: 50,
          sessionAgentId: "main",
        }),
      ).toBe("updated");
      expect(
        recordSessionParticipant(scope, {
          actor: { type: "agent", id: "main" },
          promptedAt: 300,
          sessionAgentId: "main",
        }),
      ).toBeNull();

      const records = listSessionParticipantsReadOnly(scope).get(sessionKey) ?? [];
      expect(records).toHaveLength(MAX_SESSION_PARTICIPANTS);
      expect(records.find((record) => record.actor.id === "profile-00")).toMatchObject({
        firstPromptedAt: 10,
        lastPromptedAt: 200,
      });
      const projected = loadSessionEntry(scope);
      expect(projected?.participantCount).toBe(MAX_SESSION_PARTICIPANTS - 1);
      expect(projected?.participants).toHaveLength(MAX_SESSION_PARTICIPANTS - 1);
      expect(projected?.participants?.slice(0, 4)).toEqual([
        { type: "human", id: "profile-00" },
        { type: "human", id: "profile-01" },
        { type: "human", id: "profile-02" },
        { type: "human", id: "profile-03" },
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
});
