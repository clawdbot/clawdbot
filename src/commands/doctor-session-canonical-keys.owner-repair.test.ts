import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveSessionStorePathCore } from "../config/sessions/paths.js";
import {
  loadExactSessionEntryReadOnly,
  loadTranscriptEvents,
} from "../config/sessions/session-accessor.js";
import { replaceSessionOwnerInTransaction } from "../config/sessions/session-accessor.sqlite-owner.js";
import { resolveSqliteTargetFromSessionStorePath } from "../config/sessions/session-sqlite-target.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { FIRST_USE_ADDITIVE_AGENT_COLUMN_DEFINITIONS } from "../state/openclaw-agent-db-additive-columns.js";
import {
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
} from "../state/openclaw-agent-db.js";
import { withStateDirEnv } from "../test-helpers/state-dir-env.js";
import { repairCanonicalSessionKeys } from "./doctor-session-canonical-keys.js";
import { insertLegacySession } from "./doctor-session-canonical-keys.test-support.js";

afterEach(() => closeOpenClawAgentDatabasesForTest());

function insertEmptyAlias(params: {
  agentId: string;
  env: NodeJS.ProcessEnv;
  sessionId: string;
  sessionKey: string;
  storePath: string;
  updatedAt: number;
}) {
  const database = openOpenClawAgentDatabase({
    agentId: params.agentId,
    env: params.env,
    path: resolveSqliteTargetFromSessionStorePath(params.storePath, {
      agentId: params.agentId,
      env: params.env,
    }).path,
  });
  database.db
    .prepare(
      "INSERT INTO session_nodes (session_key, current_session_id, entry_json, updated_at) VALUES (?, ?, '{}', ?)",
    )
    .run(params.sessionKey, params.sessionId, params.updatedAt);
  return database;
}

