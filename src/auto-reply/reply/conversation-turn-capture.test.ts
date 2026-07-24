import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import {
  beginConversationDeliveryOperation,
  getConversationDeliveryOperation,
  markConversationDeliveryQueued,
  markConversationDeliverySent,
} from "../../config/sessions/conversation-delivery-store.js";
import * as sessionAccessor from "../../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { buildConversationRef } from "../../routing/conversation-ref.js";
import { registerPendingConversationTurn } from "../../sessions/conversation-turns.js";
import { closeOpenClawAgentDatabasesForTest } from "../../state/openclaw-agent-db.js";
import { normalizeSessionDeliveryState } from "../../utils/delivery-context.shared.js";
import type { FinalizedRuntimeMsgContext } from "../templating.js";
import { capturePendingConversationTurnReply } from "./conversation-turn-capture.js";

afterEach(() => {
  vi.restoreAllMocks();
  closeOpenClawAgentDatabasesForTest();
});
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

async function setupReefConversation() {
  const stateDir = tempDirs.make("openclaw-conversation-capture-");
  const storePath = path.join(stateDir, "sessions.json");
  const sessionKey = "agent:main:reef:direct:peer-agent";
  const sessionId = "reef-session";
  const cfg = { session: { store: storePath } } as OpenClawConfig;
  await sessionAccessor.upsertSessionEntry(
    { agentId: "main", sessionKey, storePath },
    {
      sessionId,
      updatedAt: 100,
      chatType: "direct",
      delivery: normalizeSessionDeliveryState({
        context: { channel: "reef", accountId: "default", to: "reef:peer-agent" },
        origin: {
          provider: "reef",
          accountId: "default",
          nativeDirectUserId: "peer-agent",
        },
      }),
    },
  );
  return {
    cfg,
    scope: { agentId: "main", storePath },
    sessionKey,
    sessionId,
    storePath,
    conversationRef: buildConversationRef({
      channel: "reef",
      accountId: "default",
      kind: "direct",
      peerId: "peer-agent",
    }),
  };
}

function persistSentOperation(params: {
  scope: { agentId: string; storePath: string };
  operationId: string;
  conversationRef: string;
  outboundMessageId: string;
}) {
  beginConversationDeliveryOperation(params.scope, {
    operationId: params.operationId,
    operationKind: "turn",
    conversationRef: params.conversationRef,
    message: "outbound",
    preparedMessageId: params.outboundMessageId,
  });
  markConversationDeliveryQueued(params.scope, params.operationId, `queue-${params.operationId}`);
  markConversationDeliverySent(params.scope, params.operationId, params.outboundMessageId);
}

