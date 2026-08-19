import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const CALLERS = [
  ["extensions/buzz/src/inbound.ts", "channelIngress: access"],
  ["extensions/clickclack/src/inbound.ts", "channelIngress: access.channelIngress"],
  ["extensions/discord/src/monitor/message-handler.context.ts", "channelIngress,"],
  ["extensions/feishu/src/bot.ts", "channelIngress:"],
  ["extensions/feishu/src/comment-handler.ts", "channelIngress:"],
  ["extensions/googlechat/src/monitor.ts", "channelIngress: access.channelIngress"],
  [
    "extensions/imessage/src/monitor/inbound-processing.ts",
    "channelIngress: decision.channelIngress",
  ],
  ["extensions/irc/src/inbound.ts", "channelIngress: access"],
  ["extensions/line/src/bot-message-context.ts", "channelIngress: params.channelIngress"],
  ["extensions/matrix/src/matrix/monitor/handler-context.ts", "channelIngress,"],
  ["extensions/msteams/src/monitor-handler/inbound-dispatch.ts", "channelIngress:"],
  ["extensions/nextcloud-talk/src/inbound.ts", "channelIngress: access"],
  ["extensions/qa-channel/src/inbound.ts", "channelIngress: access"],
  ["extensions/raft/src/inbound.ts", 'channelIngress: "unsupported"'],
  ["extensions/signal/src/monitor/event-handler.ts", "channelIngress: entry.channelIngress"],
  ["extensions/slack/src/monitor/message-handler/prepare.ts", "channelIngress: messageIngress"],
  ["extensions/sms/src/inbound.ts", "channelIngress: auth"],
  ["extensions/synology-chat/src/inbound-event.ts", "channelIngress,"],
  ["extensions/telegram/src/bot-message-context.session.ts", "channelIngress,"],
  ["extensions/tlon/src/monitor/index.ts", "channelIngress,"],
  ["extensions/twitch/src/monitor.ts", "channelIngress,"],
  ["extensions/whatsapp/src/auto-reply/monitor/prepared-inbound.ts", '| "channelIngress"'],
  ["extensions/zalo/src/monitor.ts", "channelIngress,"],
  ["extensions/zalouser/src/monitor.ts", "channelIngress: accessDecision"],
  ["src/channels/direct-dm.ts", "channelIngress: params.channelIngress"],
  ["src/channels/feedback-reflection.ts", 'channelIngress: "unsupported"'],
] as const;

const CONTEXT_BINDING_PRODUCERS = [
  "extensions/buzz/src/inbound.ts",
  "extensions/clickclack/src/access.ts",
  "extensions/discord/src/monitor/message-handler.preflight.ts",
  "extensions/feishu/src/policy.ts",
  "extensions/googlechat/src/monitor-access.ts",
  "extensions/imessage/src/monitor/inbound-processing.ts",
  "extensions/irc/src/inbound.ts",
  "extensions/line/src/bot-handlers.ts",
  "extensions/matrix/src/matrix/monitor/access-state.ts",
  "extensions/msteams/src/monitor-handler/access.ts",
  "extensions/nextcloud-talk/src/inbound.ts",
  "extensions/nostr/src/gateway.ts",
  "extensions/qa-channel/src/inbound.ts",
  "extensions/signal/src/monitor/access-policy.ts",
  "extensions/slack/src/monitor/auth.ts",
  "extensions/sms/src/inbound.ts",
  "extensions/synology-chat/src/security.ts",
  "extensions/telegram/src/bot-handlers.inbound-authorization.ts",
  "extensions/tlon/src/monitor/utils.ts",
  "extensions/twitch/src/access-control.ts",
  "extensions/whatsapp/src/inbound-policy.ts",
  "extensions/zalo/src/monitor.ts",
  "extensions/zalouser/src/monitor.ts",
] as const;

