/**
 * Gateway node catalog regression tests.
 */
import { describe, expect, it } from "vitest";
import {
  createKnownNodeCatalog,
  getKnownNode,
  getKnownNodeEntry,
  listKnownNodes,
} from "./node-catalog.js";

type CatalogInput = Parameters<typeof createKnownNodeCatalog>[0];
type TestPairedDevice = CatalogInput["pairedDevices"][number];
type TestPairedNode = NonNullable<CatalogInput["pairedNodes"]>[number];
type TestPendingNode = NonNullable<CatalogInput["pendingNodes"]>[number];

function pairedDevice(overrides: Partial<TestPairedDevice> = {}): TestPairedDevice {
  return {
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
    ...overrides,
  };
}

function pairedNode(overrides: Partial<TestPairedNode> = {}): TestPairedNode {
  return {
    nodeId: "mac-1",
    platform: "macos",
    caps: ["camera"],
    commands: ["system.run"],
    createdAtMs: 1,
    approvedAtMs: 100,
    ...overrides,
  };
}

function pendingNode(overrides: Partial<TestPendingNode> = {}): TestPendingNode {
  return {
    requestId: "request-1",
    nodeId: "mac-1",
    platform: "macos",
    caps: ["camera", "screen"],
    commands: ["screen.snapshot", "system.run"],
    permissions: { camera: true, screen: true },
    ts: 200,
    ...overrides,
  };
}

