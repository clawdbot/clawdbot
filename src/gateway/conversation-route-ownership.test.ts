import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveConversationRouteEligibilityForAgent } from "./conversation-route-ownership.js";

const baseConversation = {
  accountId: "default",
  channel: "reef",
  kind: "group" as const,
  peerId: "topic-42",
  target: "group:topic-42",
};

function configWithBindings(bindings: NonNullable<OpenClawConfig["bindings"]>): OpenClawConfig {
  return {
    agents: { entries: { main: { default: true }, finance: {} } },
    bindings,
  };
}

describe("resolveConversationRouteEligibilityForAgent", () => {
  it("replays authoritative parent context when selecting the route owner", () => {
    const config = configWithBindings([
      {
        type: "route",
        agentId: "finance",
        match: { channel: "reef", peer: { kind: "group", id: "parent-room" } },
      },
    ]);
    const conversation = {
      ...baseConversation,
      routeContextObserved: true as const,
      routeContext: { parentPeerId: "parent-room" },
    };

    expect(
      resolveConversationRouteEligibilityForAgent({ config, agentId: "main", conversation }),
    ).toBe("denied");
    expect(
      resolveConversationRouteEligibilityForAgent({ config, agentId: "finance", conversation }),
    ).toBe("eligible");
  });

  it("does not treat an unrelated peer binding as a possible parent owner for a legacy thread", () => {
    const config = configWithBindings([
      {
        type: "route",
        agentId: "finance",
        match: { channel: "reef", peer: { kind: "group", id: "unrelated-room" } },
      },
    ]);

    expect(
      resolveConversationRouteEligibilityForAgent({
        config,
        agentId: "main",
        conversation: { ...baseConversation, threadId: "topic-7" },
      }),
    ).toBe("eligible");
  });

  it("replays a legacy thread parent binding from its retained route peer", () => {
    const config = configWithBindings([
      {
        type: "route",
        agentId: "finance",
        match: { channel: "reef", peer: { kind: "group", id: "parent-room" } },
      },
    ]);
    const conversation = { ...baseConversation, peerId: "parent-room", threadId: "topic-7" };

    expect(
      resolveConversationRouteEligibilityForAgent({ config, agentId: "main", conversation }),
    ).toBe("denied");
    expect(
      resolveConversationRouteEligibilityForAgent({ config, agentId: "finance", conversation }),
    ).toBe("eligible");
  });

  it("fails closed for a matching contextual wildcard when legacy context is absent", () => {
    const config = configWithBindings([
      {
        type: "route",
        agentId: "finance",
        match: { channel: "reef", peer: { kind: "group", id: "*" }, teamId: "finance" },
      },
    ]);

    expect(
      resolveConversationRouteEligibilityForAgent({
        config,
        agentId: "main",
        conversation: baseConversation,
      }),
    ).toBe("denied");

    expect(
      resolveConversationRouteEligibilityForAgent({
        config,
        agentId: "main",
        conversation: { ...baseConversation, routeContextObserved: true },
      }),
    ).toBe("eligible");
  });
});
