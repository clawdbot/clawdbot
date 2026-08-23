// Node resolve tests cover node identity and address resolution helpers.
import { describe, expect, it } from "vitest";
import { resolveNodeFromNodeList, resolveNodeIdFromNodeList } from "./node-resolve.js";

describe("shared/node-resolve", () => {
  const nodes = [
    { nodeId: "mac-123", displayName: "Mac Studio", connected: true },
    { nodeId: "pi-456", displayName: "Raspberry Pi", connected: false },
  ];

  it("resolves node ids through candidate matching", () => {
    expect(resolveNodeIdFromNodeList(nodes, "Mac Studio")).toBe("mac-123");
  });

  it("supports optional default-node selection when query is blank", () => {
    expect(
      resolveNodeIdFromNodeList(nodes, "   ", {
        allowDefault: true,
        pickDefaultNode: (entries) => entries.find((entry) => entry.connected) ?? null,
      }),
    ).toBe("mac-123");
  });

  it("passes the original node list to the default picker", () => {
    expect(
      resolveNodeIdFromNodeList(nodes, "", {
        allowDefault: true,
        pickDefaultNode: (entries) => {
          expect(entries).toBe(nodes);
          return entries[1] ?? null;
        },
      }),
    ).toBe("pi-456");
  });

  it("still throws when default selection is disabled or returns null", () => {
    expect(() => resolveNodeIdFromNodeList(nodes, "   ")).toThrow(/node required/);
    expect(() =>
      resolveNodeIdFromNodeList(nodes, "", {
        allowDefault: true,
        pickDefaultNode: () => null,
      }),
    ).toThrow(/node required/);
  });

  it("returns the full node object and falls back to a synthetic entry when needed", () => {
    expect(resolveNodeFromNodeList(nodes, "pi-456")).toEqual(nodes[1]);
    expect(
      resolveNodeFromNodeList([], "", {
        allowDefault: true,
        pickDefaultNode: () => ({ nodeId: "synthetic-1" }),
      }),
    ).toEqual({ nodeId: "synthetic-1" });
  });
});
