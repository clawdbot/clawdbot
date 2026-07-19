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
    expect([...subscribers.getForConnection("conn-reviewer")]).toEqual([]);
    expect([...subscribers.get("agent:main:main")]).toEqual([]);
    expect([...subscribers.getApprovals("agent:main:main")]).toEqual([]);
    expect([...subscribers.get("agent:main:child")]).toEqual(["conn-other"]);
    expect([...subscribers.getApprovals("agent:main:child")]).toEqual(["conn-other"]);

    subscribers.clear();
    expect([...subscribers.get("agent:main:child")]).toEqual([]);
    expect([...subscribers.getApprovals("agent:main:child")]).toEqual([]);
  });

  it.each(["first", "second"])(
    "removes a first-time subscription when both concurrent replays fail (%s rollback first)",
    (firstRollback) => {
      const subscribers = createSessionMessageSubscriberRegistry();
      const first = subscribers.subscribe("conn", "agent:main:main", { provisional: true })!;
      const second = subscribers.subscribe("conn", "agent:main:main", { provisional: true })!;

      if (firstRollback === "first") {
        first();
        second();
      } else {
        second();
        first();
      }

      expect([...subscribers.get("agent:main:main")]).toEqual([]);
      expect([...subscribers.getForConnection("conn")]).toEqual([]);
    },
  );

  it.each(["first", "second"])(
    "keeps the successful concurrent replay recency (%s resolution first)",
    (firstResolution) => {
      const subscribers = createSessionMessageSubscriberRegistry();
      subscribers.subscribe("conn", "agent:main:other");
      const first = subscribers.subscribe("conn", "agent:main:main", { provisional: true })!;
      const second = subscribers.subscribe("conn", "agent:main:main", { provisional: true })!;

      if (firstResolution === "first") {
        first();
        second.commit();
      } else {
        second.commit();
        first();
      }

      expect([...subscribers.getForConnection("conn")]).toEqual([
        "agent:main:other",
        "agent:main:main",
      ]);
    },
  );

  it("retains the committed recency when a re-subscribe replay fails", () => {
    const subscribers = createSessionMessageSubscriberRegistry();
    subscribers.subscribe("conn", "agent:main:main");
    subscribers.subscribe("conn", "agent:main:child");
    const rollback = subscribers.subscribe("conn", "agent:main:main", { provisional: true })!;

    rollback();

    expect([...subscribers.getForConnection("conn")]).toEqual([
      "agent:main:main",
      "agent:main:child",
    ]);
  });

  it("does not restore a replay invalidated by unsubscribe", () => {
    const subscribers = createSessionMessageSubscriberRegistry();
    const subscription = subscribers.subscribe("conn", "agent:main:main", {
      provisional: true,
    })!;

    subscribers.unsubscribe("conn", "agent:main:main");
    subscription.commit();

    expect([...subscribers.getForConnection("conn")]).toEqual([]);
    expect([...subscribers.get("agent:main:main")]).toEqual([]);
  });
});
