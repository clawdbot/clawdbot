import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import { describe, expect, it } from "vitest";
import { resolveWhatsAppReactionLevel } from "./reaction-level.js";

type ReactionResolution = ReturnType<typeof resolveWhatsAppReactionLevel>;

describe("resolveWhatsAppReactionLevel", () => {
  const expectReactionFlags = (
    result: ReactionResolution,
    expected: {
      level: "off" | "ack" | "minimal" | "extensive";
      ackEnabled: boolean;
      agentReactionsEnabled: boolean;
      agentReactionGuidance?: "minimal" | "extensive";
    },
  ) => {
    expect(result.level).toBe(expected.level);
    expect(result.ackEnabled).toBe(expected.ackEnabled);
    expect(result.agentReactionsEnabled).toBe(expected.agentReactionsEnabled);
    expect(result.agentReactionGuidance).toBe(expected.agentReactionGuidance);
  };

  it("defaults to minimal level when reactionLevel is not set", () => {
    const cfg: OpenClawConfig = {
      channels: { whatsapp: {} },
    };

    const result = resolveWhatsAppReactionLevel({ cfg });
    expectReactionFlags(result, {
      level: "minimal",
      ackEnabled: false,
      agentReactionsEnabled: true,
      agentReactionGuidance: "minimal",
    });
  });

  it("returns off level with no reactions enabled", () => {
    const cfg: OpenClawConfig = {
      channels: { whatsapp: { reactionLevel: "off" } },
    };

    const result = resolveWhatsAppReactionLevel({ cfg });
    expectReactionFlags(result, {
      level: "off",
      ackEnabled: false,
      agentReactionsEnabled: false,
    });
  });

  it("returns ack level with only ackEnabled", () => {
    const cfg: OpenClawConfig = {
      channels: { whatsapp: { reactionLevel: "ack" } },
    };

    const result = resolveWhatsAppReactionLevel({ cfg });
    expectReactionFlags(result, {
      level: "ack",
      ackEnabled: true,
      agentReactionsEnabled: false,
    });
  });

  it("returns minimal level with agent reactions enabled and minimal guidance", () => {
    const cfg: OpenClawConfig = {
      channels: { whatsapp: { reactionLevel: "minimal" } },
    };

    const result = resolveWhatsAppReactionLevel({ cfg });
    expectReactionFlags(result, {
      level: "minimal",
      ackEnabled: false,
      agentReactionsEnabled: true,
      agentReactionGuidance: "minimal",
    });
  });

  it("returns extensive level with agent reactions enabled and extensive guidance", () => {
    const cfg: OpenClawConfig = {
      channels: { whatsapp: { reactionLevel: "extensive" } },
    };

    const result = resolveWhatsAppReactionLevel({ cfg });
    expectReactionFlags(result, {
      level: "extensive",
      ackEnabled: false,
      agentReactionsEnabled: true,
      agentReactionGuidance: "extensive",
    });
  });

  it("resolves reaction level from a specific account", () => {
    const cfg: OpenClawConfig = {
      channels: {
        whatsapp: {
          reactionLevel: "minimal",
          accounts: {
            work: { reactionLevel: "extensive" },
          },
        },
      },
    };

    const result = resolveWhatsAppReactionLevel({ cfg, accountId: "work" });
    expectReactionFlags(result, {
      level: "extensive",
      ackEnabled: false,
      agentReactionsEnabled: true,
      agentReactionGuidance: "extensive",
    });
  });
});
