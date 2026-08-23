// Covers voice wake routing normalization and resolution.
import { describe, expect, it } from "vitest";
import {
  normalizeVoiceWakeRoutingConfig,
  resolveVoiceWakeRouteByTrigger,
} from "./voicewake-routing.js";

describe("voicewake routing normalization", () => {
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
});
