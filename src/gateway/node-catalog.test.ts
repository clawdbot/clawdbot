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
    expect(entry?.nodePairing).toEqual(
      expect.objectContaining({
        commands: ["system.run"],
        caps: ["camera"],
        approvedAtMs: 100,
      }),
    );
    expect(getKnownNode(catalog, "mac-1")).toEqual(
      expect.objectContaining({
        nodeId: "mac-1",
        displayName: "Mac",
        clientId: "openclaw-macos",
        clientMode: "node",
        remoteIp: "100.0.0.11",
        caps: ["camera", "screen"],
        commands: ["screen.snapshot", "system.run"],
        pathEnv: "/usr/bin:/bin",
        approvedAtMs: 100,
        connectedAtMs,
        lastSeenAtMs: connectedAtMs,
        lastSeenReason: "connect",
        paired: true,
        connected: true,
      }),
    );
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
    expect(entry?.nodePairing).toEqual(
      expect.objectContaining({
        commands: ["system.run"],
        caps: ["system"],
        approvedAtMs: 123,
      }),
    );
    expect(getKnownNode(catalog, "mac-1")).toEqual(
      expect.objectContaining({
        nodeId: "mac-1",
        caps: ["system"],
        commands: ["system.run"],
        approvedAtMs: 123,
        lastSeenAtMs: 456,
        lastSeenReason: "silent_push",
        paired: true,
        connected: false,
      }),
    );
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

    expect(getKnownNode(catalog, "ios-1")).toEqual(
      expect.objectContaining({
        lastSeenAtMs: 300,
        lastSeenReason: "silent_push",
      }),
    );
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

    expect(getKnownNode(catalog, "mac-1")).toEqual(
      expect.objectContaining({
        caps: ["canvas"],
        commands: ["canvas.snapshot"],
        connected: true,
      }),
    );
  });
});
