import { describe, expect, it } from "vitest";
import type { PairedDevice } from "./index.ts";
import {
  buildNodesInventory,
  listStaleInventoryEntries,
  resolveInventoryRemoval,
} from "./inventory.ts";

function device(overrides: Partial<PairedDevice> & { deviceId: string }): PairedDevice {
  return {
    publicKey: `pk-${overrides.deviceId}`,
    roles: ["operator"],
    ...overrides,
  };
}

describe("buildNodesInventory", () => {
  it("joins device records with node catalog rows by id", () => {
    const groups = buildNodesInventory({
      paired: [
        device({
          deviceId: "node-1",
          displayName: "megaclaw",
          roles: ["operator", "node"],
          lastSeenAtMs: 1_000,
        }),
      ],
      nodes: [
        {
          nodeId: "node-1",
          displayName: "megaclaw",
          connected: true,
          paired: true,
          caps: ["screen"],
          commands: ["system.run"],
          version: "2026.6.11",
        },
      ],
    });

    expect(groups).toHaveLength(1);
    const entry = groups[0].primary;
    expect(entry.id).toBe("node-1");
    expect(entry.connected).toBe(true);
    expect(entry.roles).toEqual(["operator", "node"]);
    expect(entry.version).toBe("2026.6.11");
    expect(entry.node?.caps).toEqual(["screen"]);
  });

  it("groups duplicate pairings by display name with the freshest entry first", () => {
    const groups = buildNodesInventory({
      paired: [
        device({ deviceId: "old-1", displayName: "MacBook", lastSeenAtMs: 1_000 }),
        device({ deviceId: "new-1", displayName: "MacBook", lastSeenAtMs: 3_000 }),
        device({ deviceId: "mid-1", displayName: "macbook", lastSeenAtMs: 2_000 }),
      ],
      nodes: [],
    });

    expect(groups).toHaveLength(1);
    expect(groups[0].primary.id).toBe("new-1");
    expect(groups[0].duplicates.map((entry) => entry.id)).toEqual(["mid-1", "old-1"]);
  });

  it("prefers connected entries as group primary over fresher offline ones", () => {
    const groups = buildNodesInventory({
      paired: [
        device({ deviceId: "offline-1", displayName: "megaclaw", lastSeenAtMs: 9_000 }),
        device({
          deviceId: "live-1",
          displayName: "megaclaw",
          roles: ["node"],
          lastSeenAtMs: 1_000,
        }),
      ],
      nodes: [{ nodeId: "live-1", connected: true, paired: true }],
    });

    expect(groups[0].primary.id).toBe("live-1");
    expect(groups[0].duplicates.map((entry) => entry.id)).toEqual(["offline-1"]);
  });

  it("groups anonymous records by client identity and keeps unknown ids separate", () => {
    const groups = buildNodesInventory({
      paired: [
        device({ deviceId: "cli-1", clientId: "cli", clientMode: "cli", lastSeenAtMs: 2_000 }),
        device({ deviceId: "cli-2", clientId: "cli", clientMode: "cli", lastSeenAtMs: 1_000 }),
        device({ deviceId: "anon-1" }),
        device({ deviceId: "anon-2" }),
      ],
      nodes: [],
    });

    const keys = groups.map((group) => group.key);
    expect(keys).toContain("client:cli:cli");
    expect(keys).toContain("id:anon-1");
    expect(keys).toContain("id:anon-2");
    const cliGroup = groups.find((group) => group.key === "client:cli:cli");
    expect(cliGroup?.primary.id).toBe("cli-1");
    expect(cliGroup?.duplicates.map((entry) => entry.id)).toEqual(["cli-2"]);
    expect(cliGroup?.name).toBe("cli");
  });

  it("keeps legacy node-only rows and marks them with the node role", () => {
    const groups = buildNodesInventory({
      paired: [],
      nodes: [{ nodeId: "legacy-1", displayName: "clawmac", paired: true, connected: false }],
    });

    expect(groups).toHaveLength(1);
    expect(groups[0].primary.roles).toEqual(["node"]);
    expect(groups[0].primary.device).toBeUndefined();
  });

  it("flags silent and trusted-cidr pairings as auto-approved", () => {
    const groups = buildNodesInventory({
      paired: [
        device({ deviceId: "cli-1", clientId: "cli", approvedVia: "silent" }),
        device({ deviceId: "cidr-1", displayName: "megaclaw", approvedVia: "trusted-cidr" }),
        device({ deviceId: "owner-1", displayName: "iPhone", approvedVia: "owner" }),
      ],
      nodes: [],
    });
    const byId = new Map(groups.map((group) => [group.primary.id, group.primary]));
    expect(byId.get("cli-1")?.autoApproved).toBe(true);
    expect(byId.get("cidr-1")?.autoApproved).toBe(true);
    expect(byId.get("owner-1")?.autoApproved).toBe(false);
  });
});

