import { describe, expect, it } from "vitest";
import {
  normalizeVoiceWakeRoutingConfig,
  normalizeVoiceWakeTriggerWord,
  resolveVoiceWakeRouteByTrigger,
  validateVoiceWakeRoutingConfigInput,
} from "./voicewake-routing.js";

describe("voicewake routing normalization", () => {
  it("normalizes punctuation-heavy triggers to token-equivalent spacing", () => {
    expect(normalizeVoiceWakeTriggerWord("  Hey,   Bot!!  ")).toBe("hey bot");
  });

  it("normalizes agentId targets before persisting routes", () => {
    const normalized = normalizeVoiceWakeRoutingConfig({
      defaultTarget: { mode: "current" },
      routes: [{ trigger: "Wake", target: { agentId: " Main Agent " } }],
    });
    expect(normalized.routes).toHaveLength(1);
    expect(normalized.routes[0]?.target).toEqual({ agentId: "main-agent" });
  });

  it("resolves trigger routing with punctuation-insensitive trigger values", () => {
    const config = normalizeVoiceWakeRoutingConfig({
      defaultTarget: { mode: "current" },
      routes: [{ trigger: "Hey, Bot", target: { sessionKey: "agent:main:voice" } }],
    });
    expect(resolveVoiceWakeRouteByTrigger({ trigger: "hey bot", config })).toEqual({
      sessionKey: "agent:main:voice",
    });
  });

  it("rejects invalid route agent ids instead of normalizing them to main", () => {
    expect(
      validateVoiceWakeRoutingConfigInput({
        routes: [{ trigger: "wake", target: { agentId: "!!!" } }],
      }),
    ).toEqual({
      ok: false,
      message: "config.routes[0].target.agentId must be a valid agent id",
    });
  });

  it("rejects malformed session keys instead of persisting dead routes", () => {
    expect(
      validateVoiceWakeRoutingConfigInput({
        routes: [{ trigger: "wake", target: { sessionKey: "agent::main" } }],
      }),
    ).toEqual({
      ok: false,
      message: "config.routes[0].target.sessionKey must be a canonical agent session key",
    });
  });

  it("rejects session keys with empty path segments", () => {
    expect(
      validateVoiceWakeRoutingConfigInput({
        routes: [{ trigger: "wake", target: { sessionKey: "agent:main:main:" } }],
      }),
    ).toEqual({
      ok: false,
      message: "config.routes[0].target.sessionKey must be a canonical agent session key",
    });
  });

  it("rejects duplicate triggers after normalization", () => {
    expect(
      validateVoiceWakeRoutingConfigInput({
        routes: [
          { trigger: "Hey Bot", target: { mode: "current" } },
          { trigger: "hey, bot", target: { agentId: "main" } },
        ],
      }),
    ).toEqual({
      ok: false,
      message: "config.routes[1].trigger duplicates config.routes[0].trigger after normalization",
    });
  });

  it("rejects oversized route lists", () => {
    expect(
      validateVoiceWakeRoutingConfigInput({
        routes: Array.from({ length: 33 }, (_, index) => ({
          trigger: `wake ${index}`,
          target: { mode: "current" as const },
        })),
      }),
    ).toEqual({
      ok: false,
      message: "config.routes must contain at most 32 entries",
    });
  });

  it("rejects oversized triggers", () => {
    expect(
      validateVoiceWakeRoutingConfigInput({
        routes: [
          {
            trigger: "x".repeat(65),
            target: { mode: "current" as const },
          },
        ],
      }),
    ).toEqual({
      ok: false,
      message: "config.routes[0].trigger must be at most 64 characters",
    });
  });
});
