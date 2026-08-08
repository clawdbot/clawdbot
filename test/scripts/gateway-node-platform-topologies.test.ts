import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const CONTRACT_PATH = "qa/contracts/gateway-node-platform-topologies.json";
const PLATFORM_ORDER = [
  "macos",
  "ios",
  "watchos",
  "android",
  "wearos",
  "windows",
  "linux",
] as const;
const MAX_STRING_LENGTH = 180;
const SHA_PATTERN = /^[0-9a-f]{40}$/;

type JsonRecord = Record<string, unknown>;

function asRecord(value: unknown, label: string): JsonRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  return value as JsonRecord;
}

function assertExactKeys(value: JsonRecord, expected: readonly string[], label: string): void {
  expect(Object.keys(value).toSorted(), `${label} keys`).toEqual([...expected].toSorted());
}

function assertBoundedString(value: unknown, label: string): asserts value is string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > MAX_STRING_LENGTH ||
    value.trim() !== value
  ) {
    throw new Error(`${label} must be a bounded trimmed string.`);
  }
}

function assertRepositoryPath(value: unknown, label: string): asserts value is string {
  assertBoundedString(value, label);
  expect(value.startsWith("/")).toBe(false);
  expect(value.includes("\\")).toBe(false);
  expect(value.split("/")).not.toContain("");
  expect(value.split("/")).not.toContain(".");
  expect(value.split("/")).not.toContain("..");
}

function assertSourceAnchor(value: unknown, label: string, platform: string): string {
  const anchor = asRecord(value, label);
  expect(anchor.platform).toBe(platform);
  assertBoundedString(anchor.repository, `${label}.repository`);
  expect(["openclaw/openclaw", "openclaw/openclaw-windows-node"]).toContain(anchor.repository);
  assertRepositoryPath(anchor.path, `${label}.path`);
  expect(Array.isArray(anchor.symbols)).toBe(true);
  const symbols = anchor.symbols as unknown[];
  expect(symbols.length).toBeGreaterThan(0);
  for (const [symbolIndex, symbol] of symbols.entries()) {
    assertBoundedString(symbol, `${label}.symbols[${symbolIndex}]`);
  }

  if (anchor.repository === "openclaw/openclaw") {
    assertExactKeys(anchor, ["platform", "repository", "verification", "path", "symbols"], label);
    expect(anchor.verification).toBe("tracked-source-markers");
    expect(() =>
      execFileSync("git", ["ls-files", "--error-unmatch", "--", anchor.path], { stdio: "ignore" }),
    ).not.toThrow();
    const source = readFileSync(anchor.path, "utf8");
    for (const symbol of symbols as string[]) {
      expect(source, `${label} source anchor ${symbol}`).toContain(symbol);
    }
    return `${anchor.repository}:${anchor.path}`;
  }

  assertExactKeys(
    anchor,
    ["platform", "repository", "verification", "path", "revision", "symbols"],
    label,
  );
  expect(anchor.verification).toBe("unverified-external-reference");
  expect(anchor.revision).toMatch(SHA_PATTERN);
  return `${anchor.repository}@${anchor.revision}:${anchor.path}`;
}

function expectedTopology(platform: string): JsonRecord {
  if (platform === "watchos") {
    return {
      kind: "watch-http",
      gatewayNegotiator: "watchos",
      edges: [
        {
          from: "watchos",
          to: "gateway",
          transport: "bounded-https-challenge-connect-poll",
        },
      ],
    };
  }
  if (platform === "wearos") {
    return {
      kind: "wear-two-hop",
      gatewayNegotiator: "android-phone",
      edges: [
        {
          from: "wearos",
          to: "android-phone",
          transport: "wear-message-api-data-layer",
        },
        {
          from: "wearos",
          to: "android-phone",
          transport: "wear-channel-api-data-layer",
        },
        {
          from: "android-phone",
          to: "gateway",
          transport: "websocket",
        },
      ],
    };
  }
  return {
    kind: "direct-ws",
    gatewayNegotiator: platform,
    edges: [{ from: platform, to: "gateway", transport: "websocket" }],
  };
}

function validateInventory(value: unknown): JsonRecord {
  const inventory = asRecord(value, "platform topology inventory");
  assertExactKeys(
    inventory,
    ["kind", "scope", "releaseEvidence", "consumers", "platforms"],
    "platform topology inventory",
  );
  expect(inventory.kind).toBe("openclaw.gateway-node-platform-topology-reference");
  expect(inventory.scope).toBe("advisory-source-topology");
  expect(inventory.releaseEvidence).toBe("none");
  expect(inventory.consumers).toEqual([]);
  expect(Array.isArray(inventory.platforms)).toBe(true);
  const platforms = inventory.platforms as unknown[];
  expect(platforms).toHaveLength(PLATFORM_ORDER.length);

  const seenPlatforms = new Set<string>();
  platforms.forEach((rowValue, index) => {
    const row = asRecord(rowValue, `platforms[${index}]`);
    assertExactKeys(row, ["platform", "topology", "sourceAnchors"], `platforms[${index}]`);
    const platform = PLATFORM_ORDER[index];
    expect(row.platform).toBe(platform);
    assertBoundedString(row.platform, `platforms[${index}].platform`);
    expect(seenPlatforms.has(row.platform)).toBe(false);
    seenPlatforms.add(row.platform);

    const topology = asRecord(row.topology, `${row.platform}.topology`);
    assertExactKeys(topology, ["kind", "gatewayNegotiator", "edges"], `${row.platform}.topology`);
    expect(topology).toEqual(expectedTopology(platform));

    expect(Array.isArray(row.sourceAnchors)).toBe(true);
    const anchors = row.sourceAnchors as unknown[];
    expect(anchors.length).toBeGreaterThan(0);
    const identities = anchors.map((anchor, anchorIndex) =>
      assertSourceAnchor(anchor, `${row.platform}.sourceAnchors[${anchorIndex}]`, platform),
    );
    expect(new Set(identities).size).toBe(identities.length);
  });

  return inventory;
}

