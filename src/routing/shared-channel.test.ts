import { describe, it, expect } from "vitest";
import { resolveAgentRoute, type ResolveAgentRouteInput } from "./resolve-route.js";
import type { MoltbotConfig } from "../config/config.js";

const mockConfig: MoltbotConfig = {
  agents: { list: [{ id: "main" }] },
  channels: {
    discord: {
      enabled: true,
      accounts: {
        bot_a: { token: "taken_a" },
        bot_b: { token: "token_b" },
      },
    },
  },
};

describe("resolveAgentRoute - Shared Channel", () => {
  it("should generate distinct keys for SAME channel on DIFFERENT bots", () => {
    const inputA: ResolveAgentRouteInput = {
      cfg: mockConfig,
      channel: "discord",
      accountId: "bot_a",
      peer: { kind: "channel", id: "channel_123" },
    };

    const inputB: ResolveAgentRouteInput = {
      cfg: mockConfig,
      channel: "discord",
      accountId: "bot_b",
      peer: { kind: "channel", id: "channel_123" },
    };

    const routeA = resolveAgentRoute(inputA);
    const routeB = resolveAgentRoute(inputB);

    console.log("Channel RouteA:", routeA.sessionKey);
    console.log("Channel RouteB:", routeB.sessionKey);

    expect(routeA.sessionKey).not.toEqual(routeB.sessionKey);
    expect(routeA.sessionKey).toContain(":bot_a");
    expect(routeB.sessionKey).toContain(":bot_b");
  });

  it("should preserve backward compatibility for default bot in channel", () => {
    const input: ResolveAgentRouteInput = {
      cfg: mockConfig,
      channel: "discord",
      accountId: "default",
      peer: { kind: "channel", id: "channel_123" },
    };

    const route = resolveAgentRoute(input);
    console.log("Channel Default:", route.sessionKey);

    expect(route.sessionKey).toBe("agent:main:discord:channel:channel_123");
  });
});