describe("listStaleInventoryEntries", () => {
  it("treats server-reported device connectivity as live for operator-only entries", () => {
    const groups = buildNodesInventory({
      paired: [
        device({
          deviceId: "cli-new",
          clientId: "cli",
          approvedVia: "silent",
          lastSeenAtMs: 3_000,
        }),
        device({
          deviceId: "cli-live",
          clientId: "cli",
          approvedVia: "silent",
          connected: true,
          lastSeenAtMs: 1_000,
        }),
        device({
          deviceId: "cli-stale",
          clientId: "cli",
          approvedVia: "silent",
          lastSeenAtMs: 2_000,
        }),
      ],
      nodes: [],
    });

    expect(groups[0].primary.id).toBe("cli-live");
    expect(listStaleInventoryEntries(groups).map((entry) => entry.id)).toEqual([
      "cli-new",
      "cli-stale",
    ]);
  });

  it("lists offline auto-approved duplicates only", () => {
    const groups = buildNodesInventory({
      paired: [
        device({
          deviceId: "new-1",
          displayName: "megaclaw",
          approvedVia: "silent",
          lastSeenAtMs: 3_000,
        }),
        device({
          deviceId: "live-old",
          displayName: "megaclaw",
          roles: ["node"],
          approvedVia: "trusted-cidr",
          lastSeenAtMs: 2_000,
        }),
        device({
          deviceId: "old-1",
          displayName: "megaclaw",
          approvedVia: "trusted-cidr",
          lastSeenAtMs: 1_000,
        }),
        // Owner-approved and pre-provenance duplicates never enter the bulk sweep.
        device({ deviceId: "owner-old", displayName: "megaclaw", approvedVia: "owner" }),
        device({ deviceId: "legacy-old", displayName: "megaclaw" }),
      ],
      nodes: [{ nodeId: "live-old", connected: true, paired: true }],
    });

    // Connected entry becomes primary; fresh offline entry stays a duplicate but
    // only offline auto-approved duplicates are safe to clean up.
    expect(listStaleInventoryEntries(groups).map((entry) => entry.id)).toEqual(["new-1", "old-1"]);
  });
});

describe("resolveInventoryRemoval", () => {
  it("routes node-role entries through node removal", () => {
    const groups = buildNodesInventory({
      paired: [device({ deviceId: "node-1", roles: ["node"], displayName: "megaclaw" })],
      nodes: [],
    });
    expect(resolveInventoryRemoval(groups[0].primary)).toEqual({
      removeNode: true,
      removeDevice: false,
    });
  });

  it("routes mixed-role entries through node and device removal", () => {
    const groups = buildNodesInventory({
      paired: [
        device({ deviceId: "mixed-1", roles: ["operator", "node"], displayName: "MacBook" }),
      ],
      nodes: [],
    });
    expect(resolveInventoryRemoval(groups[0].primary)).toEqual({
      removeNode: true,
      removeDevice: true,
    });
  });

  it("routes operator-only entries through device removal", () => {
    const groups = buildNodesInventory({
      paired: [device({ deviceId: "op-1", roles: ["operator"] })],
      nodes: [],
    });
    expect(resolveInventoryRemoval(groups[0].primary)).toEqual({
      removeNode: false,
      removeDevice: true,
    });
  });

  it("routes legacy node-only rows through node removal", () => {
    const groups = buildNodesInventory({
      paired: [],
      nodes: [{ nodeId: "legacy-1", paired: true }],
    });
    expect(resolveInventoryRemoval(groups[0].primary)).toEqual({
      removeNode: true,
      removeDevice: false,
    });
  });
});
