import { describe, expect, it } from "vitest";
import { createChatSessionSubscriptionRegistry } from "./server-chat.js";

describe("ChatSessionSubscriptionRegistry", () => {
  it("subscribes a connId to a session and retrieves it", () => {
    const registry = createChatSessionSubscriptionRegistry();
    registry.subscribe("session-A", "conn-1");

    const connIds = registry.getConnIds("session-A");
    expect(connIds).toBeDefined();
    expect(connIds!.has("conn-1")).toBe(true);
    expect(connIds!.size).toBe(1);
  });

  it("supports multiple connIds per session", () => {
    const registry = createChatSessionSubscriptionRegistry();
    registry.subscribe("session-A", "conn-1");
    registry.subscribe("session-A", "conn-2");

    const connIds = registry.getConnIds("session-A");
    expect(connIds!.size).toBe(2);
    expect(connIds!.has("conn-1")).toBe(true);
    expect(connIds!.has("conn-2")).toBe(true);
  });

  it("supports multiple sessions per connId", () => {
    const registry = createChatSessionSubscriptionRegistry();
    registry.subscribe("session-A", "conn-1");
    registry.subscribe("session-B", "conn-1");

    expect(registry.getConnIds("session-A")!.has("conn-1")).toBe(true);
    expect(registry.getConnIds("session-B")!.has("conn-1")).toBe(true);
  });

  it("returns undefined for unknown session keys", () => {
    const registry = createChatSessionSubscriptionRegistry();
    expect(registry.getConnIds("nonexistent")).toBeUndefined();
  });

  it("unsubscribes a specific connId from a session", () => {
    const registry = createChatSessionSubscriptionRegistry();
    registry.subscribe("session-A", "conn-1");
    registry.subscribe("session-A", "conn-2");

    registry.unsubscribe("session-A", "conn-1");

    const connIds = registry.getConnIds("session-A");
    expect(connIds!.size).toBe(1);
    expect(connIds!.has("conn-1")).toBe(false);
    expect(connIds!.has("conn-2")).toBe(true);
  });

  it("cleans up session entry when last connId is unsubscribed", () => {
    const registry = createChatSessionSubscriptionRegistry();
    registry.subscribe("session-A", "conn-1");
    registry.unsubscribe("session-A", "conn-1");

    expect(registry.getConnIds("session-A")).toBeUndefined();
    expect(registry.hasSubscribers("session-A")).toBe(false);
  });

  it("unsubscribeAll removes a connId from all sessions", () => {
    const registry = createChatSessionSubscriptionRegistry();
    registry.subscribe("session-A", "conn-1");
    registry.subscribe("session-B", "conn-1");
    registry.subscribe("session-B", "conn-2");

    registry.unsubscribeAll("conn-1");

    expect(registry.getConnIds("session-A")).toBeUndefined();
    expect(registry.hasSubscribers("session-A")).toBe(false);

    const sessionB = registry.getConnIds("session-B");
    expect(sessionB!.size).toBe(1);
    expect(sessionB!.has("conn-2")).toBe(true);
  });

  it("unsubscribeAll is a no-op for unknown connId", () => {
    const registry = createChatSessionSubscriptionRegistry();
    registry.subscribe("session-A", "conn-1");

    // Should not throw
    registry.unsubscribeAll("conn-999");

    expect(registry.getConnIds("session-A")!.size).toBe(1);
  });

  it("hasSubscribers returns correct boolean", () => {
    const registry = createChatSessionSubscriptionRegistry();
    expect(registry.hasSubscribers("session-A")).toBe(false);

    registry.subscribe("session-A", "conn-1");
    expect(registry.hasSubscribers("session-A")).toBe(true);

    registry.unsubscribe("session-A", "conn-1");
    expect(registry.hasSubscribers("session-A")).toBe(false);
  });

  it("ignores subscribe with empty sessionKey or connId", () => {
    const registry = createChatSessionSubscriptionRegistry();
    registry.subscribe("", "conn-1");
    registry.subscribe("session-A", "");
    registry.subscribe("", "");

    expect(registry.getConnIds("")).toBeUndefined();
    expect(registry.getConnIds("session-A")).toBeUndefined();
  });

  it("duplicate subscribe is idempotent", () => {
    const registry = createChatSessionSubscriptionRegistry();
    registry.subscribe("session-A", "conn-1");
    registry.subscribe("session-A", "conn-1");

    expect(registry.getConnIds("session-A")!.size).toBe(1);
  });
});
