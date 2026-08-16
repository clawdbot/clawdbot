import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveSessionStorePathCore } from "../config/sessions/paths.js";
import {
  loadExactSessionEntryReadOnly,
  loadTranscriptEvents,
} from "../config/sessions/session-accessor.js";
import { resolveSqliteTargetFromSessionStorePath } from "../config/sessions/session-sqlite-target.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
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
