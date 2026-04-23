import { describe, expect, it } from "vitest";
import { resolveSandboxRuntimeStatus } from "../../agents/sandbox/runtime-status.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { MsgContext } from "../templating.js";
import { resolveRuntimePolicySessionKey } from "./runtime-policy-session-key.js";

describe("resolveRuntimePolicySessionKey", () => {
  const cfg: OpenClawConfig = {
    agents: {
      defaults: {
        sandbox: { mode: "non-main", scope: "agent" },
      },
      list: [{ id: "main" }],
    },
  };

  it("derives an external direct-chat policy key when the conversation uses main", () => {
    const sessionKey = resolveRuntimePolicySessionKey({
      cfg,
      sessionKey: "agent:main:main",
      ctx: {
        SessionKey: "agent:main:main",
        OriginatingChannel: "whatsapp" as MsgContext["OriginatingChannel"],
        AccountId: "personal",
        ChatType: "direct",
        SenderId: "15555550123",
      },
    });

    expect(sessionKey).toBe("agent:main:whatsapp:personal:direct:15555550123");
    expect(resolveSandboxRuntimeStatus({ cfg, sessionKey }).sandboxed).toBe(true);
  });

  it("normalizes dm chat type aliases", () => {
    expect(
      resolveRuntimePolicySessionKey({
        cfg,
        sessionKey: "agent:main:main",
        ctx: {
          SessionKey: "agent:main:main",
          OriginatingChannel: "slack" as MsgContext["OriginatingChannel"],
          ChatType: "dm",
          SenderId: "U123",
        },
      }),
    ).toBe("agent:main:slack:default:direct:u123");
  });

  it("leaves local main-session runs unsandboxed in non-main mode", () => {
    const sessionKey = resolveRuntimePolicySessionKey({
      cfg,
      sessionKey: "agent:main:main",
      ctx: {
        SessionKey: "agent:main:main",
        Provider: "webchat",
        ChatType: "direct",
        SenderId: "operator",
      },
    });

    expect(sessionKey).toBe("agent:main:main");
    expect(resolveSandboxRuntimeStatus({ cfg, sessionKey }).sandboxed).toBe(false);
  });

  it("keeps already-isolated sessions unchanged", () => {
    expect(
      resolveRuntimePolicySessionKey({
        cfg,
        sessionKey: "agent:main:discord:channel:123:thread:456",
        ctx: {
          SessionKey: "agent:main:discord:channel:123:thread:456",
          OriginatingChannel: "discord" as MsgContext["OriginatingChannel"],
          ChatType: "channel",
          SenderId: "u1",
        },
      }),
    ).toBe("agent:main:discord:channel:123:thread:456");
  });

  it("uses native command target sessions as the policy base", () => {
    expect(
      resolveRuntimePolicySessionKey({
        cfg,
        sessionKey: "agent:main:main",
        ctx: {
          SessionKey: "telegram:slash:status",
          CommandTargetSessionKey: "agent:main:main",
          OriginatingChannel: "telegram" as MsgContext["OriginatingChannel"],
          AccountId: "default",
          ChatType: "direct",
          NativeDirectUserId: "42",
        },
      }),
    ).toBe("agent:main:telegram:default:direct:42");
  });

  it("applies identity links for derived direct-chat policy keys", () => {
    expect(
      resolveRuntimePolicySessionKey({
        cfg: {
          ...cfg,
          session: {
            identityLinks: {
              alice: ["telegram:42"],
            },
          },
        },
        sessionKey: "agent:main:main",
        ctx: {
          SessionKey: "agent:main:main",
          OriginatingChannel: "telegram" as MsgContext["OriginatingChannel"],
          AccountId: "default",
          ChatType: "direct",
          SenderId: "42",
        },
      }),
    ).toBe("agent:main:telegram:default:direct:alice");
  });
});
