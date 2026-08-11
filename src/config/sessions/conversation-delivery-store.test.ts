import path from "node:path";
import { describe, expect, it } from "vitest";
import { requireNodeSqlite } from "../../infra/node-sqlite.js";
import { completeDurableDelivery } from "../../infra/outbound/delivery-completion.js";
import { normalizeLegacySessionEntryDelivery } from "../../infra/state-migrations.legacy-session-store.js";
import { buildConversationRef } from "../../routing/conversation-ref.js";
import {
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import { withTestDir } from "../../test-helpers/temp-dir.js";
import type { DeliveryContext } from "../../utils/delivery-context.types.js";
import {
  beginConversationDeliveryOperation,
  findConversationTurnDeliveryByReplyTarget,
  getConversationDeliveryOperation,
  markConversationDeliveryQueued,
  markConversationDeliveryRejected,
  markConversationDeliveryReplied,
  markConversationDeliverySent,
  markConversationDeliveryUnknown,
} from "./conversation-delivery-store.js";
import { resolveConversation } from "./conversation-registry.js";
import {
  deleteSessionEntryLifecycle,
  upsertSessionEntryCore as upsertCanonicalSessionEntry,
} from "./session-accessor.js";
import { resolveSqliteReadScope, toDatabaseOptions } from "./session-accessor.sqlite-scope.js";
import type { SessionEntry, SessionOrigin } from "./types.js";

type LegacyDeliveryFixture = Partial<SessionEntry> & {
  deliveryContext?: DeliveryContext;
  origin?: SessionOrigin;
};

const upsertSessionEntry = (
  scope: Parameters<typeof upsertCanonicalSessionEntry>[0],
  entry: LegacyDeliveryFixture,
) => upsertCanonicalSessionEntry(scope, normalizeLegacySessionEntryDelivery(entry as SessionEntry));

async function withConversationStore(
  run: (params: {
    scope: { agentId: string; storePath: string };
    conversationRef: string;
  }) => Promise<void> | void,
): Promise<void> {
  await withTestDir({ prefix: "openclaw-conversation-delivery-" }, async (dir) => {
    const storePath = path.join(dir, "sessions.json");
    const scope = { agentId: "main", storePath };
    try {
      await upsertSessionEntry(
        { ...scope, sessionKey: "agent:main:reef:direct:peer-agent" },
        {
          sessionId: "reef-session",
          updatedAt: 100,
          chatType: "direct",
          deliveryContext: { channel: "reef", accountId: "default", to: "reef:peer-agent" },
          origin: {
            provider: "reef",
            accountId: "default",
            nativeDirectUserId: "peer-agent",
          },
        },
      );
      await run({
        scope,
        conversationRef: buildConversationRef({
          channel: "reef",
          accountId: "default",
          kind: "direct",
          peerId: "peer-agent",
        }),
      });
    } finally {
      closeOpenClawAgentDatabasesForTest();
    }
  });
}

describe("conversation delivery store", () => {
  it("installs receipt provenance on first delivery-owner use", async () => {
    await withConversationStore(({ scope }) => {
      const databaseOptions = toDatabaseOptions(resolveSqliteReadScope(scope));
      const databasePath = openOpenClawAgentDatabase(databaseOptions).path;
      closeOpenClawAgentDatabasesForTest();

      const { DatabaseSync } = requireNodeSqlite();
      const legacy = new DatabaseSync(databasePath);
      legacy.exec("ALTER TABLE conversation_deliveries DROP COLUMN platform_message_id_source;");
      legacy.close();

      expect(getConversationDeliveryOperation(scope, "missing-operation")).toBeUndefined();
      const upgraded = openOpenClawAgentDatabase(databaseOptions);
      expect(
        (
          upgraded.db.prepare("PRAGMA table_info(conversation_deliveries)").all() as Array<{
            name?: unknown;
          }>
        ).some((column) => column.name === "platform_message_id_source"),
      ).toBe(true);
    });
  });

  it("creates idempotent operations and rejects operation-id input reuse", async () => {
    await withConversationStore(({ scope, conversationRef }) => {
      const first = beginConversationDeliveryOperation(scope, {
        operationId: "operation-1",
        operationKind: "send",
        conversationRef,
        sourceSessionKey: "agent:main:telegram:direct:operator",
        message: "hello",
        preparedMessageId: "prepared-1",
      });
      const repeated = beginConversationDeliveryOperation(scope, {
        operationId: "operation-1",
        operationKind: "send",
        conversationRef,
        sourceSessionKey: "agent:main:telegram:direct:operator",
        message: "hello",
        preparedMessageId: "ignored-retry-candidate",
      });

      expect(first.created).toBe(true);
      expect(first.record.channel).toBe("reef");
      expect(first.record.sourceSessionKey).toBe("agent:main:telegram:direct:operator");
      expect(repeated).toEqual({ created: false, record: first.record });
      expect(() =>
        beginConversationDeliveryOperation(scope, {
          operationId: "operation-1",
          operationKind: "send",
          conversationRef,
          message: "different",
        }),
      ).toThrow("reused with different input");
      expect(() =>
        beginConversationDeliveryOperation(scope, {
          operationId: "operation-1",
          operationKind: "turn",
          conversationRef,
          sourceSessionKey: "agent:main:telegram:direct:operator",
          message: "hello",
        }),
      ).toThrow("reused with different input");
      expect(() =>
        beginConversationDeliveryOperation(scope, {
          operationId: "operation-1",
          operationKind: "send",
          conversationRef,
          sourceSessionKey: "agent:main:discord:channel:other",
          message: "hello",
        }),
      ).toThrow("reused with different input");
    });
  });

  it("persists queue, platform, and correlated reply evidence", async () => {
    await withConversationStore(({ scope, conversationRef }) => {
      beginConversationDeliveryOperation(scope, {
        operationId: "operation-2",
        operationKind: "turn",
        conversationRef,
        message: "hello",
        preparedMessageId: "prepared-2",
      });
      expect(markConversationDeliveryQueued(scope, "operation-2", "queue-2")).toMatchObject({
        status: "queued",
        queueId: "queue-2",
      });
      expect(
        markConversationDeliverySent(scope, "operation-2", {
          messageId: "platform-2",
          source: "receipt",
        }),
      ).toMatchObject({
        status: "sent",
        platformMessageId: "platform-2",
        platformMessageIdSource: "receipt",
      });
      const replied = markConversationDeliveryReplied(scope, {
        operationId: "operation-2",
        reply: {
          messageId: "reply-2",
          replyToId: "platform-2",
          text: "ack",
          timestamp: 200,
        },
      });

      expect(replied).toMatchObject({
        status: "replied",
        reply: { messageId: "reply-2", text: "ack" },
      });
      expect(
        findConversationTurnDeliveryByReplyTarget(scope, {
          conversationRef,
          replyToId: "prepared-2",
        }),
      ).toEqual(replied);
      expect(getConversationDeliveryOperation(scope, "operation-2")).toEqual(replied);
      // Late queue/sent callbacks cannot regress a completed correlated reply.
      expect(markConversationDeliveryQueued(scope, "operation-2", "queue-late")).toEqual(replied);
      expect(
        markConversationDeliverySent(scope, "operation-2", {
          messageId: "platform-late",
          source: "receipt",
        }),
      ).toEqual(replied);
    });
  });

  it("does not expose inbound reply evidence as a durable platform receipt", async () => {
    await withConversationStore(async ({ scope, conversationRef }) => {
      beginConversationDeliveryOperation(scope, {
        operationId: "operation-inbound-evidence",
        operationKind: "turn",
        conversationRef,
        message: "hello",
        preparedMessageId: "prepared-inbound-evidence",
      });
      markConversationDeliverySent(scope, "operation-inbound-evidence", {
        messageId: "inbound-reply-target",
        source: "inbound-reply",
      });

      await expect(
        completeDurableDelivery(
          {
            kind: "conversation",
            agentId: scope.agentId,
            operationId: "operation-inbound-evidence",
            storePath: scope.storePath,
          },
          { channel: "reef", messageId: "bare-result-id" },
        ),
      ).resolves.toEqual({ state: "delivered" });
    });
  });

  it("does not revive an operation after an unqueued outcome became unknown", async () => {
    await withConversationStore(({ scope, conversationRef }) => {
      beginConversationDeliveryOperation(scope, {
        operationId: "operation-3",
        operationKind: "send",
        conversationRef,
        message: "hello",
      });
      const unknown = markConversationDeliveryUnknown(scope, "operation-3");

      expect(unknown.status).toBe("unknown");
      expect(markConversationDeliveryQueued(scope, "operation-3", "queue-late")).toEqual(unknown);
      expect(
        markConversationDeliverySent(scope, "operation-3", {
          messageId: "platform-late",
          source: "receipt",
        }),
      ).toEqual(unknown);
    });
  });

  it("persists a permanent rejection and never revives its delivery", async () => {
    await withConversationStore(({ scope, conversationRef }) => {
      beginConversationDeliveryOperation(scope, {
        operationId: "operation-rejected",
        operationKind: "send",
        conversationRef,
        message: "hello",
      });
      markConversationDeliveryQueued(scope, "operation-rejected", "queue-rejected");

      const rejected = markConversationDeliveryRejected(
        scope,
        "operation-rejected",
        "atomic message limit",
      );

      expect(rejected).toMatchObject({
        status: "rejected",
        queueId: "queue-rejected",
        rejectionError: "atomic message limit",
      });
      expect(
        markConversationDeliverySent(scope, "operation-rejected", {
          messageId: "platform-late",
          source: "receipt",
        }),
      ).toEqual(rejected);
    });
  });

  it("retains terminal delivery evidence after its local session binding is pruned", async () => {
    await withConversationStore(async ({ scope, conversationRef }) => {
      beginConversationDeliveryOperation(scope, {
        operationId: "operation-pruned-session",
        operationKind: "send",
        conversationRef,
        message: "hello",
      });
      markConversationDeliverySent(scope, "operation-pruned-session", {
        messageId: "platform-pruned",
        source: "receipt",
      });

      await deleteSessionEntryLifecycle({
        agentId: scope.agentId,
        archiveTranscript: false,
        storePath: scope.storePath,
        target: {
          canonicalKey: "agent:main:reef:direct:peer-agent",
          storeKeys: ["agent:main:reef:direct:peer-agent"],
        },
      });

      expect(resolveConversation(scope, conversationRef)).toMatchObject({
        conversationRef,
        channel: "reef",
      });
      expect(resolveConversation(scope, conversationRef)?.sessionId).toBeUndefined();
      expect(getConversationDeliveryOperation(scope, "operation-pruned-session")).toMatchObject({
        channel: "reef",
        conversationRef,
        platformMessageId: "platform-pruned",
        status: "sent",
      });
    });
  });

  it("makes a dead-lettered queued operation terminal", async () => {
    await withConversationStore(({ scope, conversationRef }) => {
      beginConversationDeliveryOperation(scope, {
        operationId: "operation-4",
        operationKind: "send",
        conversationRef,
        message: "hello",
      });
      markConversationDeliveryQueued(scope, "operation-4", "queue-4");

      const unknown = markConversationDeliveryUnknown(scope, "operation-4");

      expect(unknown).toMatchObject({ status: "unknown", queueId: "queue-4" });
      expect(
        markConversationDeliverySent(scope, "operation-4", {
          messageId: "platform-late",
          source: "receipt",
        }),
      ).toEqual(unknown);
    });
  });
});