describe("doctor transcript owner repair", () => {
  it.each([
    { label: "same database orphan", sourceAgentId: "main", sourceEpoch: undefined },
    { label: "cross database orphan", sourceAgentId: "ops", sourceEpoch: undefined },
    {
      label: "cross database foreign carry",
      sourceAgentId: "ops",
      sourceEpoch: "22222222-2222-4222-8222-222222222222",
    },
  ])("rotates recipient authority for $label", async ({ sourceAgentId, sourceEpoch }) => {
    await withStateDirEnv("openclaw-doctor-orphan-authority-", async ({ stateDir }) => {
      const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
      const storeTemplate = path.join(stateDir, "agents", "{agentId}", "sessions.json");
      const destinationStore = resolveSessionStorePathCore(storeTemplate, {
        agentId: "main",
        env,
      });
      const sourceStore = resolveSessionStorePathCore(storeTemplate, {
        agentId: sourceAgentId,
        env,
      });
      const canonicalKey = "agent:main:work";
      const aliasKey = "agent:main:main";
      const orphanEpoch = "11111111-1111-4111-8111-111111111111";
      const cfg = {
        agents: {
          list: [
            { id: "main", default: true },
            ...(sourceAgentId === "ops" ? [{ id: "ops" }] : []),
          ],
        },
        session: { mainKey: "work", store: storeTemplate },
      } as OpenClawConfig;
      insertLegacySession({
        agentId: sourceAgentId,
        entry: { sessionId: "alias-session", updatedAt: 20 },
        env,
        sessionKey: aliasKey,
        storePath: sourceStore,
      });
      const destinationDatabase = openOpenClawAgentDatabase({
        agentId: "main",
        env,
        path: resolveSqliteTargetFromSessionStorePath(destinationStore, {
          agentId: "main",
          env,
        }).path,
      });
      const sourceDatabase = openOpenClawAgentDatabase({
        agentId: sourceAgentId,
        env,
        path: resolveSqliteTargetFromSessionStorePath(sourceStore, {
          agentId: sourceAgentId,
          env,
        }).path,
      });
      destinationDatabase.db
        .prepare(
          "INSERT INTO session_recipient_authority (session_key, epoch, created_at, updated_at) VALUES (?, ?, 1, 1)",
        )
        .run(canonicalKey, orphanEpoch);
      if (sourceEpoch) {
        sourceDatabase.db
          .prepare(
            "INSERT INTO session_recipient_authority (session_key, epoch, created_at, updated_at) VALUES (?, ?, 1, 1)",
          )
          .run(aliasKey, sourceEpoch);
      }

      expect(await repairCanonicalSessionKeys({ apply: true, cfg, env })).toMatchObject({
        foundGroups: 1,
        repairedGroups: 1,
      });
      const repaired = destinationDatabase.db
        .prepare("SELECT epoch FROM session_recipient_authority WHERE session_key = ?")
        .get(canonicalKey) as { epoch: string };
      expect(repaired.epoch).not.toBe(orphanEpoch);
      if (sourceEpoch) {
        expect(repaired.epoch).not.toBe(sourceEpoch);
      }
      expect(repaired.epoch).toMatch(/^[0-9a-f-]{36}$/u);
      expect(
        sourceDatabase.db
          .prepare("SELECT session_key FROM session_recipient_authority WHERE session_key = ?")
          .get(aliasKey),
      ).toBeUndefined();
    });
  });

  it("compares authority ownership against the selected occupant before stamp preservation", async () => {
    await withStateDirEnv("openclaw-doctor-stamped-authority-", async ({ stateDir }) => {
      const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
      const storeTemplate = path.join(stateDir, "agents", "{agentId}", "sessions.json");
      const storePath = resolveSessionStorePathCore(storeTemplate, { agentId: "main", env });
      const canonicalKey = "agent:main:work";
      const aliasKey = "agent:main:main";
      const epoch = "11111111-1111-4111-8111-111111111111";
      const cfg = {
        agents: { list: [{ id: "main", default: true }] },
        session: { mainKey: "work", store: storeTemplate },
      } as OpenClawConfig;
      insertLegacySession({
        agentId: "main",
        entry: {
          createdActor: { type: "human", id: "canonical-owner" },
          sandbox: "required",
          sessionId: "canonical-session",
          updatedAt: 10,
        },
        env,
        sessionKey: canonicalKey,
        storePath,
      });
      insertLegacySession({
        agentId: "main",
        entry: {
          createdActor: { type: "human", id: "winner-owner" },
          sessionId: "winner-session",
          updatedAt: 20,
        },
        env,
        sessionKey: aliasKey,
        storePath,
      });
      const database = openOpenClawAgentDatabase({
        agentId: "main",
        env,
        path: resolveSqliteTargetFromSessionStorePath(storePath, {
          agentId: "main",
          env,
        }).path,
      });
      const insertAuthority = database.db.prepare(
        "INSERT INTO session_recipient_authority (session_key, epoch, created_at, updated_at) VALUES (?, ?, 1, 1)",
      );
      insertAuthority.run(canonicalKey, epoch);
      insertAuthority.run(aliasKey, epoch);

      expect(await repairCanonicalSessionKeys({ apply: true, cfg, env })).toMatchObject({
        foundGroups: 1,
        repairedGroups: 1,
      });
      expect(
        loadExactSessionEntryReadOnly({
          agentId: "main",
          env,
          sessionKey: canonicalKey,
          storePath,
        })?.entry,
      ).toMatchObject({
        createdActor: { type: "human", id: "canonical-owner" },
        sessionId: "winner-session",
      });
      const repaired = database.db
        .prepare("SELECT epoch FROM session_recipient_authority WHERE session_key = ?")
        .get(canonicalKey) as { epoch: string };
      expect(repaired.epoch).not.toBe(epoch);
    });
  });

  it.each([
    { label: "same database", sourceAgentId: "main" },
    { label: "cross database", sourceAgentId: "ops" },
  ])(
    "rotates competing recipient authority during $label owner replacement",
    async ({ sourceAgentId }) => {
      await withStateDirEnv("openclaw-doctor-recipient-authority-", async ({ stateDir }) => {
        const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
        const storeTemplate = path.join(stateDir, "agents", "{agentId}", "sessions.json");
        const destinationStore = resolveSessionStorePathCore(storeTemplate, {
          agentId: "main",
          env,
        });
        const sourceStore = resolveSessionStorePathCore(storeTemplate, {
          agentId: sourceAgentId,
          env,
        });
        const canonicalKey = "agent:main:work";
        const aliasKey = "agent:main:main";
        const canonicalEpoch = "11111111-1111-4111-8111-111111111111";
        const aliasEpoch = "22222222-2222-4222-8222-222222222222";
        const cfg = {
          agents: {
            list: [
              { id: "main", default: true },
              ...(sourceAgentId === "ops" ? [{ id: "ops" }] : []),
            ],
          },
          session: { mainKey: "work", store: storeTemplate },
        } as OpenClawConfig;
        insertLegacySession({
          agentId: "main",
          entry: {
            createdActor: { type: "human", id: "owner-before" },
            sessionId: "canonical-session",
            updatedAt: 10,
          },
          env,
          sessionKey: canonicalKey,
          storePath: destinationStore,
        });
        insertLegacySession({
          agentId: sourceAgentId,
          entry: {
            createdActor: { type: "human", id: "owner-after" },
            sessionId: "alias-session",
            updatedAt: 20,
          },
          env,
          sessionKey: aliasKey,
          storePath: sourceStore,
        });
        const destinationDatabase = openOpenClawAgentDatabase({
          agentId: "main",
          env,
          path: resolveSqliteTargetFromSessionStorePath(destinationStore, {
            agentId: "main",
            env,
          }).path,
        });
        const sourceDatabase = openOpenClawAgentDatabase({
          agentId: sourceAgentId,
          env,
          path: resolveSqliteTargetFromSessionStorePath(sourceStore, {
            agentId: sourceAgentId,
            env,
          }).path,
        });
        destinationDatabase.db
          .prepare(
            "INSERT INTO session_recipient_authority (session_key, epoch, created_at, updated_at) VALUES (?, ?, 1, 1)",
          )
          .run(canonicalKey, canonicalEpoch);
        sourceDatabase.db
          .prepare(
            "INSERT INTO session_recipient_authority (session_key, epoch, created_at, updated_at) VALUES (?, ?, 1, 1)",
          )
          .run(aliasKey, aliasEpoch);

        expect(await repairCanonicalSessionKeys({ apply: true, cfg, env })).toMatchObject({
          foundGroups: 1,
          repairedGroups: 1,
        });
        expect(
          loadExactSessionEntryReadOnly({
            agentId: "main",
            env,
            sessionKey: canonicalKey,
            storePath: destinationStore,
          })?.entry,
        ).toMatchObject({
          createdActor: { type: "human", id: "owner-after" },
          sessionId: "alias-session",
        });
        const repairedAuthority = destinationDatabase.db
          .prepare("SELECT epoch FROM session_recipient_authority WHERE session_key = ?")
          .get(canonicalKey) as { epoch: string };
        expect(repairedAuthority.epoch).not.toBe(canonicalEpoch);
        expect(repairedAuthority.epoch).not.toBe(aliasEpoch);
        expect(repairedAuthority.epoch).toMatch(/^[0-9a-f-]{36}$/u);
        expect(
          sourceDatabase.db
            .prepare("SELECT session_key FROM session_recipient_authority WHERE session_key = ?")
            .get(aliasKey),
        ).toBeUndefined();
      });
    },
  );

  it.each([
    { sourceAgentId: "main", requiredAlias: true, requiredCanonical: false },
    { sourceAgentId: "ops", requiredAlias: true, requiredCanonical: false },
    { sourceAgentId: "main", requiredAlias: true, requiredCanonical: true },
    { sourceAgentId: "main", requiredAlias: false, requiredCanonical: false },
  ])("preserves required creation provenance during canonical repair: %o", async (fixture) => {
    await withStateDirEnv("openclaw-doctor-canonical-creation-stamp-", async ({ stateDir }) => {
      const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
      const storeTemplate = path.join(stateDir, "agents", "{agentId}", "sessions.json");
      const destinationStore = resolveSessionStorePathCore(storeTemplate, { agentId: "main", env });
      const sourceStore = resolveSessionStorePathCore(storeTemplate, {
        agentId: fixture.sourceAgentId,
        env,
      });
      const canonicalKey = "agent:main:work";
      const cfg: OpenClawConfig = {
        agents: { list: [{ id: "main", default: true }, { id: "ops" }] },
        session: { mainKey: "work", store: storeTemplate },
      };
      const canonicalStamp = {
        createdVia: "operator" as const,
        createdActor: {
          type: "human" as const,
          source: "profile" as const,
          id: "profile-canonical",
        },
        createdAt: 10,
        ...(fixture.requiredCanonical ? { sandbox: "required" as const } : {}),
      };
      const aliasStamp = {
        createdVia: "channel" as const,
        createdActor: { type: "human" as const, source: "channel" as const, id: "profile-alias" },
        createdAt: 20,
        ...(fixture.requiredAlias ? { sandbox: "required" as const } : {}),
      };
      insertLegacySession({
        agentId: "main",
        entry: {
          ...canonicalStamp,
          sessionId: "canonical-session",
          updatedAt: fixture.requiredCanonical ? 10 : 30,
        },
        env,
        sessionKey: canonicalKey,
        storePath: destinationStore,
      });
      insertLegacySession({
        agentId: fixture.sourceAgentId,
        entry: { ...aliasStamp, sessionId: "alias-session", updatedAt: 20 },
        env,
        sessionKey: "agent:main:main",
        storePath: sourceStore,
      });

      expect(await repairCanonicalSessionKeys({ apply: true, cfg, env })).toMatchObject({
        foundGroups: 1,
        repairedGroups: 1,
      });
      const repaired = loadExactSessionEntryReadOnly({
        agentId: "main",
        env,
        sessionKey: canonicalKey,
        storePath: destinationStore,
      })?.entry;
      const expectedStamp =
        fixture.requiredAlias && !fixture.requiredCanonical ? aliasStamp : canonicalStamp;
      expect(repaired).toMatchObject({
        ...expectedStamp,
        sessionId: fixture.requiredCanonical ? "alias-session" : "canonical-session",
        updatedAt: fixture.requiredCanonical ? 20 : 30,
      });
      if (!fixture.requiredAlias && !fixture.requiredCanonical) {
        expect(repaired).not.toHaveProperty("sandbox");
      }
    });
  });

  it.each([
    { label: "replaces a stale same-store owner", sourceAgentId: "main", winnerOwned: true },
    { label: "clears a stale same-store owner", sourceAgentId: "main", winnerOwned: false },
    { label: "lazily restores cross-store owner columns", sourceAgentId: "ops", winnerOwned: true },
    {
      label: "preserves an owner while repairing malformed session metadata",
      sourceAgentId: "main",
      winnerOwned: true,
      malformed: true,
    },
  ])("$label from the selected canonical-repair winner", async (fixture) => {
    const { sourceAgentId, winnerOwned } = fixture;
    await withStateDirEnv("openclaw-doctor-assigned-owner-", async ({ stateDir }) => {
      const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
      const storeTemplate = path.join(stateDir, "agents", "{agentId}", "sessions.json");
      const destinationStore = resolveSessionStorePathCore(storeTemplate, { agentId: "main", env });
      const sourceStore = resolveSessionStorePathCore(storeTemplate, {
        agentId: sourceAgentId,
        env,
      });
      const canonicalKey = "agent:main:work";
      const winnerKey = "agent:main:main";
      const cfg = {
        agents: {
          list: [
            { id: "main", default: true },
            ...(sourceAgentId === "ops" ? [{ id: "ops" }] : []),
          ],
        },
        session: { mainKey: "work", store: storeTemplate },
      } as OpenClawConfig;

      if (sourceAgentId === "main") {
        insertLegacySession({
          agentId: "main",
          entry: { sessionId: "stale-destination", updatedAt: 10 },
          env,
          sessionKey: canonicalKey,
          storePath: destinationStore,
        });
        replaceSessionOwnerInTransaction(
          openOpenClawAgentDatabase({
            agentId: "main",
            env,
            path: resolveSqliteTargetFromSessionStorePath(destinationStore, {
              agentId: "main",
              env,
            }).path,
          }),
          canonicalKey,
          {
            actor: { type: "human", id: "profile-stale" },
            assignedBy: { type: "human", id: "profile-stale-assigner" },
            assignedAt: 10,
          },
        );
      }

      insertLegacySession({
        agentId: sourceAgentId,
        entry: { sessionId: "selected-winner", updatedAt: 20 },
        env,
        sessionKey: winnerKey,
        storePath: sourceStore,
      });
      const owner = winnerOwned
        ? {
            actor: { type: "human" as const, id: "profile-winner" },
            assignedBy: { type: "agent" as const, id: "research" },
            assignedAt: 1234,
          }
        : undefined;
      if (owner) {
        replaceSessionOwnerInTransaction(
          openOpenClawAgentDatabase({
            agentId: sourceAgentId,
            env,
            path: resolveSqliteTargetFromSessionStorePath(sourceStore, {
              agentId: sourceAgentId,
              env,
            }).path,
          }),
          winnerKey,
          owner,
        );
      }

      if ("malformed" in fixture) {
        openOpenClawAgentDatabase({
          agentId: sourceAgentId,
          env,
          path: resolveSqliteTargetFromSessionStorePath(sourceStore, {
            agentId: sourceAgentId,
            env,
          }).path,
        })
          .db.prepare("UPDATE session_nodes SET entry_json = ? WHERE session_key = ?")
          .run("{malformed", winnerKey);
      }

      if (sourceAgentId === "ops") {
        const database = openOpenClawAgentDatabase({
          agentId: "main",
          env,
          path: resolveSqliteTargetFromSessionStorePath(destinationStore, {
            agentId: "main",
            env,
          }).path,
        });
        for (const { columnName } of FIRST_USE_ADDITIVE_AGENT_COLUMN_DEFINITIONS) {
          database.db.exec(`ALTER TABLE session_nodes DROP COLUMN ${columnName};`);
        }
      }

      expect(await repairCanonicalSessionKeys({ apply: true, cfg, env })).toMatchObject({
        foundGroups: 1,
        repairedGroups: 1,
      });
      expect(
        loadExactSessionEntryReadOnly({
          agentId: "main",
          env,
          sessionKey: canonicalKey,
          storePath: destinationStore,
        })?.entry.owner,
      ).toEqual(owner ?? undefined);
    });
  });

  it("restores a valid node after an empty alias steals its transcript window", async () => {
    await withStateDirEnv("openclaw-doctor-transcript-owner-", async ({ stateDir }) => {
      const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
      const storeTemplate = path.join(stateDir, "agents", "{agentId}", "sessions.json");
      const storePath = resolveSessionStorePathCore(storeTemplate, { agentId: "main", env });
      const cfg = {
        agents: { list: [{ id: "main", default: true }] },
        session: { store: storeTemplate },
      } as OpenClawConfig;
      const canonicalKey = "agent:main:main";
      const staleKey = "agent:main:telegram:default:direct:fixture-peer";
      const sessionId = "stolen-owner-session";
      insertLegacySession({
        agentId: "main",
        entry: { label: "canonical metadata", sessionId, updatedAt: 20 },
        env,
        eventText: "preserved history",
        sessionKey: canonicalKey,
        storePath,
      });
      const database = insertEmptyAlias({
        agentId: "main",
        env,
        sessionId,
        sessionKey: staleKey,
        storePath,
        updatedAt: 30,
      });
      database.db
        .prepare("UPDATE session_nodes SET entry_valid = 1 WHERE session_key = ?")
        .run(canonicalKey);
      database.db
        .prepare("UPDATE session_windows SET session_key = ? WHERE session_id = ?")
        .run(staleKey, sessionId);

      expect(await repairCanonicalSessionKeys({ apply: false, cfg, env })).toMatchObject({
        foundGroups: 1,
        repairedGroups: 0,
      });
      expect(await repairCanonicalSessionKeys({ apply: true, cfg, env })).toMatchObject({
        foundGroups: 1,
        removedRows: 1,
        repairedGroups: 1,
      });
      expect(
        loadExactSessionEntryReadOnly({ agentId: "main", env, sessionKey: staleKey, storePath }),
      ).toBeUndefined();
      expect(
        loadExactSessionEntryReadOnly({ agentId: "main", env, sessionKey: canonicalKey, storePath })
          ?.entry,
      ).toMatchObject({ label: "canonical metadata", sessionId });
      expect(
        database.db
          .prepare("SELECT session_key FROM session_windows WHERE session_id = ?")
          .get(sessionId),
      ).toEqual({ session_key: canonicalKey });
      await expect(
        loadTranscriptEvents({
          agentId: "main",
          env,
          sessionId,
          sessionKey: canonicalKey,
          storePath,
        }),
      ).resolves.toEqual([
        expect.objectContaining({
          message: expect.objectContaining({ content: "preserved history" }),
        }),
      ]);
      expect(await repairCanonicalSessionKeys({ apply: true, cfg, env })).toMatchObject({
        foundGroups: 0,
        repairedGroups: 0,
      });
    });
  });

  it("follows alias ownership transitively to the configured canonical key", async () => {
    await withStateDirEnv("openclaw-doctor-transcript-owner-chain-", async ({ stateDir }) => {
      const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
      const storeTemplate = path.join(stateDir, "agents", "{agentId}", "sessions.json");
      const storePath = resolveSessionStorePathCore(storeTemplate, { agentId: "main", env });
      const cfg = {
        agents: { list: [{ id: "main", default: true }] },
        session: { mainKey: "work", store: storeTemplate },
      } as OpenClawConfig;
      const staleKey = "agent:main:telegram:default:direct:fixture-peer";
      const intermediateKey = "agent:main:main";
      const canonicalKey = "agent:main:work";
      const sessionId = "owner-chain-session";
      insertLegacySession({
        agentId: "main",
        entry: { label: "intermediate metadata", sessionId, updatedAt: 20 },
        env,
        eventText: "chain history",
        sessionKey: intermediateKey,
        storePath,
      });
      insertEmptyAlias({
        agentId: "main",
        env,
        sessionId,
        sessionKey: staleKey,
        storePath,
        updatedAt: 30,
      });

      expect(await repairCanonicalSessionKeys({ apply: true, cfg, env })).toMatchObject({
        foundGroups: 1,
        removedRows: 2,
        repairedGroups: 1,
      });
      for (const sessionKey of [staleKey, intermediateKey]) {
        expect(
          loadExactSessionEntryReadOnly({ agentId: "main", env, sessionKey, storePath }),
        ).toBeUndefined();
      }
      expect(
        loadExactSessionEntryReadOnly({ agentId: "main", env, sessionKey: canonicalKey, storePath })
          ?.entry,
      ).toMatchObject({ label: "intermediate metadata", sessionId });
      await expect(
        loadTranscriptEvents({
          agentId: "main",
          env,
          sessionId,
          sessionKey: canonicalKey,
          storePath,
        }),
      ).resolves.toEqual([
        expect.objectContaining({ message: expect.objectContaining({ content: "chain history" }) }),
      ]);
      expect(await repairCanonicalSessionKeys({ apply: true, cfg, env })).toMatchObject({
        foundGroups: 0,
        repairedGroups: 0,
      });
    });
  });
});
