import { beforeEach, describe, expect, it, vi } from "vitest";
import { createReplyDispatcherWithTyping } from "../auto-reply/reply/reply-dispatcher.js";

const dispatchMock = vi.fn();

vi.mock("@buape/carbon", () => ({
  ChannelType: { DM: "dm", GroupDM: "group" },
  MessageType: {
    ChatInputCommand: 1,
    ContextMenuCommand: 2,
    Default: 0,
  },
  Button: class {},
  Command: class {},
  Client: class {},
  MessageCreateListener: class {},
  MessageReactionAddListener: class {},
  MessageReactionRemoveListener: class {},
  PresenceUpdateListener: class {},
  Row: class {
    constructor(_components: unknown[]) {}
  },
}));

vi.mock("../auto-reply/dispatch.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../auto-reply/dispatch.js")>();
  return {
    ...actual,
    dispatchInboundMessage: (...args: unknown[]) => dispatchMock(...args),
    dispatchInboundMessageWithDispatcher: (...args: unknown[]) => dispatchMock(...args),
    dispatchInboundMessageWithBufferedDispatcher: (...args: unknown[]) => dispatchMock(...args),
  };
});

beforeEach(() => {
  dispatchMock.mockReset().mockImplementation(async (params) => {
    if ("dispatcher" in params && params.dispatcher) {
      params.dispatcher.sendFinalReply({ text: "final reply" });
      return { queuedFinal: true, counts: { tool: 0, block: 0, final: 1 } };
    }
    if ("dispatcherOptions" in params && params.dispatcherOptions) {
      const { dispatcher, markDispatchIdle } = createReplyDispatcherWithTyping(
        params.dispatcherOptions,
      );
      dispatcher.sendFinalReply({ text: "final reply" });
      await dispatcher.waitForIdle();
      markDispatchIdle();
      return { queuedFinal: true, counts: dispatcher.getQueuedCounts() };
    }
    return { queuedFinal: false, counts: { tool: 0, block: 0, final: 0 } };
  });
});

describe("discord native commands", () => {
  it("skips tool results for native slash commands", { timeout: 60_000 }, async () => {
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
      session: { store: "/tmp/moltbot-sessions.json" },
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
    expect(followUp).toHaveBeenCalledTimes(0);
    expect(reply.mock.calls[0]?.[0]?.content).toContain("final");
  });
});
