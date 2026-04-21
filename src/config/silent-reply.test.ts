import { describe, expect, it } from "vitest";
import { resolveSilentReplyPolicy, resolveSilentReplyRewriteEnabled } from "./silent-reply.js";
import type { OpenClawConfig } from "./types.openclaw.js";

describe("silent reply config resolution", () => {
  it("uses the default direct/group/internal policy and rewrite flags", () => {
    expect(resolveSilentReplyPolicy({ surface: "webchat" })).toBe("disallow");
    expect(resolveSilentReplyRewriteEnabled({ surface: "webchat" })).toBe(true);
    expect(
      resolveSilentReplyPolicy({
        sessionKey: "agent:main:telegram:group:123",
        surface: "telegram",
      }),
    ).toBe("allow");
    expect(
      resolveSilentReplyRewriteEnabled({
        sessionKey: "agent:main:telegram:group:123",
        surface: "telegram",
      }),
    ).toBe(false);
    expect(
      resolveSilentReplyPolicy({
        sessionKey: "agent:main:subagent:abc",
      }),
    ).toBe("allow");
  });

  it("applies configured defaults by conversation type", () => {
    const cfg: OpenClawConfig = {
      agents: {
        defaults: {
          silentReply: {
            direct: "disallow",
            group: "disallow",
            internal: "allow",
          },
          silentReplyRewrite: {
            direct: false,
            group: true,
            internal: false,
          },
        },
      },
    };

    expect(resolveSilentReplyPolicy({ cfg, surface: "webchat" })).toBe("disallow");
    expect(resolveSilentReplyRewriteEnabled({ cfg, surface: "webchat" })).toBe(false);
    expect(
      resolveSilentReplyPolicy({
        cfg,
        sessionKey: "agent:main:discord:group:123",
        surface: "discord",
      }),
    ).toBe("disallow");
    expect(
      resolveSilentReplyRewriteEnabled({
        cfg,
        sessionKey: "agent:main:discord:group:123",
        surface: "discord",
      }),
    ).toBe(true);
  });

  it("lets surface overrides beat the default policy and rewrite flags", () => {
    const cfg: OpenClawConfig = {
      agents: {
        defaults: {
          silentReply: {
            direct: "disallow",
            group: "allow",
            internal: "allow",
          },
          silentReplyRewrite: {
            direct: true,
            group: false,
            internal: false,
          },
        },
      },
      surfaces: {
        telegram: {
          silentReply: {
            direct: "allow",
          },
          silentReplyRewrite: {
            direct: false,
          },
        },
      },
    };

    expect(
      resolveSilentReplyPolicy({
        cfg,
        sessionKey: "agent:main:telegram:direct:123",
        surface: "telegram",
      }),
    ).toBe("allow");
    expect(
      resolveSilentReplyRewriteEnabled({
        cfg,
        sessionKey: "agent:main:telegram:direct:123",
        surface: "telegram",
      }),
    ).toBe(false);
  });
});
