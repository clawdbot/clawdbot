import { afterAll, afterEach, describe, expect, it } from "vitest";
import { cleanupTempDirs, makeTempDir } from "../../test/helpers/temp-dir.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { listAuditEvents, recordAuditEvent } from "./audit-event-store.js";
import type {
  AgentRunAuditEventInput,
  InboundMessageAuditEventInput,
  OutboundMessageAuditEventInput,
  OutboundMessageAuditTerminal,
} from "./audit-event-types.js";

const tempDirs: string[] = [];
const AUDIT_REF_RE = /^hmac-sha256:v1:[a-f0-9]{32}:[a-f0-9]{64}$/u;

function createDatabaseOptions() {
  return { env: { OPENCLAW_STATE_DIR: makeTempDir(tempDirs, "openclaw-message-audit-") } };
}

type InboundMessageOverrides = Partial<
  Pick<
    InboundMessageAuditEventInput,
    | "sourceId"
    | "sourceSequence"
    | "occurredAt"
    | "actorId"
    | "agentId"
    | "runId"
    | "channel"
    | "conversationKind"
    | "durationMs"
    | "resultCount"
    | "accountId"
    | "conversationId"
    | "messageId"
    | "targetId"
  >
>;

function messageInput(overrides: InboundMessageOverrides = {}): InboundMessageAuditEventInput {
  return {
    sourceId: "message-source-1",
    sourceSequence: 1,
    occurredAt: Date.now(),
    kind: "message",
    action: "message.inbound.processed",
    status: "succeeded",
    actorType: "channel_sender",
    actorId: "sender:+15551234567",
    agentId: "main",
    runId: "run-1",
    direction: "inbound",
    channel: "telegram",
    conversationKind: "direct",
    outcome: "completed",
    durationMs: 12,
    resultCount: 1,
    accountId: "operator@example.test",
    conversationId: "chat-123",
    messageId: "message-456",
    targetId: "target-789",
    ...overrides,
  };
}

type OutboundMessageOverrides = Partial<
  Pick<
    OutboundMessageAuditEventInput,
    | "sourceId"
    | "sourceSequence"
    | "occurredAt"
    | "channel"
    | "conversationKind"
    | "durationMs"
    | "resultCount"
    | "accountId"
    | "conversationId"
    | "messageId"
    | "targetId"
  >
>;

function outboundMessageInput(
  terminal: OutboundMessageAuditTerminal,
  overrides: OutboundMessageOverrides = {},
): OutboundMessageAuditEventInput {
  return {
    sourceId: "outbound-message-source-1",
    sourceSequence: 1,
    occurredAt: Date.now(),
    kind: "message",
    action: "message.outbound.finished",
    actorType: "agent",
    actorId: "main",
    agentId: "main",
    runId: "run-1",
    direction: "outbound",
    channel: "telegram",
    conversationKind: "direct",
    durationMs: 12,
    resultCount: 1,
    accountId: "operator@example.test",
    conversationId: "chat-123",
    messageId: "message-456",
    targetId: "target-789",
    ...terminal,
    ...overrides,
  };
}

function runInput(
  overrides: Partial<
    Pick<AgentRunAuditEventInput, "sourceId" | "sourceSequence" | "occurredAt" | "runId">
  > = {},
): AgentRunAuditEventInput {
  return {
    sourceId: "run-source-1",
    sourceSequence: 1,
    occurredAt: Date.now(),
    kind: "agent_run",
    action: "agent.run.started",
    status: "started",
    actorType: "agent",
    actorId: "main",
    agentId: "main",
    runId: "run-1",
    ...overrides,
  };
}

afterEach(() => {
  closeOpenClawStateDatabaseForTest();
});

afterAll(() => {
  cleanupTempDirs(tempDirs);
});

