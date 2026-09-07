// Whatsapp tests cover the durable outbound handoff across startup recovery.
import type { AnyMessageContent, MiscMessageGenerationOptions, WAMessage } from "baileys";
import { isChannelPartialDeliveryError } from "openclaw/plugin-sdk/channel-inbound";
import { sendDurableMessageBatch } from "openclaw/plugin-sdk/channel-outbound";
import {
  createEmptyPluginRegistry,
  createOutboundTestPlugin,
  createTestRegistry,
  resetPluginRuntimeStateForTest,
  setActivePluginRegistry,
} from "openclaw/plugin-sdk/channel-test-helpers";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { drainPendingDeliveries } from "openclaw/plugin-sdk/delivery-queue-runtime";
import { PlatformMessageNotDispatchedError } from "openclaw/plugin-sdk/error-runtime";
import { withStateDirEnv } from "openclaw/plugin-sdk/test-env";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { whatsappChannelOutbound, whatsappMessageAdapter } from "./channel-outbound.js";
import { createWebSendApi } from "./inbound/send-api.js";
import { createAcceptedWhatsAppSendResult } from "./inbound/send-result.test-helper.js";
import type { ActiveWebListener } from "./inbound/types.js";
import { cacheInboundMessageMeta } from "./quoted-message.js";

const runtimeContextMocks = vi.hoisted(() => ({
  controllers: new Map<string, unknown>(),
  loadOutboundMediaFromUrl: vi.fn(),
}));

vi.mock("openclaw/plugin-sdk/channel-activity-runtime", async () => {
  const actual = await vi.importActual<
    typeof import("openclaw/plugin-sdk/channel-activity-runtime")
  >("openclaw/plugin-sdk/channel-activity-runtime");
  return { ...actual, recordChannelActivity: vi.fn() };
});

vi.mock("openclaw/plugin-sdk/outbound-media", async () => {
  const actual = await vi.importActual<typeof import("openclaw/plugin-sdk/outbound-media")>(
    "openclaw/plugin-sdk/outbound-media",
  );
  return { ...actual, loadOutboundMediaFromUrl: runtimeContextMocks.loadOutboundMediaFromUrl };
});

vi.mock("./connection-controller-runtime-context.js", () => ({
  getWhatsAppConnectionController: (accountId: string) =>
    runtimeContextMocks.controllers.get(accountId) ?? null,
}));

const cfg = { channels: { whatsapp: {} } } as OpenClawConfig;
const accountId = "default";

async function drainDefaultWhatsAppDeliveries(stateDir: string) {
  const log = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
  await drainPendingDeliveries({
    drainKey: `whatsapp:${accountId}`,
    logLabel: "WhatsApp reconnect drain",
    cfg,
    log,
    stateDir,
    selectEntry: (entry) => ({
      match:
        entry.channel === "whatsapp" && ((entry.accountId ?? "").trim() || accountId) === accountId,
      bypassBackoff:
        typeof entry.lastError === "string" &&
        entry.lastError.includes("No active WhatsApp Web listener"),
    }),
  });
  return log;
}

