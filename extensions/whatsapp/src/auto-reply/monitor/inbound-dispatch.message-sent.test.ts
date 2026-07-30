// WhatsApp tests prove native reply receipts reach the canonical sent-message observers.
import {
  dispatchChannelInboundReply,
  type ChannelInboundTurnPlan,
} from "openclaw/plugin-sdk/channel-inbound";
import {
  createMessageReceiptFromOutboundResults,
  type MessageReceiptSourceResult,
} from "openclaw/plugin-sdk/channel-outbound";
import {
  addTestHook,
  createEmptyPluginRegistry,
  initializeGlobalHookRunner,
  resetGlobalHookRunner,
  type PluginHookRegistration,
} from "openclaw/plugin-sdk/channel-test-helpers";
import { clearInternalHooks, registerInternalHook } from "openclaw/plugin-sdk/hook-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTestWebInboundMessage } from "../../inbound/test-message.test-helper.js";
import {
  buildWhatsAppInboundTransportContext,
  createWhatsAppReplyPlan,
} from "./inbound-dispatch.js";

const sessionKey = "agent:main:whatsapp:direct:+1000";
type InternalHookEvent = Parameters<Parameters<typeof registerInternalHook>[1]>[0];

function createReceipt(results: MessageReceiptSourceResult[]) {
  return createMessageReceiptFromOutboundResults({
    kind: "unknown",
    results,
  });
}

function createPlan(deliverReply: Parameters<typeof createWhatsAppReplyPlan>[0]["deliverReply"]) {
  const msg = createTestWebInboundMessage({
    event: { id: "wa-inbound-1" },
    payload: { body: "show me the result" },
    platform: {
      chatJid: "1000@s.whatsapp.net",
      recipientJid: "+2000",
      senderJid: "1000@s.whatsapp.net",
    },
    admission: {
      accountId: "default",
      conversation: { kind: "direct", id: "+1000" },
      sender: { id: "1000@s.whatsapp.net" },
    },
  });
  const context = {
    Body: "show me the result",
    BodyForAgent: "show me the result",
    RawBody: "show me the result",
    CommandBody: "show me the result",
    From: "+1000",
    To: "+2000",
    SessionKey: sessionKey,
    Provider: "whatsapp",
    Surface: "whatsapp",
    OriginatingChannel: "whatsapp",
    OriginatingTo: "+1000",
    AccountId: "default",
    ChatType: "direct",
    CommandAuthorized: false,
  };
  const plan = createWhatsAppReplyPlan({
    cfg: { channels: { whatsapp: {} } } as never,
    connectionId: "conn-1",
    context,
    deliverReply,
    groupHistories: new Map(),
    groupHistoryKey: sessionKey,
    maxMediaBytes: 1024,
    inbound: {
      channel: "whatsapp",
      event: { id: "wa-inbound-1" },
      from: "+1000",
      sender: { id: "1000@s.whatsapp.net" },
      conversation: { kind: "direct", id: "+1000" },
      route: {
        agentId: "main",
        accountId: "default",
        routeSessionKey: sessionKey,
      },
      reply: { to: "+2000", originatingTo: "+1000" },
      message: {
        body: "show me the result",
        bodyForAgent: "show me the result",
        rawBody: "show me the result",
        commandBody: "show me the result",
      },
    },
    rememberSentText: vi.fn(),
    replyLogger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    } as never,
    replyPipeline: {},
    replyResolver: (async () => undefined) as never,
    route: {
      agentId: "main",
      channel: "whatsapp",
      accountId: "default",
      sessionKey,
      mainSessionKey: sessionKey,
      lastRoutePolicy: "main",
      matchedBy: "default",
    },
    shouldClearGroupHistory: false,
    transport: buildWhatsAppInboundTransportContext(msg),
  });
  return { context, plan };
}

afterEach(() => {
  clearInternalHooks();
  resetGlobalHookRunner();
});

describe("WhatsApp canonical message_sent delivery", () => {
  it("emits one receipt-backed event with session and run correlation for multipart media", async () => {
    const pluginHook = vi.fn();
    const internalHook = vi.fn();
    const registry = createEmptyPluginRegistry();
    addTestHook({
      registry,
      pluginId: "whatsapp-message-sent-test",
      hookName: "message_sent",
      handler: pluginHook as PluginHookRegistration["handler"],
    });
    initializeGlobalHookRunner(registry);
    registerInternalHook("message:sent", internalHook);

    const receipt = createReceipt([
      { channel: "whatsapp", messageId: "wa-media-1" },
      { channel: "whatsapp", messageId: "wa-caption-2" },
    ]);
    const { context, plan } = createPlan(async () => ({
      results: [],
      receipt,
      providerAccepted: true,
    }));
    const dispatchReplyWithBufferedBlockDispatcher = vi.fn(async (params) => {
      params.replyOptions?.onAgentRunStart?.("run-wa-1");
      await params.dispatcherOptions.deliver(
        {
          text: "generated image",
          mediaUrls: ["/tmp/generated.jpg", "/tmp/details.pdf"],
        },
        { kind: "final" },
      );
      return { queuedFinal: true, counts: { tool: 0, block: 0, final: 1 } };
    });

    await dispatchChannelInboundReply({
      cfg: { channels: { whatsapp: {} } } as never,
      channel: "whatsapp",
      accountId: "default",
      agentId: "main",
      routeSessionKey: sessionKey,
      storePath: "/tmp/whatsapp-message-sent-test.json",
      ctxPayload: context,
      recordInboundSession: async () => undefined,
      dispatchReplyWithBufferedBlockDispatcher,
      dispatcherOptions: plan.dispatcherOptions,
      delivery: plan.delivery,
      replyOptions: plan.replyOptions,
      replyResolver: plan.replyResolver,
    });

    await vi.waitFor(() => {
      expect(pluginHook).toHaveBeenCalledOnce();
      expect(internalHook).toHaveBeenCalledOnce();
    });
    expect(pluginHook).toHaveBeenCalledWith(
      {
        to: "+1000",
        content: "generated image",
        success: true,
        messageId: "wa-media-1",
        sessionKey,
        runId: "run-wa-1",
      },
      {
        channelId: "whatsapp",
        accountId: "default",
        conversationId: "+1000",
        sessionKey,
        runId: "run-wa-1",
        messageId: "wa-media-1",
      },
    );
    const internalEvent = internalHook.mock.calls[0]?.[0] as InternalHookEvent;
    expect(internalEvent).toMatchObject({
      type: "message",
      action: "sent",
      sessionKey,
      context: {
        to: "+1000",
        content: "generated image",
        success: true,
        channelId: "whatsapp",
        accountId: "default",
        conversationId: "+1000",
        messageId: "wa-media-1",
      },
    });
  });

  it("keeps durable text on the core-owned path without native fallback", async () => {
    const deliverReply = vi.fn();
    const { plan } = createPlan(deliverReply);
    const delivery = plan.delivery as ChannelInboundTurnPlan["delivery"];

    expect(delivery.observeMessageSent).toBe(true);
    expect(
      typeof delivery.durable === "function"
        ? await delivery.durable({ text: "durable text" }, { kind: "final" })
        : delivery.durable,
    ).toMatchObject({ to: "+1000" });
    expect(deliverReply).not.toHaveBeenCalled();
  });
});
