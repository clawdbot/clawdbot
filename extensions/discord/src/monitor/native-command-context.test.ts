import { describe, expect, it } from "vitest";
import { buildDiscordNativeCommandContext } from "./native-command-context.js";

describe("buildDiscordNativeCommandContext", () => {
  it("builds direct-message slash command context", () => {
    const ctx = buildDiscordNativeCommandContext({
      prompt: "/status",
      commandArgs: {},
      sessionKey: "agent:codex:discord:slash:user-1",
      commandTargetSessionKey: "agent:codex:discord:direct:user-1",
      accountId: "default",
      interactionId: "interaction-1",
      channelId: "dm-1",
      commandAuthorized: true,
      isDirectMessage: true,
      isGroupDm: false,
      isGuild: false,
      isThreadChannel: false,
      user: {
        id: "user-1",
        username: "tester",
        globalName: "Tester",
      },
      sender: {
        id: "user-1",
        tag: "tester#0001",
      },
      timestampMs: 123,
    });

    expect(ctx.From).toBe("discord:user-1");
    expect(ctx.To).toBe("slash:user-1");
    expect(ctx.ChatType).toBe("direct");
    expect(ctx.ConversationLabel).toBe("Tester");
    expect(ctx.SessionKey).toBe("agent:codex:discord:slash:user-1");
    expect(ctx.CommandTargetSessionKey).toBe("agent:codex:discord:direct:user-1");
    expect(ctx.OriginatingTo).toBe("user:user-1");
    expect(ctx.UntrustedContext).toBeUndefined();
    expect(ctx.GroupSystemPrompt).toBeUndefined();
    expect(ctx.Timestamp).toBe(123);
  });

  it("builds guild slash command context with owner allowlist and channel metadata", () => {
    const ctx = buildDiscordNativeCommandContext({
      prompt: "/status",
      commandArgs: { values: { model: "gpt-5.2" } },
      sessionKey: "agent:codex:discord:slash:user-1",
      commandTargetSessionKey: "agent:codex:discord:channel:chan-1",
      accountId: "default",
      interactionId: "interaction-1",
      channelId: "chan-1",
      threadParentId: "parent-1",
      guildName: "Ops",
      channelTopic: "Production alerts only",
      channelConfig: {
        allowed: true,
        users: ["discord:user-1"],
        systemPrompt: "Use the runbook.",
      },
      guildInfo: {
        id: "guild-1",
      },
      allowNameMatching: false,
      commandAuthorized: true,
      isDirectMessage: false,
      isGroupDm: false,
      isGuild: true,
      isThreadChannel: true,
      user: {
        id: "user-1",
        username: "tester",
      },
      sender: {
        id: "user-1",
        name: "tester",
        tag: "tester#0001",
      },
      timestampMs: 456,
    });

    expect(ctx.From).toBe("discord:channel:chan-1");
    expect(ctx.ChatType).toBe("channel");
    expect(ctx.ConversationLabel).toBe("chan-1");
    expect(ctx.GroupSubject).toBe("Ops");
    expect(ctx.GroupSystemPrompt).toBe("Use the runbook.");
    expect(ctx.OwnerAllowFrom).toEqual(["user-1"]);
    expect(ctx.MessageThreadId).toBe("chan-1");
    expect(ctx.ThreadParentId).toBe("parent-1");
    expect(ctx.OriginatingTo).toBe("channel:chan-1");
    expect(ctx.UntrustedContext).toEqual([
      expect.stringContaining("Discord channel topic:\nProduction alerts only"),
    ]);
    expect(ctx.Timestamp).toBe(456);
  });
});