describe("gateway/node-catalog", () => {
  it("filters paired nodes by active node token instead of sticky historical roles", () => {
    const catalog = createKnownNodeCatalog({
      pairedDevices: [
        pairedDevice({
          deviceId: "legacy-mac",
          displayName: "Peter's Mac Studio",
          clientId: "clawdbot-macos",
          tokens: {
            node: {
              token: "legacy-token",
              role: "node",
              scopes: [],
              createdAtMs: 1,
              revokedAtMs: 2,
            },
          },
          approvedAtMs: 1,
        }),
        pairedDevice({
          deviceId: "current-mac",
          displayName: "Peter's Mac Studio",
          approvedAtMs: 1,
        }),
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
        pairedDevice({
          remoteIp: "100.0.0.10",
        }),
      ],
      pairedNodes: [
        pairedNode({
          displayName: "Mac",
          version: "1.2.0",
          coreVersion: "1.2.0",
          uiVersion: "1.2.0",
          remoteIp: "100.0.0.9",
          approvedAtMs: 100,
        }),
      ],
      connectedNodes: [
        {
          nodeId: "mac-1",
          connId: "conn-1",
          client: {} as never,
          clientId: "openclaw-macos",
          clientMode: "node",
          displayName: "Mac",
          platform: "macos",
          version: "1.2.3",
          declaredCaps: ["camera", "screen"],
          caps: ["camera", "screen"],
          declaredCommands: ["screen.snapshot", "system.run"],
          commands: ["screen.snapshot", "system.run"],
          declaredNodePluginTools: [],
          nodePluginTools: [],
          nodeSkills: [],
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
      pairedDevices: [pairedDevice()],
      pairedNodes: [
        pairedNode({
          caps: ["system"],
          lastSeenAtMs: 456,
          lastSeenReason: "silent_push",
          approvedAtMs: 123,
        }),
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
        pairedDevice({
          deviceId: "ios-1",
          displayName: "iPhone",
          lastSeenAtMs: 300,
          lastSeenReason: "silent_push",
          approvedAtMs: 10,
        }),
      ],
      pairedNodes: [
        pairedNode({
          nodeId: "ios-1",
          platform: "ios",
          caps: [],
          commands: [],
          lastConnectedAtMs: 200,
          lastSeenAtMs: 100,
          lastSeenReason: "bg_app_refresh",
          approvedAtMs: 11,
        }),
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
        pairedNode({
          caps: ["system"],
          approvedAtMs: 123,
        }),
      ],
      connectedNodes: [
        {
          nodeId: "mac-1",
          connId: "conn-1",
          client: {} as never,
          displayName: "Mac",
          platform: "macos",
          declaredCaps: ["canvas"],
          caps: ["canvas"],
          declaredCommands: ["canvas.snapshot"],
          commands: ["canvas.snapshot"],
          declaredNodePluginTools: [],
          nodePluginTools: [],
          nodeSkills: [],
          connectedAtMs: 1,
        },
      ],
    });

    const node = getKnownNode(catalog, "mac-1");
    expect(node?.caps).toEqual(["canvas"]);
    expect(node?.commands).toEqual(["canvas.snapshot"]);
    expect(node?.connected).toBe(true);
  });

  it("reports pending first approval without making declarations effective", () => {
    const catalog = createKnownNodeCatalog({
      pairedDevices: [pairedDevice({ deviceId: "new-node" })],
      pairedNodes: [],
      pendingNodes: [pendingNode({ nodeId: "new-node", displayName: "Pending Mac" })],
      connectedNodes: [],
    });

    const node = getKnownNode(catalog, "new-node");
    expect(node?.displayName).toBe("Mac");
    expect(node?.approvalState).toBe("pending-approval");
    expect(node?.pendingRequestId).toBe("request-1");
    expect(node?.pendingDeclaredCaps).toEqual(["camera", "screen"]);
    expect(node?.pendingDeclaredCommands).toEqual(["screen.snapshot", "system.run"]);
    expect(node?.pendingDeclaredPermissions).toEqual({ camera: true, screen: true });
    expect(node?.caps).toEqual([]);
    expect(node?.commands).toEqual([]);
    expect(node?.permissions).toBeUndefined();
  });

  it("uses pending request metadata as the final fallback for pending-only nodes", () => {
    const catalog = createKnownNodeCatalog({
      pairedDevices: [],
      pairedNodes: [],
      pendingNodes: [
        pendingNode({
          nodeId: "new-node",
          clientId: "openclaw-linux",
          clientMode: "node",
          displayName: "Pending Node",
          platform: "linux",
          version: "1.2.3",
          coreVersion: "1.2.4",
          uiVersion: "1.2.5",
          deviceFamily: "desktop",
          modelIdentifier: "x86_64",
          remoteIp: "100.0.0.20",
        }),
      ],
      connectedNodes: [],
    });

    expect(getKnownNode(catalog, "new-node")).toMatchObject({
      nodeId: "new-node",
      clientId: "openclaw-linux",
      clientMode: "node",
      displayName: "Pending Node",
      platform: "linux",
      version: "1.2.3",
      coreVersion: "1.2.4",
      uiVersion: "1.2.5",
      deviceFamily: "desktop",
      modelIdentifier: "x86_64",
      remoteIp: "100.0.0.20",
      approvalState: "pending-approval",
      pendingRequestId: "request-1",
      caps: [],
      commands: [],
      paired: false,
      connected: false,
    });
    expect(getKnownNode(catalog, "new-node")?.permissions).toBeUndefined();
  });

  it("preserves pending first approval when a metadata reconnect omits permissions", () => {
    const catalog = createKnownNodeCatalog({
      pairedDevices: [pairedDevice({ deviceId: "new-node" })],
      pairedNodes: [],
      pendingNodes: [pendingNode({ nodeId: "new-node" })],
      connectedNodes: [
        {
          nodeId: "new-node",
          connId: "conn-1",
          client: {} as never,
          displayName: "New Node",
          platform: "macos",
          declaredCaps: ["camera", "screen"],
          caps: [],
          declaredCommands: ["screen.snapshot", "system.run"],
          commands: [],
          declaredNodePluginTools: [],
          nodePluginTools: [],
          nodeSkills: [],
          connectedAtMs: 1,
        },
      ],
    });

    const node = getKnownNode(catalog, "new-node");
    expect(node?.approvalState).toBe("pending-approval");
    expect(node?.pendingRequestId).toBe("request-1");
    expect(node?.pendingDeclaredPermissions).toEqual({ camera: true, screen: true });
    expect(node?.permissions).toBeUndefined();
  });

  it("reports pending reapproval without making declarations effective", () => {
    const catalog = createKnownNodeCatalog({
      pairedDevices: [pairedDevice()],
      pairedNodes: [
        pairedNode({
          caps: ["camera"],
          commands: ["screen.snapshot"],
          permissions: { camera: true },
        }),
      ],
      pendingNodes: [pendingNode()],
      connectedNodes: [
        {
          nodeId: "mac-1",
          connId: "conn-1",
          client: {} as never,
          displayName: "Mac",
          platform: "macos",
          declaredCaps: ["camera", "screen"],
          caps: ["camera"],
          declaredCommands: ["screen.snapshot", "system.run"],
          commands: ["screen.snapshot"],
          declaredNodePluginTools: [],
          nodePluginTools: [],
          nodeSkills: [],
          declaredPermissions: { camera: true, screen: true },
          permissions: { camera: true },
          connectedAtMs: 1,
        },
      ],
    });

    const node = getKnownNode(catalog, "mac-1");
    expect(node?.approvalState).toBe("pending-reapproval");
    expect(node?.pendingRequestId).toBe("request-1");
    expect(node?.pendingDeclaredCaps).toEqual(["camera", "screen"]);
    expect(node?.pendingDeclaredCommands).toEqual(["screen.snapshot", "system.run"]);
    expect(node?.pendingDeclaredPermissions).toEqual({ camera: true, screen: true });
    expect(node?.caps).toEqual(["camera"]);
    expect(node?.commands).toEqual(["screen.snapshot"]);
    expect(node?.permissions).toEqual({ camera: true });
  });

  it("ignores a pending reapproval that no longer matches the live declaration", () => {
    const catalog = createKnownNodeCatalog({
      pairedDevices: [pairedDevice()],
      pairedNodes: [
        pairedNode({
          caps: ["camera"],
          commands: ["screen.snapshot"],
          permissions: { camera: true },
        }),
      ],
      pendingNodes: [pendingNode()],
      connectedNodes: [
        {
          nodeId: "mac-1",
          connId: "conn-1",
          client: {} as never,
          displayName: "Mac",
          platform: "macos",
          declaredCaps: ["camera"],
          caps: ["camera"],
          declaredCommands: ["screen.snapshot"],
          commands: ["screen.snapshot"],
          declaredNodePluginTools: [],
          nodePluginTools: [],
          nodeSkills: [],
          declaredPermissions: { camera: true },
          permissions: { camera: true },
          connectedAtMs: 1,
        },
      ],
    });

    const entry = getKnownNodeEntry(catalog, "mac-1");
    expect(entry?.pendingNodePairing).toBeUndefined();
    const node = getKnownNode(catalog, "mac-1");
    expect(node?.approvalState).toBe("approved");
    expect(node?.pendingRequestId).toBeUndefined();
    expect(node?.pendingDeclaredCaps).toBeUndefined();
    expect(node?.pendingDeclaredCommands).toBeUndefined();
    expect(node?.pendingDeclaredPermissions).toBeUndefined();
    expect(node?.caps).toEqual(["camera"]);
    expect(node?.commands).toEqual(["screen.snapshot"]);
    expect(node?.permissions).toEqual({ camera: true });
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

  it("normalizes non-string scalar fields from malformed pairing records (no nodes-status crash)", () => {
    // Paired/pending records are blind-cast from disk, so every formatter-facing scalar can be a
    // non-string; before this guard a `nodes status` formatter (.trim() / sanitizeTerminalText) threw.
    const catalog = createKnownNodeCatalog({
      pairedDevices: [
        pairedDevice({
          deviceId: "mac-1",
          displayName: 654 as unknown as string,
          clientId: 456 as unknown as string,
          clientMode: 789 as unknown as string,
        }),
      ],
      pairedNodes: [
        pairedNode({
          nodeId: "mac-1",
          version: 123 as unknown as string,
          displayName: 321 as unknown as string,
          platform: 11 as unknown as string,
          remoteIp: 22 as unknown as string,
          deviceFamily: 33 as unknown as string,
          modelIdentifier: 44 as unknown as string,
        }),
      ],
      connectedNodes: [],
    });

    const node = getKnownNode(catalog, "mac-1");
    expect(node?.version).toBeUndefined();
    expect(node?.displayName).toBeUndefined();
    expect(node?.clientId).toBeUndefined();
    expect(node?.clientMode).toBeUndefined();
    expect(node?.platform).toBeUndefined();
    expect(node?.remoteIp).toBeUndefined();
    expect(node?.deviceFamily).toBeUndefined();
    expect(node?.modelIdentifier).toBeUndefined();
  });

  it("falls through a non-string higher-priority scalar to a valid lower-priority value", () => {
    // A corrupted live (higher-priority) scalar must be treated as ABSENT so the valid paired
    // (lower-priority) value still surfaces, instead of the malformed value suppressing it.
    const catalog = createKnownNodeCatalog({
      pairedDevices: [pairedDevice({ deviceId: "mac-1" })],
      pairedNodes: [
        pairedNode({ nodeId: "mac-1", displayName: "Node Display", platform: "linux" }),
      ],
      connectedNodes: [
        {
          nodeId: "mac-1",
          connId: "conn-1",
          client: {} as never,
          displayName: 42 as unknown as string,
          platform: {} as unknown as string,
          declaredCaps: [],
          caps: [],
          declaredCommands: [],
          commands: [],
          declaredNodePluginTools: [],
          nodePluginTools: [],
          nodeSkills: [],
          connectedAtMs: 1,
        },
      ],
    });

    const node = getKnownNode(catalog, "mac-1");
    expect(node?.displayName).toBe("Node Display");
    expect(node?.platform).toBe("linux");
  });

  it("drops blind-cast pairing entries whose required id is not a string", () => {
    const catalog = createKnownNodeCatalog({
      pairedDevices: [
        pairedDevice({ deviceId: "good-node" }),
        // A corrupted pairing file can carry a non-string id; without the catalog id guard
        // these would key the maps and crash listKnownNodes' nodeId.localeCompare sort.
        pairedDevice({ deviceId: 7 as unknown as string }),
      ],
      pairedNodes: [
        pairedNode({ nodeId: "good-node" }),
        pairedNode({ nodeId: {} as unknown as string }),
      ],
      pendingNodes: [pendingNode({ nodeId: [] as unknown as string })],
      connectedNodes: [],
    });

    const nodes = listKnownNodes(catalog);
    expect(nodes.map((entry) => entry.nodeId)).toEqual(["good-node"]);
    expect(getKnownNode(catalog, "good-node")).not.toBeNull();
  });
});
