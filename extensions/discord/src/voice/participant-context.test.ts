// Discord tests cover voice participant classification.
import { describe, expect, it } from "vitest";
import {
  countDiscordVoiceHumanParticipants,
  formatDiscordVoiceParticipantStateLine,
} from "./participant-context.js";

describe("formatDiscordVoiceParticipantStateLine", () => {
  it.each([
    {
      name: "drops an emoji split by the label limit",
      nick: `${"x".repeat(99)}😀tail`,
      expected: "x".repeat(99),
    },
    {
      name: "keeps an emoji that ends at the label limit",
      nick: `${"x".repeat(98)}😀tail`,
      expected: `${"x".repeat(98)}😀`,
    },
    { name: "keeps a short label unchanged", nick: "Ada", expected: "Ada" },
  ])("$name", ({ nick, expected }) => {
    const line = formatDiscordVoiceParticipantStateLine({
      userId: "user-1",
      state: {
        user_id: "user-1",
        member: { nick },
      } as never,
    });

    expect(line).toBe(`- user_id="user-1" display_name=${JSON.stringify(expected)}`);
  });
});

describe("countDiscordVoiceHumanParticipants", () => {
  it("counts people while excluding the agent and other bots", () => {
    expect(
      countDiscordVoiceHumanParticipants({
        states: [
          {
            user_id: "agent",
            member: { user: { id: "agent", bot: true } },
          },
          {
            user_id: "owner",
            member: { user: { id: "owner", bot: false } },
          },
          {
            user_id: "helper-bot",
            member: { user: { id: "helper-bot", bot: true } },
          },
        ] as never,
        botUserId: "agent",
      }),
    ).toBe(1);
  });

  it("conservatively counts inferred speakers with missing member metadata", () => {
    expect(
      countDiscordVoiceHumanParticipants({
        states: [
          {
            user_id: "known-bot",
            member: { user: { id: "known-bot", bot: true } },
          },
        ] as never,
        additionalUserIds: ["known-bot", "cache-race-speaker"],
      }),
    ).toBe(1);
  });
});
