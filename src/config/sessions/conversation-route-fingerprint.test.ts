import { describe, expect, it } from "vitest";
import { resolveConversationRouteFingerprint } from "./conversation-route-fingerprint.js";

const route = {
  accountId: "default",
  channel: "reef",
  kind: "direct" as const,
  peerId: "molty",
  target: "user:molty",
};

describe("resolveConversationRouteFingerprint", () => {
  it("binds both canonical ownership identity and physical delivery address", () => {
    const expected = resolveConversationRouteFingerprint(route);

    expect(resolveConversationRouteFingerprint({ ...route, target: "user:other" })).not.toBe(
      expected,
    );
    expect(resolveConversationRouteFingerprint({ ...route, nativeDirectUserId: "other" })).not.toBe(
      expected,
    );
  });

  it("canonicalizes contextual role order before hashing", () => {
    const first = resolveConversationRouteFingerprint({
      ...route,
      routeContextObserved: true,
      routeContext: { guildId: "guild-1", memberRoleIds: ["role-b", "role-a"] },
    });
    const second = resolveConversationRouteFingerprint({
      ...route,
      routeContextObserved: true,
      routeContext: { memberRoleIds: ["role-a", "role-b", "role-a"], guildId: "guild-1" },
    });

    expect(first).toBe(second);
  });
});
