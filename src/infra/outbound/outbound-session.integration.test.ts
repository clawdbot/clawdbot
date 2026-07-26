import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import type { OpenClawConfig } from "../../config/config.js";
import { buildConversationIdentity } from "../../config/sessions/conversation-identity.js";
import {
  registerConversationAddresses,
  resolveConversation,
} from "../../config/sessions/conversation-registry.js";
import { upsertSessionEntry } from "../../config/sessions/session-accessor.js";
import { closeOpenClawAgentDatabasesForTest } from "../../state/openclaw-agent-db.js";
import { normalizeSessionDeliveryState } from "../../utils/delivery-context.shared.js";
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
    await upsertSessionEntry(
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
});
