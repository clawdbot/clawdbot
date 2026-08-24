import { telegramPlugin } from "../extensions/telegram/src/channel.js";
import { buildReplyPayloads } from "../src/auto-reply/reply/agent-runner-payloads.js";
import type { OpenClawConfig } from "../src/config/types.openclaw.js";
import { resolveSendableOutboundReplyParts } from "../src/plugin-sdk/reply-payload.js";
import { createPluginRecord } from "../src/plugins/loader-records.js";
import { createPluginRegistry } from "../src/plugins/registry.js";
import { setActivePluginRegistry } from "../src/plugins/runtime.js";
import type { PluginRuntime } from "../src/plugins/runtime/types.js";

const cfg = {
  channels: {
    telegram: {
      botToken: "000000:REDACTED-PROOF-TOKEN",
    },
  },
} as OpenClawConfig;

const record = createPluginRecord({
  id: "telegram",
  name: "Telegram",
  source: "extensions/telegram/src/channel.ts",
  origin: "bundled",
  enabled: true,
  configSchema: true,
});

const registryBuilder = createPluginRegistry({
  logger: { info() {}, warn() {}, error() {}, debug() {} },
  runtime: {} as PluginRuntime,
  activateGlobalSideEffects: false,
});
registryBuilder.registerChannel(record, telegramPlugin);
registryBuilder.registry.plugins.push(record);
setActivePluginRegistry(registryBuilder.registry, "pr-128580-real-channel-proof");

type SendCall = {
  to: string;
  text: string;
  mediaUrl?: string;
};

const sendCalls: SendCall[] = [];
const loopbackSend = async (
  to: string,
  text: string,
  options: { mediaUrl?: string },
): Promise<{ messageId: string; chatId: string }> => {
  sendCalls.push({ to, text, ...(options.mediaUrl ? { mediaUrl: options.mediaUrl } : {}) });
  return { messageId: `proof-${sendCalls.length}`, chatId: to };
};

async function build(payload: { text: string; mediaUrl?: string; mediaUrls?: string[] }) {
  return await buildReplyPayloads({
    isHeartbeat: false,
    didLogHeartbeatStrip: false,
    blockStreamingEnabled: false,
    blockReplyPipeline: null,
    replyToMode: "off",
    payloads: [payload],
    messageProvider: "telegram",
    originatingChannel: "telegram",
    originatingTo: "12345",
    messagingToolSentTexts: ["duplicate text"],
  });
}

const blankPayload = { text: "duplicate text", mediaUrl: "   " };
const realPayload = { text: "duplicate text", mediaUrl: "https://example.com/report.png" };
const blankResult = await build(blankPayload);
const realResult = await build(realPayload);

const sendPayload = telegramPlugin.outbound?.sendPayload;
if (!sendPayload) {
  throw new Error("Telegram production plugin has no outbound.sendPayload");
}

async function deliver(payloads: ReadonlyArray<(typeof blankResult.replyPayloads)[number]>) {
  const start = sendCalls.length;
  for (const payload of payloads) {
    await sendPayload({
      cfg,
      to: "12345",
      text: payload.text ?? "",
      payload,
      deps: { telegram: loopbackSend },
    });
  }
  return sendCalls.length - start;
}

const blankOutboundCalls = await deliver(blankResult.replyPayloads);
const realOutboundCalls = await deliver(realResult.replyPayloads);

const blankParts = resolveSendableOutboundReplyParts(blankPayload);
const realParts = resolveSendableOutboundReplyParts(realPayload);
const legacyBlankHasMedia = Boolean(blankPayload.mediaUrl || blankPayload.mediaUrls?.length);

console.log(
  JSON.stringify(
    {
      registry: {
        channelId: registryBuilder.registry.channels[0]?.plugin.id,
        source: registryBuilder.registry.channels[0]?.source,
        implementation: "extensions/telegram/src/channel.ts -> telegramPlugin.outbound.sendPayload",
      },
      blankMedia: {
        legacyPredicateHasMedia: legacyBlankHasMedia,
        canonicalHasMedia: blankParts.hasMedia,
        retainedPayloads: blankResult.replyPayloads.length,
        outboundCalls: blankOutboundCalls,
      },
      realMedia: {
        canonicalHasMedia: realParts.hasMedia,
        retainedPayloads: realResult.replyPayloads.length,
        outboundCalls: realOutboundCalls,
        loopbackCalls: sendCalls,
      },
    },
    null,
    2,
  ),
);
