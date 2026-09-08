import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildConversationIdentity } from "../config/sessions/conversation-identity.js";
import { resolveSessionStorePathCore } from "../config/sessions/paths.js";
import {
  loadTranscriptEvents,
  loadExactSessionEntryReadOnly,
  replaceSessionEntrySync,
} from "../config/sessions/session-accessor.js";
import { resolveSqliteTargetFromSessionStorePath } from "../config/sessions/session-sqlite-target.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  readSessionProgressCard,
  writeSessionProgressCard,
} from "../session-cards/progress-card-store.js";
import {
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
} from "../state/openclaw-agent-db.js";
import { withStateDirEnv } from "../test-helpers/state-dir-env.js";
import {
  deliveryContextFromSession,
  normalizeSessionDeliveryState,
} from "../utils/delivery-context.shared.js";
import { repairCanonicalSessionKeys } from "./doctor-session-canonical-keys.js";
import { insertLegacySession } from "./doctor-session-canonical-keys.test-support.js";

function openSessionDatabase(agentId: string, env: NodeJS.ProcessEnv, storePath: string) {
  return openOpenClawAgentDatabase({
    agentId,
    env,
    path: resolveSqliteTargetFromSessionStorePath(storePath, { agentId, env }).path,
  });
}

afterEach(() => closeOpenClawAgentDatabasesForTest());

