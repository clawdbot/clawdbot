// Slack tests cover context plugin behavior.
import type { App } from "@slack/bolt";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime-env";
import { describe, expect, it, vi } from "vitest";
import { createSlackMonitorContext } from "./context.js";
import type { SlackEventScope } from "./event-scope.js";

function createTestContext(params?: {
  dmScope?: "main" | "per-peer" | "per-channel-peer" | "per-account-channel-peer";
  groupDmEnabled?: boolean;
  groupDmChannels?: string[];
  appClient?: App["client"];
}) {
  return createSlackMonitorContext({
    cfg: {
      channels: { slack: { enabled: true } },
      session: { dmScope: params?.dmScope ?? "main" },
    } as OpenClawConfig,
    accountId: "default",
    botToken: "xoxb-test",
    app: { client: params?.appClient ?? {} } as App,
    runtime: {} as RuntimeEnv,
    botUserId: "U_BOT",
    botId: "B_BOT",
    teamId: "T_EXPECTED",
    apiAppId: "A_EXPECTED",
    historyLimit: 0,
    sessionScope: "per-sender",
    mainKey: "main",
    dmEnabled: true,
    dmPolicy: "open",
    allowFrom: [],
    allowNameMatching: false,
    groupDmEnabled: params?.groupDmEnabled ?? false,
    groupDmChannels: params?.groupDmChannels ?? [],
    defaultRequireMention: true,
    groupPolicy: "allowlist",
    useAccessGroups: true,
    reactionMode: "off",
    reactionAllowlist: [],
    replyToMode: "off",
    threadHistoryScope: "thread",
    threadInheritParent: false,
    threadRequireExplicitMention: false,
    slashCommand: {
      enabled: true,
      name: "openclaw",
      ephemeral: true,
      sessionPrefix: "slack:slash",
    },
    textLimit: 4000,
    typingReaction: "",
    ackReactionScope: "group-mentions",
    mediaMaxBytes: 20 * 1024 * 1024,
    removeAckAfterReply: false,
  });
}

describe("createSlackMonitorContext shouldDropMismatchedSlackEvent", () => {
  it("drops mismatched top-level app/team identifiers", () => {
    const ctx = createTestContext();
    expect(
      ctx.shouldDropMismatchedSlackEvent({
        api_app_id: "A_WRONG",
        team_id: "T_EXPECTED",
      }),
    ).toBe(true);
    expect(
      ctx.shouldDropMismatchedSlackEvent({
        api_app_id: "A_EXPECTED",
        team_id: "T_WRONG",
      }),
    ).toBe(true);
  });

  it("drops mismatched nested team.id payloads used by interaction bodies", () => {
    const ctx = createTestContext();
    expect(
      ctx.shouldDropMismatchedSlackEvent({
        api_app_id: "A_EXPECTED",
        team: { id: "T_WRONG" },
      }),
    ).toBe(true);
    expect(
      ctx.shouldDropMismatchedSlackEvent({
        api_app_id: "A_EXPECTED",
        team: { id: "T_EXPECTED" },
      }),
    ).toBe(false);
  });
});

describe("createSlackMonitorContext isChannelAllowed", () => {
  it("normalizes channel-prefixed group DM allowlist entries", () => {
    const ctx = createTestContext({
      groupDmEnabled: true,
      groupDmChannels: ["channel:G456"],
    });

    expect(ctx.isChannelAllowed({ channelId: "G456", channelType: "mpim" })).toBe(true);
    expect(ctx.isChannelAllowed({ channelId: "G999", channelType: "mpim" })).toBe(false);
  });
});

describe("createSlackMonitorContext resolveSlackSystemEventSessionKey", () => {
  it("routes threaded interaction events to the Slack thread session", () => {
    const ctx = createTestContext();

    expect(
      ctx.resolveSlackSystemEventSessionKey({
        channelId: "C_THREAD",
        channelType: "channel",
        senderId: "U_CLICKER",
        threadTs: "1712345678.123456",
      }),
    ).toBe("agent:main:slack:channel:c_thread:thread:1712345678.123456");
  });

  it("routes channel-less direct interactions to the sender session", () => {
    const ctx = createTestContext({ dmScope: "per-channel-peer" });

    expect(
      ctx.resolveSlackSystemEventSessionKey({
        channelType: "im",
        senderId: "U_SHORTCUT",
      }),
    ).toBe("agent:main:slack:direct:u_shortcut");
  });

  it("routes typeless system events through an event-carried mpDM type", () => {
    const ctx = createTestContext();
    ctx.rememberSlackChannelType("C0MPDM42", "mpim");

    expect(
      ctx.resolveSlackSystemEventSessionKey({
        channelId: "C0MPDM42",
        senderId: "U_ACTOR",
      }),
    ).toBe("agent:main:slack:group:c0mpdm42");
  });
});

