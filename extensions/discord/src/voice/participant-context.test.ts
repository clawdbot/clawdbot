// Discord tests cover voice participant classification.
import { describe, expect, it } from "vitest";
import { countDiscordVoiceHumanParticipants } from "./participant-context.js";

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