describe("doctor canonical session-key repair", () => {
  it.each([
    {
      canonicalKey: "agent:main:matrix:channel:!MixedCase:example.org",
      channel: "matrix",
      chatType: "channel" as const,
      label: "Matrix room",
      to: "!MixedCase:example.org",
    },
    {
      canonicalKey: "agent:main:signal:group:VWATodkf2hc8zdOS76q9Tb0+5Bi522E03qLdaQ/9ypg=",
      channel: "signal",
      chatType: "group" as const,
      label: "Signal group",
      to: "signal:group:VWATodkf2hc8zdOS76q9Tb0+5Bi522E03qLdaQ/9ypg=",
    },
  ])("restores a delivery-proven lowercased $label alias", async (fixture) => {
    await withStateDirEnv("openclaw-doctor-canonical-delivery-alias-", async ({ stateDir }) => {
      const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
      const storeTemplate = path.join(stateDir, "agents", "{agentId}", "sessions.json");
      const storePath = resolveSessionStorePathCore(storeTemplate, { agentId: "main", env });
      const cfg = {
        agents: { list: [{ id: "main", default: true }] },
        session: { store: storeTemplate },
      } as OpenClawConfig;
      const legacyKey = fixture.canonicalKey.toLowerCase();
      insertLegacySession({
        agentId: "main",
        entry: {
          chatType: fixture.chatType,
          delivery: normalizeSessionDeliveryState({
            context: { channel: fixture.channel, to: fixture.to },
          }),
          sessionId: `${fixture.channel}-legacy-session`,
          updatedAt: 10,
        },
        env,
        eventText: `${fixture.label} history`,
        sessionKey: legacyKey,
        storePath,
      });
      const childKey = `agent:main:${fixture.channel}-child`;
      insertLegacySession({
        agentId: "main",
        entry: {
          parentSessionKey: legacyKey,
          sessionId: `${fixture.channel}-child-session`,
          updatedAt: 5,
        },
        env,
        sessionKey: childKey,
        storePath,
      });

      expect(await repairCanonicalSessionKeys({ apply: true, cfg, env })).toMatchObject({
        foundGroups: 2,
        repairBatches: 1,
        removedRows: 1,
        repairedGroups: 2,
      });
      expect(
        loadExactSessionEntryReadOnly({
          agentId: "main",
          env,
          sessionKey: fixture.canonicalKey,
          storePath,
        })?.entry.sessionId,
      ).toBe(`${fixture.channel}-legacy-session`);
      expect(
        loadExactSessionEntryReadOnly({ agentId: "main", env, sessionKey: legacyKey, storePath }),
      ).toBeUndefined();
      expect(
        loadExactSessionEntryReadOnly({ agentId: "main", env, sessionKey: childKey, storePath })
          ?.entry.parentSessionKey,
      ).toBe(fixture.canonicalKey);
      await expect(
        loadTranscriptEvents({
          agentId: "main",
          env,
          sessionId: `${fixture.channel}-legacy-session`,
          sessionKey: fixture.canonicalKey,
          storePath,
        }),
      ).resolves.toEqual([
        expect.objectContaining({
          message: expect.objectContaining({ content: `${fixture.label} history` }),
        }),
      ]);
      expect(await repairCanonicalSessionKeys({ apply: true, cfg, env })).toMatchObject({
        foundGroups: 0,
        repairedGroups: 0,
      });
    });
  });

  it("bounds same-database repair batches while collapsing whole-store projections", async () => {
    await withStateDirEnv("openclaw-doctor-canonical-batches-", async ({ stateDir }) => {
      const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
      const storeTemplate = path.join(stateDir, "agents", "{agentId}", "sessions.json");
      const storePath = resolveSessionStorePathCore(storeTemplate, { agentId: "main", env });
      const cfg = {
        agents: { list: [{ id: "main", default: true }] },
        session: { store: storeTemplate },
      } as OpenClawConfig;
      for (let index = 0; index < 65; index += 1) {
        const target = `!BatchRoom${index}:example.org`;
        const canonicalKey = `agent:main:matrix:channel:${target}`;
        insertLegacySession({
          agentId: "main",
          entry: {
            chatType: "channel",
            delivery: normalizeSessionDeliveryState({
              context: { channel: "matrix", to: target },
            }),
            sessionId: `batch-session-${index}`,
            updatedAt: index,
          },
          env,
          sessionKey: canonicalKey.toLowerCase(),
          storePath,
        });
      }

      expect(await repairCanonicalSessionKeys({ apply: true, cfg, env })).toMatchObject({
        foundGroups: 65,
        repairBatches: 2,
        removedRows: 65,
        repairedGroups: 65,
      });
      expect(await repairCanonicalSessionKeys({ apply: true, cfg, env })).toMatchObject({
        foundGroups: 0,
        repairBatches: 0,
        repairedGroups: 0,
      });
    });
  });

  it("is a no-op for fresh stores and remains idempotent after repair", async () => {
    await withStateDirEnv("openclaw-doctor-canonical-fresh-", async ({ stateDir }) => {
      const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
      const storeTemplate = path.join(stateDir, "agents", "{agentId}", "sessions.json");
      const storePath = resolveSessionStorePathCore(storeTemplate, { agentId: "main", env });
      const cfg = {
        agents: { list: [{ id: "main", default: true }] },
        session: { store: storeTemplate },
      } as OpenClawConfig;
      replaceSessionEntrySync(
        { agentId: "main", env, sessionKey: "agent:main:main", storePath },
        { sessionId: "fresh", updatedAt: 10 },
      );

      expect(await repairCanonicalSessionKeys({ apply: false, cfg, env })).toMatchObject({
        foundGroups: 0,
        repairedGroups: 0,
      });
      expect(await repairCanonicalSessionKeys({ apply: true, cfg, env })).toMatchObject({
        foundGroups: 0,
        repairedGroups: 0,
      });
      const database = openSessionDatabase("main", env, storePath);
      database.db
        .prepare("UPDATE session_nodes SET entry_json = ? WHERE session_key = ?")
        .run(
          JSON.stringify({ sessionId: "\0invalid", subject: "legacy", updatedAt: 10 }),
          "agent:main:main",
        );
      expect(
        database.db
          .prepare("SELECT entry_valid FROM session_nodes WHERE session_key = ?")
          .get("agent:main:main"),
      ).toEqual({ entry_valid: 0 });
      expect(await repairCanonicalSessionKeys({ apply: true, cfg, env })).toMatchObject({
        foundGroups: 1,
        removedRows: 0,
        repairedGroups: 1,
      });
      expect(
        JSON.parse(
          (
            database.db
              .prepare("SELECT entry_json FROM session_nodes WHERE session_key = ?")
              .get("agent:main:main") as { entry_json: string }
          ).entry_json,
        ),
      ).toMatchObject({ sessionId: "fresh", subject: "legacy", updatedAt: 10 });
      expect(
        database.db
          .prepare("SELECT entry_valid FROM session_nodes WHERE session_key = ?")
          .get("agent:main:main"),
      ).toEqual({ entry_valid: 1 });
      expect(await repairCanonicalSessionKeys({ apply: true, cfg, env })).toMatchObject({
        foundGroups: 0,
        repairedGroups: 0,
      });
    });
  });

  it("moves a legacy global heartbeat sibling to its agent-qualified key", async () => {
    await withStateDirEnv("openclaw-doctor-canonical-global-heartbeat-", async ({ stateDir }) => {
      const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
      const storeTemplate = path.join(stateDir, "agents", "{agentId}", "sessions.json");
      const storePath = resolveSessionStorePathCore(storeTemplate, { agentId: "historian2", env });
      const cfg = {
        agents: { list: [{ id: "main", default: true }, { id: "historian2" }] },
        session: { scope: "global", store: storeTemplate },
      } as OpenClawConfig;
      insertLegacySession({
        agentId: "historian2",
        entry: {
          heartbeatIsolatedBaseSessionKey: "global",
          lastHeartbeatText: "legacy heartbeat",
          sessionId: "heartbeat-session",
          updatedAt: 10,
        },
        env,
        sessionKey: "global:heartbeat",
        storePath,
      });

      expect(await repairCanonicalSessionKeys({ apply: true, cfg, env })).toMatchObject({
        foundGroups: 1,
        repairedGroups: 1,
      });
      expect(
        loadExactSessionEntryReadOnly({
          agentId: "historian2",
          env,
          sessionKey: "agent:historian2:global:heartbeat",
          storePath,
        })?.entry,
      ).toMatchObject({
        heartbeatIsolatedBaseSessionKey: "global",
        lastHeartbeatText: "legacy heartbeat",
        sessionId: "heartbeat-session",
      });
      expect(
        loadExactSessionEntryReadOnly({
          agentId: "historian2",
          env,
          sessionKey: "global:heartbeat",
          storePath,
        }),
      ).toBeUndefined();
    });
  });

  it("preserves in-flight recovery ownership while canonicalizing the main alias", async () => {
    await withStateDirEnv("openclaw-doctor-canonical-recovery-owner-", async ({ stateDir }) => {
      const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
      const storeTemplate = path.join(stateDir, "agents", "{agentId}", "sessions.json");
      const storePath = resolveSessionStorePathCore(storeTemplate, { agentId: "main", env });
      const cfg = {
        agents: { list: [{ id: "main", default: true }] },
        session: { store: storeTemplate },
      } as OpenClawConfig;
      insertLegacySession({
        agentId: "main",
        entry: {
          abortedLastRun: true,
          mainRestartRecovery: {
            cycleId: "cycle-1",
            revision: 2,
            chargedAttempts: 1,
            reservation: {
              runId: "recovery-1",
              attempt: 1,
              lifecycleGeneration: "generation-1",
            },
            foregroundClaims: {
              lifecycleGeneration: "generation-1",
              tokens: ["claim-1"],
            },
          },
          sessionId: "main-session",
          updatedAt: 10,
        },
        env,
        sessionKey: "main",
        storePath,
      });

      expect(await repairCanonicalSessionKeys({ apply: true, cfg, env })).toMatchObject({
        foundGroups: 1,
        repairedGroups: 1,
      });
      expect(
        loadExactSessionEntryReadOnly({
          agentId: "main",
          env,
          sessionKey: "agent:main:main",
          storePath,
        })?.entry,
      ).toMatchObject({
        abortedLastRun: true,
        mainRestartRecovery: {
          cycleId: "cycle-1",
          revision: 2,
          chargedAttempts: 1,
          reservation: { runId: "recovery-1", attempt: 1 },
          foregroundClaims: { tokens: ["claim-1"] },
        },
      });
    });
  });

  it("moves an empty stored key to the owning agent main key", async () => {
    await withStateDirEnv("openclaw-doctor-canonical-empty-key-", async ({ stateDir }) => {
      const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
      const storeTemplate = path.join(stateDir, "agents", "{agentId}", "sessions.json");
      const storePath = resolveSessionStorePathCore(storeTemplate, { agentId: "main", env });
      const cfg = {
        agents: { list: [{ id: "main", default: true }] },
        session: { store: storeTemplate },
      } as OpenClawConfig;
      insertLegacySession({
        agentId: "main",
        entry: { sessionId: "empty-key-session", updatedAt: 10 },
        env,
        eventText: "empty key history",
        sessionKey: "",
        storePath,
      });
      const database = openSessionDatabase("main", env, storePath);
      database.db
        .prepare(
          "INSERT INTO conversations (conversation_id, channel, account_id, kind, peer_id, delivery_target, metadata_json, created_at, updated_at) VALUES ('empty-key-conversation', 'webchat', 'default', 'direct', 'empty', 'empty', '{}', 10, 10)",
        )
        .run();
      database.db
        .prepare(
          "INSERT INTO conversation_deliveries (operation_id, operation_kind, conversation_id, source_session_key, message_hash, status, created_at, updated_at) VALUES ('empty-key-operation', 'turn', 'empty-key-conversation', '', 'hash', 'sent', 10, 10)",
        )
        .run();

      expect(await repairCanonicalSessionKeys({ apply: true, cfg, env })).toMatchObject({
        foundGroups: 1,
        removedRows: 1,
        repairedGroups: 1,
      });
      expect(
        loadExactSessionEntryReadOnly({
          agentId: "main",
          env,
          sessionKey: "agent:main:main",
          storePath,
        })?.entry.sessionId,
      ).toBe("empty-key-session");
      expect(
        loadExactSessionEntryReadOnly({ agentId: "main", env, sessionKey: "", storePath }),
      ).toBeUndefined();
      await expect(
        loadTranscriptEvents({
          agentId: "main",
          env,
          sessionId: "empty-key-session",
          sessionKey: "agent:main:main",
          storePath,
        }),
      ).resolves.toEqual([
        expect.objectContaining({
          message: expect.objectContaining({ content: "empty key history" }),
        }),
      ]);
      expect(
        database.db
          .prepare(
            "SELECT source_session_key FROM conversation_deliveries WHERE operation_id = 'empty-key-operation'",
          )
          .get(),
      ).toEqual({ source_session_key: "agent:main:main" });
    });
  });

  it("rehomes matching in-store transcript generations under the canonical key", async () => {
    await withStateDirEnv("openclaw-doctor-canonical-rehome-", async ({ stateDir }) => {
      const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
      const storeTemplate = path.join(stateDir, "agents", "{agentId}", "sessions.json");
      const storePath = resolveSessionStorePathCore(storeTemplate, { agentId: "main", env });
      const cfg = {
        agents: { list: [{ id: "main", default: true }] },
        session: { mainKey: "work", store: storeTemplate },
      } as OpenClawConfig;
      replaceSessionEntrySync(
        { agentId: "main", env, sessionKey: "agent:main:work", storePath },
        { previousSessionId: "older", sessionId: "newer", updatedAt: 20 },
      );
      insertLegacySession({
        agentId: "main",
        entry: { sessionId: "older", subject: "preserved", updatedAt: 10 },
        env,
        eventText: "older history",
        sessionKey: "agent:main:main",
        storePath,
      });
      const database = openSessionDatabase("main", env, storePath);
      database.db
        .prepare("UPDATE session_nodes SET entry_json = ? WHERE session_key = ?")
        .run(JSON.stringify({ sessionId: "older", subject: "preserved" }), "agent:main:main");

      const first = await repairCanonicalSessionKeys({ apply: true, cfg, env });
      expect(first).toMatchObject({ foundGroups: 1, removedRows: 1, repairedGroups: 1 });
      expect(first.archivedTranscriptDirectories).toEqual([]);
      expect(
        database.db
          .prepare("SELECT session_key FROM session_windows WHERE session_id = ?")
          .get("older"),
      ).toEqual({ session_key: "agent:main:work" });
      expect(
        database.db
          .prepare("SELECT count(*) AS count FROM transcript_events WHERE session_id = ?")
          .get("older"),
      ).toEqual({ count: 1 });
      expect(await repairCanonicalSessionKeys({ apply: true, cfg, env })).toMatchObject({
        foundGroups: 0,
        repairedGroups: 0,
      });
    });
  });

  it("replaces same-store membership from the selected alias winner", async () => {
    await withStateDirEnv("openclaw-doctor-canonical-members-", async ({ stateDir }) => {
      const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
      const storeTemplate = path.join(stateDir, "agents", "{agentId}", "sessions.json");
      const storePath = resolveSessionStorePathCore(storeTemplate, { agentId: "main", env });
      const cfg = {
        agents: { list: [{ id: "main", default: true }] },
        session: { mainKey: "work", store: storeTemplate },
      } as OpenClawConfig;
      replaceSessionEntrySync(
        { agentId: "main", env, sessionKey: "agent:main:work", storePath },
        { sessionId: "shared-session", updatedAt: 10 },
      );
      insertLegacySession({
        agentId: "main",
        entry: { sessionId: "alias-winner-session", updatedAt: 20 },
        env,
        sessionKey: "agent:main:main",
        storePath,
      });
      const database = openSessionDatabase("main", env, storePath);
      const insertMember = database.db.prepare(
        "INSERT INTO session_members (session_key, identity_id, added_by, added_at) VALUES (?, ?, 'owner', 10)",
      );
      insertMember.run("agent:main:work", "canonical-member");
      insertMember.run("agent:main:main", "winner-member");
      writeSessionProgressCard(database.db, "agent:main:work", { markdown: "Already completed" });
      writeSessionProgressCard(database.db, "agent:main:work", {});
      writeSessionProgressCard(database.db, "agent:main:main", { markdown: "Do not resurrect" });
      database.db
        .prepare(
          "INSERT INTO conversations (conversation_id, channel, account_id, kind, peer_id, delivery_target, metadata_json, created_at, updated_at) VALUES ('same-store-conversation', 'webchat', 'default', 'direct', 'peer', 'peer', '{}', 10, 10)",
        )
        .run();
      database.db
        .prepare(
          "INSERT INTO conversation_deliveries (operation_id, operation_kind, conversation_id, source_session_key, message_hash, status, created_at, updated_at) VALUES ('same-store-operation', 'turn', 'same-store-conversation', 'agent:main:main', 'hash', 'sent', 10, 10)",
        )
        .run();

      expect(await repairCanonicalSessionKeys({ apply: true, cfg, env })).toMatchObject({
        foundGroups: 1,
        removedRows: 1,
        repairedGroups: 1,
      });
      expect(database.db.prepare("SELECT identity_id FROM session_members").all()).toEqual([
        { identity_id: "winner-member" },
      ]);
      expect(
        database.db
          .prepare("SELECT markdown, revision, session_key FROM session_progress_cards")
          .all(),
      ).toEqual([{ markdown: null, revision: 2, session_key: "agent:main:work" }]);
      expect(
        database.db
          .prepare(
            "SELECT source_session_key FROM conversation_deliveries WHERE operation_id = 'same-store-operation'",
          )
          .get(),
      ).toEqual({ source_session_key: "agent:main:work" });
    });
  });

  it("rehomes suggestions from a stale same-store alias", async () => {
    await withStateDirEnv("openclaw-doctor-canonical-suggestions-", async ({ stateDir }) => {
      const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
      const storeTemplate = path.join(stateDir, "agents", "{agentId}", "sessions.json");
      const storePath = resolveSessionStorePathCore(storeTemplate, { agentId: "main", env });
      const cfg = {
        agents: { list: [{ id: "main", default: true }] },
        session: { mainKey: "work", store: storeTemplate },
      } as OpenClawConfig;
      replaceSessionEntrySync(
        { agentId: "main", env, sessionKey: "agent:main:work", storePath },
        { sessionId: "winner", updatedAt: 20 },
      );
      insertLegacySession({
        agentId: "main",
        entry: { sessionId: "stale-alias", updatedAt: 10 },
        env,
        sessionKey: "agent:main:main",
        storePath,
      });
      const database = openSessionDatabase("main", env, storePath);
      database.db
        .prepare(
          "INSERT INTO session_suggestions (id, session_key, author_id, text, created_at, state) VALUES ('alias-suggestion', 'agent:main:main', 'operator', 'keep me', 10, 'pending')",
        )
        .run();
      const insertMember = database.db.prepare(
        "INSERT INTO session_members (session_key, identity_id, added_by, added_at) VALUES (?, ?, 'owner', 10)",
      );
      insertMember.run("agent:main:work", "canonical-member");
      insertMember.run("agent:main:main", "stale-alias-member");

      expect(await repairCanonicalSessionKeys({ apply: true, cfg, env })).toMatchObject({
        foundGroups: 1,
        removedRows: 1,
        repairedGroups: 1,
      });
      expect(
        database.db
          .prepare("SELECT session_key FROM session_suggestions WHERE id = 'alias-suggestion'")
          .get(),
      ).toEqual({ session_key: "agent:main:work" });
      expect(database.db.prepare("SELECT identity_id FROM session_members").all()).toEqual([
        { identity_id: "canonical-member" },
      ]);
    });
  });

  it("keeps sentinel rows scoped to their owning agent stores", async () => {
    await withStateDirEnv("openclaw-doctor-canonical-sentinels-", async ({ stateDir }) => {
      const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
      const storeTemplate = path.join(stateDir, "agents", "{agentId}", "sessions.json");
      const mainStore = resolveSessionStorePathCore(storeTemplate, { agentId: "main", env });
      const opsStore = resolveSessionStorePathCore(storeTemplate, { agentId: "ops", env });
      const cfg = {
        agents: { list: [{ id: "main", default: true }, { id: "ops" }] },
        session: { store: storeTemplate },
      } as OpenClawConfig;
      replaceSessionEntrySync(
        { agentId: "main", env, sessionKey: "global", storePath: mainStore },
        { sessionId: "main-global", updatedAt: 10 },
      );
      insertLegacySession({
        agentId: "ops",
        env,
        sessionKey: "global",
        storePath: opsStore,
        entry: {
          parentSessionKey: "parent",
          sessionId: "ops-global",
          spawnedBy: "controller",
          updatedAt: 20,
        },
      });

      expect(await repairCanonicalSessionKeys({ apply: true, cfg, env })).toMatchObject({
        foundGroups: 1,
        repairedGroups: 1,
      });
      expect(
        loadExactSessionEntryReadOnly({
          agentId: "main",
          env,
          sessionKey: "global",
          storePath: mainStore,
        })?.entry.sessionId,
      ).toBe("main-global");
      const opsGlobal = loadExactSessionEntryReadOnly({
        agentId: "ops",
        env,
        sessionKey: "global",
        storePath: opsStore,
      })?.entry;
      expect(opsGlobal).toMatchObject({
        parentSessionKey: "agent:ops:parent",
        sessionId: "ops-global",
        spawnedBy: "agent:ops:controller",
      });
    });
  });

  it("normalizes persisted lineage keys before runtime SQL filtering", async () => {
    await withStateDirEnv("openclaw-doctor-canonical-lineage-", async ({ stateDir }) => {
      const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
      const storeTemplate = path.join(stateDir, "agents", "{agentId}", "sessions.json");
      const storePath = resolveSessionStorePathCore(storeTemplate, { agentId: "main", env });
      const cfg = {
        agents: { list: [{ id: "main", default: true }] },
        session: { store: storeTemplate },
      } as OpenClawConfig;
      insertLegacySession({
        agentId: "main",
        env,
        sessionKey: "agent:main:child",
        storePath,
        entry: {
          forkSource: {
            entryId: "fork-entry",
            sessionId: "fork-session",
            sessionKey: "Agent:Main:Fork ",
          },
          parentSessionKey: "Agent:Main:Parent ",
          sessionId: "child",
          spawnedBy: " ",
          updatedAt: 10,
        },
      });

      expect(await repairCanonicalSessionKeys({ apply: true, cfg, env })).toMatchObject({
        foundGroups: 1,
        repairedGroups: 1,
      });
      expect(
        loadExactSessionEntryReadOnly({
          agentId: "main",
          env,
          sessionKey: "agent:main:child",
          storePath,
        })?.entry,
      ).toMatchObject({
        forkSource: {
          entryId: "fork-entry",
          sessionId: "fork-session",
          sessionKey: "agent:main:fork",
        },
        parentSessionKey: "agent:main:parent",
      });
      expect(
        loadExactSessionEntryReadOnly({
          agentId: "main",
          env,
          sessionKey: "agent:main:child",
          storePath,
        })?.entry.spawnedBy,
      ).toBeUndefined();
      expect(await repairCanonicalSessionKeys({ apply: true, cfg, env })).toMatchObject({
        foundGroups: 0,
        repairedGroups: 0,
      });
      const database = openSessionDatabase("main", env, storePath);
      database.db
        .prepare("UPDATE session_nodes SET parent_session_key = ? WHERE session_key = ?")
        .run("Agent:Main:Parent ", "agent:main:child");
      expect(await repairCanonicalSessionKeys({ apply: true, cfg, env })).toMatchObject({
        foundGroups: 1,
        repairedGroups: 1,
      });
      expect(
        database.db
          .prepare("SELECT parent_session_key FROM session_nodes WHERE session_key = ?")
          .get("agent:main:child"),
      ).toEqual({ parent_session_key: "agent:main:parent" });
      const canonicalJson = (
        database.db
          .prepare("SELECT entry_json FROM session_nodes WHERE session_key = ?")
          .get("agent:main:child") as { entry_json: string }
      ).entry_json;
      database.db.prepare("UPDATE session_nodes SET entry_json = ? WHERE session_key = ?").run(
        JSON.stringify({
          ...(JSON.parse(canonicalJson) as object),
          icon: "archive",
          spawnedBy: null,
        }),
        "agent:main:child",
      );
      expect(await repairCanonicalSessionKeys({ apply: true, cfg, env })).toMatchObject({
        foundGroups: 1,
        repairedGroups: 1,
      });
      expect(
        loadExactSessionEntryReadOnly({
          agentId: "main",
          env,
          sessionKey: "agent:main:child",
          storePath,
        })?.entry,
      ).not.toHaveProperty("icon");
    });
  });

  it("moves a lone alias row to its canonical key", async () => {
    await withStateDirEnv("openclaw-doctor-canonical-single-alias-", async ({ stateDir }) => {
      const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
      const storeTemplate = path.join(stateDir, "agents", "{agentId}", "sessions.json");
      const storePath = resolveSessionStorePathCore(storeTemplate, { agentId: "main", env });
      const cfg = {
        agents: { list: [{ id: "main", default: true }] },
        session: { mainKey: "work", store: storeTemplate },
      } as OpenClawConfig;
      insertLegacySession({
        agentId: "main",
        entry: { sessionId: "legacy", updatedAt: 10 },
        env,
        sessionKey: "agent:main:main ",
        storePath,
      });
      const database = openSessionDatabase("main", env, storePath);
      database.db
        .prepare(
          `UPDATE session_nodes
             SET entry_json = 'not-json', archived_at = 30, category = 'investigation',
                 icon = '🦞', label = 'Recovered metadata', last_activity_at = 29,
                 last_interaction_at = 28, last_read_at = 27, parent_session_key = 'agent:main:parent',
                 pinned_at = 26, spawned_by = 'agent:main:controller', status = 'failed',
                 display_name = 'Projected display name'
           WHERE session_key = ?`,
        )
        .run("agent:main:main ");
      const repairConversation = buildConversationIdentity({
        accountId: "work",
        channel: "matrix",
        deliveryTarget: "!Recovered:example.org",
        kind: "group",
        peerId: "!Recovered:example.org",
        threadId: "thread-root",
      });
      if (!repairConversation) {
        throw new Error("expected repair conversation identity");
      }
      database.db
        .prepare(
          `INSERT INTO conversations (
             conversation_id, channel, account_id, kind, peer_id, delivery_target,
             thread_id, created_at, updated_at
           ) VALUES (?, 'matrix', 'work', 'group', ?, ?, 'thread-root', 10, 10)`,
        )
        .run(
          repairConversation.conversationRef,
          "!Recovered:example.org",
          "!Recovered:example.org",
        );
      database.db
        .prepare(
          "INSERT INTO conversation_deliveries (operation_id, operation_kind, conversation_id, source_session_key, message_hash, status, created_at, updated_at) VALUES ('trimmed-alias-operation', 'turn', ?, 'agent:main:main', 'hash', 'sent', 10, 10)",
        )
        .run(repairConversation.conversationRef);
      database.db
        .prepare(
          "INSERT INTO session_members (session_key, identity_id, added_by, added_at) VALUES ('agent:main:main ', 'profile-1', 'profile-1', 10)",
        )
        .run();
      database.db
        .prepare(
          `UPDATE session_windows
             SET agent_harness_id = 'codex', chat_type = 'group', ended_at = 24,
                 model = 'gpt-5.4', model_provider = 'openai',
                 previous_session_id = 'previous-generation',
                 primary_conversation_id = ?, started_at = 23
           WHERE session_id = 'legacy'`,
        )
        .run(repairConversation.conversationRef);

      expect(await repairCanonicalSessionKeys({ apply: true, cfg, env })).toMatchObject({
        foundGroups: 1,
        removedRows: 1,
        repairedGroups: 1,
      });
      expect(
        loadExactSessionEntryReadOnly({
          agentId: "main",
          env,
          sessionKey: "agent:main:main",
          storePath,
        }),
      ).toBeUndefined();
      expect(
        database.db
          .prepare("SELECT count(*) AS count FROM session_nodes WHERE session_key = ?")
          .get("agent:main:main"),
      ).toEqual({ count: 0 });
      const repaired = loadExactSessionEntryReadOnly({
        agentId: "main",
        env,
        sessionKey: "agent:main:work",
        storePath,
      })?.entry;
      expect(repaired).toMatchObject({
        archivedAt: 30,
        category: "investigation",
        chatType: "group",
        endedAt: 24,
        label: "Recovered metadata",
        icon: "🦞",
        displayName: "Projected display name",
        lastActivityAt: 29,
        lastInteractionAt: 28,
        lastReadAt: 27,
        parentSessionKey: "agent:main:parent",
        pinnedAt: 26,
        previousSessionId: "previous-generation",
        model: "gpt-5.4",
        modelProvider: "openai",
        agentHarnessId: "codex",
        sessionId: "legacy",
        spawnedBy: "agent:main:controller",
        startedAt: 23,
        status: "failed",
      });
      expect(deliveryContextFromSession(repaired)).toEqual({
        accountId: "work",
        channel: "matrix",
        threadId: "thread-root",
        to: "!Recovered:example.org",
      });
      expect(
        database.db
          .prepare(
            "SELECT source_session_key FROM conversation_deliveries WHERE operation_id = 'trimmed-alias-operation'",
          )
          .get(),
      ).toEqual({ source_session_key: "agent:main:work" });
      expect(
        database.db
          .prepare(
            "SELECT session_key, identity_id FROM session_members WHERE identity_id = 'profile-1'",
          )
          .get(),
      ).toEqual({ session_key: "agent:main:work", identity_id: "profile-1" });
      expect(() =>
        replaceSessionEntrySync(
          { agentId: "main", env, sessionKey: "agent:main:main", storePath },
          { sessionId: "recreated-alias", updatedAt: 20 },
        ),
      ).toThrow("openclaw doctor --fix");
    });
  });

  it("moves a lone canonical row out of the wrong agent database", async () => {
    await withStateDirEnv("openclaw-doctor-canonical-wrong-store-", async ({ stateDir }) => {
      const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
      const storeTemplate = path.join(stateDir, "agents", "{agentId}", "sessions.json");
      const mainStore = resolveSessionStorePathCore(storeTemplate, { agentId: "main", env });
      const opsStore = resolveSessionStorePathCore(storeTemplate, { agentId: "ops", env });
      const cfg = {
        agents: { list: [{ id: "main", default: true }, { id: "ops" }] },
        session: { mainKey: "work", store: storeTemplate },
      } as OpenClawConfig;
      insertLegacySession({
        agentId: "ops",
        entry: {
          parentSessionKey: "main",
          sessionId: "misplaced",
          spawnedBy: "controller",
          updatedAt: 10,
        },
        env,
        eventText: "misplaced history",
        sessionKey: "agent:main:misplaced",
        storePath: opsStore,
      });
      const sourceDatabase = openSessionDatabase("ops", env, opsStore);
      const destinationDatabase = openSessionDatabase("main", env, mainStore);
      writeSessionProgressCard(sourceDatabase.db, "agent:main:misplaced", {
        markdown: "Preserve this cross-store task",
        steps: [{ step: "Finish the migration", status: "in_progress" }],
      });
      destinationDatabase.db.exec("DROP TABLE session_progress_cards");
      expect(
        destinationDatabase.db
          .prepare("SELECT name FROM sqlite_schema WHERE name = 'session_progress_cards'")
          .get(),
      ).toBeUndefined();

      expect(await repairCanonicalSessionKeys({ apply: true, cfg, env })).toMatchObject({
        foundGroups: 1,
        removedRows: 1,
        repairedGroups: 1,
      });
      expect(
        loadExactSessionEntryReadOnly({
          agentId: "main",
          env,
          sessionKey: "agent:main:misplaced",
          storePath: mainStore,
        })?.entry,
      ).toMatchObject({
        parentSessionKey: "agent:main:work",
        sessionId: "misplaced",
        spawnedBy: "agent:main:controller",
      });
      expect(readSessionProgressCard(destinationDatabase.db, "agent:main:misplaced")).toMatchObject(
        {
          markdown: "Preserve this cross-store task",
          revision: 1,
          sessionKey: "agent:main:misplaced",
          steps: [{ step: "Finish the migration", status: "in_progress" }],
        },
      );
      expect(
        loadExactSessionEntryReadOnly({
          agentId: "ops",
          env,
          sessionKey: "agent:main:misplaced",
          storePath: opsStore,
        }),
      ).toBeUndefined();
      expect(() =>
        replaceSessionEntrySync(
          { agentId: "main", env, sessionKey: "agent:main:main", storePath: mainStore },
          { sessionId: "new-destination-alias", updatedAt: 20 },
        ),
      ).toThrow("openclaw doctor --fix");
      await expect(
        loadTranscriptEvents({
          agentId: "main",
          env,
          sessionId: "misplaced",
          sessionKey: "agent:main:misplaced",
          storePath: mainStore,
        }),
      ).resolves.toEqual([
        expect.objectContaining({
          message: expect.objectContaining({ content: "misplaced history" }),
        }),
      ]);
    });
  });

  it("keeps canonical destination history when cross-store timestamps tie", async () => {
    await withStateDirEnv("openclaw-doctor-canonical-tied-stores-", async ({ stateDir }) => {
      const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
      const storeTemplate = path.join(stateDir, "agents", "{agentId}", "sessions.json");
      const mainStore = resolveSessionStorePathCore(storeTemplate, { agentId: "main", env });
      const opsStore = resolveSessionStorePathCore(storeTemplate, { agentId: "ops", env });
      const cfg = {
        agents: { list: [{ id: "main", default: true }, { id: "ops" }] },
        session: { mainKey: "shared", store: storeTemplate },
      } as OpenClawConfig;
      insertLegacySession({
        agentId: "main",
        entry: { sessionId: "canonical", updatedAt: 10 },
        env,
        eventText: "canonical history",
        sessionKey: "agent:main:shared",
        storePath: mainStore,
      });
      insertLegacySession({
        agentId: "ops",
        entry: { sessionId: "wrong-store", updatedAt: 10 },
        env,
        eventText: "wrong-store history",
        sessionKey: "agent:main:main ",
        storePath: opsStore,
      });
      const destinationDatabase = openSessionDatabase("main", env, mainStore);
      const progressCardTable = () =>
        destinationDatabase.db
          .prepare("SELECT name FROM sqlite_schema WHERE name = 'session_progress_cards'")
          .get();
      destinationDatabase.db.exec("DROP TABLE session_progress_cards");
      expect(progressCardTable()).toBeUndefined();

      expect(await repairCanonicalSessionKeys({ apply: true, cfg, env })).toMatchObject({
        foundGroups: 1,
        removedRows: 1,
        repairedGroups: 1,
      });
      expect(progressCardTable()).toBeUndefined();
      expect(
        loadExactSessionEntryReadOnly({
          agentId: "main",
          env,
          sessionKey: "agent:main:shared",
          storePath: mainStore,
        })?.entry,
      ).toMatchObject({ sessionId: "canonical", updatedAt: 10 });
      await expect(
        loadTranscriptEvents({
          agentId: "main",
          env,
          sessionId: "canonical",
          sessionKey: "agent:main:shared",
          storePath: mainStore,
        }),
      ).resolves.toEqual([
        expect.objectContaining({
          message: expect.objectContaining({ content: "canonical history" }),
        }),
      ]);
    });
  });
});
