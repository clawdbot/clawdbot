// Irc tests cover channel plugin behavior.
import { describe, expect, it } from "vitest";
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
