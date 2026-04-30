import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WhatsAppSendResult } from "../../inbound/send-result.js";

// Hoisted mocks used across tests so vi.mock factories can reference them.
const { resolvePolicyMock, buildContextMock, runMessageReceivedMock, trackBackgroundTaskMock } =
  vi.hoisted(() => ({
    resolvePolicyMock: vi.fn(),
    buildContextMock: vi.fn(),
    runMessageReceivedMock: vi.fn(async () => undefined),
    trackBackgroundTaskMock: vi.fn(),
  }));

function acceptedSendResult(kind: "media" | "text", id: string): WhatsAppSendResult {
  return {
    kind,
    messageId: id,
    messageIds: [id],
    keys: [{ id }],
    providerAccepted: true,
  };
}

vi.mock("../../inbound-policy.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../inbound-policy.js")>();
  return {
    ...actual,
    resolveWhatsAppCommandAuthorized: async () => true,
    resolveWhatsAppInboundPolicy: resolvePolicyMock,
  };
});

vi.mock("./inbound-dispatch.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./inbound-dispatch.js")>();
  return {
    ...actual,
    buildWhatsAppInboundContext: buildContextMock,
    dispatchWhatsAppBufferedReply: async () => ({
      queuedFinal: false,
      counts: { tool: 0, block: 0, final: 0 },
    }),
    resolveWhatsAppDmRouteTarget: () => null,
    resolveWhatsAppResponsePrefix: () => undefined,
    updateWhatsAppMainLastRoute: () => {},
  };
});

vi.mock("openclaw/plugin-sdk/plugin-runtime", () => ({
  getGlobalHookRunner: () => ({
    hasHooks: (hookName: string) => hookName === "message_received",
    runMessageReceived: runMessageReceivedMock,
  }),
}));

vi.mock("../../identity.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../identity.js")>();
  return {
    ...actual,
    getPrimaryIdentityId: () => null,
    getSelfIdentity: () => ({ e164: "+15550001111" }),
    getSenderIdentity: () => ({ name: "Alice", e164: "+15550002222" }),
  };
});

vi.mock("../../reconnect.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../reconnect.js")>();
  return { ...actual, newConnectionId: () => "test-conn-id" };
});

vi.mock("../../session.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../session.js")>();
  return { ...actual, formatError: (e: unknown) => String(e) };
});

vi.mock("../deliver-reply.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../deliver-reply.js")>();
  return { ...actual, deliverWebReply: async () => {} };
});

vi.mock("../loggers.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../loggers.js")>();
  return {
    ...actual,
    whatsappInboundLog: { info: () => {}, debug: () => {} },
  };
});

vi.mock("./ack-reaction.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./ack-reaction.js")>();
  return { ...actual, maybeSendAckReaction: async () => {} };
});

vi.mock("./inbound-context.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./inbound-context.js")>();
  return {
    ...actual,
    resolveVisibleWhatsAppGroupHistory: () => [],
    resolveVisibleWhatsAppReplyContext: () => null,
  };
});

vi.mock("./last-route.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./last-route.js")>();
  return {
    ...actual,
    trackBackgroundTask: trackBackgroundTaskMock,
    updateLastRouteInBackground: () => {},
  };
});

vi.mock("./message-line.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./message-line.js")>();
  return { ...actual, buildInboundLine: () => "hi" };
});

vi.mock("./runtime-api.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./runtime-api.js")>();
  return {
    ...actual,
    buildHistoryContextFromEntries: () => "hi",
    createChannelReplyPipeline: () => ({ onModelSelected: () => {}, responsePrefix: undefined }),
    formatInboundEnvelope: () => "hi",
    logVerbose: () => {},
    normalizeE164: (v: string) => v,
    recordSessionMetaFromInbound: async () => {},
    resolveChannelContextVisibilityMode: () => "off",
    resolveInboundSessionEnvelopeContext: () => ({
      storePath: "/tmp",
      envelopeOptions: {},
      previousTimestamp: undefined,
    }),
    resolvePinnedMainDmOwnerFromAllowlist: () => null,
    shouldComputeCommandAuthorized: () => false,
    shouldLogVerbose: () => false,
  };
});

import { clearInternalHooks, registerInternalHook } from "openclaw/plugin-sdk/hook-runtime";
import { processMessage } from "./process-message.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeAccount(groups: Record<string, { systemPrompt?: string }> = {}): {
  accountId: string;
  authDir: string;
  groups: Record<string, { systemPrompt?: string }>;
} {
  return { accountId: "default", authDir: "/tmp/wa-test-auth", groups };
}

function makePolicy(account: ReturnType<typeof makeAccount>) {
  return {
    account,
    dmPolicy: "pairing",
    groupPolicy: "allowlist",
    configuredAllowFrom: [],
    dmAllowFrom: [],
    groupAllowFrom: [],
    isSelfChat: false,
    providerMissingFallbackApplied: false,
    shouldReadStorePairingApprovals: true,
    isSamePhone: () => false,
    isDmSenderAllowed: () => false,
    isGroupSenderAllowed: () => false,
    resolveConversationGroupPolicy: () => "allowlist",
    resolveConversationRequireMention: () => false,
  };
}

const GROUP_JID = "123@g.us";

const baseMsg = {
  id: "msg1",
  from: GROUP_JID,
  to: "+15550001111",
  conversationId: GROUP_JID,
  accountId: "default",
  chatId: GROUP_JID,
  chatType: "group" as const,
  body: "hi",
  sendComposing: async () => {},
  reply: async () => acceptedSendResult("text", "r1"),
  sendMedia: async () => acceptedSendResult("media", "m1"),
};

