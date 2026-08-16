import { afterEach, describe, expect, it } from "vitest";
import { requireNodeSqlite } from "../infra/node-sqlite.js";
import { buildConversationRef } from "../routing/conversation-ref.js";
import {
  backfillSessionConversations,
  migrateConversationDeliveryTargetColumn,
} from "./openclaw-agent-db-session-migrations.js";

describe("agent DB conversation migration", () => {
  const databases: Array<{ close: () => void }> = [];

  afterEach(() => {
    for (const database of databases.splice(0)) {
      database.close();
    }
  });

  it("backfills direct addresses and keeps shared-main peers as participants", () => {
    const sqlite = requireNodeSqlite();
    const database = new sqlite.DatabaseSync(":memory:");
    databases.push(database);
    database.exec(`
      PRAGMA foreign_keys = ON;
      CREATE TABLE conversations (
        conversation_id TEXT PRIMARY KEY,
        channel TEXT NOT NULL,
        account_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        peer_id TEXT NOT NULL,
        delivery_target TEXT NOT NULL,
        parent_conversation_id TEXT,
        thread_id TEXT,
        native_channel_id TEXT,
        native_direct_user_id TEXT,
        label TEXT,
        metadata_json TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE sessions (
        session_id TEXT PRIMARY KEY,
        session_key TEXT NOT NULL,
        session_scope TEXT NOT NULL,
        chat_type TEXT,
        primary_conversation_id TEXT
      );
      CREATE TABLE session_entries (
        session_key TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        entry_json TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE session_conversations (
        session_id TEXT NOT NULL,
        conversation_id TEXT NOT NULL,
        role TEXT NOT NULL,
        first_seen_at INTEGER NOT NULL,
        last_seen_at INTEGER NOT NULL,
        PRIMARY KEY (session_id, conversation_id, role)
      );
      CREATE UNIQUE INDEX idx_agent_conversations_identity
        ON conversations(
          channel,
          account_id,
          kind,
          peer_id,
          IFNULL(parent_conversation_id, ''),
          IFNULL(thread_id, '')
        );
      CREATE UNIQUE INDEX idx_agent_session_conversations_primary
        ON session_conversations(session_id) WHERE role = 'primary';
    `);
    const insertSession = database.prepare(
      "INSERT INTO sessions (session_id, session_key, session_scope, chat_type) VALUES (?, ?, ?, ?)",
    );
    const insertEntry = database.prepare(
      "INSERT INTO session_entries (session_key, session_id, entry_json, updated_at) VALUES (?, ?, ?, ?)",
    );
    insertSession.run("shared", "agent:main:main", "shared-main", "channel");
    insertEntry.run(
      "agent:main:main",
      "shared",
      JSON.stringify({
        groupId: "shared-ops",
        deliveryContext: {
          channel: "discord",
          accountId: "default",
          to: "channel:shared-ops",
        },
      }),
      50,
    );
    insertEntry.run(
      "agent:main:reef:direct:peer-a",
      "shared",
      JSON.stringify({
        deliveryContext: { channel: "reef", accountId: "default", to: "reef:peer-a" },
      }),
      100,
    );
    insertSession.run("dedicated", "agent:main:reef:direct:peer-b", "conversation", "direct");
    insertEntry.run(
      "agent:main:reef:direct:peer-b",
      "dedicated",
      JSON.stringify({
        chatType: "direct",
        origin: {
          provider: "reef",
          nativeDirectUserId: "stale-peer",
          from: "reef:stale-peer",
        },
        deliveryContext: { channel: "reef", accountId: "default", to: "reef:peer-b" },
      }),
      200,
    );
    insertEntry.run(
      "agent:main:reef:direct:peer-a:related",
      "dedicated",
      JSON.stringify({
        chatType: "direct",
        origin: { provider: "reef", nativeDirectUserId: "peer-a" },
        deliveryContext: { channel: "reef", accountId: "default", to: "reef:peer-a" },
      }),
      300,
    );
    insertSession.run("channel-case", "agent:main:legacy-room", "channel", null);
    insertEntry.run(
      "agent:main:legacy-room",
      "channel-case",
      JSON.stringify({
        groupId: "ops-room",
        deliveryContext: {
          channel: "discord",
          accountId: "default",
          to: "channel:ops-room",
        },
      }),
      400,
    );
    insertSession.run("group-case", "agent:main:legacy-group", "channel", null);
    insertEntry.run(
      "agent:main:legacy-group",
      "group-case",
      JSON.stringify({
        groupId: "crew-room",
        deliveryContext: {
          channel: "telegram",
          accountId: "default",
          to: "-100123",
        },
      }),
      500,
    );
    insertSession.run("thread-case", "agent:main:discord:channel:ops-room:thread", "channel", null);
    insertEntry.run(
      "agent:main:discord:channel:ops-room:thread",
      "thread-case",
      JSON.stringify({
        chatType: "channel",
        groupId: "ops-room",
        deliveryContext: {
          channel: "discord",
          accountId: "default",
          to: "channel:ops-room",
          threadId: "user-context",
        },
      }),
      600,
    );

    backfillSessionConversations(database);

    expect(
      database
        .prepare(
          `SELECT sc.session_id, sc.role, c.kind, c.peer_id, c.delivery_target
           FROM session_conversations sc
           JOIN conversations c ON c.conversation_id = sc.conversation_id
           ORDER BY sc.session_id, sc.role, c.peer_id`,
        )
        .all(),
    ).toEqual([
      {
        session_id: "channel-case",
        role: "primary",
        kind: "channel",
        peer_id: "ops-room",
        delivery_target: "channel:ops-room",
      },
      {
        session_id: "dedicated",
        role: "primary",
        kind: "direct",
        peer_id: "peer-a",
        delivery_target: "reef:peer-a",
      },
      {
        session_id: "dedicated",
        role: "related",
        kind: "direct",
        peer_id: "peer-b",
        delivery_target: "reef:peer-b",
      },
      {
        session_id: "group-case",
        role: "primary",
        kind: "group",
        peer_id: "-100123",
        delivery_target: "-100123",
      },
      {
        session_id: "shared",
        role: "participant",
        kind: "direct",
        peer_id: "peer-a",
        delivery_target: "reef:peer-a",
      },
      {
        session_id: "shared",
        role: "primary",
        kind: "channel",
        peer_id: "shared-ops",
        delivery_target: "channel:shared-ops",
      },
      {
        session_id: "thread-case",
        role: "primary",
        kind: "channel",
        peer_id: "ops-room",
        delivery_target: "channel:ops-room",
      },
    ]);
    expect(
      database
        .prepare(
          `SELECT c.conversation_id, c.parent_conversation_id, c.thread_id
           FROM session_conversations sc
           JOIN conversations c ON c.conversation_id = sc.conversation_id
           WHERE sc.session_id = 'thread-case'`,
        )
        .get(),
    ).toEqual({
      conversation_id: buildConversationRef({
        channel: "discord",
        accountId: "default",
        kind: "channel",
        peerId: "ops-room",
        threadId: "user-context",
      }),
      parent_conversation_id: null,
      thread_id: "user-context",
    });
    expect(
      database
        .prepare("SELECT primary_conversation_id FROM sessions WHERE session_id = 'shared'")
        .get(),
    ).toEqual({ primary_conversation_id: expect.stringMatching(/^conv_[a-f0-9]{32}$/u) });
    expect(
      database
        .prepare(
          `SELECT c.peer_id
           FROM sessions s
           JOIN conversations c ON c.conversation_id = s.primary_conversation_id
           WHERE s.session_id = 'shared'`,
        )
        .get(),
    ).toEqual({ peer_id: "shared-ops" });
    expect(
      database
        .prepare("SELECT primary_conversation_id FROM sessions WHERE session_id = 'dedicated'")
        .get(),
    ).toEqual({ primary_conversation_id: expect.stringMatching(/^conv_[a-f0-9]{32}$/u) });
    expect(
      database
        .prepare(
          `SELECT c.peer_id
           FROM sessions s
           JOIN conversations c ON c.conversation_id = s.primary_conversation_id
           WHERE s.session_id = 'dedicated'`,
        )
        .get(),
    ).toEqual({ peer_id: "peer-a" });
  });

  it("drops v8 conversation rows whose exact delivery target cannot be reconstructed", () => {
    const sqlite = requireNodeSqlite();
    const database = new sqlite.DatabaseSync(":memory:");
    databases.push(database);
    database.exec(`
      CREATE TABLE conversations (
        conversation_id TEXT PRIMARY KEY,
        channel TEXT NOT NULL,
        account_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        peer_id TEXT NOT NULL,
        parent_conversation_id TEXT,
        thread_id TEXT,
        native_channel_id TEXT,
        native_direct_user_id TEXT,
        label TEXT,
        metadata_json TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE sessions (
        session_id TEXT PRIMARY KEY,
        session_key TEXT NOT NULL,
        session_scope TEXT NOT NULL,
        chat_type TEXT,
        primary_conversation_id TEXT
      );
      CREATE TABLE session_entries (
        session_key TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        entry_json TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE session_conversations (
        session_id TEXT NOT NULL,
        conversation_id TEXT NOT NULL,
        role TEXT NOT NULL,
        first_seen_at INTEGER NOT NULL,
        last_seen_at INTEGER NOT NULL,
        PRIMARY KEY (session_id, conversation_id, role)
      );
      CREATE UNIQUE INDEX idx_agent_conversations_identity_v8
        ON conversations(
          channel,
          account_id,
          kind,
          peer_id,
          IFNULL(parent_conversation_id, ''),
          IFNULL(thread_id, '')
        );
      CREATE UNIQUE INDEX idx_agent_session_conversations_primary
        ON session_conversations(session_id) WHERE role = 'primary';
      INSERT INTO conversations (
        conversation_id, channel, account_id, kind, peer_id, created_at, updated_at
      ) VALUES
        ('stale-direct', 'reef', 'default', 'direct', 'peer-a', 1, 1),
        ('stale-channel', 'discord', 'default', 'channel', 'ops-room', 1, 1);
      INSERT INTO sessions (
        session_id, session_key, session_scope, primary_conversation_id
      ) VALUES
        ('recoverable', 'agent:main:reef:direct:peer-a', 'conversation', 'stale-direct'),
        ('orphaned', 'agent:main:discord:channel:ops-room', 'channel', 'stale-channel');
      INSERT INTO session_conversations (
        session_id, conversation_id, role, first_seen_at, last_seen_at
      ) VALUES
        ('recoverable', 'stale-direct', 'primary', 1, 1),
        ('orphaned', 'stale-channel', 'primary', 1, 1);
      INSERT INTO session_entries (session_key, session_id, entry_json, updated_at)
      VALUES (
        'agent:main:reef:direct:peer-a',
        'recoverable',
        '{"chatType":"direct","origin":{"provider":"reef","nativeDirectUserId":"peer-a"},"deliveryContext":{"channel":"reef","accountId":"default","to":"reef:peer-a"}}',
        100
      );
    `);

    migrateConversationDeliveryTargetColumn(database);
    backfillSessionConversations(database);

    expect(
      database
        .prepare(
          "SELECT conversation_id, delivery_target FROM conversations ORDER BY conversation_id",
        )
        .all(),
    ).toEqual([
      {
        conversation_id: expect.stringMatching(/^conv_[a-f0-9]{32}$/u),
        delivery_target: "reef:peer-a",
      },
    ]);
    expect(
      database
        .prepare("SELECT primary_conversation_id FROM sessions WHERE session_id = 'orphaned'")
        .get(),
    ).toEqual({ primary_conversation_id: null });
    expect(
      database
        .prepare(
          "SELECT COUNT(*) AS count FROM session_conversations WHERE session_id = 'orphaned'",
        )
        .get(),
    ).toEqual({ count: 0 });
  });
});
