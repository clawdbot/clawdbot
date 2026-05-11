import { describe, expect, it } from "vitest";
import {
  createKnownNodeCatalog,
  getKnownNode,
  getKnownNodeEntry,
  listKnownNodes,
} from "./node-catalog.js";

describe("gateway/node-catalog", () => {
  it("filters paired nodes by active node token instead of sticky historical roles", () => {
    const catalog = createKnownNodeCatalog({
      pairedDevices: [
        {
          deviceId: "legacy-mac",
          publicKey: "legacy-public-key",
          displayName: "Peter's Mac Studio",
          clientId: "clawdbot-macos",
          role: "node",
          roles: ["node"],
          tokens: {
            node: {
              token: "legacy-token",
              role: "node",
              scopes: [],
              createdAtMs: 1,
              revokedAtMs: 2,
            },
          },
          createdAtMs: 1,
          approvedAtMs: 1,
        },
        {
          deviceId: "current-mac",
          publicKey: "current-public-key",
          displayName: "Peter's Mac Studio",
          clientId: "openclaw-macos",
          role: "node",
          roles: ["node"],
          tokens: {
            node: {
              token: "current-token",
              role: "node",
              scopes: [],
              createdAtMs: 1,
            },
          },
          createdAtMs: 1,
          approvedAtMs: 1,
        },
      ],
      pairedNodes: [],
      connectedNodes: [],
    });

    expect(listKnownNodes(catalog).map((node) => node.nodeId)).toEqual(["current-mac"]);
  });

  it("builds one merged node view for paired and live state", () => {
    const connectedAtMs = 123;
    const catalog = createKnownNodeCatalog({
      pairedDevices: [
        {
          deviceId: "mac-1",
          publicKey: "public-key",
          displayName: "Mac",
          clientId: "openclaw-macos",
          clientMode: "node",
          role: "node",
          roles: ["node"],
          remoteIp: "100.0.0.10",
          tokens: {
            node: {
              token: "current-token",
              role: "node",
              scopes: [],
              createdAtMs: 1,
            },
          },
          createdAtMs: 1,
          approvedAtMs: 99,
        },
      ],
      pairedNodes: [
        {
          nodeId: "mac-1",
          token: "node-token",
          displayName: "Mac",
          platform: "darwin",
          version: "1.2.0",
          coreVersion: "1.2.0",
          uiVersion: "1.2.0",
          remoteIp: "100.0.0.9",
          caps: ["camera"],
          commands: ["system.run"],
          createdAtMs: 1,
          approvedAtMs: 100,
        },
      ],
      connectedNodes: [
        {
          nodeId: "mac-1",
          connId: "conn-1",
          client: {} as never,
          clientId: "openclaw-macos",
          clientMode: "node",
          displayName: "Mac",
          platform: "darwin",
          version: "1.2.3",
          caps: ["camera", "screen"],
          commands: ["screen.snapshot", "system.run"],
          remoteIp: "100.0.0.11",
          pathEnv: "/usr/bin:/bin",
          connectedAtMs,
        },
      ],
    });

    const entry = getKnownNodeEntry(catalog, "mac-1");
    expect(entry?.nodePairing?.commands).toEqual(["system.run"]);
    expect(entry?.nodePairing?.caps).toEqual(["camera"]);
    expect(entry?.nodePairing?.approvedAtMs).toBe(100);
    const node = getKnownNode(catalog, "mac-1");
    expect(node?.nodeId).toBe("mac-1");
    expect(node?.displayName).toBe("Mac");
    expect(node?.clientId).toBe("openclaw-macos");
    expect(node?.clientMode).toBe("node");
    expect(node?.remoteIp).toBe("100.0.0.11");
    expect(node?.caps).toEqual(["camera", "screen"]);
    expect(node?.commands).toEqual(["screen.snapshot", "system.run"]);
    expect(node?.pathEnv).toBe("/usr/bin:/bin");
    expect(node?.approvedAtMs).toBe(100);
    expect(node?.connectedAtMs).toBe(connectedAtMs);
    expect(node?.lastSeenAtMs).toBe(connectedAtMs);
    expect(node?.lastSeenReason).toBe("connect");
    expect(node?.paired).toBe(true);
    expect(node?.connected).toBe(true);
  });

  it("surfaces node-pair metadata even when the node is offline", () => {
    const catalog = createKnownNodeCatalog({
      pairedDevices: [
        {
          deviceId: "mac-1",
          publicKey: "public-key",
          displayName: "Mac",
          clientId: "openclaw-macos",
          clientMode: "node",
          role: "node",
          roles: ["node"],
          tokens: {
            node: {
              token: "current-token",
              role: "node",
              scopes: [],
              createdAtMs: 1,
            },
          },
          createdAtMs: 1,
          approvedAtMs: 99,
        },
      ],
      pairedNodes: [
        {
          nodeId: "mac-1",
          token: "node-token",
          platform: "darwin",
          caps: ["system"],
          commands: ["system.run"],
          lastSeenAtMs: 456,
          lastSeenReason: "silent_push",
          createdAtMs: 1,
          approvedAtMs: 123,
        },
      ],
      connectedNodes: [],
    });

    const entry = getKnownNodeEntry(catalog, "mac-1");
    expect(entry?.live).toBeUndefined();
    expect(entry?.nodePairing?.commands).toEqual(["system.run"]);
    expect(entry?.nodePairing?.caps).toEqual(["system"]);
    expect(entry?.nodePairing?.approvedAtMs).toBe(123);
    const node = getKnownNode(catalog, "mac-1");
    expect(node?.nodeId).toBe("mac-1");
    expect(node?.caps).toEqual(["system"]);
    expect(node?.commands).toEqual(["system.run"]);
    expect(node?.approvedAtMs).toBe(123);
    expect(node?.lastSeenAtMs).toBe(456);
    expect(node?.lastSeenReason).toBe("silent_push");
    expect(node?.paired).toBe(true);
    expect(node?.connected).toBe(false);
  });

  it("uses the newest durable last-seen source for offline nodes", () => {
    const catalog = createKnownNodeCatalog({
      pairedDevices: [
        {
          deviceId: "ios-1",
          publicKey: "public-key",
          displayName: "iPhone",
          role: "node",
          roles: ["node"],
          tokens: {
            node: {
              token: "current-token",
              role: "node",
              scopes: [],
              createdAtMs: 1,
            },
          },
          lastSeenAtMs: 300,
          lastSeenReason: "silent_push",
          createdAtMs: 1,
          approvedAtMs: 10,
        },
      ],
      pairedNodes: [
        {
          nodeId: "ios-1",
          token: "node-token",
          platform: "ios",
          caps: [],
          commands: [],
          lastConnectedAtMs: 200,
          lastSeenAtMs: 100,
          lastSeenReason: "bg_app_refresh",
          createdAtMs: 1,
          approvedAtMs: 11,
        },
      ],
      connectedNodes: [],
    });

    const node = getKnownNode(catalog, "ios-1");
    expect(node?.lastSeenAtMs).toBe(300);
    expect(node?.lastSeenReason).toBe("silent_push");
  });

  it("prefers the live command surface for connected nodes", () => {
    const catalog = createKnownNodeCatalog({
      pairedDevices: [],
      pairedNodes: [
        {
          nodeId: "mac-1",
          token: "node-token",
          platform: "darwin",
          caps: ["system"],
          commands: ["system.run"],
          createdAtMs: 1,
          approvedAtMs: 123,
        },
      ],
      connectedNodes: [
        {
          nodeId: "mac-1",
          connId: "conn-1",
          client: {} as never,
          displayName: "Mac",
          platform: "darwin",
          caps: ["canvas"],
          commands: ["canvas.snapshot"],
          connectedAtMs: 1,
        },
      ],
    });

    const node = getKnownNode(catalog, "mac-1");
    expect(node?.caps).toEqual(["canvas"]);
    expect(node?.commands).toEqual(["canvas.snapshot"]);
    expect(node?.connected).toBe(true);
  });

  it("ignores malformed node capability entries instead of throwing", () => {
    const catalog = createKnownNodeCatalog({
      pairedDevices: [],
      pairedNodes: [],
      connectedNodes: [
        {
          nodeId: "bad-node",
          connId: "conn-1",
          client: {} as never,
          displayName: "Bad Node",
          caps: ["camera", undefined],
          commands: ["system.run", null],
          connectedAtMs: 1,
        } as never,
      ],
    });

    const nodes = listKnownNodes(catalog);
    expect(nodes).toHaveLength(1);
    expect(nodes[0]?.nodeId).toBe("bad-node");
    expect(nodes[0]?.caps).toEqual(["camera"]);
    expect(nodes[0]?.commands).toEqual(["system.run"]);
  });
});
