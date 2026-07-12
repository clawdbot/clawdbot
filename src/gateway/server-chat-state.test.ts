import { describe, expect, it } from "vitest";
import { createSessionMessageSubscriberRegistry } from "./server-chat-state.js";

describe("createSessionMessageSubscriberRegistry", () => {
  it("keeps approval delivery opt-in and updates it on resubscribe", () => {
    const subscribers = createSessionMessageSubscriberRegistry();

    subscribers.subscribe("conn-plain", "agent:main:main");
    subscribers.subscribe("conn-reviewer", "agent:main:main", { includeApprovals: true });

    expect([...subscribers.get("agent:main:main")]).toEqual(["conn-plain", "conn-reviewer"]);
    expect([...subscribers.getApprovals("agent:main:main")]).toEqual(["conn-reviewer"]);

    subscribers.subscribe("conn-reviewer", "agent:main:main");
    expect([...subscribers.get("agent:main:main")]).toEqual(["conn-plain", "conn-reviewer"]);
    expect([...subscribers.getApprovals("agent:main:main")]).toEqual([]);

    subscribers.subscribe("conn-reviewer", "agent:main:main", { includeApprovals: true });
    expect([...subscribers.getApprovals("agent:main:main")]).toEqual(["conn-reviewer"]);

    subscribers.unsubscribe("conn-reviewer", "agent:main:main");
    expect([...subscribers.get("agent:main:main")]).toEqual(["conn-plain"]);
    expect([...subscribers.getApprovals("agent:main:main")]).toEqual([]);
  });

  it("removes approval subscriptions through connection cleanup and registry reset", () => {
    const subscribers = createSessionMessageSubscriberRegistry();

    subscribers.subscribe("conn-reviewer", "agent:main:main", { includeApprovals: true });
    subscribers.subscribe("conn-reviewer", "agent:main:child", { includeApprovals: true });
    subscribers.subscribe("conn-other", "agent:main:child", { includeApprovals: true });

    subscribers.unsubscribeAll("conn-reviewer");
    expect([...subscribers.get("agent:main:main")]).toEqual([]);
    expect([...subscribers.getApprovals("agent:main:main")]).toEqual([]);
    expect([...subscribers.get("agent:main:child")]).toEqual(["conn-other"]);
    expect([...subscribers.getApprovals("agent:main:child")]).toEqual(["conn-other"]);

    subscribers.clear();
    expect([...subscribers.get("agent:main:child")]).toEqual([]);
    expect([...subscribers.getApprovals("agent:main:child")]).toEqual([]);
  });

  it("rolls a provisional subscription back to its exact prior state", () => {
    const subscribers = createSessionMessageSubscriberRegistry();

    const removeNew = subscribers.subscribe("conn-new", "agent:main:main", {
      includeApprovals: true,
    });
    removeNew?.();
    expect([...subscribers.get("agent:main:main")]).toEqual([]);
    expect([...subscribers.getApprovals("agent:main:main")]).toEqual([]);

    subscribers.subscribe("conn-plain", "agent:main:main");
    const restorePlain = subscribers.subscribe("conn-plain", "agent:main:main", {
      includeApprovals: true,
    });
    restorePlain?.();
    expect([...subscribers.get("agent:main:main")]).toEqual(["conn-plain"]);
    expect([...subscribers.getApprovals("agent:main:main")]).toEqual([]);

    subscribers.subscribe("conn-reviewer", "agent:main:main", { includeApprovals: true });
    const restoreReviewer = subscribers.subscribe("conn-reviewer", "agent:main:main");
    restoreReviewer?.();
    expect([...subscribers.getApprovals("agent:main:main")]).toEqual(["conn-reviewer"]);
  });
});
