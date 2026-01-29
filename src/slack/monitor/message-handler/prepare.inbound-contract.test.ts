import type { App } from "@slack/bolt";
import { describe, expect, it, vi } from "vitest";

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
      canvasMaxBytes: 1024,
      canvasTextMaxChars: 2000,
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
      canvasMaxBytes: 1024,
      canvasTextMaxChars: 2000,
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

  it("appends canvas content to the inbound body", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ title: "Canvas", text: "hello canvas" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const filesInfo = vi.fn(async () => ({
      file: {
        id: "F12345678",
        title: "Project Canvas",
        url_private_download: "https://files.slack.com/canvas.json",
      },
    }));

    const slackCtx = createSlackMonitorContext({
      cfg: {
        channels: { slack: { enabled: true } },
      } as ClawdbotConfig,
      accountId: "default",
      botToken: "token",
      app: { client: { files: { info: filesInfo } } } as App,
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
      canvasMaxBytes: 1024,
      canvasTextMaxChars: 2000,
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
      text: "see canvas",
      ts: "1.000",
      files: [{ id: "F12345678", mimetype: "application/vnd.slack-docs" }],
    } as SlackMessageEvent;

    const prepared = await prepareSlackMessage({
      ctx: slackCtx,
      account,
      message,
      opts: { source: "message" },
    });

    expect(prepared).toBeTruthy();
    expect(prepared!.ctxPayload.Body).toContain("[Slack Canvas: Project Canvas]");
    expect(prepared!.ctxPayload.Body).toContain("hello canvas");
    vi.unstubAllGlobals();
  });
});
