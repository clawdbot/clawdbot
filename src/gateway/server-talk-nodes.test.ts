/**
 * Tests gateway talk node state exposed through server events.
 */
import { describe, expect, it } from "vitest";
import type { NodeRegistry, NodeSession } from "./node-registry.js";
import { hasConnectedTalkNode } from "./server-talk-nodes.js";

function registryWith(nodes: Array<Partial<NodeSession>>): NodeRegistry {
  return {
    listCurrentConnected: async () =>
      nodes.map((node, index) => ({
        nodeId: `node-${index}`,
        connId: `conn-${index}`,
        declaredCaps: [],
        caps: [],
        declaredCommands: [],
        commands: [],
        connectedAtMs: 0,
        ...node,
      })),
  } as NodeRegistry;
}

describe("hasConnectedTalkNode", () => {
  it("uses explicit talk capability instead of platform names", async () => {
    await expect(
      hasConnectedTalkNode(registryWith([{ platform: "android", caps: ["device"], commands: [] }])),
    ).resolves.toBe(false);
    await expect(
      hasConnectedTalkNode(registryWith([{ platform: "linux", caps: ["talk"] }])),
    ).resolves.toBe(true);
  });

  it("accepts nodes that declare talk command support", async () => {
    await expect(
      hasConnectedTalkNode(registryWith([{ platform: "custom", commands: ["talk.ptt.start"] }])),
    ).resolves.toBe(true);
  });
});