describe("createSlackMonitorContext channel metadata cache", () => {
  it("fills metadata after an event stored only the authoritative type", async () => {
    const info = vi.fn().mockResolvedValue({
      channel: {
        id: "C0MPDM42",
        name: "team-chat",
        topic: { value: "planning" },
      },
    });
    const ctx = createTestContext({
      appClient: { conversations: { info } } as unknown as App["client"],
    });
    ctx.rememberSlackChannelType("C0MPDM42", "mpim");

    await expect(ctx.resolveChannelName("C0MPDM42")).resolves.toEqual({
      name: "team-chat",
      type: "mpim",
      topic: "planning",
      purpose: undefined,
    });
    await ctx.resolveChannelName("C0MPDM42");
    expect(info).toHaveBeenCalledOnce();
  });

  it("isolates remembered types by enterprise team scope", async () => {
    const createScope = (teamId: string): SlackEventScope =>
      ({
        apiAppId: "A_EXPECTED",
        enterpriseId: "E_EXPECTED",
        teamId,
        isEnterpriseInstall: true,
        client: {
          conversations: { info: vi.fn().mockRejectedValue(new Error("missing_scope")) },
        },
      }) as unknown as SlackEventScope;
    const ctx = createTestContext();
    const firstTeam = createScope("T_FIRST");
    const secondTeam = createScope("T_SECOND");
    ctx.rememberSlackChannelType("C0SHARED", "mpim", firstTeam);

    await expect(ctx.resolveChannelName("C0SHARED", firstTeam)).resolves.toMatchObject({
      type: "mpim",
    });
    await expect(ctx.resolveChannelName("C0SHARED", secondTeam)).resolves.toEqual({});
    await expect(ctx.resolveChannelName("C0SHARED")).resolves.toEqual({});
  });

  it("evicts the oldest authoritative type when the bounded cache fills", async () => {
    const info = vi.fn().mockRejectedValue(new Error("missing_scope"));
    const ctx = createTestContext({
      appClient: { conversations: { info } } as unknown as App["client"],
    });
    ctx.rememberSlackChannelType("C0OLDEST", "mpim");
    for (let index = 0; index < 1024; index += 1) {
      ctx.rememberSlackChannelType(`C${index}`, "channel");
    }

    await expect(ctx.resolveChannelName("C0OLDEST")).resolves.toEqual({});
  });

  it("evicts the oldest user name when the bounded user cache fills", async () => {
    const usersInfo = vi.fn().mockResolvedValue({
      user: { profile: { display_name: "test-user" } },
    });
    const ctx = createTestContext({
      appClient: { users: { info: usersInfo } } as unknown as App["client"],
    });
    await ctx.resolveUserName("U0OLDEST");
    for (let index = 0; index < 2048; index += 1) {
      await ctx.resolveUserName(`U${index}`);
    }
    // U0OLDEST should have been evicted by the fill. Re-requesting it must
    // call users.info again (cache miss) instead of returning a stale entry.
    await ctx.resolveUserName("U0OLDEST");
    expect(usersInfo).toHaveBeenCalledTimes(2050);
  });

  it("keeps a recently re-resolved user while older entries are evicted", async () => {
    const usersInfo = vi.fn().mockImplementation(async ({ user }: { user: string }) => ({
      user: { profile: { display_name: `name-${user}` } },
    }));
    const ctx = createTestContext({
      appClient: { users: { info: usersInfo } } as unknown as App["client"],
    });
    await ctx.resolveUserName("U0KEEP");
    for (let index = 0; index < 2047; index += 1) {
      await ctx.resolveUserName(`U${index}`);
    }
    // Touch U0KEEP so it becomes newest before the final insert that would
    // otherwise push the original insertion past the 2048-entry bound.
    await ctx.resolveUserName("U0KEEP");
    await ctx.resolveUserName("U_NEW");
    const before = usersInfo.mock.calls.length;
    await expect(ctx.resolveUserName("U0KEEP")).resolves.toEqual({ name: "name-U0KEEP" });
    expect(usersInfo).toHaveBeenCalledTimes(before);
  });
});
