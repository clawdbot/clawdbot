import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import type { OpenClawConfig } from "../../config/config.js";
import { buildConversationIdentity } from "../../config/sessions/conversation-identity.js";
import {
  listConversations,
  registerConversationAddresses,
  resolveConversation,
} from "../../config/sessions/conversation-registry.js";
import {
  loadExactSessionEntry,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import { closeOpenClawAgentDatabasesForTest } from "../../state/openclaw-agent-db.js";
import {
  deliveryContextFromSession,
  normalizeSessionDeliveryState,
  sessionDeliveryOrigin,
} from "../../utils/delivery-context.shared.js";
import { bindOutboundSessionEntry } from "./outbound-session.js";

describe("outbound session persistence", () => {
  let storePath: string;

  const tempDirs = useAutoCleanupTempDirTracker(afterEach);

  beforeEach(() => {
    storePath = path.join(tempDirs.make("openclaw-outbound-session-"), "sessions.json");
  });

  afterEach(() => {
    closeOpenClawAgentDatabasesForTest();
  });

  it("binds a discovered canonical peer through a different delivery alias", async () => {
    const sessionKey = "agent:main:main";
    await upsertSessionEntryCore(
      { agentId: "main", sessionKey, storePath },
      {
        sessionId: "shared-main-session",
        updatedAt: 100,
        chatType: "direct",
        delivery: normalizeSessionDeliveryState({
          context: { channel: "discord", accountId: "default", to: "user:operator" },
          origin: { provider: "discord", accountId: "default", from: "discord:operator" },
        }),
      },
    );
    const identity = buildConversationIdentity({
      channel: "reef",
      accountId: "default",
      kind: "direct",
      peerId: "reef:peer-agent",
      deliveryTarget: "@molty",
      nativeDirectUserId: "peer-agent",
    });
    expect(identity).toBeDefined();
    registerConversationAddresses({ agentId: "main", storePath }, [identity!], 200);
    expect(
      resolveConversation({ agentId: "main", storePath }, identity!.conversationRef),
    ).not.toMatchObject({ sessionId: expect.any(String) });

    await bindOutboundSessionEntry({
      cfg: { session: { store: storePath } } as OpenClawConfig,
      channel: "reef",
      accountId: "default",
      route: {
        sessionKey,
        baseSessionKey: sessionKey,
        peer: { kind: "direct", id: "peer-agent" },
        chatType: "direct",
        from: "reef:peer-agent",
        to: "@molty",
      },
    });

    expect(
      resolveConversation({ agentId: "main", storePath }, identity!.conversationRef),
    ).toMatchObject({
      sessionId: "shared-main-session",
      sessionKey,
      role: "participant",
      target: "@molty",
    });
  });

  it("binds a newer threadless address without restoring the established thread", async () => {
    const sessionKey = "agent:main:main";
    const peerId = "reef:contact-42";
    const target = "reef:contact-42";
    const threadId = "thread-7";
    await upsertSessionEntryCore(
      { agentId: "main", sessionKey, storePath },
      {
        sessionId: "shared-main-session",
        updatedAt: 100,
        chatType: "direct",
        delivery: normalizeSessionDeliveryState({
          context: { channel: "reef", accountId: "default", to: target, threadId },
          origin: {
            provider: "reef",
            accountId: "default",
            chatType: "direct",
            from: peerId,
            to: target,
            threadId,
          },
        }),
      },
    );
    const threadlessIdentity = buildConversationIdentity({
      channel: "reef",
      accountId: "default",
      kind: "direct",
      peerId,
      deliveryTarget: target,
      nativeDirectUserId: "contact-42",
    });
    expect(threadlessIdentity).toBeDefined();
    const established = loadExactSessionEntry({ agentId: "main", sessionKey, storePath });
    expect(established).toBeDefined();
    registerConversationAddresses(
      { agentId: "main", storePath },
      [threadlessIdentity!],
      established!.entry.updatedAt + 1,
    );

    const discovered = listConversations({ agentId: "main", storePath }, { channel: "reef" });
    expect(discovered[0]?.conversationRef).toBe(threadlessIdentity!.conversationRef);
    expect(discovered[0]).not.toMatchObject({ sessionId: expect.any(String) });

    await bindOutboundSessionEntry({
      cfg: { session: { store: storePath } } as OpenClawConfig,
      channel: "reef",
      accountId: "default",
      route: {
        sessionKey,
        baseSessionKey: sessionKey,
        peer: { kind: "direct", id: "contact-42" },
        chatType: "direct",
        from: peerId,
        to: target,
      },
    });

    expect(
      resolveConversation({ agentId: "main", storePath }, threadlessIdentity!.conversationRef),
    ).toMatchObject({
      sessionId: "shared-main-session",
      sessionKey,
      role: "participant",
      target,
    });
    const persisted = loadExactSessionEntry({ agentId: "main", sessionKey, storePath });
    expect(deliveryContextFromSession(persisted?.entry)?.threadId).toBeUndefined();
    expect(sessionDeliveryOrigin(persisted?.entry)?.threadId).toBeUndefined();
  });

  it("creates the session row when a discovered peer has no local entry", async () => {
    const sessionKey = "agent:main:reef:direct:peer-agent";
    const identity = buildConversationIdentity({
      channel: "reef",
      accountId: "default",
      kind: "direct",
      peerId: "reef:peer-agent",
      deliveryTarget: "reef:peer-agent",
      nativeDirectUserId: "peer-agent",
    });
    expect(identity).toBeDefined();
    registerConversationAddresses({ agentId: "main", storePath }, [identity!], 200);
    expect(
      resolveConversation({ agentId: "main", storePath }, identity!.conversationRef),
    ).not.toMatchObject({ sessionId: expect.any(String) });

    await bindOutboundSessionEntry({
      cfg: { session: { store: storePath } } as OpenClawConfig,
      channel: "reef",
      accountId: "default",
      route: {
        sessionKey,
        baseSessionKey: sessionKey,
        peer: { kind: "direct", id: "peer-agent" },
        chatType: "direct",
        from: "reef:peer-agent",
        to: "reef:peer-agent",
      },
    });

    expect(
      resolveConversation({ agentId: "main", storePath }, identity!.conversationRef),
    ).toMatchObject({
      sessionId: expect.any(String),
      sessionKey,
      role: "primary",
      target: "reef:peer-agent",
    });
  });

  it("persists a group ingress origin without rewriting its native channel target", async () => {
    const channelId = "private-room-123";
    const sessionKey = `agent:main:reef:group:${channelId}`;
    const from = `reef:group:${channelId}`;
    const to = `channel:${channelId}`;
    const identity = buildConversationIdentity({
      channel: "reef",
      accountId: "default",
      kind: "group",
      peerId: from,
      deliveryTarget: to,
      nativeChannelId: channelId,
    });
    expect(identity).not.toBeNull();
    registerConversationAddresses({ agentId: "main", storePath }, [identity!], 200);

    await bindOutboundSessionEntry({
      cfg: { session: { store: storePath } } as OpenClawConfig,
      channel: "reef",
      accountId: "default",
      route: {
        sessionKey,
        baseSessionKey: sessionKey,
        peer: { kind: "group", id: channelId },
        chatType: "group",
        from,
        to,
      },
    });

    const persisted = loadExactSessionEntry({ agentId: "main", sessionKey, storePath });
    expect(sessionDeliveryOrigin(persisted?.entry)).toMatchObject({
      provider: "reef",
      accountId: "default",
      from,
    });
    expect(
      resolveConversation({ agentId: "main", storePath }, identity!.conversationRef),
    ).toMatchObject({
      kind: "group",
      nativeChannelId: channelId,
      sessionKey,
      target: to,
    });
  });
});
