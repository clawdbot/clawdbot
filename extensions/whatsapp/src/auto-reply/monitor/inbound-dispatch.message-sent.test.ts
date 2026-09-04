// WhatsApp tests prove native reply receipts reach the canonical sent-message observers.
import type { WAMessage } from "baileys";
import {
  createChannelPartialDeliveryError,
  dispatchChannelInboundReply,
  isChannelPartialDeliveryError,
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
import { PlatformMessageNotDispatchedError } from "openclaw/plugin-sdk/error-runtime";
import { clearInternalHooks, registerInternalHook } from "openclaw/plugin-sdk/hook-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createWebSendApi } from "../../inbound/send-api.js";
import { normalizeWhatsAppSendResult } from "../../inbound/send-result.js";
import { createTestWebInboundMessage } from "../../inbound/test-message.test-helper.js";
import type { AdmittedWebInboundMessage } from "../../inbound/types.js";
import { loadWebMedia } from "../../media.js";
import { deliverWebReply } from "../deliver-reply.js";
import {
  buildWhatsAppInboundTransportContext,
  createWhatsAppReplyPlan,
} from "./inbound-dispatch.js";

const sessionKey = "agent:main:whatsapp:direct:+1000";
type InternalHookEvent = Parameters<Parameters<typeof registerInternalHook>[1]>[0];

const recordChannelActivity = vi.hoisted(() => vi.fn());

vi.mock("openclaw/plugin-sdk/channel-activity-runtime", async () => {
  const actual = await vi.importActual<
    typeof import("openclaw/plugin-sdk/channel-activity-runtime")
  >("openclaw/plugin-sdk/channel-activity-runtime");
  return {
    ...actual,
    recordChannelActivity: (...args: unknown[]) => recordChannelActivity(...args),
  };
});

vi.mock("../../media.js", () => ({ loadWebMedia: vi.fn() }));

function createReceipt(results: MessageReceiptSourceResult[]) {
  return createMessageReceiptFromOutboundResults({
    kind: "unknown",
    results,
  });
}

function createPlan(
  deliverReply: Parameters<typeof createWhatsAppReplyPlan>[0]["deliverReply"],
  platform?: Pick<AdmittedWebInboundMessage["platform"], "reply" | "sendMedia">,
) {
  const msg = createTestWebInboundMessage({
    event: { id: "wa-inbound-1" },
    payload: { body: "show me the result" },
    platform: {
      chatJid: "1000@s.whatsapp.net",
      recipientJid: "+2000",
      senderJid: "1000@s.whatsapp.net",
      ...platform,
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
  const replyLogger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
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
    replyLogger: replyLogger as never,
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
  return { context, plan, replyLogger };
}

async function dispatchObservedPlatformReply(params: {
  payload: { text: string; mediaUrls?: string[] };
  platform: Pick<AdmittedWebInboundMessage["platform"], "reply" | "sendMedia">;
  deferredMediaUrls?: string[];
}) {
  const pluginHook = vi.fn();
  const internalHook = vi.fn();
  const registry = createEmptyPluginRegistry();
  addTestHook({
    registry,
    pluginId: "whatsapp-message-sent-partial-test",
    hookName: "message_sent",
    handler: pluginHook as PluginHookRegistration["handler"],
  });
  initializeGlobalHookRunner(registry);
  registerInternalHook("message:sent", internalHook);
  const { context, plan, replyLogger } = createPlan(deliverWebReply, params.platform);
  const onDelivered = vi.fn(plan.delivery.onDelivered);
  let deliveryResult: unknown;
  let settledResult: unknown;
  const dispatchReplyWithBufferedBlockDispatcher = vi.fn(async (dispatch) => {
    dispatch.replyOptions?.onAgentRunStart?.("run-wa-partial");
    if (params.deferredMediaUrls) {
      const deferred = await dispatch.dispatcherOptions.deliver(
        { text: "tool images", mediaUrls: params.deferredMediaUrls },
        { kind: "tool" },
      );
      expect(deferred).toMatchObject({
        visibleReplySent: false,
        finalization: expect.any(Promise),
      });
      expect(onDelivered).not.toHaveBeenCalled();
    }
    try {
      deliveryResult = await dispatch.dispatcherOptions.deliver(params.payload, { kind: "final" });
    } finally {
      settledResult = await dispatch.dispatcherOptions.onSettled?.();
    }
    return {
      queuedFinal: true,
      counts: { tool: params.deferredMediaUrls ? 1 : 0, block: 0, final: 1 },
    };
  });
  const failure = await dispatchChannelInboundReply({
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
    delivery: { ...plan.delivery, onDelivered },
    replyOptions: plan.replyOptions,
    replyResolver: plan.replyResolver,
  }).catch((caught: unknown) => caught);
  return {
    deliveryResult,
    failure,
    internalHook,
    pluginHook,
    replyLogger,
    onDelivered,
    settledResult,
  };
}

afterEach(() => {
  clearInternalHooks();
  resetGlobalHookRunner();
});

describe("WhatsApp canonical message_sent delivery", () => {
  it.each([
    {
      replacement: ["/tmp/a.jpg"],
      sent: ["/tmp/a.jpg", "/tmp/b.jpg"],
      deferredIds: ["sent-2"],
      replacementId: "sent-1",
    },
    {
      replacement: ["/tmp/a.jpg", "/tmp/b.jpg"],
      sent: ["/tmp/a.jpg", "/tmp/b.jpg"],
      deferredIds: [],
      replacementId: "sent-1",
    },
    {
      replacement: ["/tmp/c.jpg"],
      sent: ["/tmp/a.jpg", "/tmp/b.jpg", "/tmp/c.jpg"],
      deferredIds: ["sent-1", "sent-2"],
      replacementId: "sent-3",
    },
    {
      deferredMedia: ["/tmp/a.jpg", "/tmp/b.jpg", "/tmp/c.jpg"],
      replacement: ["/tmp/b.jpg"],
      sent: ["/tmp/b.jpg", "/tmp/a.jpg", "/tmp/c.jpg"],
      deferredIds: ["sent-2", "sent-3"],
      replacementId: "sent-1",
    },
  ])(
    "finalizes every deferred attachment through core after replacement $replacement",
    async ({
      replacement,
      sent: expectedSent,
      deferredIds,
      replacementId,
      deferredMedia = ["/tmp/a.jpg", "/tmp/b.jpg"],
    }) => {
      const sent: string[] = [];
      vi.mocked(loadWebMedia).mockImplementation(async (url) => ({
        buffer: Buffer.from(url),
        contentType: "image/jpeg",
        kind: "image",
      }));
      const sendMedia = vi.fn<AdmittedWebInboundMessage["platform"]["sendMedia"]>(
        async (content) => {
          if (!("image" in content) || !Buffer.isBuffer(content.image)) {
            throw new Error("expected image transport payload");
          }
          sent.push(content.image.toString());
          return normalizeWhatsAppSendResult(
            { key: { id: `sent-${sent.length}` } } as WAMessage,
            "media",
          );
        },
      );
      const reply = vi.fn<AdmittedWebInboundMessage["platform"]["reply"]>();
      const { failure, pluginHook, internalHook, onDelivered, settledResult } =
        await dispatchObservedPlatformReply({
          payload: { text: "Here are the images", mediaUrls: replacement },
          deferredMediaUrls: deferredMedia,
          platform: { reply, sendMedia },
        });

      expect(failure).toMatchObject({ dispatched: true });
      expect(sent).toEqual(expectedSent);
      expect(reply).not.toHaveBeenCalled();
      expect(settledResult).toEqual({ visibleReplySent: true });
      expect(onDelivered).toHaveBeenCalledTimes(2);
      const [, info, finalized] = onDelivered.mock.calls[1]!;
      expect(info.kind).toBe("tool");
      expect(finalized?.finalization).toBeUndefined();
      if (deferredIds.length) {
        expect(finalized).toMatchObject({
          visibleReplySent: true,
          content: "",
          messageIds: deferredIds,
          receipt: { platformMessageIds: deferredIds },
        });
      } else {
        expect(finalized).toEqual({ visibleReplySent: false, finalization: undefined });
      }
      const observedIds = [replacementId, ...deferredIds.slice(0, 1)];
      await vi.waitFor(() => {
        expect(pluginHook).toHaveBeenCalledTimes(observedIds.length);
        expect(internalHook).toHaveBeenCalledTimes(observedIds.length);
      });
      expect(pluginHook.mock.calls.map(([event]) => [event.messageId, event.success])).toEqual(
        observedIds.map((id) => [id, true]),
      );
    },
  );

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

  it("preserves accepted voice receipts through real dispatch after caption rejection", async () => {
    recordChannelActivity.mockClear();
    vi.mocked(loadWebMedia).mockResolvedValueOnce({
      buffer: Buffer.from("voice"),
      contentType: "audio/ogg",
      kind: "audio",
    });
    const sendMedia = vi.fn(async () =>
      normalizeWhatsAppSendResult({ key: { id: "dispatch-voice-accepted" } } as WAMessage, "media"),
    );
    const reply = vi.fn(async () => normalizeWhatsAppSendResult(undefined, "text"));
    const { plan } = createPlan(deliverWebReply, { reply, sendMedia });
    const delivery = plan.delivery as ChannelInboundTurnPlan["delivery"];

    const failure = await delivery
      .deliver({ text: "caption", mediaUrls: ["/tmp/accepted-voice.ogg"] }, { kind: "final" })
      .catch((caught: unknown) => caught);

    expect(isChannelPartialDeliveryError(failure)).toBe(true);
    if (!isChannelPartialDeliveryError(failure)) {
      throw new Error("inbound dispatch discarded the accepted native voice receipt");
    }
    expect(failure.deliveryResult).toMatchObject({
      messageIds: ["dispatch-voice-accepted"],
      receipt: { platformMessageIds: ["dispatch-voice-accepted"] },
      visibleReplySent: true,
    });
    expect(failure).toHaveProperty("cause", expect.any(PlatformMessageNotDispatchedError));
    expect(sendMedia).toHaveBeenCalledOnce();
    expect(reply).toHaveBeenCalledExactlyOnceWith("caption", undefined);
    expect(recordChannelActivity).toHaveBeenCalledExactlyOnceWith({
      channel: "whatsapp",
      accountId: "default",
      direction: "outbound",
    });
  });

  it.each([
    {
      name: "a real producer-backed reply",
      route: "reply" as const,
      failDuplicateBookkeeping: false,
    },
    {
      name: "a real producer-backed reply with duplicate bookkeeping armed to fail",
      route: "reply" as const,
      failDuplicateBookkeeping: true,
    },
    {
      name: "a real producer-backed media send with duplicate bookkeeping armed to fail",
      route: "media" as const,
      failDuplicateBookkeeping: true,
    },
  ])("records activity exactly once through $name", async ({ route, failDuplicateBookkeeping }) => {
    recordChannelActivity.mockReset();
    if (failDuplicateBookkeeping) {
      recordChannelActivity.mockImplementation(() => {
        if (recordChannelActivity.mock.calls.length > 1) {
          throw new Error("outer owner duplicated producer activity bookkeeping");
        }
      });
    }
    const messageId = `dispatch-producer-${route}${failDuplicateBookkeeping ? "-guarded" : ""}`;
    const sendMessage = vi.fn(
      async () =>
        ({
          key: {
            id: messageId,
            remoteJid: "1000@s.whatsapp.net",
            fromMe: true,
            participant: "observer@s.whatsapp.net",
          },
        }) as WAMessage,
    );
    const sendApi = createWebSendApi({
      sock: {
        sendMessage,
        sendPresenceUpdate: vi.fn(async () => undefined),
      },
      defaultAccountId: "default",
    });
    const isMediaRoute = route === "media";
    vi.mocked(loadWebMedia).mockResolvedValueOnce({
      buffer: Buffer.from(isMediaRoute ? "video" : "image"),
      contentType: isMediaRoute ? "video/mp4" : "image/jpeg",
      kind: isMediaRoute ? "video" : "image",
    });
    const reply = isMediaRoute
      ? vi.fn<AdmittedWebInboundMessage["platform"]["reply"]>()
      : vi.fn<AdmittedWebInboundMessage["platform"]["reply"]>(async (text) =>
          sendApi.sendMessage("+1000", text),
        );
    const sendMedia = isMediaRoute
      ? vi.fn<AdmittedWebInboundMessage["platform"]["sendMedia"]>(async (payload) => {
          if (!("video" in payload) || !Buffer.isBuffer(payload.video)) {
            throw new Error("expected a real WhatsApp video payload");
          }
          return sendApi.sendMessage(
            "+1000",
            typeof payload.caption === "string" ? payload.caption : "",
            payload.video,
            typeof payload.mimetype === "string" ? payload.mimetype : "video/mp4",
          );
        })
      : vi
          .fn<AdmittedWebInboundMessage["platform"]["sendMedia"]>()
          .mockRejectedValueOnce(new Error("unaccepted initial upload"));

    const { deliveryResult, failure, internalHook, pluginHook, replyLogger } =
      await dispatchObservedPlatformReply({
        payload: {
          text: "caption",
          mediaUrls: [isMediaRoute ? "/tmp/producer-video.mp4" : "/tmp/producer-image.jpg"],
        },
        platform: { reply, sendMedia },
      });

    expect(failure).toMatchObject({
      dispatched: true,
      dispatchResult: { queuedFinal: true },
    });
    await vi.waitFor(() => {
      expect(pluginHook).toHaveBeenCalledOnce();
      expect(internalHook).toHaveBeenCalledOnce();
    });
    expect(pluginHook).toHaveBeenCalledWith(
      expect.objectContaining({ messageId, success: true }),
      expect.objectContaining({ messageId }),
    );
    expect(deliveryResult).toMatchObject({
      receipt: {
        primaryPlatformMessageId: messageId,
        platformMessageIds: [messageId],
        raw: [
          expect.objectContaining({
            channel: "whatsapp",
            messageId,
            toJid: "1000@s.whatsapp.net",
            meta: expect.objectContaining({
              fromMe: true,
              participant: "observer@s.whatsapp.net",
              providerAccepted: true,
            }),
          }),
        ],
        parts: [
          expect.objectContaining({
            platformMessageId: messageId,
            index: 0,
            raw: expect.objectContaining({
              toJid: "1000@s.whatsapp.net",
              meta: expect.objectContaining({
                fromMe: true,
                participant: "observer@s.whatsapp.net",
              }),
            }),
          }),
        ],
      },
    });
    expect(sendMessage).toHaveBeenCalledOnce();
    expect(sendMedia).toHaveBeenCalledOnce();
    if (isMediaRoute) {
      expect(reply).not.toHaveBeenCalled();
      expect(replyLogger.warn).not.toHaveBeenCalled();
    } else {
      expect(reply).toHaveBeenCalledExactlyOnceWith("caption\n⚠️ Media failed.", undefined);
    }
    expect(recordChannelActivity).toHaveBeenCalledExactlyOnceWith({
      channel: "whatsapp",
      accountId: "default",
      direction: "outbound",
    });
    recordChannelActivity.mockReset();
  });

  it("shares one logical activity scope across real separately accepted voice and caption sends", async () => {
    recordChannelActivity.mockReset();
    recordChannelActivity.mockImplementation(() => {
      if (recordChannelActivity.mock.calls.length > 1) {
        throw new Error("caption producer incorrectly repeated logical activity bookkeeping");
      }
    });
    vi.mocked(loadWebMedia).mockResolvedValueOnce({
      buffer: Buffer.from("voice"),
      contentType: "audio/ogg",
      kind: "audio",
    });
    const sendMessage = vi
      .fn()
      .mockResolvedValueOnce({
        key: {
          id: "dispatch-scoped-voice",
          remoteJid: "1000@s.whatsapp.net",
          fromMe: true,
        },
      } as WAMessage)
      .mockResolvedValueOnce({
        key: {
          id: "dispatch-scoped-caption",
          remoteJid: "1000@s.whatsapp.net",
          fromMe: true,
        },
      } as WAMessage);
    const sendApi = createWebSendApi({
      sock: {
        sendMessage,
        sendPresenceUpdate: vi.fn(async () => undefined),
      },
      defaultAccountId: "default",
    });
    const sendMedia = vi.fn<AdmittedWebInboundMessage["platform"]["sendMedia"]>(async (payload) => {
      if (!("audio" in payload) || !Buffer.isBuffer(payload.audio)) {
        throw new Error("expected a real WhatsApp voice payload");
      }
      return sendApi.sendMessage(
        "+1000",
        "",
        payload.audio,
        typeof payload.mimetype === "string" ? payload.mimetype : "audio/ogg",
      );
    });
    const reply = vi.fn<AdmittedWebInboundMessage["platform"]["reply"]>(async (text) =>
      sendApi.sendMessage("+1000", text),
    );

    const { deliveryResult, failure, internalHook, pluginHook, replyLogger } =
      await dispatchObservedPlatformReply({
        payload: { text: "voice caption", mediaUrls: ["/tmp/scoped-voice.ogg"] },
        platform: { reply, sendMedia },
      });

    expect(failure).toMatchObject({
      dispatched: true,
      dispatchResult: { queuedFinal: true },
    });
    expect(deliveryResult).toMatchObject({
      messageIds: ["dispatch-scoped-voice", "dispatch-scoped-caption"],
      receipt: {
        primaryPlatformMessageId: "dispatch-scoped-voice",
        platformMessageIds: ["dispatch-scoped-voice", "dispatch-scoped-caption"],
        parts: [
          expect.objectContaining({
            platformMessageId: "dispatch-scoped-voice",
            raw: expect.objectContaining({ meta: expect.objectContaining({ kind: "media" }) }),
          }),
          expect.objectContaining({
            platformMessageId: "dispatch-scoped-caption",
            raw: expect.objectContaining({ meta: expect.objectContaining({ kind: "text" }) }),
          }),
        ],
        raw: [
          expect.objectContaining({
            messageId: "dispatch-scoped-voice",
            toJid: "1000@s.whatsapp.net",
          }),
          expect.objectContaining({
            messageId: "dispatch-scoped-caption",
            toJid: "1000@s.whatsapp.net",
          }),
        ],
      },
    });
    await vi.waitFor(() => {
      expect(pluginHook).toHaveBeenCalledOnce();
      expect(internalHook).toHaveBeenCalledOnce();
    });
    expect(pluginHook).toHaveBeenCalledWith(
      expect.objectContaining({ messageId: "dispatch-scoped-voice", success: true }),
      expect.objectContaining({ messageId: "dispatch-scoped-voice" }),
    );
    expect(sendMessage).toHaveBeenCalledTimes(2);
    expect(sendMedia).toHaveBeenCalledOnce();
    expect(reply).toHaveBeenCalledExactlyOnceWith("voice caption", undefined);
    expect(replyLogger.warn).not.toHaveBeenCalled();
    expect(recordChannelActivity).toHaveBeenCalledExactlyOnceWith({
      channel: "whatsapp",
      accountId: "default",
      direction: "outbound",
    });
    recordChannelActivity.mockReset();
  });

  it("keeps the first accepted chunk visible to observers when a later chunk throws a nested partial", async () => {
    recordChannelActivity.mockClear();
    const bookkeepingError = new Error("second accepted chunk bookkeeping failed");
    vi.mocked(loadWebMedia).mockResolvedValueOnce({
      buffer: Buffer.from("voice"),
      contentType: "audio/ogg",
      kind: "audio",
    });
    const firstChunk = normalizeWhatsAppSendResult(
      { key: { id: "dispatch-first-chunk" } } as WAMessage,
      "media",
    );
    const secondChunk = normalizeWhatsAppSendResult(
      { key: { id: "dispatch-second-chunk" } } as WAMessage,
      "text",
    );
    const reply = vi.fn<AdmittedWebInboundMessage["platform"]["reply"]>().mockRejectedValueOnce(
      createChannelPartialDeliveryError(bookkeepingError, {
        messageIds: [secondChunk.messageId],
        receipt: secondChunk.receipt,
        visibleReplySent: true,
      }),
    );
    const sendMedia = vi
      .fn<AdmittedWebInboundMessage["platform"]["sendMedia"]>()
      .mockResolvedValueOnce(firstChunk);

    const { failure, internalHook, pluginHook } = await dispatchObservedPlatformReply({
      payload: { text: "caption", mediaUrls: ["/tmp/accepted-first-voice.ogg"] },
      platform: { reply, sendMedia },
    });

    expect(isChannelPartialDeliveryError(failure)).toBe(true);
    if (!isChannelPartialDeliveryError(failure)) {
      throw new Error(
        "canonical dispatch dropped accepted WhatsApp chunks after nested bookkeeping",
      );
    }
    expect(failure.deliveryResult.messageIds).toEqual([
      "dispatch-first-chunk",
      "dispatch-second-chunk",
    ]);
    expect(failure.deliveryResult.receipt?.platformMessageIds).toEqual([
      "dispatch-first-chunk",
      "dispatch-second-chunk",
    ]);
    expect(failure).toHaveProperty("cause", bookkeepingError);
    await vi.waitFor(() => {
      expect(pluginHook).toHaveBeenCalledOnce();
      expect(internalHook).toHaveBeenCalledOnce();
    });
    expect(pluginHook).toHaveBeenCalledWith(
      expect.objectContaining({ messageId: "dispatch-first-chunk", success: false }),
      expect.objectContaining({ messageId: "dispatch-first-chunk" }),
    );
    expect(sendMedia).toHaveBeenCalledOnce();
    expect(reply).toHaveBeenCalledOnce();
    expect(recordChannelActivity).toHaveBeenCalledExactlyOnceWith({
      channel: "whatsapp",
      accountId: "default",
      direction: "outbound",
    });
  });

  it("warns about a genuinely rejected trailing upload without losing its earlier receipt", async () => {
    recordChannelActivity.mockClear();
    vi.mocked(loadWebMedia)
      .mockResolvedValueOnce({
        buffer: Buffer.from("first"),
        contentType: "image/jpeg",
        kind: "image",
      })
      .mockResolvedValueOnce({
        buffer: Buffer.from("second"),
        contentType: "image/jpeg",
        kind: "image",
      });
    const sendMedia = vi
      .fn<AdmittedWebInboundMessage["platform"]["sendMedia"]>()
      .mockResolvedValueOnce(
        normalizeWhatsAppSendResult(
          { key: { id: "dispatch-accepted-first-media" } } as WAMessage,
          "media",
        ),
      )
      .mockRejectedValueOnce(new Error("trailing upload rejected"));
    const reply = vi
      .fn<AdmittedWebInboundMessage["platform"]["reply"]>()
      .mockResolvedValueOnce(
        normalizeWhatsAppSendResult(
          { key: { id: "dispatch-trailing-media-warning" } } as WAMessage,
          "text",
        ),
      );

    const { failure, internalHook, pluginHook, replyLogger } = await dispatchObservedPlatformReply({
      payload: {
        text: "caption",
        mediaUrls: ["/tmp/accepted-first.jpg", "/tmp/rejected-second.jpg"],
      },
      platform: { reply, sendMedia },
    });

    expect(failure).toMatchObject({
      dispatched: true,
      dispatchResult: { queuedFinal: true },
    });
    await vi.waitFor(() => {
      expect(pluginHook).toHaveBeenCalledOnce();
      expect(internalHook).toHaveBeenCalledOnce();
    });
    expect(pluginHook).toHaveBeenCalledWith(
      expect.objectContaining({ messageId: "dispatch-accepted-first-media", success: true }),
      expect.objectContaining({ messageId: "dispatch-accepted-first-media" }),
    );
    expect(sendMedia).toHaveBeenCalledTimes(2);
    expect(reply).toHaveBeenCalledExactlyOnceWith("⚠️ Media unavailable.", undefined);
    expect(replyLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ mediaUrl: "/tmp/rejected-second.jpg" }),
      "failed to send web media reply",
    );
    expect(recordChannelActivity).toHaveBeenCalledExactlyOnceWith({
      channel: "whatsapp",
      accountId: "default",
      direction: "outbound",
    });
  });

  it("preserves inner accepted media receipts and one activity attempt through full dispatch", async () => {
    recordChannelActivity.mockClear();
    const bookkeepingError = new Error("accepted dispatch media bookkeeping failed");
    recordChannelActivity.mockImplementationOnce(() => {
      throw bookkeepingError;
    });
    vi.mocked(loadWebMedia).mockResolvedValueOnce({
      buffer: Buffer.from("voice"),
      contentType: "audio/ogg",
      kind: "audio",
    });
    const sendApi = createWebSendApi({
      sock: {
        sendMessage: vi.fn(async () => ({ key: { id: "dispatch-nested-media" } }) as WAMessage),
        sendPresenceUpdate: vi.fn(async () => undefined),
      },
      defaultAccountId: "default",
    });
    const sendMedia = vi.fn(async () =>
      sendApi.sendMessage("+1000", "", Buffer.from("voice"), "audio/ogg"),
    );
    const reply = vi.fn<AdmittedWebInboundMessage["platform"]["reply"]>();

    const { failure, internalHook, pluginHook, replyLogger } = await dispatchObservedPlatformReply({
      payload: { text: "caption", mediaUrls: ["/tmp/accepted-nested-voice.ogg"] },
      platform: { reply, sendMedia },
    });

    expect(isChannelPartialDeliveryError(failure)).toBe(true);
    if (!isChannelPartialDeliveryError(failure)) {
      throw new Error("canonical dispatch treated accepted WhatsApp media as an upload failure");
    }
    expect(failure.deliveryResult.messageIds).toEqual(["dispatch-nested-media"]);
    expect(failure.deliveryResult.receipt?.platformMessageIds).toEqual(["dispatch-nested-media"]);
    expect(failure).toHaveProperty("cause", bookkeepingError);
    await vi.waitFor(() => {
      expect(pluginHook).toHaveBeenCalledOnce();
      expect(internalHook).toHaveBeenCalledOnce();
    });
    expect(pluginHook).toHaveBeenCalledWith(
      expect.objectContaining({ messageId: "dispatch-nested-media", success: false }),
      expect.objectContaining({ messageId: "dispatch-nested-media" }),
    );
    expect(sendMedia).toHaveBeenCalledOnce();
    expect(reply).not.toHaveBeenCalled();
    expect(replyLogger.warn).not.toHaveBeenCalled();
    expect(recordChannelActivity).toHaveBeenCalledExactlyOnceWith({
      channel: "whatsapp",
      accountId: "default",
      direction: "outbound",
    });
  });
});