const HOST_BUILDERS = [
  ["extensions/buzz/src/inbound.ts", "params.buildContext ?? buildChannelInboundEventContext"],
  [
    "extensions/clickclack/src/inbound.ts",
    "params.buildContext ?? buildChannelInboundEventContext",
  ],
  [
    "extensions/discord/src/monitor/message-handler.context.ts",
    "ctx.buildContext ?? buildChannelInboundEventContext",
  ],
  ["extensions/feishu/src/bot.ts", "core.channel.inbound.buildContext"],
  ["extensions/feishu/src/comment-handler.ts", "core.channel.inbound.buildContext"],
  ["extensions/googlechat/src/monitor.ts", "core.channel.inbound.buildContext"],
  [
    "extensions/imessage/src/monitor/inbound-processing.ts",
    "params.buildContext ?? buildChannelInboundEventContext",
  ],
  ["extensions/irc/src/inbound.ts", "core.channel.inbound.buildContext"],
  [
    "extensions/line/src/bot-message-context.ts",
    "params.buildContext ?? buildChannelInboundEventContext",
  ],
  ["extensions/matrix/src/matrix/monitor/handler-context.ts", "core.channel.inbound.buildContext"],
  [
    "extensions/msteams/src/monitor-handler/inbound-dispatch.ts",
    "core.channel.inbound.buildContext",
  ],
  ["extensions/nextcloud-talk/src/inbound.ts", "core.channel.inbound.buildContext"],
  [
    "extensions/qa-channel/src/inbound.ts",
    "params.buildContext ?? buildChannelInboundEventContext",
  ],
  ["extensions/raft/src/inbound.ts", "channelRuntime.inbound.buildContext"],
  ["extensions/signal/src/monitor/event-handler.ts", "deps.channelRuntime?.inbound.buildContext"],
  [
    "extensions/slack/src/monitor/message-handler/prepare.ts",
    "ctx.buildContext ?? buildChannelInboundEventContext",
  ],
  ["extensions/sms/src/inbound.ts", "params.channelRuntime.inbound.buildContext"],
  ["extensions/synology-chat/src/inbound-event.ts", "resolved.rt.channel.inbound.buildContext"],
  [
    "extensions/telegram/src/bot-message-context.session.ts",
    "sessionRuntime.buildChannelInboundEventContext",
  ],
  ["extensions/tlon/src/monitor/index.ts", "core.channel.inbound.buildContext"],
  ["extensions/twitch/src/monitor.ts", "core.channel.inbound.buildContext"],
  ["extensions/whatsapp/src/auto-reply/monitor/prepared-inbound.ts", "params.buildContext({"],
  ["extensions/zalo/src/monitor.ts", "core.channel.inbound.buildContext"],
  ["extensions/zalouser/src/monitor.ts", "core.channel.inbound.buildContext"],
  [
    "src/channels/direct-dm.ts",
    "const injectedBuilder = params.channelRuntime?.inbound?.buildContext",
  ],
  ["src/channels/feedback-reflection.ts", "buildHostChannelInboundEventContext"],
] as const;

const LATE_GLOBAL_BUILDERS = [
  ["extensions/buzz/src/inbound.ts", "runtime.channel.inbound.buildContext"],
  ["extensions/clickclack/src/inbound.ts", "runtime.channel.inbound.buildContext"],
  [
    "extensions/discord/src/monitor/message-handler.context.ts",
    "getDiscordRuntime().channel.inbound.buildContext",
  ],
  [
    "extensions/imessage/src/monitor/inbound-processing.ts",
    "getIMessageRuntime().channel.inbound.buildContext",
  ],
  ["extensions/line/src/bot-message-context.ts", "getLineRuntime().channel.inbound.buildContext"],
  ["extensions/qa-channel/src/inbound.ts", "runtime.channel.inbound.buildContext"],
  [
    "extensions/slack/src/monitor/message-handler/prepare.ts",
    "getSlackRuntime().channel.inbound.buildContext",
  ],
  [
    "extensions/telegram/src/bot-deps.ts",
    "getTelegramRuntime().channel.inbound\n      .buildContext",
  ],
  [
    "extensions/whatsapp/src/auto-reply/monitor/inbound-dispatch.ts",
    "getWhatsAppRuntime().channel.inbound.buildContext",
  ],
] as const;

