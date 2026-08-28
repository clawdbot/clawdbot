import fs from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTempDirTracker } from "../../test/helpers/temp-dir.js";
import { listSessionEntriesCore } from "../config/sessions/session-accessor.js";
import { readConfigMachineState, writeConfigMachineState } from "../state/config-machine-state.js";
import {
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
  resolveOpenClawAgentSqlitePath,
} from "../state/openclaw-agent-db.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { repairReservedIncognitoSessionKeys } from "./doctor-session-incognito-key-repair.js";

const tempDirs = createTempDirTracker();
afterEach(() => {
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
  tempDirs.cleanup();
});

describe("doctor reserved incognito session key repair", () => {
  it("renames durable collisions and every key-bearing linkage idempotently", () => {
    const stateDir = fs.realpathSync(tempDirs.make("openclaw-doctor-incognito-key-"));
    const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
    const sqlitePath = resolveOpenClawAgentSqlitePath({ agentId: "main", env });
    const database = openOpenClawAgentDatabase({ agentId: "main", env, path: sqlitePath });
    const secondaryPath = resolveOpenClawAgentSqlitePath({ agentId: "work", env });
    const secondaryDatabase = openOpenClawAgentDatabase({
      agentId: "work",
      env,
      path: secondaryPath,
    });
    const stateDatabase = openOpenClawStateDatabase({ env });
    const oldKey = "agent:main:dashboard:incognito-collision";
    const baseLegacyKey = "agent:main:dashboard:legacy-incognito-collision";
    const newKey = `${baseLegacyKey}-1`;
    try {
      const entryJson = JSON.stringify({
        sessionId: "session-old",
        updatedAt: 1,
        parentSessionKey: oldKey,
        spawnedBy: oldKey,
        completionOwnerSessionKey: oldKey,
        forkSource: { sessionKey: oldKey, sessionId: "source" },
        compactionCheckpoints: [{ checkpointId: "checkpoint", sessionKey: oldKey }],
        systemPromptReport: { source: "run", generatedAt: 1, sessionKey: oldKey },
        pluginExtensions: { test: { label: oldKey } },
      });
      database.db
        .prepare(
          "INSERT INTO session_nodes (session_key, current_session_id, entry_json, updated_at, parent_session_key, spawned_by, fork_source_session_key) VALUES (?, ?, ?, 1, ?, ?, ?)",
        )
        .run(oldKey, "session-old", entryJson, oldKey, oldKey, oldKey);
      database.db
        .prepare(
          "INSERT INTO session_windows (session_id, session_key, session_scope, created_at, updated_at, parent_session_key, spawned_by) VALUES (?, ?, 'conversation', 1, 1, ?, ?)",
        )
        .run("session-old", oldKey, oldKey, oldKey);
      database.db
        .prepare(
          "INSERT INTO conversations (conversation_id, channel, account_id, kind, peer_id, delivery_target, metadata_json, created_at, updated_at) VALUES ('conversation-1', 'webchat', 'default', 'direct', 'peer', 'peer', '{}', 1, 1)",
        )
        .run();
      database.db
        .prepare(
          "INSERT INTO conversation_deliveries (operation_id, operation_kind, conversation_id, source_session_key, message_hash, status, created_at, updated_at) VALUES ('operation-1', 'turn', 'conversation-1', ?, 'hash', 'sent', 1, 1)",
        )
        .run(oldKey);
      stateDatabase.db
        .prepare(
          "INSERT INTO session_state_heads (session_key, agent_id, last_sequence, updated_at) VALUES (?, 'main', 1, 1)",
        )
        .run(oldKey);
      stateDatabase.db
        .prepare(
          "INSERT INTO operator_approvals (approval_id, resolution_ref, kind, status, presentation_json, reviewer_device_ids_json, source_session_key, audience_session_keys_json, runtime_epoch, created_at_ms, expires_at_ms, updated_at_ms) VALUES ('approval-1', ?, 'exec', 'pending', '{}', '[]', ?, ?, 'epoch', 1, 2, 1)",
        )
        .run("a".repeat(43), oldKey, JSON.stringify([baseLegacyKey]));
      secondaryDatabase.db
        .prepare(
          "INSERT INTO session_nodes (session_key, current_session_id, entry_json, updated_at, parent_session_key, spawned_by) VALUES ('agent:work:dashboard:regular', 'session-work', ?, 1, ?, ?)",
        )
        .run(
          JSON.stringify({
            sessionId: "session-work",
            updatedAt: 1,
            parentSessionKey: oldKey,
            spawnedBy: oldKey,
            completionOwnerSessionKey: oldKey,
          }),
          oldKey,
          oldKey,
        );
      database.db
        .prepare("UPDATE session_nodes SET entry_valid = 1 WHERE session_key = ?")
        .run(oldKey);
      secondaryDatabase.db
        .prepare("UPDATE session_nodes SET entry_valid = 1 WHERE session_key = ?")
        .run("agent:work:dashboard:regular");
      secondaryDatabase.db
        .prepare(
          "INSERT INTO session_windows (session_id, session_key, session_scope, created_at, updated_at, parent_session_key, spawned_by) VALUES ('session-work', 'agent:work:dashboard:regular', 'conversation', 1, 1, ?, ?)",
        )
        .run(oldKey, oldKey);
      stateDatabase.db
        .prepare(
          "INSERT INTO session_watch_cursors (watcher_session_key, target_session_key, updated_at) VALUES (?, ?, 1)",
        )
        .run(oldKey, oldKey);
      writeConfigMachineState("tui.lastSession.main", oldKey, { env });
      writeConfigMachineState("unrelated.sessionReference", oldKey, { env });
      database.db
        .prepare(
          "INSERT INTO heartbeat_outcomes (session_key, run_session_key, outcome, summary, occurred_at, updated_at) VALUES (?, ?, 'done', 'done', 1, 1)",
        )
        .run(oldKey, oldKey);
      database.db
        .prepare(
          "INSERT INTO board_tabs (session_key, tab_id, title, position, created_by, revision) VALUES (?, 'tab-1', 'Tab', 0, 'user', 0)",
        )
        .run(oldKey);
      database.db
        .prepare(
          "INSERT INTO board_widgets (session_key, name, tab_id, content_kind, html, sha256, view_generation, revision, size_w, size_h, position, created_by, created_at, updated_at) VALUES (?, 'widget-1', 'tab-1', 'html', X'00', 'sha', 'view-1', 1, 1, 1, 0, 'user', 1, 1)",
        )
        .run(oldKey);
      database.db
        .prepare(
          "INSERT INTO session_members (session_key, identity_id, added_by, added_at) VALUES (?, 'member-1', 'owner-1', 1)",
        )
        .run(oldKey);
      expect(listSessionEntriesCore({ agentId: "main", clone: false, env })[0]?.sessionKey).toBe(
        oldKey,
      );

      expect(repairReservedIncognitoSessionKeys({ apply: false, cfg: {}, env })).toEqual({
        found: 1,
        repaired: 0,
      });
      expect(repairReservedIncognitoSessionKeys({ apply: true, cfg: {}, env })).toEqual({
        found: 1,
        repaired: 1,
      });
      expect(listSessionEntriesCore({ agentId: "main", clone: false, env })[0]?.sessionKey).toBe(
        newKey,
      );

      expect(
        database.db
          .prepare(
            "SELECT session_key, parent_session_key, spawned_by, fork_source_session_key FROM session_nodes",
          )
          .get(),
      ).toEqual({
        session_key: newKey,
        parent_session_key: newKey,
        spawned_by: newKey,
        fork_source_session_key: newKey,
      });
      expect(
        database.db
          .prepare("SELECT session_key, parent_session_key, spawned_by FROM session_windows")
          .get(),
      ).toEqual({ session_key: newKey, parent_session_key: newKey, spawned_by: newKey });
      expect(
        database.db.prepare("SELECT source_session_key FROM conversation_deliveries").get(),
      ).toEqual({ source_session_key: newKey });
      expect(
        database.db.prepare("SELECT session_key, run_session_key FROM heartbeat_outcomes").get(),
      ).toEqual({ session_key: newKey, run_session_key: newKey });
      expect(database.db.prepare("SELECT session_key FROM board_tabs").get()).toEqual({
        session_key: newKey,
      });
      expect(database.db.prepare("SELECT session_key FROM board_widgets").get()).toEqual({
        session_key: newKey,
      });
      expect(database.db.prepare("SELECT session_key FROM session_members").get()).toEqual({
        session_key: newKey,
      });
      expect(stateDatabase.db.prepare("SELECT session_key FROM session_state_heads").get()).toEqual(
        {
          session_key: newKey,
        },
      );
      expect(
        stateDatabase.db
          .prepare("SELECT watcher_session_key, target_session_key FROM session_watch_cursors")
          .get(),
      ).toEqual({ watcher_session_key: newKey, target_session_key: newKey });
      expect(readConfigMachineState<string>("tui.lastSession.main", { env })).toBe(newKey);
      expect(readConfigMachineState<string>("unrelated.sessionReference", { env })).toBe(oldKey);
      expect(
        stateDatabase.db
          .prepare("SELECT source_session_key, audience_session_keys_json FROM operator_approvals")
          .get(),
      ).toEqual({
        source_session_key: newKey,
        audience_session_keys_json: JSON.stringify([baseLegacyKey]),
      });
      expect(
        secondaryDatabase.db
          .prepare("SELECT parent_session_key, spawned_by FROM session_windows")
          .get(),
      ).toEqual({ parent_session_key: newKey, spawned_by: newKey });
      const secondaryEntry = secondaryDatabase.db
        .prepare("SELECT entry_json FROM session_nodes")
        .get() as { entry_json: string };
      expect(JSON.parse(secondaryEntry.entry_json)).toMatchObject({
        completionOwnerSessionKey: newKey,
      });
      const entry = database.db
        .prepare("SELECT session_key, entry_json FROM session_nodes")
        .get() as { session_key: string; entry_json: string };
      expect(entry.session_key).toBe(newKey);
      expect(JSON.parse(entry.entry_json)).toMatchObject({
        parentSessionKey: newKey,
        completionOwnerSessionKey: newKey,
        forkSource: { sessionKey: newKey },
        compactionCheckpoints: [{ sessionKey: newKey }],
        systemPromptReport: { sessionKey: newKey },
        pluginExtensions: { test: { label: oldKey } },
      });
      expect(
        database.db
          .prepare("SELECT entry_valid FROM session_nodes WHERE session_key = ?")
          .get(newKey),
      ).toEqual({ entry_valid: 1 });
      expect(
        secondaryDatabase.db
          .prepare("SELECT entry_valid FROM session_nodes WHERE session_key = ?")
          .get("agent:work:dashboard:regular"),
      ).toEqual({ entry_valid: 1 });
      closeOpenClawAgentDatabasesForTest();
      expect(listSessionEntriesCore({ agentId: "main", env })).toMatchObject([
        { sessionKey: newKey, entry: { sessionId: "session-old", updatedAt: 1 } },
      ]);
      expect(listSessionEntriesCore({ agentId: "work", env })).toMatchObject([
        {
          sessionKey: "agent:work:dashboard:regular",
          entry: { sessionId: "session-work", updatedAt: 1 },
        },
      ]);
      expect(repairReservedIncognitoSessionKeys({ apply: true, cfg: {}, env })).toEqual({
        found: 0,
        repaired: 0,
      });
      expect(
        stateDatabase.db
          .prepare("SELECT scope FROM state_leases WHERE owner = 'openclaw-doctor'")
          .get(),
      ).toBeUndefined();
    } finally {
      closeOpenClawAgentDatabasesForTest();
    }
  });

  it("resumes an interrupted cross-database repair from its durable journal", () => {
    const stateDir = fs.realpathSync(tempDirs.make("openclaw-doctor-incognito-resume-"));
    const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
    const sqlitePath = resolveOpenClawAgentSqlitePath({ agentId: "main", env });
    const database = openOpenClawAgentDatabase({ agentId: "main", env, path: sqlitePath });
    const stateDatabase = openOpenClawStateDatabase({ env });
    const oldKey = "agent:main:dashboard:incognito-interrupted";
    const newCollisionKey = "agent:main:dashboard:incognito-new";
    const resumedKey = "agent:main:dashboard:legacy-incognito-interrupted-resumed";
    database.db
      .prepare(
        "INSERT INTO session_nodes (session_key, current_session_id, entry_json, updated_at) VALUES (?, 'session-old', ?, 1)",
      )
      .run(oldKey, JSON.stringify({ sessionId: "session-old" }));
    database.db
      .prepare(
        "INSERT INTO session_windows (session_id, session_key, session_scope, created_at, updated_at) VALUES ('session-old', ?, 'conversation', 1, 1)",
      )
      .run(oldKey);
    database.db
      .prepare(
        "INSERT INTO session_nodes (session_key, current_session_id, entry_json, updated_at) VALUES (?, 'session-new', ?, 1)",
      )
      .run(newCollisionKey, JSON.stringify({ sessionId: "session-new" }));
    database.db
      .prepare(
        "INSERT INTO session_windows (session_id, session_key, session_scope, created_at, updated_at) VALUES ('session-new', ?, 'conversation', 1, 1)",
      )
      .run(newCollisionKey);
    stateDatabase.db
      .prepare(
        "INSERT INTO state_leases (scope, lease_key, owner, payload_json, created_at, updated_at) VALUES ('doctor-session-key-migration', 'reserved-incognito-v1', 'openclaw-doctor', ?, 1, 1)",
      )
      .run(
        JSON.stringify({
          version: 1,
          renames: [{ from: oldKey, to: resumedKey }],
        }),
      );
    stateDatabase.db
      .prepare(
        "INSERT INTO session_state_heads (session_key, agent_id, last_sequence, updated_at) VALUES (?, 'main', 1, 1)",
      )
      .run(resumedKey);

    expect(repairReservedIncognitoSessionKeys({ apply: false, cfg: {}, env })).toEqual({
      found: 2,
      repaired: 0,
    });
    expect(repairReservedIncognitoSessionKeys({ apply: true, cfg: {}, env })).toEqual({
      found: 2,
      repaired: 2,
    });
    expect(
      database.db
        .prepare("SELECT session_key FROM session_nodes ORDER BY session_key")
        .all()
        .map((row) => (row as { session_key: string }).session_key),
    ).toEqual([resumedKey, "agent:main:dashboard:legacy-incognito-new"].toSorted());
    expect(
      stateDatabase.db
        .prepare("SELECT scope FROM state_leases WHERE owner = 'openclaw-doctor'")
        .get(),
    ).toBeUndefined();
  });

  it("rewrites dense incognito references in bounded batches without changing payloads", () => {
    const stateDir = fs.realpathSync(tempDirs.make("openclaw-doctor-incognito-density-"));
    const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
    const database = openOpenClawAgentDatabase({ agentId: "main", env });
    const oldKey = "agent:main:dashboard:incognito-density";
    const newKey = "agent:main:dashboard:legacy-incognito-density";
    const payload = "incognito-payload-".repeat(128);
    database.db
      .prepare(
        "INSERT INTO session_nodes (session_key, current_session_id, entry_json, entry_valid, updated_at) VALUES (?, 'incognito-density-owner', ?, 1, 1)",
      )
      .run(oldKey, JSON.stringify({ sessionId: "incognito-density-owner", updatedAt: 1 }));
    database.db
      .prepare("UPDATE session_nodes SET entry_valid = 1 WHERE session_key = ?")
      .run(oldKey);
    database.db
      .prepare(
        "INSERT INTO session_windows (session_id, session_key, session_scope, created_at, updated_at) VALUES ('incognito-density-owner', ?, 'conversation', 1, 1)",
      )
      .run(oldKey);
    const insertNode = database.db.prepare(
      "INSERT INTO session_nodes (session_key, current_session_id, entry_json, entry_valid, updated_at, parent_session_key) VALUES (?, ?, ?, 1, ?, ?)",
    );
    const insertWindow = database.db.prepare(
      "INSERT INTO session_windows (session_id, session_key, session_scope, created_at, updated_at, parent_session_key) VALUES (?, ?, 'conversation', ?, ?, ?)",
    );
    for (let index = 0; index < 130; index += 1) {
      const sessionKey = `agent:main:incognito-density-${String(index).padStart(3, "0")}`;
      const sessionId = `incognito-density-session-${index}`;
      insertNode.run(
        sessionKey,
        sessionId,
        JSON.stringify({
          parentSessionKey: oldKey,
          payload,
          sessionId,
          updatedAt: index + 2,
        }),
        index + 2,
        oldKey,
      );
      insertWindow.run(sessionId, sessionKey, index + 2, index + 2, oldKey);
    }
    const originalExec = database.db.exec.bind(database.db);
    let writeTransactions = 0;
    vi.spyOn(database.db, "exec").mockImplementation((sql) => {
      if (sql === "BEGIN IMMEDIATE") {
        writeTransactions += 1;
      }
      return originalExec(sql);
    });

    expect(repairReservedIncognitoSessionKeys({ apply: true, cfg: {}, env })).toEqual({
      found: 1,
      repaired: 1,
    });
    expect(writeTransactions).toBeGreaterThanOrEqual(4);
    expect(
      database.db
        .prepare("SELECT count(*) AS count FROM session_nodes WHERE entry_valid <> 1")
        .get(),
    ).toEqual({ count: 0 });
    expect(
      database.db
        .prepare("SELECT session_key FROM session_nodes WHERE session_key = ?")
        .get(newKey),
    ).toEqual({
      session_key: newKey,
    });
    for (const index of [0, 65, 129]) {
      const sessionKey = `agent:main:incognito-density-${String(index).padStart(3, "0")}`;
      const row = database.db
        .prepare("SELECT entry_json FROM session_nodes WHERE session_key = ?")
        .get(sessionKey) as { entry_json: string };
      expect(JSON.parse(row.entry_json)).toMatchObject({ parentSessionKey: newKey, payload });
    }
  });
});