function readInventory(): { raw: string; value: JsonRecord } {
  const raw = readFileSync(CONTRACT_PATH, "utf8");
  expect(Buffer.byteLength(raw, "utf8")).toBeLessThanOrEqual(32 * 1024);
  return { raw, value: JSON.parse(raw) as JsonRecord };
}

function cloneInventory(): JsonRecord {
  return structuredClone(readInventory().value);
}

function windowsExternalAnchor(value: JsonRecord): JsonRecord {
  const windows = (value.platforms as JsonRecord[]).find((row) => row.platform === "windows");
  const anchor = (windows?.sourceAnchors as JsonRecord[] | undefined)?.find(
    (candidate) => candidate.repository === "openclaw/openclaw-windows-node",
  );
  if (!anchor) {
    throw new Error("Windows external source anchor is missing.");
  }
  return anchor;
}

describe("Gateway/node platform topology inventory", () => {
  it("is canonical advisory JSON with the exact seven validated platform rows", () => {
    const { raw, value } = readInventory();
    expect(raw).toBe(`${JSON.stringify(value, null, 2)}\n`);
    expect(validateInventory(value)).toBe(value);
  });

  it("encodes direct, watch HTTP, and Wear two-hop source topology", () => {
    const { platforms } = validateInventory(readInventory().value);
    const rows = platforms as JsonRecord[];
    expect(rows.map((row) => ({ platform: row.platform, topology: row.topology }))).toEqual(
      PLATFORM_ORDER.map((platform) => ({ platform, topology: expectedTopology(platform) })),
    );
  });

  it.each([
    [
      "release evidence field",
      (value: JsonRecord) => {
        value.currentRunEvidence = [];
      },
    ],
    [
      "release evidence consumer",
      (value: JsonRecord) => {
        value.consumers = ["scripts/release-ci-summary.mjs"];
      },
    ],
    [
      "missing platform",
      (value: JsonRecord) => {
        (value.platforms as unknown[]).pop();
      },
    ],
    [
      "duplicate platform",
      (value: JsonRecord) => {
        const rows = value.platforms as JsonRecord[];
        rows[1] = structuredClone(rows[0]);
      },
    ],
    [
      "unknown row field",
      (value: JsonRecord) => {
        (value.platforms as JsonRecord[])[0].coverage = [];
      },
    ],
    [
      "unpinned external source",
      (value: JsonRecord) => {
        delete windowsExternalAnchor(value).revision;
      },
    ],
    [
      "external source claiming local verification",
      (value: JsonRecord) => {
        windowsExternalAnchor(value).verification = "tracked-source-markers";
      },
    ],
    [
      "local source claiming external verification",
      (value: JsonRecord) => {
        const anchor = ((value.platforms as JsonRecord[])[0].sourceAnchors as JsonRecord[])[0];
        anchor.verification = "unverified-external-reference";
      },
    ],
    [
      "missing local source anchor",
      (value: JsonRecord) => {
        const anchor = ((value.platforms as JsonRecord[])[0].sourceAnchors as JsonRecord[])[0];
        anchor.path = "apps/macos/Sources/OpenClaw/NodeMode/DoesNotExist.swift";
      },
    ],
    [
      "stale local source symbol",
      (value: JsonRecord) => {
        const anchor = ((value.platforms as JsonRecord[])[0].sourceAnchors as JsonRecord[])[0];
        anchor.symbols = ["RemovedMacNodeTransport"];
      },
    ],
    [
      "cross-platform source anchors",
      (value: JsonRecord) => {
        const rows = value.platforms as JsonRecord[];
        rows[1].sourceAnchors = structuredClone(rows[0].sourceAnchors);
      },
    ],
    [
      "release coverage row field",
      (value: JsonRecord) => {
        (value.platforms as JsonRecord[])[0].coverage = [];
      },
    ],
    [
      "Wear negotiating directly with Gateway",
      (value: JsonRecord) => {
        const topology = (value.platforms as JsonRecord[])[4].topology as JsonRecord;
        topology.gatewayNegotiator = "wearos";
      },
    ],
  ])("rejects %s", (_name, mutate) => {
    const value = cloneInventory();
    mutate(value);
    expect(() => validateInventory(value)).toThrow();
  });
});
