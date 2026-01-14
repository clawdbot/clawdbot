import { beforeEach, describe, expect, it, vi } from "vitest";

const dispatchMock = vi.fn();

vi.mock("@buape/carbon", () => ({
  ChannelType: { DM: "dm", GroupDM: "group" },
  MessageType: {
    ChatInputCommand: 1,
    ContextMenuCommand: 2,
    Default: 0,
  },
  Command: class {},
  Client: class {},
  MessageCreateListener: class {},
  MessageReactionAddListener: class {},
  MessageReactionRemoveListener: class {},
}));

vi.mock("../auto-reply/reply/dispatch-from-config.js", () => ({
  dispatchReplyFromConfig: (...args: unknown[]) => dispatchMock(...args),
}));

beforeEach(() => {
  dispatchMock.mockReset().mockImplementation(async ({ dispatcher }) => {
    dispatcher.sendToolResult({ text: "tool update" });
    dispatcher.sendFinalReply({ text: "final reply" });
    return { queuedFinal: true, counts: { tool: 1, block: 0, final: 1 } };
  });
});

describe("discord native commands", () => {
  it(
    "streams tool results for native slash commands",
    { timeout: 30_000 },
    async () => {
      const { ChannelType } = await import("@buape/carbon");
      const { createDiscordNativeCommand } = await import("./monitor.js");

      const cfg = {
        agents: {
          defaults: {
            model: "anthropic/claude-opus-4-5",
            humanDelay: { mode: "off" },
            workspace: "/tmp/clawd",
          },
        },
        session: { store: "/tmp/clawdbot-sessions.json" },
        discord: { dm: { enabled: true, policy: "open" } },
      } as ReturnType<typeof import("../config/config.js").loadConfig>;

      const command = createDiscordNativeCommand({
        command: {
          name: "verbose",
          description: "Toggle verbose mode.",
          acceptsArgs: true,
        },
        cfg,
        discordConfig: cfg.discord,
        accountId: "default",
        sessionPrefix: "discord:slash",
        ephemeralDefault: true,
      });

      const reply = vi.fn().mockResolvedValue(undefined);
      const followUp = vi.fn().mockResolvedValue(undefined);

      await command.run({
        user: { id: "u1", username: "Ada", globalName: "Ada" },
        channel: { type: ChannelType.DM },
        guild: null,
        rawData: { id: "i1" },
        options: { getString: vi.fn().mockReturnValue("on") },
        reply,
        followUp,
      });

      expect(dispatchMock).toHaveBeenCalledTimes(1);
      expect(reply).toHaveBeenCalledTimes(1);
      expect(followUp).toHaveBeenCalledTimes(1);
      expect(reply.mock.calls[0]?.[0]?.content).toContain("tool");
      expect(followUp.mock.calls[0]?.[0]?.content).toContain("final");
    },
  );
});
