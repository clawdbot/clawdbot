import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { App } from "@slack/bolt";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import { afterAll, describe, expect, it, vi } from "vitest";
import type { SlackMessageEvent } from "../../types.js";

const [{ prepareSlackMessage }, helpers] = await Promise.all([
  import("./prepare.js"),
  import("./prepare.test-helpers.js"),
]);
const { createInboundSlackTestContext, createSlackTestAccount } = helpers;
let fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-slack-room-thread-context-"));
let caseId = 0;

function makeTmpStorePath() {
  if (!fixtureRoot) {
    throw new Error("fixtureRoot missing");
  }
  const dir = path.join(fixtureRoot, `case-${caseId++}`);
  fs.mkdirSync(dir);
  return path.join(dir, "sessions.json");
}

type ThreadContextCaseParams = {
  channel: string;
  channelType: SlackMessageEvent["channel_type"];
  user: string;
  userName: string;
  starterText: string;
  followUpText: string;
  startTs: string;
  replyTs: string;
  followUpTs: string;
  currentTs: string;
  channelsConfig?: Parameters<typeof createInboundSlackTestContext>[0]["channelsConfig"];
  resolveChannelName?: (channelId: string) => Promise<{
    name?: string;
    type?: SlackMessageEvent["channel_type"];
    topic?: string;
    purpose?: string;
  }>;
};

async function prepareThreadContextCase(params: ThreadContextCaseParams) {
  const replies = vi
    .fn()
    .mockResolvedValueOnce({
      messages: [{ text: params.starterText, user: params.user, ts: params.startTs }],
    })
    .mockResolvedValueOnce({
      messages: [
        { text: params.starterText, user: params.user, ts: params.startTs },
        { text: "assistant reply", bot_id: "B1", ts: params.replyTs },
        { text: params.followUpText, user: params.user, ts: params.followUpTs },
        { text: "current message", user: params.user, ts: params.currentTs },
      ],
      response_metadata: { next_cursor: "" },
    });
  const ctx = createInboundSlackTestContext({
    cfg: {
      session: { store: makeTmpStorePath() },
      channels: {
        slack: {
          enabled: true,
          replyToMode: "all",
          groupPolicy: "open",
          contextVisibility: "allowlist",
        },
      },
    } as OpenClawConfig,
    appClient: { conversations: { replies } } as unknown as App["client"],
    defaultRequireMention: false,
    replyToMode: "all",
    channelsConfig: params.channelsConfig,
  });
  ctx.allowFrom = ["u-owner"];
  ctx.resolveUserName = async (id: string) => ({
    name: id === params.user ? params.userName : "Owner",
  });
  if (params.resolveChannelName) {
    ctx.resolveChannelName = params.resolveChannelName;
  }

  const prepared = await prepareSlackMessage({
    ctx,
    account: createSlackTestAccount({
      replyToMode: "all",
      thread: { initialHistoryLimit: 20 },
    }),
    message: {
      channel: params.channel,
      channel_type: params.channelType,
      user: params.user,
      text: "current message",
      ts: params.currentTs,
      thread_ts: params.startTs,
    } as SlackMessageEvent,
    opts: { source: "message" },
  });

  return { prepared, replies };
}

