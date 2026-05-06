import { describe, expect, it } from "vitest";
import type { NodeRegistry, NodeSession } from "./node-registry.js";
import { hasConnectedTalkNode } from "./server-talk-nodes.js";

function registryWith(nodes: Array<Partial<NodeSession>>): NodeRegistry {
  return {
    listConnected: () =>
      nodes.map((node, index) => ({
        nodeId: `node-${index}`,
        connId: `conn-${index}`,
        caps: [],
        commands: [],
        connectedAtMs: 0,
        ...node,
      })),
  } as NodeRegistry;
}

describe("hasConnectedTalkNode", () => {
  it("uses explicit talk capability instead of platform names", () => {
    expect(
      hasConnectedTalkNode(registryWith([{ platform: "android", caps: ["device"], commands: [] }])),
    ).toBe(false);
    expect(hasConnectedTalkNode(registryWith([{ platform: "linux", caps: ["talk"] }]))).toBe(true);
  });

  it("accepts nodes that declare talk command support", () => {
    expect(
      hasConnectedTalkNode(registryWith([{ platform: "custom", commands: ["talk.ptt.start"] }])),
    ).toBe(true);
  });
});
