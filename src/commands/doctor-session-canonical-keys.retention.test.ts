import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readSessionArchiveContentSync } from "../config/sessions/archive-compression.js";
import { resolveStorePath } from "../config/sessions/paths.js";
import {
  loadExactSessionEntryReadOnly,
  loadTranscriptEvents,
  replaceSessionEntrySync,
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

describe("doctor canonical session-key retention repair", () => {
  it("copies only a cross-store winner and archives its stale same-store duplicate", async () => {
    await withStateDirEnv("openclaw-doctor-canonical-cross-store-", async ({ stateDir }) => {
      const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
      const storeTemplate = path.join(stateDir, "agents", "{agentId}", "sessions.json");
      const mainStore = resolveStorePath(storeTemplate, { agentId: "main", env });
      const opsStore = resolveStorePath(storeTemplate, { agentId: "ops", env });
      const cfg = {
        agents: { list: [{ id: "main", default: true }, { id: "ops" }] },
        session: { mainKey: "shared", store: storeTemplate },
      } as OpenClawConfig;

      replaceSessionEntrySync(
        {
          agentId: "main",
          env,
          sessionKey: "agent:main:shared",
          storePath: mainStore,
        },
        {
          previousSessionId: "destination-only-previous",
          sessionId: "retained-destination",
          updatedAt: 5,
        },
      );
      const destinationDatabase = openOpenClawAgentDatabase({
        agentId: "main",
        env,
        path: resolveSqliteTargetFromSessionStorePath(mainStore, { agentId: "main", env }).path,
      });
      destinationDatabase.db
        .prepare(
          "INSERT INTO session_windows (session_id, session_key, reason, session_scope, created_at, updated_at) VALUES ('destination-only-previous', 'agent:main:shared', 'recovery', 'conversation', 4, 4)",
        )
        .run();
      destinationDatabase.db
        .prepare(
          "INSERT INTO transcript_events (session_id, seq, event_json, created_at) VALUES ('destination-only-previous', 0, ?, 4)",
        )
        .run(
          JSON.stringify({
            id: "destination-only-message",
            message: { content: "destination-only history", role: "user" },
            parentId: null,
            type: "message",
          }),
        );

      insertLegacySession({
        agentId: "ops",
        entry: {
          previousSessionId: "destination-only-previous",
          sessionId: "winner",
          updatedAt: 20,
        },
        env,
        eventText: "winner history",
        sessionKey: "agent:main:main ",
        storePath: opsStore,
      });
      const sourceDatabase = openOpenClawAgentDatabase({
        agentId: "ops",
        env,
        path: resolveSqliteTargetFromSessionStorePath(opsStore, { agentId: "ops", env }).path,
      });
      for (const [label, sourceSessionKey] of [
        ["winner", "agent:main:main "],
        ["loser", "agent:main:main"],
      ] as const) {
        sourceDatabase.db
          .prepare(
            "INSERT INTO conversations (conversation_id, channel, account_id, kind, peer_id, delivery_target, metadata_json, created_at, updated_at) VALUES (?, 'webchat', 'default', 'direct', ?, ?, '{}', 10, 10)",
          )
          .run(`${label}-conversation`, label, label);
        sourceDatabase.db
          .prepare(
            "INSERT INTO conversation_deliveries (operation_id, operation_kind, conversation_id, source_session_key, message_hash, status, created_at, updated_at) VALUES (?, 'turn', ?, ?, ?, 'sent', 10, 10)",
          )
          .run(`${label}-operation`, `${label}-conversation`, sourceSessionKey, `${label}-hash`);
      }
      insertLegacySession({
        agentId: "ops",
        entry: { sessionId: "loser", updatedAt: 10 },
        env,
        eventText: "loser history",
        sessionKey: "agent:main:main",
        storePath: opsStore,
      });

      const report = await repairCanonicalSessionKeys({ apply: true, cfg, env });

      expect(report).toMatchObject({
        foundGroups: 1,
        removedRows: 2,
        repairedGroups: 1,
        scannedStores: 2,
      });
      expect(
        loadExactSessionEntryReadOnly({
          agentId: "main",
          env,
          sessionKey: "agent:main:shared",
          storePath: mainStore,
        })?.entry.sessionId,
      ).toBe("winner");
      expect(
        loadExactSessionEntryReadOnly({
          agentId: "ops",
          env,
          sessionKey: "agent:main:main ",
          storePath: opsStore,
        }),
      ).toBeUndefined();
      expect(
        loadExactSessionEntryReadOnly({
          agentId: "ops",
          env,
          sessionKey: "agent:main:main",
          storePath: opsStore,
        }),
      ).toBeUndefined();
      await expect(
        loadTranscriptEvents({
          agentId: "main",
          env,
          sessionId: "winner",
          sessionKey: "agent:main:shared",
          storePath: mainStore,
        }),
      ).resolves.toEqual([
        expect.objectContaining({
          message: expect.objectContaining({ content: "winner history" }),
        }),
      ]);
      await expect(
        loadTranscriptEvents({
          agentId: "main",
          env,
          sessionId: "loser",
          sessionKey: "agent:main:shared",
          storePath: mainStore,
        }),
      ).resolves.toEqual([]);
      await expect(
        loadTranscriptEvents({
          agentId: "main",
          env,
          sessionId: "destination-only-previous",
          sessionKey: "agent:main:shared",
          storePath: mainStore,
        }),
      ).resolves.toEqual([
        expect.objectContaining({
          message: expect.objectContaining({ content: "destination-only history" }),
        }),
      ]);
      expect(
        destinationDatabase.db
          .prepare(
            "SELECT operation_id, source_session_key FROM conversation_deliveries ORDER BY operation_id",
          )
          .all(),
      ).toEqual([{ operation_id: "winner-operation", source_session_key: "agent:main:shared" }]);
      expect(
        destinationDatabase.db
          .prepare(
            "SELECT previous_session_id, session_entry_provenance FROM session_windows WHERE session_id = 'winner'",
          )
          .get(),
      ).toEqual({ previous_session_id: "destination-only-previous", session_entry_provenance: 1 });
      expect(
        sourceDatabase.db
          .prepare("SELECT operation_id FROM conversation_deliveries ORDER BY operation_id")
          .all(),
      ).toEqual([]);
      const loserArchive = report.archivedTranscriptDirectories
        .flatMap((directory) =>
          fs
            .readdirSync(directory)
            .filter((name) => name.startsWith("loser.jsonl.deleted."))
            .map((name) => path.join(directory, name)),
        )
        .at(0);
      expect(loserArchive).toBeDefined();
      expect(readSessionArchiveContentSync(loserArchive as string)).toContain("loser history");
    });
  });

  it("copies a lone cross-store winner's normalized delivery key", async () => {
    await withStateDirEnv(
      "openclaw-doctor-canonical-cross-store-delivery-",
      async ({ stateDir }) => {
        const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
        const storeTemplate = path.join(stateDir, "agents", "{agentId}", "sessions.json");
        const mainStore = resolveStorePath(storeTemplate, { agentId: "main", env });
        const opsStore = resolveStorePath(storeTemplate, { agentId: "ops", env });
        const cfg = {
          agents: { list: [{ id: "main", default: true }, { id: "ops" }] },
          session: { mainKey: "work", store: storeTemplate },
        } as OpenClawConfig;
        insertLegacySession({
          agentId: "ops",
          entry: { sessionId: "winner", updatedAt: 20 },
          env,
          sessionKey: "agent:main:main ",
          storePath: opsStore,
        });
        const sourceDatabase = openOpenClawAgentDatabase({
          agentId: "ops",
          env,
          path: resolveSqliteTargetFromSessionStorePath(opsStore, { agentId: "ops", env }).path,
        });
        sourceDatabase.db
          .prepare(
            "INSERT INTO conversations (conversation_id, channel, account_id, kind, peer_id, delivery_target, metadata_json, created_at, updated_at) VALUES ('winner-conversation', 'webchat', 'default', 'direct', 'winner', 'winner', '{}', 10, 10)",
          )
          .run();
        sourceDatabase.db
          .prepare(
            "INSERT INTO conversation_deliveries (operation_id, operation_kind, conversation_id, source_session_key, message_hash, status, created_at, updated_at) VALUES ('winner-operation', 'turn', 'winner-conversation', 'agent:main:main', 'hash', 'sent', 10, 10)",
          )
          .run();
        sourceDatabase.db
          .prepare(
            "INSERT INTO conversation_deliveries (operation_id, operation_kind, conversation_id, source_session_key, message_hash, status, created_at, updated_at) VALUES ('canonical-operation', 'turn', 'winner-conversation', 'agent:main:work', 'canonical-hash', 'sent', 10, 10)",
          )
          .run();
        sourceDatabase.db
          .prepare(
            "INSERT INTO conversation_deliveries (operation_id, operation_kind, conversation_id, source_session_key, message_hash, status, created_at, updated_at) VALUES ('unrelated-operation', 'turn', 'winner-conversation', 'agent:ops:other', 'unrelated-hash', 'sent', 10, 10)",
          )
          .run();

        expect(await repairCanonicalSessionKeys({ apply: true, cfg, env })).toMatchObject({
          foundGroups: 1,
          repairedGroups: 1,
        });
        const destinationDatabase = openOpenClawAgentDatabase({
          agentId: "main",
          env,
          path: resolveSqliteTargetFromSessionStorePath(mainStore, { agentId: "main", env }).path,
        });
        expect(
          destinationDatabase.db
            .prepare(
              "SELECT operation_id, source_session_key FROM conversation_deliveries ORDER BY operation_id",
            )
            .all(),
        ).toEqual([
          { operation_id: "canonical-operation", source_session_key: "agent:main:work" },
          { operation_id: "winner-operation", source_session_key: "agent:main:work" },
        ]);
        expect(
          sourceDatabase.db
            .prepare("SELECT operation_id FROM conversation_deliveries ORDER BY operation_id")
            .all(),
        ).toEqual([{ operation_id: "unrelated-operation" }]);
      },
    );
  });
});
