import { describe, expect, it, vi } from "vitest";

type MockIngressInput = {
  accountId?: string;
  message?: string;
  sessionKey?: string;
  runId?: string;
};

const mocks = vi.hoisted(() => ({
  agentCommandFromIngress: vi.fn(async (_input: MockIngressInput) => ({
    payloads: [{ text: "spoken" }],
  })),
}));

vi.mock("openclaw/plugin-sdk/agent-runtime", () => ({
  agentCommandFromIngress: mocks.agentCommandFromIngress,
}));

import { runDiscordVoiceAgentTurn } from "./ingress.js";

describe("Discord voice ingress execution correlation", () => {
  it("admits sequential same-session turns without inventing a public run id", async () => {
    const entry = {
      guildId: "guild-1",
      channelId: "channel-1",
      route: { agentId: "main", sessionKey: "agent:main:discord:channel:channel-1" },
    };
    const shared = {
      entry: entry as never,
      accountId: "work",
      userId: "user-1",
      cfg: {} as never,
      discordConfig: {} as never,
      runtime: { log: vi.fn(), error: vi.fn() } as never,
      context: { senderIsOwner: false, speakerLabel: "Guest" },
      fetchGuildName: vi.fn(async () => "Guild"),
      speakerContext: {} as never,
    };

    await runDiscordVoiceAgentTurn({ ...shared, message: "first turn" });
    await runDiscordVoiceAgentTurn({ ...shared, message: "second turn" });

    expect(mocks.agentCommandFromIngress).toHaveBeenCalledTimes(2);
    const inputs = mocks.agentCommandFromIngress.mock.calls.map(([input]) => input);
    expect(inputs.map((input) => input.message)).toEqual(["first turn", "second turn"]);
    expect(inputs.map((input) => input.sessionKey)).toEqual([
      "agent:main:discord:channel:channel-1",
      "agent:main:discord:channel:channel-1",
    ]);
    expect(inputs.map((input) => input.accountId)).toEqual(["work", "work"]);
    for (const input of inputs) {
      expect(input).not.toHaveProperty("runId");
    }
  });
});