describe("message audit persistence", () => {
  it("stores stable domain-separated pseudonyms without raw transport identities", () => {
    const database = createDatabaseOptions();
    const rawIdentity = "same-raw-identity";
    const first = recordAuditEvent(
      messageInput({
        actorId: rawIdentity,
        accountId: rawIdentity,
        conversationId: rawIdentity,
        messageId: rawIdentity,
        targetId: rawIdentity,
      }),
      database,
    );

    expect(first).toMatchObject({
      schemaVersion: 1,
      kind: "message",
      direction: "inbound",
      channel: "telegram",
      conversationKind: "direct",
      outcome: "completed",
      durationMs: 12,
      resultCount: 1,
      redaction: "metadata_only",
    });
    expect(first).toHaveProperty("sourceSequence", 1);
    const refs = [
      first?.actorId,
      first?.accountRef,
      first?.conversationRef,
      first?.messageRef,
      first?.targetRef,
    ];
    expect(refs).toEqual(refs.map(() => expect.stringMatching(AUDIT_REF_RE)));
    expect(new Set(refs).size).toBe(refs.length);
    expect(JSON.stringify(first)).not.toContain(rawIdentity);

    const { db } = openOpenClawStateDatabase(database);
    const stored = db
      .prepare(
        `SELECT actor_id, account_ref, conversation_ref, message_ref, target_ref,
                session_key, session_id
         FROM audit_events`,
      )
      .get() as Record<string, unknown>;
    expect(JSON.stringify(stored)).not.toContain(rawIdentity);
    expect(stored.session_key).toBeNull();
    expect(stored.session_id).toBeNull();

    const keyRow = db.prepare("SELECT key_id, key FROM audit_identity_keys WHERE id = 1").get() as {
      key_id: string;
      key: Uint8Array;
    };
    expect(keyRow.key_id).toMatch(/^[a-f0-9]{32}$/u);
    expect(keyRow.key.byteLength).toBe(32);

    closeOpenClawStateDatabaseForTest();
    const second = recordAuditEvent(
      messageInput({
        sourceId: "message-source-2",
        actorId: rawIdentity,
        accountId: rawIdentity,
        conversationId: rawIdentity,
        messageId: rawIdentity,
        targetId: rawIdentity,
      }),
      database,
    );
    expect(second).toMatchObject({
      actorId: first?.actorId,
      accountRef: first?.accountRef,
      conversationRef: first?.conversationRef,
      messageRef: first?.messageRef,
      targetRef: first?.targetRef,
    });
  });

  it("fails closed instead of replacing corrupt identity key material", () => {
    const database = createDatabaseOptions();
    const { db } = openOpenClawStateDatabase(database);
    db.prepare(
      "INSERT INTO audit_identity_keys (id, key_id, key, created_at) VALUES (?, ?, ?, ?)",
    ).run(1, "a".repeat(32), Buffer.alloc(31), Date.now());

    expect(() => recordAuditEvent(messageInput(), database)).toThrow(
      "audit identity key is corrupt",
    );
    const count = db.prepare("SELECT COUNT(*) AS count FROM audit_events").get() as {
      count: number;
    };
    expect(count.count).toBe(0);
    expect(
      (
        db.prepare("SELECT length(key) AS length FROM audit_identity_keys WHERE id = 1").get() as {
          length: number;
        }
      ).length,
    ).toBe(31);
  });

  it("fails closed when retained message references lose their identity key", () => {
    const database = createDatabaseOptions();
    const first = recordAuditEvent(messageInput(), database);
    expect(first?.messageRef).toMatch(AUDIT_REF_RE);

    closeOpenClawStateDatabaseForTest();
    const { db } = openOpenClawStateDatabase(database);
    db.prepare("DELETE FROM audit_identity_keys WHERE id = 1").run();
    closeOpenClawStateDatabaseForTest();

    expect(() =>
      recordAuditEvent(messageInput({ sourceId: "message-after-key-loss" }), database),
    ).toThrow("audit identity key is missing");
    const reopened = openOpenClawStateDatabase(database).db;
    expect(
      (
        reopened.prepare("SELECT COUNT(*) AS count FROM audit_identity_keys").get() as {
          count: number;
        }
      ).count,
    ).toBe(0);
  });

  it("forgets a transaction-local identity key after a rolled-back event insert", () => {
    const database = createDatabaseOptions();
    const { db } = openOpenClawStateDatabase(database);
    db.exec(`
      CREATE TABLE audit_rollback_parent (id INTEGER PRIMARY KEY);
      CREATE TABLE audit_rollback_child (
        parent_id INTEGER NOT NULL,
        FOREIGN KEY (parent_id) REFERENCES audit_rollback_parent(id)
          DEFERRABLE INITIALLY DEFERRED
      );
      CREATE TRIGGER reject_audit_event
      AFTER INSERT ON audit_events
      BEGIN
        INSERT INTO audit_rollback_child (parent_id) VALUES (1);
      END;
    `);

    expect(() => recordAuditEvent(messageInput(), database)).toThrow(/FOREIGN KEY/u);
    expect(
      (db.prepare("SELECT COUNT(*) AS count FROM audit_identity_keys").get() as { count: number })
        .count,
    ).toBe(0);
    db.exec(`
      DROP TRIGGER reject_audit_event;
      DROP TABLE audit_rollback_child;
      DROP TABLE audit_rollback_parent;
    `);

    const committed = recordAuditEvent(
      messageInput({ sourceId: "message-after-rollback", messageId: "stable-message" }),
      database,
    );
    expect(committed?.messageRef).toMatch(AUDIT_REF_RE);
    expect(
      (db.prepare("SELECT COUNT(*) AS count FROM audit_identity_keys").get() as { count: number })
        .count,
    ).toBe(1);

    closeOpenClawStateDatabaseForTest();
    const reopened = recordAuditEvent(
      messageInput({ sourceId: "message-after-reopen", messageId: "stable-message" }),
      database,
    );
    expect(reopened?.messageRef).toBe(committed?.messageRef);
  });

  it("scopes platform message references to their conversation", () => {
    const database = createDatabaseOptions();
    const first = recordAuditEvent(
      messageInput({
        sourceId: "message-conversation-a-1",
        conversationId: "conversation-a",
        messageId: "42",
      }),
      database,
    );
    const otherConversation = recordAuditEvent(
      messageInput({
        sourceId: "message-conversation-b-1",
        conversationId: "conversation-b",
        messageId: "42",
      }),
      database,
    );
    const sameConversation = recordAuditEvent(
      messageInput({
        sourceId: "message-conversation-a-2",
        conversationId: "conversation-a",
        messageId: "42",
      }),
      database,
    );

    expect(first?.messageRef).toMatch(AUDIT_REF_RE);
    expect(otherConversation?.messageRef).toMatch(AUDIT_REF_RE);
    expect(otherConversation?.messageRef).not.toBe(first?.messageRef);
    expect(sameConversation?.messageRef).toBe(first?.messageRef);
  });

  it("uses the outbound target as the conversation correlation fallback", () => {
    const database = createDatabaseOptions();
    const event = recordAuditEvent(
      outboundMessageInput(
        {
          status: "failed",
          outcome: "failed",
          errorCode: "message_delivery_failed",
          failureStage: "platform_send",
        },
        {
          sourceId: "message-outbound-target-fallback",
          conversationId: undefined,
          targetId: "target-conversation",
        },
      ),
      database,
    );

    expect(event?.conversationRef).toMatch(AUDIT_REF_RE);
    expect(event?.targetRef).toMatch(AUDIT_REF_RE);
    expect(event?.conversationRef).not.toBe(event?.targetRef);
  });

  it("rejects persisted message terminal combinations outside the closed contract", () => {
    const database = createDatabaseOptions();
    recordAuditEvent(messageInput(), database);
    const { db } = openOpenClawStateDatabase(database);
    db.prepare("UPDATE audit_events SET error_code = ? WHERE kind = 'message'").run(
      "message_processing_failed",
    );

    expect(() =>
      listAuditEvents({ database, limit: 10, filters: { includeMessages: true } }),
    ).toThrow("corrupt audit event row 1: unexpected error_code");
  });

  it("rejects delivery kind on terminals where no payload was proven delivered", () => {
    const database = createDatabaseOptions();
    recordAuditEvent(
      outboundMessageInput({
        status: "blocked",
        outcome: "suppressed",
        reasonCode: "no_visible_payload",
      }),
      database,
    );
    const { db } = openOpenClawStateDatabase(database);
    db.prepare("UPDATE audit_events SET delivery_kind = 'text' WHERE kind = 'message'").run();

    expect(() =>
      listAuditEvents({ database, limit: 10, filters: { includeMessages: true } }),
    ).toThrow("corrupt audit event row 1: unexpected delivery_kind");
  });

  it("rejects a persisted channel-sender actor without a keyed reference", () => {
    const database = createDatabaseOptions();
    recordAuditEvent(messageInput(), database);
    const { db } = openOpenClawStateDatabase(database);
    db.prepare("UPDATE audit_events SET actor_id = ? WHERE kind = 'message'").run("raw-sender");

    expect(() =>
      listAuditEvents({ database, limit: 10, filters: { includeMessages: true } }),
    ).toThrow("corrupt audit event row 1: invalid actorId");
  });

  it("keeps message rows opt-in while supporting message filters", () => {
    const database = createDatabaseOptions();
    const now = Date.now();
    recordAuditEvent(runInput({ occurredAt: now }), database);
    recordAuditEvent(messageInput({ occurredAt: now + 1 }), database);
    recordAuditEvent(
      outboundMessageInput(
        { status: "succeeded", outcome: "sent" },
        {
          sourceId: "message-source-2",
          occurredAt: now + 2,
          channel: "slack",
          conversationKind: "channel",
        },
      ),
      database,
    );

    expect(listAuditEvents({ database, limit: 10 }).events.map((event) => event.kind)).toEqual([
      "agent_run",
    ]);
    expect(
      listAuditEvents({ database, limit: 10, filters: { includeMessages: true } }).events.map(
        (event) => event.kind,
      ),
    ).toEqual(["message", "message", "agent_run"]);
    expect(
      listAuditEvents({
        database,
        limit: 10,
        filters: {
          kind: "message",
          includeMessages: false,
          direction: "inbound",
          channel: "telegram",
        },
      }).events,
    ).toEqual([expect.objectContaining({ direction: "inbound", channel: "telegram" })]);
  });
});
