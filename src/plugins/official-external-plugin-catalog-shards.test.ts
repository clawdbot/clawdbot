import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  parseOfficialExternalPluginCatalogShardRoot,
  parseOfficialExternalPluginCatalogShardedSnapshot,
  serializeOfficialExternalPluginCatalogShardedSnapshot,
  validateOfficialExternalPluginCatalogShardSet,
} from "./official-external-plugin-catalog-shards.js";

function shardBody(index: number, ids: readonly string[]): string {
  return JSON.stringify({
    schemaVersion: 1,
    feedId: "clawhub-official",
    sequence: 7,
    index,
    entries: ids.map((id) => ({ type: "plugin", id })),
  });
}

function rootFor(shardBodies: readonly string[]) {
  return {
    schemaVersion: 1,
    feedId: "clawhub-official",
    sequence: 7,
    generatedAt: "2026-07-17T12:00:00Z",
    expiresAt: "2026-07-24T12:00:00Z",
    metadata: { description: "ClawHub plugins" },
    entryCount: shardBodies.length,
    shards: shardBodies.map((body, index) => ({
      index,
      url: `https://clawhub.ai/v1/feeds/plugins/shards/${index}.json`,
      sha256: createHash("sha256").update(body).digest("hex"),
      byteLength: Buffer.byteLength(body, "utf8"),
      entryCount: 1,
    })),
  };
}

describe("official external plugin catalog shards", () => {
  it("assembles a complete deterministically ordered shard set", () => {
    const bodies = [shardBody(0, ["@acme/alpha"]), shardBody(1, ["@acme/beta"])];
    const root = parseOfficialExternalPluginCatalogShardRoot(rootFor(bodies));

    expect(validateOfficialExternalPluginCatalogShardSet(root, bodies)).toMatchObject({
      schemaVersion: 1,
      id: "clawhub-official",
      sequence: 7,
      entries: [{ id: "@acme/alpha" }, { id: "@acme/beta" }],
    });
  });

  it("rejects cross-shard ordering and duplicate identities", () => {
    const unordered = [shardBody(0, ["@acme/beta"]), shardBody(1, ["@acme/alpha"])];
    expect(() =>
      validateOfficialExternalPluginCatalogShardSet(
        parseOfficialExternalPluginCatalogShardRoot(rootFor(unordered)),
        unordered,
      ),
    ).toThrow("shard set ordering is invalid");

    const duplicated = [shardBody(0, ["@acme/alpha"]), shardBody(1, ["@acme/alpha"])];
    expect(() =>
      validateOfficialExternalPluginCatalogShardSet(
        parseOfficialExternalPluginCatalogShardRoot(rootFor(duplicated)),
        duplicated,
      ),
    ).toThrow("identity is duplicated");
  });

  it("rejects malformed roots before any shard fetch", () => {
    const bodies = [shardBody(0, ["@acme/alpha"])];
    expect(() =>
      parseOfficialExternalPluginCatalogShardRoot({
        ...rootFor(bodies),
        unexpected: true,
      }),
    ).toThrow("shard root is malformed");
    expect(() =>
      parseOfficialExternalPluginCatalogShardRoot({
        ...rootFor(bodies),
        shards: [{ ...rootFor(bodies).shards[0], sha256: "ABC" }],
      }),
    ).toThrow("lowercase SHA-256 hex");
  });

  it("round-trips the exact authenticated root and shard bytes for fallback", () => {
    const bodies = [shardBody(0, ["@acme/alpha"])];
    const rootBody = '{"signed":"root"}';
    const serialized = serializeOfficialExternalPluginCatalogShardedSnapshot({
      rootBody,
      shardBodies: bodies,
    });

    expect(parseOfficialExternalPluginCatalogShardedSnapshot(JSON.parse(serialized))).toEqual({
      kind: "official-external-plugin-catalog-shards-v1",
      rootBody,
      shardBodies: bodies,
    });
  });
});
