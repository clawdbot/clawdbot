// Native command session target tests cover session targeting for built-in channel commands.
import { describe, expect, it } from "vitest";
import { resolveNativeCommandSessionTargets } from "./native-command-session-targets.js";

describe("resolveNativeCommandSessionTargets", () => {
  it("uses the bound session for both targets when present", () => {
    expect(
      resolveNativeCommandSessionTargets({
        agentId: "codex",
        sessionPrefix: "discord:slash",
        userId: "user-1",
        targetSessionKey: "agent:codex:discord:channel:chan-1",
        boundSessionKey: "agent:codex:acp:binding:discord:default:seed",
      }),
    ).toEqual({
      sessionKey: "agent:codex:acp:binding:discord:default:seed",
      commandTargetSessionKey: "agent:codex:acp:binding:discord:default:seed",
    });
  });

  it("falls back to the routed session target when unbound", () => {
    expect(
      resolveNativeCommandSessionTargets({
        agentId: "qwen",
        sessionPrefix: "telegram:slash",
        userId: "user-1",
        targetSessionKey: "agent:qwen:telegram:direct:user-1",
      }),
    ).toEqual({
      sessionKey: "agent:qwen:telegram:slash:user-1",
      commandTargetSessionKey: "agent:qwen:telegram:direct:user-1",
    });
  });

  it("supports lowercase session keys for providers that already normalize", () => {
    expect(
      resolveNativeCommandSessionTargets({
        agentId: "Qwen",
        sessionPrefix: "Slack:Slash",
        userId: "U123",
        targetSessionKey: "agent:qwen:slack:channel:c1",
        lowercaseSessionKey: true,
      }),
    ).toEqual({
      sessionKey: "agent:qwen:slack:slash:u123",
      commandTargetSessionKey: "agent:qwen:slack:channel:c1",
    });
  });
});