const SCOPED_BUILDER_HANDOFFS = [
  [
    "buzz",
    "extensions/buzz/src/gateway.ts",
    "const buildContext = channelRuntime?.inbound.buildContext",
  ],
  ["clickclack", "extensions/clickclack/src/gateway.ts", "buildContext: params.buildContext"],
  [
    "discord",
    "extensions/discord/src/monitor/provider.ts",
    'opts.channelRuntime as PluginRuntime["channel"] | undefined',
  ],
  [
    "imessage",
    "extensions/imessage/src/monitor/monitor-provider.ts",
    'opts.channelRuntime as PluginRuntime["channel"] | undefined',
  ],
  [
    "line",
    "extensions/line/src/gateway.ts",
    'ctx.channelRuntime as PluginRuntime["channel"] | undefined',
  ],
  ["line", "extensions/line/src/bot.ts", "buildContext: opts.buildContext"],
  ["line", "extensions/line/src/bot-handlers.ts", "buildContext: context.buildContext"],
  ["nostr", "extensions/nostr/src/gateway.ts", "channelRuntime,"],
  [
    "qa-channel",
    "extensions/qa-channel/src/gateway.ts",
    "channelRuntime?.inbound.buildContext ?? buildChannelInboundEventContext",
  ],
  [
    "slack",
    "extensions/slack/src/monitor/context.ts",
    'params.channelRuntime as PluginRuntime["channel"] | undefined',
  ],
  [
    "telegram-webhook",
    "extensions/telegram/src/monitor.ts",
    'opts.channelRuntime as PluginRuntime["channel"] | undefined',
  ],
  ["telegram-webhook", "extensions/telegram/src/webhook.ts", "buildContext: opts.buildContext"],
  [
    "telegram-polling",
    "extensions/telegram/src/polling-session.ts",
    "buildContext: this.opts.buildContext",
  ],
  ["telegram", "extensions/telegram/src/bot-core.ts", "buildContext: opts.buildContext"],
  [
    "telegram",
    "extensions/telegram/src/bot-message.ts",
    "buildContext ?? telegramDeps.buildChannelInboundEventContext",
  ],
  [
    "whatsapp",
    "extensions/whatsapp/src/auto-reply/monitor.ts",
    'tuning.channelRuntime as PluginRuntime["channel"] | undefined',
  ],
  [
    "whatsapp",
    "extensions/whatsapp/src/auto-reply/monitor/on-message.ts",
    "buildContext: params.buildContext",
  ],
  [
    "whatsapp",
    "extensions/whatsapp/src/auto-reply/monitor/process-message.ts",
    "buildContext: params.buildContext",
  ],
] as const;

function source(relativePath: string): string {
  return fs.readFileSync(path.join(process.cwd(), relativePath), "utf8");
}

describe("channel context builder caller inventory", () => {
  it("keeps all production sinks wired to exact ingress or named unsupported paths", () => {
    for (const [relativePath, marker] of CALLERS) {
      expect(source(relativePath), relativePath).toContain(marker);
    }
  });

  it("binds all supported producers to finalized host context identity", () => {
    for (const relativePath of CONTEXT_BINDING_PRODUCERS) {
      expect(source(relativePath), relativePath).toContain("contextBinding");
    }
  });

  it("routes every production sink through its selected context builder", () => {
    for (const [relativePath, marker] of HOST_BUILDERS) {
      expect(source(relativePath), relativePath).toContain(marker);
    }
    expect(source("extensions/signal/src/monitor.ts")).toContain(
      "channelRuntime: opts.channelRuntime",
    );
    expect(source("extensions/telegram/src/monitor.ts")).toContain(
      'opts.channelRuntime as PluginRuntime["channel"] | undefined',
    );
    expect(source("extensions/whatsapp/src/auto-reply/monitor.ts")).toContain(
      'tuning.channelRuntime as PluginRuntime["channel"] | undefined',
    );
  });

  it("does not rediscover host context builders through process-global runtime stores", () => {
    for (const [relativePath, marker] of LATE_GLOBAL_BUILDERS) {
      expect(source(relativePath), relativePath).not.toContain(marker);
    }
  });

  it("hands scoped context builders from each migrated startup path to its sink", () => {
    for (const [chain, relativePath, marker] of SCOPED_BUILDER_HANDOFFS) {
      expect(source(relativePath), `${chain}: ${relativePath}`).toContain(marker);
    }
  });

  it("keeps direct-DM classifications at their authoritative producers", () => {
    expect(source("extensions/nostr/src/gateway.ts")).toContain(
      "resolveChannelIngress: async (contextBinding)",
    );
    expect(source("extensions/nostr/src/gateway.ts")).toContain("channelRuntime,");
    expect(source("src/channels/direct-dm.ts")).toContain(
      "const injectedBuilder = params.channelRuntime?.inbound?.buildContext",
    );
    expect(source("extensions/reef/src/channel.ts")).toContain('channelIngress: "unsupported"');
  });
});
