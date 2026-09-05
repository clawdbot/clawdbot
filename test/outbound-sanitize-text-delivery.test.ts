// Root-owned integration combines shared delivery with public plugin surfaces.
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { googlechatPlugin } from "../extensions/googlechat/api.js";
import { ircPlugin } from "../extensions/irc/api.js";
import { telegramOutbound } from "../extensions/telegram/api.js";
import { whatsappPlugin } from "../extensions/whatsapp/api.js";
import { createDirectTextMediaOutbound } from "../src/channels/plugins/outbound/direct-text-media.js";
import type { ChannelOutboundAdapter } from "../src/channels/plugins/types.adapters.js";
import type { OpenClawConfig } from "../src/config/types.openclaw.js";
import { deliverOutboundPayloadsCore } from "../src/infra/outbound/deliver-core.js";
import { prepareOutboundPayloadBatch } from "../src/infra/outbound/deliver-prepare.js";
import { createEmptyPluginRegistry } from "../src/plugins/registry.js";
import { setActivePluginRegistry } from "../src/plugins/runtime.js";
import { createOutboundTestPlugin, createTestRegistry } from "../src/test-utils/channel-plugins.js";

const literalCode = '`<p class="literal">code</p>`';
const fixtures = [
  {
    text: `before<p title="a>b">inside</p>after\n\n${literalCode}`,
    plainText: `before\ninside\nafter\n\n${literalCode}`,
  },
  {
    text: `before<div title='a>b'>inside</div>after\n\n${literalCode}`,
    plainText: `before\ninside\nafter\n\n${literalCode}`,
  },
  {
    text: 'before<a href="`hidden`">click</a> then `visible`',
    plainText: "beforeclick then `visible`",
  },
];
const payloads = fixtures.map(({ text }) => ({ text }));

const sharedPlainTextSiblings: ReadonlyArray<
  readonly [
    label: string,
    channel: "googlechat" | "irc" | "whatsapp",
    source: Pick<ChannelOutboundAdapter, "sanitizeText" | "normalizePayload">,
  ]
> = [
  [
    "Google Chat",
    "googlechat",
    expectDefined(googlechatPlugin.outbound, "googlechatPlugin.outbound"),
  ],
  ["IRC", "irc", expectDefined(ircPlugin.outbound, "ircPlugin.outbound")],
  ["WhatsApp", "whatsapp", expectDefined(whatsappPlugin.outbound, "whatsappPlugin.outbound")],
];

afterEach(() => {
  setActivePluginRegistry(createEmptyPluginRegistry());
});

describe("HTML sanitization through outbound delivery", () => {
  it.each(["default Telegram", "rich Telegram", "direct text/media"] as const)(
    "preserves the %s transport contract",
    async (mode) => {
      const send = vi.fn(async (_to: string, _text: string) => ({
        messageId: "fixture-message",
        chatId: "12345",
      }));
      const channel = mode === "direct text/media" ? "imessage" : "telegram";
      const cfg: OpenClawConfig =
        mode === "rich Telegram" ? { channels: { telegram: { richMessages: true } } } : {};
      const outbound =
        channel === "telegram"
          ? telegramOutbound
          : createDirectTextMediaOutbound({
              channel,
              resolveSender: () => send,
              resolveMaxBytes: () => undefined,
              buildTextOptions: () => ({}),
              buildMediaOptions: () => ({}),
            });
      setActivePluginRegistry(
        createTestRegistry([
          {
            pluginId: channel,
            source: "test",
            plugin: createOutboundTestPlugin({ id: channel, outbound }),
          },
        ]),
      );
      const params = { cfg, channel, to: "12345", payloads, deps: { telegram: send } };
      const preparedBatch = await prepareOutboundPayloadBatch(params);
      const results = await deliverOutboundPayloadsCore({ ...params, preparedBatch });

      expect(results).toHaveLength(payloads.length);
      expect(send.mock.calls.map(([to, text]) => ({ to, text }))).toEqual(
        fixtures.map(({ text, plainText }) => ({
          to: "12345",
          text: mode === "rich Telegram" ? text : plainText,
        })),
      );
    },
  );

  it.each(["default Telegram", "direct text/media"] as const)(
    "keeps the unspaced angle-link label on the %s delivery boundary",
    async (mode) => {
      const send = vi.fn(async (_to: string, _text: string) => ({
        messageId: "fixture-message",
        chatId: "12345",
      }));
      const channel = mode === "direct text/media" ? "imessage" : "telegram";
      const outbound =
        channel === "telegram"
          ? telegramOutbound
          : createDirectTextMediaOutbound({
              channel,
              resolveSender: () => send,
              resolveMaxBytes: () => undefined,
              buildTextOptions: () => ({}),
              buildMediaOptions: () => ({}),
            });
      setActivePluginRegistry(
        createTestRegistry([
          {
            pluginId: channel,
            source: "test",
            plugin: createOutboundTestPlugin({ id: channel, outbound }),
          },
        ]),
      );
      const params = {
        cfg: {} satisfies OpenClawConfig,
        channel,
        to: "12345",
        payloads: [{ text: "<https://example.com/a.pdf|Manual>" }],
        deps: { telegram: send },
      };
      const preparedBatch = await prepareOutboundPayloadBatch(params);
      const results = await deliverOutboundPayloadsCore({ ...params, preparedBatch });

      expect(results).toHaveLength(1);
      expect(send.mock.calls.map(([to, text]) => ({ to, text }))).toEqual([
        { to: "12345", text: "Manual" },
      ]);
    },
  );

  it.each(sharedPlainTextSiblings)(
    "keeps the unspaced angle-link label on the %s outbound delivery boundary",
    async (_label, channel, source) => {
      const send = vi.fn(
        async (params: Parameters<NonNullable<ChannelOutboundAdapter["sendText"]>>[0]) => ({
          channel,
          messageId: "fixture-message",
          to: params.to,
          text: params.text,
        }),
      );
      const outbound: ChannelOutboundAdapter = {
        deliveryMode: "direct",
        ...(source.sanitizeText ? { sanitizeText: source.sanitizeText } : {}),
        ...(source.normalizePayload ? { normalizePayload: source.normalizePayload } : {}),
        sendText: send,
      };
      setActivePluginRegistry(
        createTestRegistry([
          {
            pluginId: channel,
            source: "test",
            plugin: createOutboundTestPlugin({ id: channel, outbound }),
          },
        ]),
      );
      const params = {
        cfg: {} satisfies OpenClawConfig,
        channel,
        to: "12345",
        payloads: [{ text: "<https://example.com/a.pdf|Manual>" }],
      };
      const preparedBatch = await prepareOutboundPayloadBatch(params);
      const results = await deliverOutboundPayloadsCore({ ...params, preparedBatch });

      expect(results).toHaveLength(1);
      expect(send.mock.calls.map(([call]) => ({ to: call.to, text: call.text }))).toEqual([
        { to: "12345", text: "Manual" },
      ]);
    },
  );
});
