// Irc tests cover channel plugin behavior.
import { beforeEach, describe, expect, it, vi } from "vitest";

const hoisted = vi.hoisted(() => ({
  connectIrcClient: vi.fn(),
  sendPrivmsg: vi.fn(),
}));

vi.mock("./client.js", () => ({
  connectIrcClient: hoisted.connectIrcClient,
}));

import { PAIRING_APPROVED_MESSAGE } from "./channel-api.js";
import { ircPlugin } from "./channel.js";
import { ircOutboundBaseAdapter } from "./outbound-base.js";
import type { CoreConfig } from "./types.js";

describe("IRC named-account reload contract", () => {
  it("keeps sibling account resolution unchanged across named-account additions and edits", () => {
    const cfg: CoreConfig = {
      channels: {
        irc: {
          host: "irc.example.com",
          nick: "default-bot",
          channels: ["#shared"],
          nickserv: { service: "NickServ", enabled: false },
          accounts: { alpha: { nick: "alpha-bot", channels: ["#alpha"] } },
        },
      },
    };
    const original = ["default", "alpha"].map((id) => ircPlugin.config.resolveAccount(cfg, id));
    for (const beta of [
      { nick: "beta-bot", channels: ["#beta"] },
      { nick: "beta-next", channels: ["#next"], nickserv: { enabled: true } },
    ]) {
      const next: CoreConfig = {
        channels: {
          irc: { ...cfg.channels?.irc, accounts: { ...cfg.channels?.irc?.accounts, beta } },
        },
      };
      expect(["default", "alpha"].map((id) => ircPlugin.config.resolveAccount(next, id))).toEqual(
        original,
      );
      expect(ircPlugin.config.resolveAccount(next, "beta").nick).toBe(beta.nick);
    }
    expect(ircPlugin.reload).toMatchObject({ accountScopedRestart: true });
  });
});

describe("irc outbound chunking", () => {
  it("chunks outbound text without requiring IRC runtime initialization", () => {
    expect(ircOutboundBaseAdapter.chunker("alpha beta", 5)).toEqual(["alpha", "beta"]);
    expect(ircOutboundBaseAdapter.deliveryMode).toBe("direct");
    expect(ircOutboundBaseAdapter.chunkerMode).toBe("markdown");
    expect(ircOutboundBaseAdapter.textChunkLimit).toBe(350);
    expect(ircPlugin.outbound?.sendFormattedText).toBeTypeOf("function");
  });
});

describe("irc target classification", () => {
  it("distinguishes nicknames from channels", () => {
    expect(ircPlugin.messaging?.inferTargetChatType?.({ to: "alice" })).toBe("direct");
    expect(ircPlugin.messaging?.inferTargetChatType?.({ to: "#operators" })).toBe("group");
  });
});

describe("ircPlugin pairing.notifyApproval", () => {
  const pairingCfg = {
    channels: {
      irc: {
        defaultAccount: "alpha",
        accounts: {
          alpha: { host: "irc.alpha.test", nick: "alpha-bot", password: "password-alpha" },
          beta: { host: "irc.beta.test", nick: "beta-bot", password: "password-beta" },
        },
      },
    },
  } as CoreConfig;

  beforeEach(() => {
    hoisted.sendPrivmsg.mockReset();
    hoisted.connectIrcClient.mockReset();
    hoisted.connectIrcClient.mockImplementation(async () => ({
      nick: "openclaw",
      isReady: () => true,
      sendRaw: vi.fn(),
      join: vi.fn(),
      sendPrivmsg: hoisted.sendPrivmsg,
      quit: vi.fn(),
      close: vi.fn(),
    }));
  });

  it.each([
    {
      name: "the approved account",
      accountId: "beta",
      host: "irc.beta.test",
      nick: "beta-bot",
      password: "password-beta",
    },
    {
      name: "the default account when no account was approved",
      accountId: undefined,
      host: "irc.alpha.test",
      nick: "alpha-bot",
      password: "password-alpha",
    },
  ])("sends the approval from $name", async ({ accountId, host, nick, password }) => {
    await ircPlugin.pairing!.notifyApproval!({
      cfg: pairingCfg,
      id: "paired-user",
      ...(accountId ? { accountId } : {}),
    });

    expect(hoisted.connectIrcClient).toHaveBeenCalledTimes(1);
    expect(hoisted.connectIrcClient.mock.calls[0]?.[0]).toMatchObject({ host, nick, password });
    expect(hoisted.sendPrivmsg).toHaveBeenCalledExactlyOnceWith(
      "paired-user",
      PAIRING_APPROVED_MESSAGE,
    );
  });
});
