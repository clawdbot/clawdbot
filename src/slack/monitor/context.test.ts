import type { App } from "@slack/bolt";
import { describe, expect, it } from "vitest";

import type { ClawdbotConfig } from "../../config/config.js";
import type { RuntimeEnv } from "../../runtime.js";
import { createSlackMonitorContext, normalizeSlackChannelType } from "./context.js";

const baseParams = () => ({
  cfg: {} as ClawdbotConfig,
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
      "agent:main:slack:channel:C123",
    );
  });
});
