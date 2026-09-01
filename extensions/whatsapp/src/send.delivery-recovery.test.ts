// Whatsapp tests cover the durable outbound handoff across startup recovery.
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
import { createAcceptedWhatsAppSendResult } from "./inbound/send-result.test-helper.js";
import type { ActiveWebListener } from "./inbound/types.js";

const runtimeContextMocks = vi.hoisted(() => ({
  controllers: new Map<string, unknown>(),
}));

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
