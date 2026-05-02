import type { App } from "@slack/bolt";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-types";
import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime-env";
import { describe, expect, it } from "vitest";
import { resolveSlackChannelConfig } from "./channel-config.js";
import { createSlackMonitorContext, normalizeSlackChannelType } from "./context.js";

describe("resolveSlackChannelConfig", () => {
  it("uses defaultRequireMention when channels config is empty", () => {
    const res = resolveSlackChannelConfig({
      channelId: "C1",
      channels: {},
      defaultRequireMention: false,
    });
    expect(res).toEqual({ allowed: true, requireMention: false });
  });

  it("defaults defaultRequireMention to true when not provided", () => {
    const res = resolveSlackChannelConfig({
      channelId: "C1",
      channels: {},
    });
    expect(res).toEqual({ allowed: true, requireMention: true });
  });

  it("prefers explicit channel/fallback requireMention over defaultRequireMention", () => {
    const res = resolveSlackChannelConfig({
      channelId: "C1",
      channels: { "*": { requireMention: true } },
      defaultRequireMention: false,
    });
    expect(res).toMatchObject({ requireMention: true });
  });

  it("uses wildcard entries when no direct channel config exists", () => {
    const res = resolveSlackChannelConfig({
      channelId: "C1",
      channels: { "*": { enabled: true, requireMention: false } },
      defaultRequireMention: true,
    });
    expect(res).toMatchObject({
      allowed: true,
      requireMention: false,
      matchKey: "*",
      matchSource: "wildcard",
    });
  });

  it("uses direct match metadata when channel config exists", () => {
    const res = resolveSlackChannelConfig({
      channelId: "C1",
      channels: { C1: { enabled: true, requireMention: false } },
      defaultRequireMention: true,
    });
    expect(res).toMatchObject({
      matchKey: "C1",
      matchSource: "direct",
    });
  });

  it("matches channel config key stored in lowercase when Slack delivers uppercase channel ID", () => {
    // Slack always delivers channel IDs in uppercase (e.g. C0ABC12345).
    // Users commonly copy them in lowercase from docs or older CLI output.
    const res = resolveSlackChannelConfig({
      channelId: "C0ABC12345", // pragma: allowlist secret
      channels: { c0abc12345: { enabled: true, requireMention: false } },
      defaultRequireMention: true,
    });
    expect(res).toMatchObject({ allowed: true, requireMention: false });
  });

  it("matches channel config key stored in uppercase when user types lowercase channel ID", () => {
    // Defensive: also handle the inverse direction.
    const res = resolveSlackChannelConfig({
      channelId: "c0abc12345", // pragma: allowlist secret
      channels: { C0ABC12345: { enabled: true, requireMention: false } },
      defaultRequireMention: true,
    });
    expect(res).toMatchObject({ allowed: true, requireMention: false });
  });

  it("matches channel-prefixed config keys when Slack delivers a bare channel ID", () => {
    const res = resolveSlackChannelConfig({
      channelId: "C0AJYR3BVTJ",
      channels: { "channel:C0AJYR3BVTJ": { enabled: true, requireMention: false } },
      defaultRequireMention: true,
    });
    expect(res).toMatchObject({
      allowed: true,
      requireMention: false,
      matchKey: "channel:C0AJYR3BVTJ",
      matchSource: "direct",
    });
  });

  it("matches lowercase channel-prefixed config keys when Slack delivers uppercase channel IDs", () => {
    const res = resolveSlackChannelConfig({
      channelId: "C0AJYR3BVTJ",
      channels: { "channel:c0ajyr3bvtj": { enabled: true, requireMention: false } },
      defaultRequireMention: true,
    });
    expect(res).toMatchObject({
      allowed: true,
      requireMention: false,
      matchKey: "channel:c0ajyr3bvtj",
      matchSource: "direct",
    });
  });

  it("blocks channel-name route matches by default", () => {
    const res = resolveSlackChannelConfig({
      channelId: "C1",
      channelName: "ops-room",
      channels: { "ops-room": { enabled: true, requireMention: false } },
      defaultRequireMention: true,
    });
    expect(res).toMatchObject({ allowed: false, requireMention: true });
  });

  it("allows channel-name route matches when dangerous name matching is enabled", () => {
    const res = resolveSlackChannelConfig({
      channelId: "C1",
      channelName: "ops-room",
      channels: { "ops-room": { enabled: true, requireMention: false } },
      defaultRequireMention: true,
      allowNameMatching: true,
    });
    expect(res).toMatchObject({
      allowed: true,
      requireMention: false,
      matchKey: "ops-room",
      matchSource: "direct",
    });
  });
});

