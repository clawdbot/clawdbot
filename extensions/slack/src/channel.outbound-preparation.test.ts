import { createMessageReceiptFromOutboundResults } from "openclaw/plugin-sdk/channel-outbound";
import type { OutboundDeliveryResult } from "openclaw/plugin-sdk/channel-send-result";
import type { OpenClawConfig, SlackAccountConfig } from "openclaw/plugin-sdk/config-contracts";
import { describe, expect, it, vi } from "vitest";
import { slackPlugin } from "./channel.js";
import { registerSlackInstallationState } from "./installation-identity-state.js";

type SlackSend = typeof import("./send.runtime.js").sendMessageSlack;

const sendMethods = [
  { kind: "text", send: slackPlugin.outbound!.sendText! },
  { kind: "media", send: slackPlugin.outbound!.sendMedia! },
  { kind: "payload", send: slackPlugin.outbound!.sendPayload! },
] as const;

function createContext(
  account: SlackAccountConfig = {
    mode: "http",
    postAs: "user",
    userToken: "test-user-token",
  },
) {
  const cfg: OpenClawConfig = { channels: { slack: { accounts: { work: account } } } };
  return { cfg, accountId: "work", to: "channel:C123", text: "hello", payload: { text: "hello" } };
}

function createNativeSender() {
  let part = 0;
  return vi.fn<SlackSend>(async (_to, _text, options) => {
    await options.onPlatformSendDispatch?.();
    const messageId = `171.00${++part}`;
    const result = {
      messageId,
      channelId: "C123",
      receipt: createMessageReceiptFromOutboundResults({
        results: [{ channel: "slack", messageId }],
        kind: options.mediaUrl ? "media" : "text",
      }),
    };
    await options.onDeliveryResult?.(result);
    return result;
  });
}

describe("Slack public outbound preparation", () => {
  it.each(sendMethods)(
    "preserves token, custody, and receipts for $kind",
    async ({ kind, send }) => {
      const ctx = createContext();
      const originalConfig = structuredClone(ctx.cfg);
      const nativeSend = createNativeSender();
      const order: string[] = [];
      const progress: OutboundDeliveryResult[] = [];
      const result = await send({
        ...ctx,
        ...(kind === "media" ? { mediaUrl: "https://example.invalid/image.png" } : {}),
        payload: { text: "hello", presentation: { blocks: [{ type: "divider" }] } },
        deliveryQueueId: "queue-1",
        deps: { slack: nativeSend },
        onPlatformSendDispatch: async () => {
          order.push("dispatch");
        },
        onDeliveryResult: (delivery) => {
          order.push("receipt");
          progress.push(delivery);
        },
      });

      expect(nativeSend).toHaveBeenCalledOnce();
      const options = nativeSend.mock.calls[0]![2];
      expect(options.cfg).toBe(ctx.cfg);
      expect(options.accountId).toBe("work");
      expect(options.token).toBe("test-user-token");
      expect(options.deliveryQueueId).toBe(kind === "text" ? "queue-1" : undefined);
      expect(order).toEqual(["dispatch", "receipt"]);
      expect(progress).toMatchObject([
        { channel: "slack", messageId: "171.001", target: { kind: "channel", id: "C123" } },
      ]);
      expect(result).toMatchObject({
        channel: "slack",
        messageId: "171.001",
        target: { kind: "channel", id: "C123" },
        receipt: { platformMessageIds: ["171.001"] },
      });
      expect(ctx.cfg).toEqual(originalConfig);
    },
  );

  it.each(sendMethods)(
    "rejects active SecretRefs before an injected $kind send",
    async ({ send }) => {
      const nativeSend = createNativeSender();
      const ctx = createContext({
        mode: "http",
        botToken: { source: "exec", provider: "default", id: "fixture-slack-token" },
      });

      await expect(send({ ...ctx, deps: { slack: nativeSend } })).rejects.toThrow(
        "channels.slack.accounts.work.botToken",
      );
      expect(nativeSend).not.toHaveBeenCalled();
    },
  );

  it.each(sendMethods.filter(({ kind }) => kind !== "text"))(
    "rejects bare Enterprise targets before an injected $kind send",
    async ({ send }) => {
      const nativeSend = createNativeSender();
      const installation = registerSlackInstallationState("work", "enterprise");
      try {
        await expect(send({ ...createContext(), deps: { slack: nativeSend } })).rejects.toThrow(
          "unsupported_enterprise_slack_delivery",
        );
        expect(nativeSend).not.toHaveBeenCalled();
      } finally {
        installation.release();
      }
    },
  );

  it.each(["implicit", "explicit"] as const)(
    "preserves %s first-mode replies without resurrecting a consumed fallback thread",
    async (source) => {
      const nativeSend = createNativeSender();
      const progress: OutboundDeliveryResult[] = [];
      const result = await slackPlugin.outbound!.sendPayload!({
        ...createContext(),
        payload: {
          text: "caption",
          mediaUrls: ["https://example.invalid/1.png", "https://example.invalid/2.png"],
        },
        replyToId: "internal-message-id",
        threadId: "1712345678.123456",
        replyToMode: "first",
        replyToIdSource: source,
        deps: { slack: nativeSend },
        onDeliveryResult: (delivery) => {
          progress.push(delivery);
        },
      });

      expect(nativeSend.mock.calls.map((call) => call[2].threadTs)).toEqual([
        "1712345678.123456",
        source === "explicit" ? "1712345678.123456" : undefined,
      ]);
      expect(nativeSend.mock.calls.map(([, text]) => text)).toEqual(["caption", ""]);
      expect(progress.map(({ messageId }) => messageId)).toEqual(["171.001", "171.002"]);
      expect(result).toMatchObject({ channel: "slack", messageId: "171.002" });
    },
  );

  it.each([{ postAs: "user" as const }, { userTokenReadOnly: false }])(
    "keeps the selected sender and write token throughout payload fanout: %j",
    async (identity) => {
      const account: SlackAccountConfig = {
        mode: "http",
        userToken: "test-first-token",
        ...identity,
      };
      const nativeSend = createNativeSender();
      const replacementSend = createNativeSender();
      const deps = { slack: nativeSend };
      const firstSend = nativeSend.getMockImplementation()!;
      nativeSend.mockImplementationOnce(async (...args) => {
        account.userToken = "test-replacement-token";
        deps.slack = replacementSend;
        return await firstSend(...args);
      });

      const result = await slackPlugin.outbound!.sendPayload!({
        ...createContext(account),
        deps,
        payload: {
          text: "done",
          mediaUrls: ["https://example.invalid/image.png"],
          presentation: { blocks: [{ type: "divider" }] },
        },
      });

      expect(nativeSend.mock.calls.map((call) => call[2].token)).toEqual([
        "test-first-token",
        "test-first-token",
      ]);
      expect(replacementSend).not.toHaveBeenCalled();
      expect(result.receipt?.platformMessageIds).toEqual(["171.001", "171.002"]);
    },
  );
});
