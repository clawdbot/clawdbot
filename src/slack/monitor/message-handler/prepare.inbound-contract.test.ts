import type { App } from "@slack/bolt";
import { describe, expect, it } from "vitest";

import type { MoltbotConfig } from "../../../config/config.js";
import type { RuntimeEnv } from "../../../runtime.js";
import { expectInboundContextContract } from "../../../../test/helpers/inbound-contract.js";
import type { ResolvedSlackAccount } from "../../accounts.js";
import type { SlackMessageEvent } from "../../types.js";
import { createSlackMonitorContext } from "../context.js";
import { prepareSlackMessage } from "./prepare.js";

describe("slack prepareSlackMessage inbound contract", () => {
  it("produces a finalized MsgContext", async () => {
    const slackCtx = createSlackMonitorContext({
      cfg: {
        channels: { slack: { enabled: true } },
      } as MoltbotConfig,
      accountId: "default",
      botToken: "token",
      app: { client: {} } as App,
      runtime: {} as RuntimeEnv,
      botUserId: "B1",
      teamId: "T1",
      apiAppId: "A1",
      historyLimit: 0,
      sessionScope: "per-sender",
      mainKey: "main",
      dmEnabled: true,
      dmPolicy: "open",
      allowFrom: [],
      groupDmEnabled: true,
      groupDmChannels: [],
      defaultRequireMention: true,
      groupPolicy: "open",
      useAccessGroups: false,
      reactionMode: "off",
      reactionAllowlist: [],
      replyToMode: "off",
      threadHistoryScope: "thread",
      threadInheritParent: false,
      slashCommand: {
        enabled: false,
        name: "clawd",
        sessionPrefix: "slack:slash",
        ephemeral: true,
      },
      textLimit: 4000,
      ackReactionScope: "group-mentions",
      mediaMaxBytes: 1024,
      removeAckAfterReply: false,
    });
    slackCtx.resolveUserName = async () => ({ name: "Alice" }) as any;

    const account: ResolvedSlackAccount = {
      accountId: "default",
      enabled: true,
      botTokenSource: "config",
      appTokenSource: "config",
      config: {},
    };

    const message: SlackMessageEvent = {
      channel: "D123",
      channel_type: "im",
      user: "U1",
      text: "hi",
      ts: "1.000",
    } as SlackMessageEvent;

    const prepared = await prepareSlackMessage({
      ctx: slackCtx,
      account,
      message,
      opts: { source: "message" },
    });

    expect(prepared).toBeTruthy();
    expectInboundContextContract(prepared!.ctxPayload as any);
  });

  it("sets MessageThreadId for top-level messages when replyToMode=all", async () => {
    const slackCtx = createSlackMonitorContext({
      cfg: {
        channels: { slack: { enabled: true, replyToMode: "all" } },
      } as MoltbotConfig,
      accountId: "default",
      botToken: "token",
      app: { client: {} } as App,
      runtime: {} as RuntimeEnv,
      botUserId: "B1",
      teamId: "T1",
      apiAppId: "A1",
      historyLimit: 0,
      sessionScope: "per-sender",
      mainKey: "main",
      dmEnabled: true,
      dmPolicy: "open",
      allowFrom: [],
      groupDmEnabled: true,
      groupDmChannels: [],
      defaultRequireMention: true,
      groupPolicy: "open",
      useAccessGroups: false,
      reactionMode: "off",
      reactionAllowlist: [],
      replyToMode: "all",
      threadHistoryScope: "thread",
      threadInheritParent: false,
      slashCommand: {
        enabled: false,
        name: "clawd",
        sessionPrefix: "slack:slash",
        ephemeral: true,
      },
      textLimit: 4000,
      ackReactionScope: "group-mentions",
      mediaMaxBytes: 1024,
      removeAckAfterReply: false,
    });
    slackCtx.resolveUserName = async () => ({ name: "Alice" }) as any;

    const account: ResolvedSlackAccount = {
      accountId: "default",
      enabled: true,
      botTokenSource: "config",
      appTokenSource: "config",
      config: { replyToMode: "all" },
    };

    const message: SlackMessageEvent = {
      channel: "D123",
      channel_type: "im",
      user: "U1",
      text: "hi",
      ts: "1.000",
    } as SlackMessageEvent;

    const prepared = await prepareSlackMessage({
      ctx: slackCtx,
      account,
      message,
      opts: { source: "message" },
    });

    expect(prepared).toBeTruthy();
    expect(prepared!.ctxPayload.MessageThreadId).toBe("1.000");
  });
});
