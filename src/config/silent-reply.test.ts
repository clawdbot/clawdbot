import { describe, expect, it } from "vitest";
import { resolveSilentReplyPolicy, resolveSilentReplyRewriteEnabled } from "./silent-reply.js";
import type { OpenClawConfig } from "./types.openclaw.js";

describe("silent reply config resolution", () => {
  it("uses the default direct/group/internal policy", () => {
    expect(resolveSilentReplyPolicy({ surface: "webchat" })).toBe("disallow");
    expect(
      resolveSilentReplyPolicy({
        sessionKey: "agent:main:telegram:group:123",
        surface: "telegram",
      }),
    ).toBe("allow");
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
        },
      },
    };

    expect(resolveSilentReplyPolicy({ cfg, surface: "webchat" })).toBe("disallow");
    expect(
      resolveSilentReplyPolicy({
        cfg,
        sessionKey: "agent:main:discord:group:123",
        surface: "discord",
      }),
    ).toBe("disallow");
  });

  it("lets surface overrides beat the default policy", () => {
    const cfg: OpenClawConfig = {
      agents: {
        defaults: {
          silentReply: {
            direct: "disallow",
            group: "allow",
            internal: "allow",
          },
        },
      },
      surfaces: {
        telegram: {
          silentReply: {
            direct: "allow",
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
  });

  it("resolves rewrite defaults and surface overrides by conversation type", () => {
    expect(resolveSilentReplyRewriteEnabled({ surface: "webchat" })).toBe(true);
    expect(
      resolveSilentReplyRewriteEnabled({
        sessionKey: "agent:main:telegram:group:123",
        surface: "telegram",
      }),
    ).toBe(false);

    const cfg: OpenClawConfig = {
      agents: {
        defaults: {
          silentReplyRewrite: {
            direct: true,
          },
        },
      },
      surfaces: {
        telegram: {
          silentReplyRewrite: {
            direct: false,
          },
        },
      },
    };

    expect(
      resolveSilentReplyRewriteEnabled({
        cfg,
        sessionKey: "agent:main:telegram:direct:123",
        surface: "telegram",
      }),
    ).toBe(false);
  });
});
