import { describe, expect, it } from "vitest";
import {
  createDiscordSupplementalContextAccessChecker,
  buildDiscordGroupSystemPrompt,
  buildDiscordInboundAccessContext,
  buildDiscordUntrustedContext,
} from "./inbound-context.js";

describe("Discord inbound context helpers", () => {
  it("builds guild access context from channel config and topic", () => {
    const accessContext = buildDiscordInboundAccessContext({
      channelConfig: {
        allowed: true,
        users: ["discord:user-1"],
        systemPrompt: "Use the runbook.",
      },
      guildInfo: { id: "guild-1" },
      sender: {
        id: "user-1",
        name: "tester",
        tag: "tester#0001",
      },
      isGuild: true,
      channelTopic: "Production alerts only",
    });

    expect(accessContext.groupSystemPrompt).toBe("Use the runbook.");
    expect(accessContext.ownerAllowFrom).toEqual(["user-1"]);
    expect(accessContext.untrustedContext).toEqual([
      {
        label: "Discord channel metadata",
        source: "discord",
        type: "channel_metadata",
        payload: { topic: "Production alerts only" },
      },
    ]);
  });

  it("omits guild-only metadata for direct messages", () => {
    expect(
      buildDiscordInboundAccessContext({
        sender: {
          id: "user-1",
        },
        isGuild: false,
        channelTopic: "ignored",
      }),
    ).toEqual({
      groupSystemPrompt: undefined,
      untrustedContext: undefined,
      ownerAllowFrom: undefined,
    });
  });

  it("keeps direct helper behavior consistent", () => {
    expect(buildDiscordGroupSystemPrompt({ allowed: true, systemPrompt: "  hi  " })).toBe("hi");
    const untrustedContext = buildDiscordUntrustedContext({
      isGuild: true,
      channelTopic: "topic",
    });
    expect(untrustedContext).toEqual([
      {
        label: "Discord channel metadata",
        source: "discord",
        type: "channel_metadata",
        payload: { topic: "topic" },
      },
    ]);
  });

  it("matches supplemental context senders through role allowlists", () => {
    const isAllowed = createDiscordSupplementalContextAccessChecker({
      channelConfig: {
        allowed: true,
        roles: ["role:ops", "123"],
      },
      isGuild: true,
    });

    expect(
      isAllowed({
        id: "user-2",
        memberRoleIds: ["123"],
      }),
    ).toBe(true);
    expect(
      isAllowed({
        id: "user-3",
        memberRoleIds: ["999"],
      }),
    ).toBe(false);
  });

  it("matches supplemental context senders by plain username when name matching is enabled", () => {
    const isAllowed = createDiscordSupplementalContextAccessChecker({
      channelConfig: {
        allowed: true,
        users: ["alice"],
      },
      allowNameMatching: true,
      isGuild: true,
    });

    expect(
      isAllowed({
        id: "user-2",
        name: "Alice",
        tag: "Alice#1234",
      }),
    ).toBe(true);
  });
});
