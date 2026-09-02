import { existsSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import {
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import { ensureProfileForEmail, linkEmail } from "../../state/user-profiles.js";
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
import type { SessionParticipantIdentity } from "./session-participant-identity.js";

const profile = (id: string): SessionParticipantIdentity => ({ type: "profile", id });
const remote = (id: string, domain = "workspace"): SessionParticipantIdentity => ({
  type: "remote",
  pluginId: "test-channel",
  domain,
  idKind: "user",
  id,
});

afterEach(closeOpenClawAgentDatabasesForTest);

describe("SQLite session participants", () => {
  it("does not create a missing agent database during participant reads", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      expect(listSessionParticipantsReadOnly({ agentId: "absent", env: state.env }).size).toBe(0);
      expect(existsSync(state.agentDir("absent"))).toBe(false);
    });
  });

  it.each([false, true])(
    "keeps namespaces and times separate (profile first: %s)",
    async (profileFirst) => {
      await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
        const scope = { agentId: "main", env: state.env, sessionKey: "agent:main:collision" };
        await upsertSessionEntryCore(scope, { sessionId: "collision", updatedAt: 1 });
        const inputs = [
          { identity: remote("same-id"), promptedAt: 10 },
          { identity: remote("same-id"), promptedAt: 20 },
          { identity: profile("same-id"), promptedAt: 30 },
          { identity: profile("same-id"), promptedAt: 40 },
          { identity: remote("same-id"), promptedAt: 50 },
          { identity: remote("same-id"), promptedAt: 5 },
        ];
        for (const input of profileFirst ? inputs.toReversed() : inputs) {
          recordSessionParticipant(scope, input);
        }
        recordSessionParticipant(scope, {
          identity: { type: "agent", id: "same-id" },
          promptedAt: 40,
        });
        recordSessionParticipant(scope, {
          identity: remote("same-id", "other-workspace"),
          promptedAt: 40,
        });
        closeOpenClawAgentDatabasesForTest();
        const records = listSessionParticipantsReadOnly(scope).get(scope.sessionKey) ?? [];
        expect(records).toHaveLength(4);
        expect(records).toEqual(
          expect.arrayContaining([
            {
              identity: profile("same-id"),
              contributionCount: 2,
              firstPromptedAt: 30,
              lastPromptedAt: 40,
            },
            {
              identity: remote("same-id"),
              contributionCount: 4,
              firstPromptedAt: 5,
              lastPromptedAt: 50,
            },
            {
              identity: remote("same-id", "other-workspace"),
              contributionCount: 1,
              firstPromptedAt: 40,
              lastPromptedAt: 40,
            },
            {
              identity: { type: "agent", id: "same-id" },
              contributionCount: 1,
              firstPromptedAt: 40,
              lastPromptedAt: 40,
            },
          ]),
        );
      });
    },
  );

  it.each([false, true])(
    "updates a merged profile at the admission bound (canonical row: %s)",
    async (hasCanonicalRow) => {
      await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
        const scope = { agentId: "main", env: state.env, sessionKey: "agent:main:merged-full" };
        const old = ensureProfileForEmail("old@example.test", { env: state.env });
        const current = ensureProfileForEmail("current@example.test", { env: state.env });
        await upsertSessionEntryCore(scope, { sessionId: "merged-full", updatedAt: 1 });
        recordSessionParticipant(scope, { identity: profile(old.id), promptedAt: 10 });
        if (hasCanonicalRow) {
          recordSessionParticipant(scope, { identity: profile(current.id), promptedAt: 20 });
        }
        for (let index = hasCanonicalRow ? 2 : 1; index < MAX_SESSION_PARTICIPANTS; index++) {
          recordSessionParticipant(scope, { identity: remote(`remote-${index}`), promptedAt: 30 });
        }
        linkEmail("old@example.test", current.id, { env: state.env });
        expect(
          recordSessionParticipant(scope, { identity: profile(current.id), promptedAt: 40 }),
        ).toBe("updated");
        const records = listSessionParticipantsReadOnly(scope).get(scope.sessionKey) ?? [];
        expect(records).toHaveLength(MAX_SESSION_PARTICIPANTS);
        const profiles = records.filter((record) => record.identity.type === "profile");
        expect(profiles.reduce((count, record) => count + record.contributionCount, 0)).toBe(
          hasCanonicalRow ? 3 : 2,
        );
        expect(
          profiles.find((record) => record.identity.id === (hasCanonicalRow ? current.id : old.id)),
        ).toMatchObject({ contributionCount: 2, lastPromptedAt: 40 });
      });
    },
  );

  it("keeps the admission bound, unknown first time, reset history, and deletion ownership", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const scope = { agentId: "main", env: state.env, sessionKey: "agent:main:bounded" };
      await upsertSessionEntryCore(scope, { sessionId: "bounded", updatedAt: 1 });
      const database = openOpenClawAgentDatabase({ agentId: "main", env: state.env });
      database.db.exec("DROP TABLE session_participants");
      expect(listSessionParticipantsReadOnly(scope).get(scope.sessionKey)).toBeUndefined();
      expect(
        database.db
          .prepare("SELECT name FROM sqlite_schema WHERE name = 'session_participants'")
          .get(),
      ).toBeUndefined();
      for (let index = 0; index < MAX_SESSION_PARTICIPANTS; index++) {
        expect(
          recordSessionParticipant(scope, {
            identity: profile(`profile-${index}`),
            promptedAt: 10,
          }),
        ).toBe("inserted");
      }
      expect(
        recordSessionParticipant(scope, { identity: remote("profile-0"), promptedAt: 10 }),
      ).toBe("capped");
      expect(
        recordSessionParticipant(scope, {
          identity: { type: "agent", id: "main" },
          sessionAgentId: "main",
        }),
      ).toBeNull();
      database.db
        .prepare(
          "UPDATE session_participants SET first_prompted_at = NULL, last_prompted_at = NULL WHERE actor_id = 'profile-0'",
        )
        .run();
      recordSessionParticipant(scope, { identity: profile("profile-0"), promptedAt: 20 });
      recordSessionParticipant(scope, { identity: profile("profile-0"), promptedAt: 20 });
      recordSessionParticipant(scope, { identity: profile("profile-0"), promptedAt: 15 });
      expect(listSessionParticipantsReadOnly(scope).get(scope.sessionKey)).toContainEqual({
        identity: profile("profile-0"),
        contributionCount: 4,
        firstPromptedAt: null,
        lastPromptedAt: 20,
      });
      await upsertSessionEntryCore(scope, { sessionId: "bounded-reset", updatedAt: 30 });
      expect(loadSessionEntry(scope)?.participants).toHaveLength(MAX_SESSION_PARTICIPANTS);
      await deleteSessionEntryLifecycle({
        agentId: "main",
        storePath: database.path,
        target: { canonicalKey: scope.sessionKey, storeKeys: [scope.sessionKey] },
        archiveTranscript: false,
      });
      expect(listSessionParticipantsReadOnly(scope).get(scope.sessionKey)).toBeUndefined();
    });
  });

  it("preserves over-bound repair histories and does not inflate retried cross-store copies", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const sourceScope = { agentId: "source", env: state.env, sessionKey: "agent:source:shared" };
      const targetScope = { agentId: "main", env: state.env, sessionKey: "agent:main:shared" };
      await upsertSessionEntryCore(sourceScope, { sessionId: "source", updatedAt: 1 });
      await upsertSessionEntryCore(targetScope, { sessionId: "target", updatedAt: 1 });
      for (let index = 0; index < MAX_SESSION_PARTICIPANTS; index++) {
        recordSessionParticipant(sourceScope, {
          identity: profile(`profile-${index}`),
          promptedAt: 10,
        });
        recordSessionParticipant(targetScope, {
          identity: remote(`profile-${index}`),
          promptedAt: 20,
        });
      }
      recordSessionParticipant(sourceScope, { identity: profile("profile-0"), promptedAt: 30 });
      const source = openOpenClawAgentDatabase({ agentId: "source", env: state.env });
      const target = openOpenClawAgentDatabase({ agentId: "main", env: state.env });
      copySessionNodeArtifactsForRepair(
        source,
        target,
        [sourceScope.sessionKey],
        targetScope.sessionKey,
      );
      copySessionNodeArtifactsForRepair(
        source,
        target,
        [sourceScope.sessionKey],
        targetScope.sessionKey,
      );
      const rows = listSessionParticipantsReadOnly(targetScope).get(targetScope.sessionKey) ?? [];
      expect(rows).toHaveLength(64);
      expect(
        rows.find((row) => row.identity.type === "profile" && row.identity.id === "profile-0")
          ?.contributionCount,
      ).toBe(2);
      expect(
        recordSessionParticipant(targetScope, { identity: profile("overflow"), promptedAt: 40 }),
      ).toBe("capped");
    });
  });
});