describe("conversation turn capture", () => {
  it("fails closed without channel ingress admission proof", async () => {
    const pending = registerPendingConversationTurn({
      agentId: "main",
      id: "turn-untrusted",
      conversationRef: "conv_0123456789abcdef0123456789abcdef",
      sessionId: "session-main",
      timeoutMs: 5_000,
    });
    pending.setOutboundMessageId("outbound-untrusted");
    pending.markReady();

    await expect(
      capturePendingConversationTurnReply({
        cfg: {} as OpenClawConfig,
        ctx: {
          SessionKey: "agent:main:reef:direct:untrusted",
          ChatType: "direct",
          Provider: "reef",
          ReplyToIdFull: "outbound-untrusted",
          RawBody: "untrusted reply",
          commandText: "untrusted reply",
          agentText: "untrusted reply",
          rawText: "untrusted reply",
        } as FinalizedRuntimeMsgContext,
      }),
    ).resolves.toBe(false);
    pending.cancel();
  });

  it("consumes a correlated reply inline and persists only a side artifact", async () => {
    const setup = await setupReefConversation();
    const operationId = "turn-full-id";
    persistSentOperation({
      scope: setup.scope,
      operationId,
      conversationRef: setup.conversationRef,
      outboundMessageId: "reef-outbound-full",
    });
    const pending = registerPendingConversationTurn({
      agentId: "main",
      id: operationId,
      conversationRef: setup.conversationRef,
      sessionId: setup.sessionId,
      timeoutMs: 5_000,
    });
    pending.setOutboundMessageId("reef-outbound-full");
    pending.markReady();

    const inboundContext = {
      AgentId: "main",
      SessionKey: setup.sessionKey,
      ChatType: "direct",
      Provider: "reef",
      InboundAccessAuthorized: true,
      OriginatingChannel: "reef",
      OriginatingTo: "reef:peer-agent",
      NativeDirectUserId: "peer-agent",
      MessageSid: "reef-inbound-short",
      MessageSidFull: "reef-inbound-full",
      ReplyToId: "wrong-short-id",
      ReplyToIdFull: "reef-outbound-full",
      RawBody: "peer acknowledged",
      BodyForAgent: "trusted provenance\n\n<reef-message>peer acknowledged</reef-message>",
      commandText: "peer acknowledged",
      agentText: "trusted provenance\n\n<reef-message>peer acknowledged</reef-message>",
      rawText: "peer acknowledged",
      Timestamp: 1_710_000_000,
    } as FinalizedRuntimeMsgContext;
    await expect(
      capturePendingConversationTurnReply({ cfg: setup.cfg, ctx: inboundContext }),
    ).resolves.toBe(true);

    await expect(pending.wait()).resolves.toMatchObject({
      conversationRef: setup.conversationRef,
      messageId: "reef-inbound-full",
      replyToId: "reef-outbound-full",
      text: "trusted provenance\n\n<reef-message>peer acknowledged</reef-message>",
      timestamp: 1_710_000_000_000,
      transcriptArtifactId: `conversation-turn-reply-${operationId}`,
    });
    expect(getConversationDeliveryOperation(setup.scope, operationId)).toMatchObject({
      status: "replied",
      reply: {
        messageId: "reef-inbound-full",
        replyToId: "reef-outbound-full",
        text: "trusted provenance\n\n<reef-message>peer acknowledged</reef-message>",
      },
    });
    const events = await sessionAccessor.loadTranscriptEvents({
      agentId: "main",
      sessionId: setup.sessionId,
      storePath: setup.storePath,
    });
    expect(events.filter((event) => "message" in (event as Record<string, unknown>))).toEqual([]);
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "custom",
        customType: "openclaw.conversation-turn-reply",
        appendMode: "side",
        data: expect.objectContaining({
          turnId: operationId,
          conversationRef: setup.conversationRef,
          messageId: "reef-inbound-full",
          message: expect.objectContaining({
            role: "user",
            content: "trusted provenance\n\n<reef-message>peer acknowledged</reef-message>",
          }),
        }),
      }),
    );
    await expect(
      capturePendingConversationTurnReply({ cfg: setup.cfg, ctx: inboundContext }),
    ).resolves.toBe(true);
    await expect(
      capturePendingConversationTurnReply({
        cfg: setup.cfg,
        ctx: {
          ...inboundContext,
          MessageSidFull: "reef-inbound-distinct",
          RawBody: "new ordinary message",
          BodyForAgent: "new ordinary message",
          commandText: "new ordinary message",
          agentText: "new ordinary message",
          rawText: "new ordinary message",
        } as FinalizedRuntimeMsgContext,
      }),
    ).resolves.toBe(false);
    expect(
      await sessionAccessor.loadTranscriptEvents({
        agentId: "main",
        sessionId: setup.sessionId,
        storePath: setup.storePath,
      }),
    ).toHaveLength(1);
  });

  it("redacts the durable reply and its audit artifact before persistence", async () => {
    const setup = await setupReefConversation();
    const operationId = "turn-redacted";
    const outboundMessageId = "reef-outbound-redacted";
    const redactedValue = "sensitive-reply-value";
    const replyText = `trusted provenance\n\n<reef-message>secret ${redactedValue}</reef-message>`;
    persistSentOperation({
      scope: setup.scope,
      operationId,
      conversationRef: setup.conversationRef,
      outboundMessageId,
    });
    const pending = registerPendingConversationTurn({
      agentId: "main",
      id: operationId,
      conversationRef: setup.conversationRef,
      sessionId: setup.sessionId,
      timeoutMs: 5_000,
    });
    pending.setOutboundMessageId(outboundMessageId);
    pending.markReady();

    await expect(
      capturePendingConversationTurnReply({
        cfg: {
          ...setup.cfg,
          logging: {
            redactPatterns: ["sensitive-reply-[a-z]+"],
          },
        },
        ctx: {
          AgentId: "main",
          SessionKey: setup.sessionKey,
          ChatType: "direct",
          Provider: "reef",
          InboundAccessAuthorized: true,
          OriginatingChannel: "reef",
          OriginatingTo: "reef:peer-agent",
          NativeDirectUserId: "peer-agent",
          MessageSidFull: "reef-inbound-redacted",
          ReplyToIdFull: outboundMessageId,
          RawBody: `secret ${redactedValue}`,
          BodyForAgent: replyText,
          commandText: `secret ${redactedValue}`,
          agentText: replyText,
          rawText: `secret ${redactedValue}`,
        } as FinalizedRuntimeMsgContext,
      }),
    ).resolves.toBe(true);
    await expect(pending.wait()).resolves.toMatchObject({ text: replyText });

    const operation = getConversationDeliveryOperation(setup.scope, operationId);
    expect(operation?.reply?.text).toBeTruthy();
    expect(operation?.reply?.text).not.toContain(redactedValue);
    const events = await sessionAccessor.loadTranscriptEvents({
      agentId: "main",
      sessionId: setup.sessionId,
      storePath: setup.storePath,
    });
    expect(JSON.stringify(events)).not.toContain(redactedValue);
  });

  it("completes the durable reply when optional audit persistence throws", async () => {
    const setup = await setupReefConversation();
    const operationId = "turn-audit-failure";
    const outboundMessageId = "reef-outbound-audit-failure";
    persistSentOperation({
      scope: setup.scope,
      operationId,
      conversationRef: setup.conversationRef,
      outboundMessageId,
    });
    const pending = registerPendingConversationTurn({
      agentId: "main",
      id: operationId,
      conversationRef: setup.conversationRef,
      sessionId: setup.sessionId,
      timeoutMs: 5_000,
    });
    pending.setOutboundMessageId(outboundMessageId);
    pending.markReady();
    vi.spyOn(sessionAccessor, "appendTranscriptEventSync").mockImplementationOnce(() => {
      throw new Error("audit store unavailable");
    });

    await expect(
      capturePendingConversationTurnReply({
        cfg: setup.cfg,
        ctx: {
          AgentId: "main",
          SessionKey: setup.sessionKey,
          ChatType: "direct",
          Provider: "reef",
          InboundAccessAuthorized: true,
          OriginatingChannel: "reef",
          OriginatingTo: "reef:peer-agent",
          NativeDirectUserId: "peer-agent",
          MessageSidFull: "reef-inbound-audit-failure",
          ReplyToIdFull: outboundMessageId,
          RawBody: "reply survives audit failure",
          BodyForAgent: "reply survives audit failure",
          commandText: "reply survives audit failure",
          agentText: "reply survives audit failure",
          rawText: "reply survives audit failure",
        } as FinalizedRuntimeMsgContext,
      }),
    ).resolves.toBe(true);
    await expect(pending.wait()).resolves.toEqual(
      expect.objectContaining({ text: "reply survives audit failure" }),
    );
    expect(getConversationDeliveryOperation(setup.scope, operationId)).toMatchObject({
      status: "replied",
      reply: { text: "reply survives audit failure" },
    });
  });

  it("does not make an ordinary post-restart reply replayable inline", async () => {
    const setup = await setupReefConversation();
    const operationId = "turn-after-restart";
    beginConversationDeliveryOperation(setup.scope, {
      operationId,
      operationKind: "turn",
      conversationRef: setup.conversationRef,
      message: "outbound",
      preparedMessageId: "reef-outbound-restart",
    });
    markConversationDeliveryQueued(setup.scope, operationId, `queue-${operationId}`);

    await expect(
      capturePendingConversationTurnReply({
        cfg: setup.cfg,
        ctx: {
          AgentId: "main",
          SessionKey: setup.sessionKey,
          ChatType: "direct",
          Provider: "reef",
          InboundAccessAuthorized: true,
          OriginatingChannel: "reef",
          OriginatingTo: "reef:peer-agent",
          NativeDirectUserId: "peer-agent",
          MessageSidFull: "reef-inbound-restart",
          ReplyToIdFull: "reef-outbound-restart",
          RawBody: "reply after restart",
          BodyForAgent: "reply after restart",
          commandText: "reply after restart",
          agentText: "reply after restart",
          rawText: "reply after restart",
        } as FinalizedRuntimeMsgContext,
      }),
    ).resolves.toBe(false);

    expect(getConversationDeliveryOperation(setup.scope, operationId)).toMatchObject({
      status: "sent",
      platformMessageId: "reef-outbound-restart",
    });
    expect(getConversationDeliveryOperation(setup.scope, operationId)?.reply).toBeUndefined();
    expect(
      await sessionAccessor.loadTranscriptEvents({
        agentId: "main",
        sessionId: setup.sessionId,
        storePath: setup.storePath,
      }),
    ).toEqual([]);
  });

  it("leaves replies to plain sends for ordinary inbound dispatch", async () => {
    const setup = await setupReefConversation();
    const operationId = "send-before-reply";
    beginConversationDeliveryOperation(setup.scope, {
      operationId,
      operationKind: "send",
      conversationRef: setup.conversationRef,
      message: "one-way outbound",
      preparedMessageId: "reef-outbound-send",
    });
    markConversationDeliveryQueued(setup.scope, operationId, `queue-${operationId}`);

    await expect(
      capturePendingConversationTurnReply({
        cfg: setup.cfg,
        ctx: {
          AgentId: "main",
          SessionKey: setup.sessionKey,
          ChatType: "direct",
          Provider: "reef",
          InboundAccessAuthorized: true,
          OriginatingChannel: "reef",
          OriginatingTo: "reef:peer-agent",
          NativeDirectUserId: "peer-agent",
          MessageSidFull: "reef-inbound-send-reply",
          ReplyToIdFull: "reef-outbound-send",
          RawBody: "ordinary reply",
          BodyForAgent: "ordinary reply",
          commandText: "ordinary reply",
          agentText: "ordinary reply",
          rawText: "ordinary reply",
        } as FinalizedRuntimeMsgContext,
      }),
    ).resolves.toBe(false);
    expect(getConversationDeliveryOperation(setup.scope, operationId)).toMatchObject({
      operationKind: "send",
      status: "queued",
    });
  });

  it("consumes duplicate replies that promoted an unthreaded message into a thread", async () => {
    const setup = await setupReefConversation();
    const operationId = "turn-promoted-thread";
    const outboundMessageId = "reef-promoted-root";
    persistSentOperation({
      scope: setup.scope,
      operationId,
      conversationRef: setup.conversationRef,
      outboundMessageId,
    });
    const pending = registerPendingConversationTurn({
      agentId: "main",
      id: operationId,
      conversationRef: setup.conversationRef,
      sessionId: setup.sessionId,
      timeoutMs: 5_000,
    });
    pending.setOutboundMessageId(outboundMessageId);
    pending.markReady();
    const inboundContext = {
      AgentId: "main",
      SessionKey: setup.sessionKey,
      ChatType: "direct",
      Provider: "reef",
      InboundAccessAuthorized: true,
      OriginatingChannel: "reef",
      OriginatingTo: "reef:peer-agent",
      NativeDirectUserId: "peer-agent",
      MessageThreadId: outboundMessageId,
      MessageSidFull: "reef-promoted-reply",
      ReplyToIdFull: outboundMessageId,
      RawBody: "thread-promoted reply",
      BodyForAgent: "thread-promoted reply",
      commandText: "thread-promoted reply",
      agentText: "thread-promoted reply",
      rawText: "thread-promoted reply",
    } as FinalizedRuntimeMsgContext;

    await expect(
      capturePendingConversationTurnReply({ cfg: setup.cfg, ctx: inboundContext }),
    ).resolves.toBe(true);
    await expect(pending.wait()).resolves.toMatchObject({
      messageId: "reef-promoted-reply",
      replyToId: outboundMessageId,
      threadId: outboundMessageId,
    });
    await expect(
      capturePendingConversationTurnReply({ cfg: setup.cfg, ctx: inboundContext }),
    ).resolves.toBe(true);
  });

  it("captures a threaded reply only for the exact conversation and message", async () => {
    const stateDir = tempDirs.make("openclaw-conversation-capture-");
    const storePath = path.join(stateDir, "sessions.json");
    const scope = { agentId: "main", storePath };
    const sessionKey = "agent:main:discord:channel:ops-room:thread:user-context";
    const sessionId = "discord-thread-session";
    const cfg = { session: { store: storePath } } as OpenClawConfig;
    await sessionAccessor.upsertSessionEntry(
      { ...scope, sessionKey },
      {
        sessionId,
        updatedAt: 100,
        chatType: "channel",
        groupId: "ops-room",
        delivery: normalizeSessionDeliveryState({
          context: {
            channel: "discord",
            accountId: "default",
            to: "channel:ops-room",
            threadId: "user-context",
          },
          origin: { provider: "discord", accountId: "default", nativeChannelId: "ops-room" },
        }),
      },
    );
    const conversationRef = buildConversationRef({
      channel: "discord",
      accountId: "default",
      kind: "channel",
      peerId: "ops-room",
      threadId: "user-context",
    });
    persistSentOperation({
      scope,
      operationId: "turn-thread",
      conversationRef,
      outboundMessageId: "discord-outbound-full",
    });
    const pending = registerPendingConversationTurn({
      agentId: "main",
      id: "turn-thread",
      conversationRef,
      sessionId,
      threadId: "user-context",
      timeoutMs: 5_000,
    });
    pending.setOutboundMessageId("discord-outbound-full");
    pending.markReady();

    await expect(
      capturePendingConversationTurnReply({
        cfg,
        ctx: {
          AgentId: "main",
          SessionKey: sessionKey,
          ChatType: "channel",
          Provider: "discord",
          InboundAccessAuthorized: true,
          From: "discord:channel:ops-room",
          To: "channel:ops-room",
          OriginatingChannel: "discord",
          OriginatingTo: "channel:ops-room",
          NativeChannelId: "ops-room",
          MessageThreadId: "user-context",
          MessageSidFull: "discord-inbound-full",
          ReplyToIdFull: "discord-outbound-full",
          SenderId: "member-1",
          RawBody: "channel ack",
          BodyForAgent: "channel ack",
          commandText: "channel ack",
          agentText: "channel ack",
          rawText: "channel ack",
        } as FinalizedRuntimeMsgContext,
      }),
    ).resolves.toBe(true);
    await expect(pending.wait()).resolves.toMatchObject({
      conversationRef,
      threadId: "user-context",
      text: "channel ack",
    });
  });

  it("falls through without claiming when the inbound session cannot be resolved", async () => {
    const stateDir = tempDirs.make("openclaw-conversation-capture-");
    const pending = registerPendingConversationTurn({
      agentId: "main",
      id: "turn-missing",
      conversationRef: buildConversationRef({
        channel: "reef",
        accountId: "default",
        kind: "direct",
        peerId: "missing",
      }),
      sessionId: "session-main",
      timeoutMs: 5_000,
    });
    pending.setOutboundMessageId("outbound-missing");
    pending.markReady();

    await expect(
      capturePendingConversationTurnReply({
        cfg: { session: { store: path.join(stateDir, "sessions.json") } } as OpenClawConfig,
        ctx: {
          SessionKey: "agent:main:reef:direct:missing",
          ChatType: "direct",
          Provider: "reef",
          InboundAccessAuthorized: true,
          OriginatingChannel: "reef",
          OriginatingTo: "reef:missing",
          NativeDirectUserId: "missing",
          MessageSidFull: "inbound-missing",
          ReplyToIdFull: "outbound-missing",
          RawBody: "fall through",
          BodyForAgent: "fall through",
          commandText: "fall through",
          agentText: "fall through",
          rawText: "fall through",
        } as FinalizedRuntimeMsgContext,
      }),
    ).resolves.toBe(false);
    pending.cancel();
  });
});
