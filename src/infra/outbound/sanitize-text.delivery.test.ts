// Exercises sanitizer selection and the recorded transport output through real outbound delivery.
import { afterEach, describe, expect, it, vi } from "vitest";
import { telegramOutbound } from "../../../extensions/telegram/api.js";
import { createDirectTextMediaOutbound } from "../../channels/plugins/outbound/direct-text-media.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createEmptyPluginRegistry } from "../../plugins/registry.js";
import { setActivePluginRegistry } from "../../plugins/runtime.js";
import { createOutboundTestPlugin, createTestRegistry } from "../../test-utils/channel-plugins.js";
import { deliverOutboundPayloadsCore } from "./deliver-core.js";
import { prepareOutboundPayloadBatch } from "./deliver-prepare.js";

const literalCode = '`<p class="literal">code</p>`';
const payloads = [
  { text: `before<p title="a>b">inside</p>after\n\n${literalCode}` },
  { text: `before<div title='a>b'>inside</div>after\n\n${literalCode}` },
];

afterEach(() => {
  setActivePluginRegistry(createEmptyPluginRegistry());
});

describe("HTML block boundaries through outbound delivery", () => {
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
        payloads.map(({ text }) => ({
          to: "12345",
          text: mode === "rich Telegram" ? text : `before\ninside\nafter\n\n${literalCode}`,
        })),
      );
    },
  );
});
