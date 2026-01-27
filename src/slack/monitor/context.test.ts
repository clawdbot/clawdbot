import type { App } from "@slack/bolt";
import { describe, expect, it } from "vitest";

import type { MoltbotConfig } from "../../config/config.js";
import type { RuntimeEnv } from "../../runtime.js";
import { createSlackMonitorContext, normalizeSlackChannelType } from "./context.js";

const baseParams = () => ({
  cfg: {} as MoltbotConfig,
  accountId: "default",
  botToken: "token",
  app: { client: {} } as App,
  runtime: {} as RuntimeEnv,
  botUserId: "B1",
  teamId: "T1",
  apiAppId: "A1",
  historyLimit: 0,
  sessionScope: "per-sender" as const,
  mainKey: "main",
  dmEnabled: true,
  dmPolicy: "open" as const,
  allowFrom: [],
  groupDmEnabled: true,
  groupDmChannels: [],
  defaultRequireMention: true,
  groupPolicy: "open" as const,
  useAccessGroups: false,
  reactionMode: "off" as const,
  reactionAllowlist: [],
  replyToMode: "off" as const,
  slashCommand: {
    enabled: false,
    name: "clawd",
    sessionPrefix: "slack:slash",
    ephemeral: true,
  },
  textLimit: 4000,
  ackReactionScope: "group-mentions",
  mediaMaxBytes: 1,
  removeAckAfterReply: false,
});

describe("normalizeSlackChannelType", () => {
  it("infers channel types from ids when missing", () => {
    expect(normalizeSlackChannelType(undefined, "C123")).toBe("channel");
    expect(normalizeSlackChannelType(undefined, "D123")).toBe("im");
    expect(normalizeSlackChannelType(undefined, "G123")).toBe("group");
  });

  it("prefers explicit channel_type values", () => {
    expect(normalizeSlackChannelType("mpim", "C123")).toBe("mpim");
  });
});

describe("resolveSlackSystemEventSessionKey", () => {
  it("defaults missing channel_type to channel sessions", () => {
    const ctx = createSlackMonitorContext(baseParams());
    expect(ctx.resolveSlackSystemEventSessionKey({ channelId: "C123" })).toBe(
      "agent:main:slack:channel:c123",
    );
  });
});

describe("isChannelAllowed with groupPolicy and channelsConfig", () => {
  it("allows unlisted channels when groupPolicy is open even with channelsConfig entries", () => {
    // Bug fix: when groupPolicy="open" and channels has some entries,
    // unlisted channels should still be allowed (not blocked)
    const ctx = createSlackMonitorContext({
      ...baseParams(),
      groupPolicy: "open",
      channelsConfig: {
        C_LISTED: { requireMention: true },
      },
    });
    // Listed channel should be allowed
    expect(ctx.isChannelAllowed({ channelId: "C_LISTED", channelType: "channel" })).toBe(true);
    // Unlisted channel should ALSO be allowed when policy is "open"
    expect(ctx.isChannelAllowed({ channelId: "C_UNLISTED", channelType: "channel" })).toBe(true);
  });

  it("blocks unlisted channels when groupPolicy is allowlist", () => {
    const ctx = createSlackMonitorContext({
      ...baseParams(),
      groupPolicy: "allowlist",
      channelsConfig: {
        C_LISTED: { requireMention: true },
      },
    });
    // Listed channel should be allowed
    expect(ctx.isChannelAllowed({ channelId: "C_LISTED", channelType: "channel" })).toBe(true);
    // Unlisted channel should be blocked when policy is "allowlist"
    expect(ctx.isChannelAllowed({ channelId: "C_UNLISTED", channelType: "channel" })).toBe(false);
  });

  it("blocks explicitly denied channels even when groupPolicy is open", () => {
    const ctx = createSlackMonitorContext({
      ...baseParams(),
      groupPolicy: "open",
      channelsConfig: {
        C_ALLOWED: { allow: true },
        C_DENIED: { allow: false },
      },
    });
    // Explicitly allowed channel
    expect(ctx.isChannelAllowed({ channelId: "C_ALLOWED", channelType: "channel" })).toBe(true);
    // Explicitly denied channel should be blocked even with open policy
    expect(ctx.isChannelAllowed({ channelId: "C_DENIED", channelType: "channel" })).toBe(false);
    // Unlisted channel should be allowed with open policy
    expect(ctx.isChannelAllowed({ channelId: "C_UNLISTED", channelType: "channel" })).toBe(true);
  });

  it("allows all channels when groupPolicy is open and channelsConfig is empty", () => {
    const ctx = createSlackMonitorContext({
      ...baseParams(),
      groupPolicy: "open",
      channelsConfig: undefined,
    });
    expect(ctx.isChannelAllowed({ channelId: "C_ANY", channelType: "channel" })).toBe(true);
  });
});
