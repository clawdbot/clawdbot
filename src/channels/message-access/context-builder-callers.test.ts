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
  ["extensions/matrix/src/matrix/monitor/handler-context.ts", "channelIngress:"],
  ["extensions/msteams/src/monitor-handler/inbound-dispatch.ts", "channelIngress:"],
  ["extensions/nextcloud-talk/src/inbound.ts", "channelIngress: access"],
  ["extensions/qa-channel/src/inbound.ts", "channelIngress: access"],
  ["extensions/raft/src/inbound.ts", 'channelIngress: "unsupported"'],
  ["extensions/signal/src/monitor/event-handler.ts", "channelIngress: entry.channelIngress"],
  ["extensions/slack/src/monitor/message-handler/prepare.ts", "channelIngress: messageIngress"],
  ["extensions/sms/src/inbound.ts", "channelIngress: auth"],
  ["extensions/synology-chat/src/inbound-event.ts", "channelIngress: params.msg.channelIngress"],
  [
    "extensions/telegram/src/bot-message-context.session.ts",
    "channelIngress: options?.channelIngress",
  ],
  ["extensions/tlon/src/monitor/index.ts", "channelIngress,"],
  ["extensions/twitch/src/monitor.ts", "channelIngress,"],
  ["extensions/whatsapp/src/auto-reply/monitor/prepared-inbound.ts", '| "channelIngress"'],
  ["extensions/zalo/src/monitor.ts", "channelIngress,"],
  ["extensions/zalouser/src/monitor.ts", "channelIngress: accessDecision"],
  ["src/channels/direct-dm.ts", "channelIngress: params.channelIngress"],
  ["src/channels/feedback-reflection.ts", 'channelIngress: "unsupported"'],
] as const;

function source(relativePath: string): string {
  return fs.readFileSync(path.join(process.cwd(), relativePath), "utf8");
}

describe("channel context builder caller inventory", () => {
  it("keeps all 26 production sinks wired to exact ingress or named unsupported paths", () => {
    expect(CALLERS).toHaveLength(26);
    for (const [relativePath, marker] of CALLERS) {
      expect(source(relativePath), relativePath).toContain(marker);
    }
  });

  it("keeps direct-DM classifications at their authoritative producers", () => {
    expect(source("extensions/nostr/src/gateway.ts")).toContain("channelIngress: resolvedAccess");
    expect(source("extensions/reef/src/channel.ts")).toContain('channelIngress: "unsupported"');
  });
});
