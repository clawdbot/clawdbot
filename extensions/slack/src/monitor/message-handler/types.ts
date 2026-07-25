// Slack type declarations define plugin contracts.
import type { MessageMetadata } from "@slack/types";
import type { HistoryEntry } from "openclaw/plugin-sdk/reply-history";
import type { FinalizedMsgContext } from "openclaw/plugin-sdk/reply-runtime";
import type { ResolvedAgentRoute } from "openclaw/plugin-sdk/routing";
import type { ResolvedSlackAccount } from "../../accounts.js";
import type { SlackSendIdentity } from "../../send.js";
import type { SlackMessageEvent } from "../../types.js";
import type { SlackChannelConfigResolved } from "../channel-config.js";
import type { SlackMonitorContext } from "../context.js";
import type { SlackEventScope } from "../event-scope.js";
import type { SlackIngressTurnLifecycle } from "../ingress.js";

export type PreparedSlackMessage = {
  ctx: SlackMonitorContext;
  account: ResolvedSlackAccount;
  message: SlackMessageEvent;
  relayIdentity?: SlackSendIdentity;
  eventScope?: SlackEventScope;
  turnAdoptionLifecycle?: SlackIngressTurnLifecycle;
  route: ResolvedAgentRoute;
  channelConfig: SlackChannelConfigResolved | null;
  replyTarget: string;
  ctxPayload: FinalizedMsgContext;
  turn: {
    storePath: string;
    record: unknown;
    history?: {
      isGroup?: boolean;
      historyKey?: string;
      historyMap?: Map<string, HistoryEntry[]>;
      limit?: number;
    };
  };
  replyToMode: "off" | "first" | "all" | "batched";
  forcedReplyThreadTs?: string;
  slackMessageMetadata?: MessageMetadata;
  requireMention: boolean;
  isDirectMessage: boolean;
  isRoomish: boolean;
  historyKey: string;
  preview: string;
  ackReactionMessageTs?: string;
  ackReactionValue: string;
  ackReactionPromise: Promise<boolean> | null;
};
