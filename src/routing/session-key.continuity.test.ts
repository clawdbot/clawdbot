import { describe, it, expect } from "vitest";
import { buildAgentSessionKey } from "./resolve-route.js";

describe("Channel Session Key Continuity", () => {
  const agentId = "main";
  const channel = "quietchat";
  const accountId = "default";

  function buildChannelSessionKey(params: {
    peer: { kind: "direct" | "channel"; id: string };
    dmScope?: "main" | "per-peer";
  }) {
    return buildAgentSessionKey({
      agentId,
      channel,
      accountId,
      dmScope: params.dmScope ?? "main",
      peer: params.peer,
    });
  }

  function expectDistinctDmAndChannelKeys(params: {
    dmScope: "main" | "per-peer";
    expectedDmKey: string;
  }) {
    const dmKey = buildChannelSessionKey({
      peer: { kind: "direct", id: "user123" },
      dmScope: params.dmScope,
    });

    const groupKey = buildChannelSessionKey({
      peer: { kind: "channel", id: "channel456" },
    });

    expect(dmKey).toBe(params.expectedDmKey);
    expect(groupKey).toBe("agent:main:quietchat:channel:channel456");
    expect(dmKey).not.toBe(groupKey);
  }

  function expectUnknownChannelKeyCase(channelId: string) {
    const missingIdKey = buildChannelSessionKey({
      peer: { kind: "channel", id: channelId },
    });

    expect(missingIdKey).toContain("unknown");
    expect(missingIdKey).not.toBe("agent:main:main");
  }

  it.each([
    {
      name: "keeps main-scoped DMs distinct from channel sessions",
      dmScope: "main" as const,
      expectedDmKey: "agent:main:main",
    },
    {
      name: "keeps per-peer DMs distinct from channel sessions",
      dmScope: "per-peer" as const,
      expectedDmKey: "agent:main:direct:user123",
    },
  ])("$name", ({ dmScope, expectedDmKey }) => {
    expectDistinctDmAndChannelKeys({ dmScope, expectedDmKey });
  });

  it.each(["", "   "] as const)("handles invalid channel id %j without collision", (channelId) => {
    expectUnknownChannelKeyCase(channelId);
  });
});
