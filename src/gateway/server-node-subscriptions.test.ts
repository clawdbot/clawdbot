import { describe, expect, test, vi } from "vitest";
import type { SerializedEventPayload } from "./node-registry.js";
import { createNodeSubscriptionManager } from "./server-node-subscriptions.js";

describe("node subscription manager", () => {
  test("routes events with each subscribed node pairing generation", async () => {
    const manager = createNodeSubscriptionManager();
    const sent: Array<{
      nodeId: string;
      pairingGeneration: string;
      event: string;
      payloadJSON?: SerializedEventPayload | null;
    }> = [];

    manager.subscribe("node-a", "generation-a", "main");
    manager.subscribe("node-b", "generation-b", "main");
    await manager.sendToSession("main", "chat", { ok: true }, (event) => {
      sent.push(event);
    });

    expect(sent).toHaveLength(2);
    expect(sent.map((event) => event.nodeId).toSorted()).toEqual(["node-a", "node-b"]);
    expect(sent.map((event) => event.pairingGeneration).toSorted()).toEqual([
      "generation-a",
      "generation-b",
    ]);
  });

  test("unsubscribeAll clears both subscription indexes", async () => {
    const manager = createNodeSubscriptionManager();
    const sent: string[] = [];
    const sendEvent = (event: { nodeId: string; event: string }) => {
      sent.push(`${event.nodeId}:${event.event}`);
    };

    manager.subscribe("node-a", "generation-a", "main");
    manager.subscribe("node-a", "generation-a", "secondary");
    manager.unsubscribeAll("node-a");
    await manager.sendToSession("main", "tick", {}, sendEvent);
    await manager.sendToSession("secondary", "tick", {}, sendEvent);

    expect(sent).toStrictEqual([]);
  });

  test("settles sender failures without rejecting fire-and-forget fanout", async () => {
    const manager = createNodeSubscriptionManager();
    const sent: string[] = [];

    manager.subscribe("node-a", "generation-a", "main");
    manager.subscribe("node-b", "generation-b", "main");
    await expect(
      manager.sendToSession("main", "tick", {}, ({ nodeId }) => {
        if (nodeId === "node-a") {
          throw new Error("transport failed");
        }
        sent.push(nodeId);
      }),
    ).resolves.toBeUndefined();

    expect(sent).toStrictEqual(["node-b"]);
  });

  test("drops unserializable payloads without rejecting fanout", async () => {
    const manager = createNodeSubscriptionManager();
    const sendEvent = vi.fn();

    manager.subscribe("node-a", "generation-a", "main");
    await expect(
      manager.sendToSession("main", "tick", { invalid: 1n }, sendEvent),
    ).resolves.toBeUndefined();

    expect(sendEvent).not.toHaveBeenCalled();
  });
});