const baseParams = () => ({
  cfg: {} as OpenClawConfig,
  accountId: "default",
  botToken: "token",
  app: { client: {} } as App,
  runtime: {} as RuntimeEnv,
  botUserId: "B1",
  botId: "B1",
  teamId: "T1",
  apiAppId: "A1",
  historyLimit: 0,
  sessionScope: "per-sender" as const,
  mainKey: "main",
  dmEnabled: true,
  dmPolicy: "open" as const,
  allowFrom: [],
  allowNameMatching: false,
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
    name: "openclaw",
    sessionPrefix: "slack:slash",
    ephemeral: true,
  },
  textLimit: 4000,
  ackReactionScope: "group-mentions",
  typingReaction: "",
  mediaMaxBytes: 1,
  threadHistoryScope: "thread" as const,
  threadInheritParent: false,
  threadRequireExplicitMention: false,
  removeAckAfterReply: false,
});

function createListedChannelsContext(groupPolicy: "open" | "allowlist") {
  return createSlackMonitorContext({
    ...baseParams(),
    groupPolicy,
    channelsConfig: {
      C_LISTED: { requireMention: true },
    },
  });
}

describe("normalizeSlackChannelType", () => {
  it("infers channel types from ids when missing", () => {
    expect(normalizeSlackChannelType(undefined, "C123")).toBe("channel");
    expect(normalizeSlackChannelType(undefined, "D123")).toBe("im");
    expect(normalizeSlackChannelType(undefined, "G123")).toBe("group");
  });

  it("prefers explicit channel_type values", () => {
    expect(normalizeSlackChannelType("mpim", "C123")).toBe("mpim");
  });

  it("overrides wrong channel_type for D-prefix DM channels", () => {
    // Slack DM channel IDs always start with "D" — if the event
    // reports a wrong channel_type, the D-prefix should win.
    expect(normalizeSlackChannelType("channel", "D123")).toBe("im");
    expect(normalizeSlackChannelType("group", "D456")).toBe("im");
    expect(normalizeSlackChannelType("mpim", "D789")).toBe("im");
  });

  it("preserves correct channel_type for D-prefix DM channels", () => {
    expect(normalizeSlackChannelType("im", "D123")).toBe("im");
  });

  it("does not override G-prefix channel_type (ambiguous prefix)", () => {
    // G-prefix can be either "group" (private channel) or "mpim" (group DM)
    // — trust the provided channel_type since the prefix is ambiguous.
    expect(normalizeSlackChannelType("group", "G123")).toBe("group");
    expect(normalizeSlackChannelType("mpim", "G456")).toBe("mpim");
  });
});

describe("resolveSlackSystemEventSessionKey", () => {
  it("defaults missing channel_type to channel sessions", () => {
    const ctx = createSlackMonitorContext(baseParams());
    expect(ctx.resolveSlackSystemEventSessionKey({ channelId: "C123" })).toBe(
      "agent:main:slack:channel:c123",
    );
  });

  it("uses the configured default agent for fallback system-event sessions", () => {
    const ctx = createSlackMonitorContext({
      ...baseParams(),
      cfg: {
        agents: { list: [{ id: "ops", default: true }] },
      },
    });
    expect(ctx.resolveSlackSystemEventSessionKey({ channelId: "C123" })).toBe(
      "agent:ops:slack:channel:c123",
    );
  });

  it("routes channel system events through account bindings", () => {
    const ctx = createSlackMonitorContext({
      ...baseParams(),
      accountId: "work",
      cfg: {
        bindings: [
          {
            agentId: "ops",
            match: {
              channel: "slack",
              accountId: "work",
            },
          },
        ],
      },
    });
    expect(
      ctx.resolveSlackSystemEventSessionKey({ channelId: "C123", channelType: "channel" }),
    ).toBe("agent:ops:slack:channel:c123");
  });

  it("routes DM system events through direct-peer bindings when sender is known", () => {
    const ctx = createSlackMonitorContext({
      ...baseParams(),
      accountId: "work",
      cfg: {
        bindings: [
          {
            agentId: "ops-dm",
            match: {
              channel: "slack",
              accountId: "work",
              peer: { kind: "direct", id: "U123" },
            },
          },
        ],
      },
    });
    expect(
      ctx.resolveSlackSystemEventSessionKey({
        channelId: "D123",
        channelType: "im",
        senderId: "U123",
      }),
    ).toBe("agent:ops-dm:main");
  });
});

describe("isChannelAllowed with groupPolicy and channelsConfig", () => {
  it("allows unlisted channels when groupPolicy is open even with channelsConfig entries", () => {
    // Bug fix: when groupPolicy="open" and channels has some entries,
    // unlisted channels should still be allowed (not blocked)
    const ctx = createListedChannelsContext("open");
    // Listed channel should be allowed
    expect(ctx.isChannelAllowed({ channelId: "C_LISTED", channelType: "channel" })).toBe(true);
    // Unlisted channel should ALSO be allowed when policy is "open"
    expect(ctx.isChannelAllowed({ channelId: "C_UNLISTED", channelType: "channel" })).toBe(true);
  });

  it("blocks unlisted channels when groupPolicy is allowlist", () => {
    const ctx = createListedChannelsContext("allowlist");
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
        C_ALLOWED: { enabled: true },
        C_DENIED: { enabled: false },
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