describe("WhatsApp delivery recovery", () => {
  beforeEach(() => {
    runtimeContextMocks.controllers.clear();
    runtimeContextMocks.loadOutboundMediaFromUrl.mockReset();
    setActivePluginRegistry(
      createTestRegistry([
        {
          pluginId: "whatsapp",
          source: "test",
          plugin: {
            ...createOutboundTestPlugin({
              id: "whatsapp",
              outbound: whatsappChannelOutbound,
            }),
            message: whatsappMessageAdapter,
          },
        },
      ]),
    );
  });

  afterEach(() => {
    runtimeContextMocks.controllers.clear();
    resetPluginRuntimeStateForTest();
    setActivePluginRegistry(createEmptyPluginRegistry());
  });

  it.each([
    { mode: "first" as const, explicit: false },
    { mode: "all" as const, explicit: false },
    { mode: "first" as const, explicit: true },
  ])("preserves long styles and $mode quotes (explicit=$explicit)", async ({ mode, explicit }) => {
    await withStateDirEnv("openclaw-whatsapp-styled-reply-", async () => {
      const sendMessage = vi.fn<ActiveWebListener["sendMessage"]>();
      sendMessage.mockImplementation(async () =>
        createAcceptedWhatsAppSendResult("text", `part-${sendMessage.mock.calls.length}`),
      );
      runtimeContextMocks.controllers.set(accountId, {
        getActiveListener: () => ({ sendMessage, sendComposingTo: vi.fn() }),
      });
      const onDeliveryResult = vi.fn();
      const result = await sendDurableMessageBatch({
        cfg: { channels: { whatsapp: { textChunkLimit: 160 } } },
        channel: "whatsapp",
        to: "+1555",
        payloads: [
          { text: `**${"x".repeat(340)}**`, ...(explicit ? { replyToId: "quoted" } : {}) },
        ],
        replyToId: "quoted",
        replyToMode: mode,
        onDeliveryResult,
        durability: "required",
      });
      expect(result.status).toBe("sent");
      expect(sendMessage.mock.calls.map(([, text]) => text)).toEqual([
        `*${"x".repeat(158)}*`,
        "*xx*",
        `*${"x".repeat(158)}*`,
        "*xx*",
        `*${"x".repeat(20)}*`,
      ]);
      expect(sendMessage.mock.calls.map((call) => call[4]?.quotedMessageKey?.id)).toEqual(
        explicit || mode === "all"
          ? ["quoted", "quoted", "quoted", "quoted", "quoted"]
          : ["quoted", undefined, undefined, undefined, undefined],
      );
      expect(onDeliveryResult.mock.calls.map(([progress]) => progress.messageId)).toEqual([
        "part-1",
        "part-2",
        "part-3",
        "part-4",
        "part-5",
      ]);
      expect(
        onDeliveryResult.mock.calls.map(([progress]) =>
          progress.receipt?.parts.map((part: { replyToId?: string }) => part.replyToId),
        ),
      ).toEqual(
        explicit || mode === "all"
          ? [["quoted"], ["quoted"], ["quoted"], ["quoted"], ["quoted"]]
          : [["quoted"], [undefined], [undefined], [undefined], [undefined]],
      );
    });
  });

  it("keeps payload formatting intact under a narrower delivery limit", async () => {
    const sendMessage = vi.fn<ActiveWebListener["sendMessage"]>();
    sendMessage.mockImplementation(async () =>
      createAcceptedWhatsAppSendResult("text", `payload-${sendMessage.mock.calls.length}`),
    );
    runtimeContextMocks.controllers.set(accountId, {
      getActiveListener: () => ({ sendMessage, sendComposingTo: vi.fn() }),
    });
    const onPlatformSendDispatch = vi.fn(async () => {});
    const onDeliveryResult = vi.fn();
    const text = `**${"x".repeat(4_200)}**`;
    await whatsappChannelOutbound.sendPayload!({
      cfg: { channels: { whatsapp: { textChunkLimit: 160 } } },
      to: "+1555",
      text,
      payload: { text },
      formatting: { textLimit: 80 },
      replyToId: "quoted",
      replyToIdSource: "implicit",
      replyToMode: "first",
      onPlatformSendDispatch,
      onDeliveryResult,
    });
    const parts = sendMessage.mock.calls.map(([, part]) => part);
    expect(parts.length).toBeGreaterThan(1);
    expect(parts.every((part) => /^\*x+\*$/.test(part) && part.length <= 80)).toBe(true);
    expect(parts.map((part) => part.slice(1, -1)).join("")).toBe("x".repeat(4_200));
    expect(sendMessage.mock.calls.map((call) => call[4]?.quotedMessageKey?.id)).toEqual(
      parts.map((_, index) => (index === 0 ? "quoted" : undefined)),
    );
    expect(onPlatformSendDispatch).toHaveBeenCalledTimes(parts.length);
    expect(onDeliveryResult.mock.calls.map(([result]) => result.messageId)).toEqual(
      parts.map((_, index) => `payload-${index + 1}`),
    );
  });

  it("preserves payloads, receipts, and callback order through the active web socket", async () => {
    const order: string[] = [];
    const nativeSendsToReject = new Set<number>();
    const socketSend = vi.fn(
      async (jid: string, content: AnyMessageContent, options?: MiscMessageGenerationOptions) => {
        const sequence = socketSend.mock.calls.length;
        order.push(`socket:${sequence}`);
        if (nativeSendsToReject.delete(sequence)) {
          throw new Error("fixture transport failed");
        }
        return {
          key: { id: `native-${sequence}`, remoteJid: jid, fromMe: true },
          message: content,
          ...(options ? { messageStubParameters: ["quoted"] } : {}),
        } as WAMessage;
      },
    );
    const sendApi = createWebSendApi({
      sock: {
        sendMessage: socketSend,
        sendPresenceUpdate: vi.fn(async () => undefined),
      },
      defaultAccountId: accountId,
    });
    runtimeContextMocks.controllers.set(accountId, {
      getActiveListener: () => sendApi,
    });
    const mediaAccess = {
      localRoots: ["/tmp/whatsapp-dispatch-fixture"],
      readFile: vi.fn(async () => Buffer.from("host-read")),
    };
    const mediaLocalRoots = ["/tmp/whatsapp-dispatch-legacy"];
    const mediaReadFile = vi.fn(async () => Buffer.from("legacy-read"));
    const media = {
      "fixture://captionless.pdf": {
        buffer: Buffer.from("pdf"),
        contentType: "application/pdf",
        kind: "document",
        fileName: "captionless.pdf",
      },
      "fixture://forced.png": {
        buffer: Buffer.from("png"),
        contentType: "image/png",
        kind: "image",
        fileName: "forced.png",
      },
      "fixture://voice.ogg": {
        buffer: Buffer.from("ogg"),
        contentType: "audio/ogg",
        kind: "audio",
        fileName: "voice.ogg",
      },
    } as const;
    runtimeContextMocks.loadOutboundMediaFromUrl.mockImplementation(async (url: string) => {
      const fixture = media[url as keyof typeof media];
      if (!fixture) {
        throw new Error(`missing fixture: ${url}`);
      }
      return fixture;
    });
    const progress: string[] = [];
    const sendPayload = async (
      payload: Parameters<NonNullable<typeof whatsappChannelOutbound.sendPayload>>[0]["payload"],
      extra: Partial<Parameters<NonNullable<typeof whatsappChannelOutbound.sendPayload>>[0]> = {},
    ) =>
      await whatsappChannelOutbound.sendPayload!({
        cfg,
        to: "+1555",
        payload,
        text: payload.text ?? "",
        mediaAccess,
        mediaLocalRoots,
        mediaReadFile,
        onPlatformSendDispatch: async () => {
          order.push("dispatch");
        },
        onDeliveryResult: async (result) => {
          progress.push(result.messageId);
          order.push(`progress:${result.messageId}`);
        },
        ...extra,
      });

    const textResult = await sendPayload({ text: "plain text" });
    const captionlessResult = await sendPayload({
      text: "",
      mediaUrl: "fixture://captionless.pdf",
    });
    const documentResult = await sendPayload(
      { text: "document caption", mediaUrl: "fixture://forced.png" },
      { forceDocument: true },
    );
    const voiceResult = await sendPayload({
      text: "voice caption",
      mediaUrl: "fixture://voice.ogg",
      audioAsVoice: false,
    });
    cacheInboundMessageMeta(accountId, "1555@s.whatsapp.net", "quoted-1", {
      body: "original quote",
      fromMe: false,
    });
    const quotedResult = await sendPayload(
      { text: "quoted text" },
      { replyToId: "quoted-1", replyToIdSource: "explicit", replyToMode: "all" },
    );
    nativeSendsToReject.add(socketSend.mock.calls.length + 2);
    const failure = await sendPayload({
      text: "caption fails after voice acceptance",
      mediaUrl: "fixture://voice.ogg",
    }).catch((error: unknown) => error);

    expect([textResult, captionlessResult, documentResult, voiceResult, quotedResult]).toEqual([
      { channel: "whatsapp", messageId: "native-1", toJid: "1555@s.whatsapp.net" },
      { channel: "whatsapp", messageId: "native-2", toJid: "1555@s.whatsapp.net" },
      { channel: "whatsapp", messageId: "native-3", toJid: "1555@s.whatsapp.net" },
      { channel: "whatsapp", messageId: "native-4", toJid: "1555@s.whatsapp.net" },
      { channel: "whatsapp", messageId: "native-6", toJid: "1555@s.whatsapp.net" },
    ]);
    expect(socketSend.mock.calls).toEqual([
      ["1555@s.whatsapp.net", { text: "plain text" }],
      [
        "1555@s.whatsapp.net",
        {
          document: Buffer.from("pdf"),
          fileName: "captionless.pdf",
          caption: undefined,
          mimetype: "application/pdf",
        },
      ],
      [
        "1555@s.whatsapp.net",
        {
          document: Buffer.from("png"),
          fileName: "forced.png",
          caption: "document caption",
          mimetype: "image/png",
        },
      ],
      [
        "1555@s.whatsapp.net",
        { audio: Buffer.from("ogg"), ptt: true, mimetype: "audio/ogg; codecs=opus" },
      ],
      ["1555@s.whatsapp.net", { text: "voice caption" }],
      [
        "1555@s.whatsapp.net",
        { text: "quoted text" },
        {
          quoted: expect.objectContaining({
            key: expect.objectContaining({
              id: "quoted-1",
              remoteJid: "1555@s.whatsapp.net",
              fromMe: false,
            }),
            message: { conversation: "original quote" },
          }),
        },
      ],
      [
        "1555@s.whatsapp.net",
        { audio: Buffer.from("ogg"), ptt: true, mimetype: "audio/ogg; codecs=opus" },
      ],
      ["1555@s.whatsapp.net", { text: "caption fails after voice acceptance" }],
    ]);
    expect(progress).toEqual([
      "native-1",
      "native-2",
      "native-3",
      "native-4",
      "native-5",
      "native-6",
      "native-7",
    ]);
    expect(order).toEqual([
      "dispatch",
      "socket:1",
      "progress:native-1",
      "dispatch",
      "socket:2",
      "progress:native-2",
      "dispatch",
      "socket:3",
      "progress:native-3",
      "dispatch",
      "socket:4",
      "progress:native-4",
      "dispatch",
      "socket:5",
      "progress:native-5",
      "dispatch",
      "socket:6",
      "progress:native-6",
      "dispatch",
      "socket:7",
      "progress:native-7",
      "dispatch",
      "socket:8",
    ]);
    expect(runtimeContextMocks.loadOutboundMediaFromUrl.mock.calls).toEqual(
      [...Object.keys(media), "fixture://voice.ogg"].map((url, index) => [
        url,
        {
          maxBytes: 50 * 1024 * 1024,
          optimizeImages: index === 1 ? false : undefined,
          mediaAccess,
          mediaLocalRoots,
          mediaReadFile,
        },
      ]),
    );
    expect(isChannelPartialDeliveryError(failure)).toBe(true);
    if (!isChannelPartialDeliveryError(failure)) {
      throw new Error("accepted fixture voice delivery did not preserve its receipt");
    }
    expect(failure.deliveryResult).toMatchObject({
      messageIds: ["native-7"],
      receipt: { platformMessageIds: ["native-7"] },
    });
    expect(failure).toHaveProperty(
      "cause",
      expect.objectContaining({
        message: "fixture transport failed",
      }),
    );
  });

  it.each(["abort", "transport"] as const)(
    "retains accepted chunks after a later %s failure",
    async (failure) => {
      await withStateDirEnv("openclaw-whatsapp-partial-reply-", async () => {
        const controller = new AbortController();
        const sendMessage = vi.fn<ActiveWebListener["sendMessage"]>(async () => {
          if (sendMessage.mock.calls.length > 1) {
            throw new Error("transport failed");
          }
          return createAcceptedWhatsAppSendResult("text", "accepted-first");
        });
        runtimeContextMocks.controllers.set(accountId, {
          getActiveListener: () => ({ sendMessage, sendComposingTo: vi.fn() }),
        });
        const result = await sendDurableMessageBatch({
          cfg: { channels: { whatsapp: { textChunkLimit: 160 } } },
          channel: "whatsapp",
          to: "+1555",
          payloads: [{ text: `**${"x".repeat(340)}**` }],
          signal: controller.signal,
          onDeliveryResult: () => {
            if (failure === "abort") {
              controller.abort(new Error("cancelled after first part"));
            }
          },
          durability: "required",
        });
        expect(result).toMatchObject({
          status: "partial_failed",
          results: [{ messageId: "accepted-first" }],
          receipt: { platformMessageIds: ["accepted-first"] },
        });
        expect(sendMessage).toHaveBeenCalledTimes(failure === "abort" ? 1 : 2);
      });
    },
  );

  it("keeps pre-connect recovery replayable, then sends exactly once after connect", async () => {
    await withStateDirEnv("openclaw-whatsapp-delivery-recovery-", async ({ stateDir }) => {
      const initialResult = await sendDurableMessageBatch({
        cfg,
        channel: "whatsapp",
        to: "+1555",
        payloads: [{ text: "queued before listener startup" }],
        durability: "required",
      });
      expect(initialResult).toMatchObject({
        status: "failed",
        error: {
          cause: expect.any(PlatformMessageNotDispatchedError),
        },
      });

      const preConnectLog = await drainDefaultWhatsAppDeliveries(stateDir);
      expect(preConnectLog.warn).toHaveBeenCalledWith(
        expect.stringContaining("No active WhatsApp Web listener"),
      );

      const sendMessage = vi.fn(async () =>
        createAcceptedWhatsAppSendResult("text", "recovered-message"),
      );
      const listener: ActiveWebListener = {
        sendComposingTo: vi.fn(async () => {}),
        sendMessage,
        sendPoll: vi.fn(async () => createAcceptedWhatsAppSendResult("poll", "poll")),
        sendReaction: vi.fn(async () => createAcceptedWhatsAppSendResult("reaction", "reaction")),
      };
      const controller = {
        getActiveListener: () => listener,
        getCurrentSock: () => null,
        getSelfIdentity: () => null,
      };
      runtimeContextMocks.controllers.set(accountId, controller);

      await drainDefaultWhatsAppDeliveries(stateDir);
      await drainDefaultWhatsAppDeliveries(stateDir);

      expect(sendMessage).toHaveBeenCalledTimes(1);
      expect(sendMessage).toHaveBeenCalledWith(
        "+1555",
        "queued before listener startup",
        undefined,
        undefined,
      );
    });
  });
});
