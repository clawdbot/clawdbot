// Root-owned integration combines shared delivery with public plugin surfaces.
import { afterEach, describe, expect, it, vi } from "vitest";
import { telegramOutbound } from "../extensions/telegram/api.js";
import { createDirectTextMediaOutbound } from "../src/channels/plugins/outbound/direct-text-media.js";
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
});