const baseRoute = {
  agentId: "main",
  channel: "whatsapp",
  accountId: "default",
  sessionKey: "agent:main:whatsapp:group:123@g.us",
  mainSessionKey: "agent:main:whatsapp:group:123@g.us",
  lastRoutePolicy: "main",
  matchedBy: "default",
};

function callProcessMessage(overrides: { cfg?: unknown } = {}) {
  return processMessage({
    cfg: (overrides.cfg ?? {}) as never,
    msg: baseMsg as never,
    route: baseRoute as never,
    groupHistoryKey: "whatsapp:default:group:123@g.us",
    groupHistories: new Map(),
    groupMemberNames: new Map(),
    connectionId: "conn-1",
    verbose: false,
    maxMediaBytes: 1024,
    replyResolver: (async () => undefined) as never,
    replyLogger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } as never,
    backgroundTasks: new Set(),
    rememberSentText: () => {},
    echoHas: () => false,
    echoForget: () => {},
    buildCombinedEchoKey: ({ sessionKey }) => sessionKey,
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("processMessage group system prompt wiring", () => {
  beforeEach(() => {
    buildContextMock.mockReset();
    resolvePolicyMock.mockReset();
    runMessageReceivedMock.mockClear();
    trackBackgroundTaskMock.mockClear();
    clearInternalHooks();
    buildContextMock.mockImplementation(
      (params: { groupSystemPrompt?: string; combinedBody?: string }) => ({
        GroupSystemPrompt: params.groupSystemPrompt,
        Body: params.combinedBody ?? "",
      }),
    );
  });

  afterEach(() => {
    clearInternalHooks();
  });

  it("resolves group systemPrompt from account config and passes it into buildWhatsAppInboundContext", async () => {
    resolvePolicyMock.mockReturnValue(
      makePolicy(makeAccount({ [GROUP_JID]: { systemPrompt: "from config" } })),
    );

    await callProcessMessage();

    expect(buildContextMock.mock.calls[0][0].groupSystemPrompt).toBe("from config");
  });

  it("fires message_received hooks with canonical WhatsApp correlation fields", async () => {
    const internalReceived = vi.fn();
    registerInternalHook("message:received", internalReceived);
    resolvePolicyMock.mockReturnValue(makePolicy(makeAccount()));
    buildContextMock.mockImplementationOnce(() => ({
      Body: "hi",
      BodyForCommands: "hi",
      RawBody: "hi",
      CommandBody: "hi",
      From: GROUP_JID,
      To: "+15550001111",
      SessionKey: baseRoute.sessionKey,
      AccountId: "default",
      MessageSid: "msg1",
      SenderId: "+15550002222",
      SenderName: "Alice",
      SenderE164: "+15550002222",
      Timestamp: 1710000000,
      Provider: "whatsapp",
      Surface: "whatsapp",
      OriginatingChannel: "whatsapp",
      OriginatingTo: GROUP_JID,
      GroupSubject: "Test Group",
    }));

    await callProcessMessage({
      cfg: {
        channels: {
          whatsapp: {
            pluginHooks: {
              messageReceived: true,
            },
          },
        },
      },
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(runMessageReceivedMock).toHaveBeenCalledTimes(1);
    expect(runMessageReceivedMock).toHaveBeenCalledWith(
      expect.objectContaining({
        from: GROUP_JID,
        content: "hi",
        timestamp: 1710000000,
        messageId: "msg1",
        senderId: "+15550002222",
        sessionKey: baseRoute.sessionKey,
      }),
      expect.objectContaining({
        channelId: "whatsapp",
        accountId: "default",
        conversationId: GROUP_JID,
        sessionKey: baseRoute.sessionKey,
        messageId: "msg1",
        senderId: "+15550002222",
      }),
    );
    expect(internalReceived).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "message",
        action: "received",
        sessionKey: baseRoute.sessionKey,
        context: expect.objectContaining({
          from: GROUP_JID,
          content: "hi",
          timestamp: 1710000000,
          channelId: "whatsapp",
          accountId: "default",
          conversationId: GROUP_JID,
          messageId: "msg1",
        }),
      }),
    );
  });

  it("does not fire WhatsApp message_received hooks without explicit opt-in", async () => {
    const internalReceived = vi.fn();
    registerInternalHook("message:received", internalReceived);
    resolvePolicyMock.mockReturnValue(makePolicy(makeAccount()));

    await callProcessMessage();

    expect(runMessageReceivedMock).not.toHaveBeenCalled();
    expect(internalReceived).not.toHaveBeenCalled();
  });

  it("tracks session metadata writes as connection background tasks", async () => {
    resolvePolicyMock.mockReturnValue(makePolicy(makeAccount()));
    buildContextMock.mockImplementationOnce(() => ({
      Body: "hi",
      RawBody: "hi",
      CommandBody: "hi",
      SessionKey: baseRoute.sessionKey,
      Provider: "whatsapp",
      Surface: "whatsapp",
    }));

    await callProcessMessage();

    expect(trackBackgroundTaskMock).toHaveBeenCalledTimes(1);
    expect(trackBackgroundTaskMock.mock.calls[0]?.[0]).toBeInstanceOf(Set);
    expect(trackBackgroundTaskMock.mock.calls[0]?.[1]).toBeInstanceOf(Promise);
  });
});