describe("prepareSlackMessage thread context allowlists", () => {
  afterAll(() => {
    if (fixtureRoot) {
      fs.rmSync(fixtureRoot, {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 50,
      });
      fixtureRoot = "";
    }
  });

  it("uses room users allowlist for thread context filtering", async () => {
    const { prepared, replies } = await prepareThreadContextCase({
      channel: "C123",
      channelType: "channel",
      user: "U1",
      userName: "Alice",
      starterText: "starter from room user",
      followUpText: "allowed follow-up",
      startTs: "100.000",
      replyTs: "100.500",
      followUpTs: "100.800",
      currentTs: "101.000",
      channelsConfig: {
        C123: {
          users: ["U1"],
          requireMention: false,
        },
      },
      resolveChannelName: async () => ({ name: "general", type: "channel" }),
    });

    expect(prepared).toBeTruthy();
    expect(prepared!.ctxPayload.ThreadStarterBody).toBe("starter from room user");
    expect(prepared!.ctxPayload.ThreadHistoryBody).toContain("starter from room user");
    expect(prepared!.ctxPayload.ThreadHistoryBody).toContain("allowed follow-up");
    expect(prepared!.ctxPayload.ThreadHistoryBody).not.toContain("assistant reply");
    expect(prepared!.ctxPayload.ThreadHistoryBody).not.toContain("current message");
    expect(replies).toHaveBeenCalledTimes(2);
  });

  it("does not apply the owner allowlist to open-room thread context", async () => {
    const { prepared, replies } = await prepareThreadContextCase({
      channel: "C124",
      channelType: "channel",
      user: "U2",
      userName: "Bob",
      starterText: "starter from open room",
      followUpText: "open-room follow-up",
      startTs: "200.000",
      replyTs: "200.500",
      followUpTs: "200.800",
      currentTs: "201.000",
      channelsConfig: {
        C124: {
          requireMention: false,
        },
      },
      resolveChannelName: async () => ({ name: "general", type: "channel" }),
    });

    expect(prepared).toBeTruthy();
    expect(prepared!.ctxPayload.ThreadStarterBody).toBe("starter from open room");
    expect(prepared!.ctxPayload.ThreadHistoryBody).toContain("starter from open room");
    expect(prepared!.ctxPayload.ThreadHistoryBody).toContain("open-room follow-up");
    expect(prepared!.ctxPayload.ThreadHistoryBody).not.toContain("assistant reply");
    expect(prepared!.ctxPayload.ThreadHistoryBody).not.toContain("current message");
    expect(replies).toHaveBeenCalledTimes(2);
  });

  it("does not apply the owner allowlist to open DMs when dmPolicy is open", async () => {
    const { prepared, replies } = await prepareThreadContextCase({
      channel: "D300",
      channelType: "im",
      user: "U3",
      userName: "Dana",
      starterText: "starter from open dm",
      followUpText: "dm follow-up",
      startTs: "300.000",
      replyTs: "300.500",
      followUpTs: "300.800",
      currentTs: "301.000",
    });

    expect(prepared).toBeTruthy();
    expect(prepared!.ctxPayload.ThreadStarterBody).toBe("starter from open dm");
    expect(prepared!.ctxPayload.ThreadHistoryBody).toContain("starter from open dm");
    expect(prepared!.ctxPayload.ThreadHistoryBody).toContain("dm follow-up");
    expect(prepared!.ctxPayload.ThreadHistoryBody).not.toContain("assistant reply");
    expect(prepared!.ctxPayload.ThreadHistoryBody).not.toContain("current message");
    expect(replies).toHaveBeenCalledTimes(2);
  });

  it("does not apply the owner allowlist to MPIM thread context", async () => {
    const { prepared, replies } = await prepareThreadContextCase({
      channel: "G400",
      channelType: "mpim",
      user: "U4",
      userName: "Evan",
      starterText: "starter from mpim",
      followUpText: "mpim follow-up",
      startTs: "400.000",
      replyTs: "400.500",
      followUpTs: "400.800",
      currentTs: "401.000",
    });

    expect(prepared).toBeTruthy();
    expect(prepared!.ctxPayload.ThreadStarterBody).toBe("starter from mpim");
    expect(prepared!.ctxPayload.ThreadHistoryBody).toContain("starter from mpim");
    expect(prepared!.ctxPayload.ThreadHistoryBody).toContain("mpim follow-up");
    expect(prepared!.ctxPayload.ThreadHistoryBody).not.toContain("assistant reply");
    expect(prepared!.ctxPayload.ThreadHistoryBody).not.toContain("current message");
    expect(replies).toHaveBeenCalledTimes(2);
  });
});
