import { createHash } from "node:crypto";
import { isRecord } from "../utils.js";
import type {
  OfficialExternalPluginCatalogEntry,
  OfficialExternalPluginCatalogFeed,
} from "./official-external-plugin-catalog.js";

export const OFFICIAL_EXTERNAL_PLUGIN_CATALOG_SHARD_MAX_BYTES = 1024 * 1024;
export const OFFICIAL_EXTERNAL_PLUGIN_CATALOG_SHARD_MAX_ENTRIES = 10_000;
const OFFICIAL_EXTERNAL_PLUGIN_CATALOG_SHARD_ROOT_MAX_BYTES = 1024 * 1024;
const OFFICIAL_EXTERNAL_PLUGIN_CATALOG_SHARD_ROOT_MAX_SHARDS = 1024;
const OFFICIAL_EXTERNAL_PLUGIN_CATALOG_SHARD_ROOT_MAX_ENTRIES = 1_000_000;
const OFFICIAL_EXTERNAL_PLUGIN_CATALOG_SHARD_SET_MAX_BYTES = 256 * 1024 * 1024;
const SHARDED_SNAPSHOT_KIND = "official-external-plugin-catalog-shards-v1";

export type OfficialExternalPluginCatalogShardDescriptor = {
  index: number;
  url: string;
  sha256: string;
  byteLength: number;
  entryCount: number;
};

export type OfficialExternalPluginCatalogShardRoot = {
  schemaVersion: 1;
  feedId: string;
  sequence: number;
  generatedAt: string;
  expiresAt: string;
  metadata: { description: string | null };
  entryCount: number;
  shards: readonly OfficialExternalPluginCatalogShardDescriptor[];
};

type OfficialExternalPluginCatalogShard = {
  schemaVersion: 1;
  feedId: string;
  sequence: number;
  index: number;
  entries: readonly OfficialExternalPluginCatalogEntry[];
};

export type OfficialExternalPluginCatalogShardedSnapshot = {
  kind: typeof SHARDED_SNAPSHOT_KIND;
  rootBody: string;
  shardBodies: readonly string[];
};

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).toSorted();
  const expected = [...keys].toSorted();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function requireNonNegativeInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative safe integer`);
  }
  return value;
}

function parseRfc3339Instant(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length > 64) {
    throw new Error(`${label} is invalid`);
  }
  const match =
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|([+-])(\d{2}):(\d{2}))$/u.exec(
      value,
    );
  if (!match) {
    throw new Error(`${label} is invalid`);
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const offsetHour = Number(match[8] ?? "0");
  const offsetMinute = Number(match[9] ?? "0");
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > daysInMonth[month - 1]! ||
    hour > 23 ||
    minute > 59 ||
    second > 59 ||
    offsetHour > 23 ||
    offsetMinute > 59 ||
    !Number.isFinite(Date.parse(value))
  ) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

function parseShardDescriptor(
  value: unknown,
  expectedIndex: number,
): OfficialExternalPluginCatalogShardDescriptor {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["index", "url", "sha256", "byteLength", "entryCount"])
  ) {
    throw new Error("hosted catalog shard descriptor is malformed");
  }
  const index = requireNonNegativeInteger(value.index, "hosted catalog shard index");
  if (index !== expectedIndex) {
    throw new Error("hosted catalog shard indexes must be contiguous");
  }
  if (typeof value.sha256 !== "string" || !/^[a-f0-9]{64}$/u.test(value.sha256)) {
    throw new Error("hosted catalog shard digest must be lowercase SHA-256 hex");
  }
  const byteLength = requireNonNegativeInteger(value.byteLength, "hosted catalog shard byteLength");
  if (byteLength < 1 || byteLength > OFFICIAL_EXTERNAL_PLUGIN_CATALOG_SHARD_MAX_BYTES) {
    throw new Error("hosted catalog shard byteLength is invalid");
  }
  const entryCount = requireNonNegativeInteger(value.entryCount, "hosted catalog shard entryCount");
  if (entryCount < 1 || entryCount > OFFICIAL_EXTERNAL_PLUGIN_CATALOG_SHARD_MAX_ENTRIES) {
    throw new Error("hosted catalog shard entryCount is invalid");
  }
  if (typeof value.url !== "string" || Buffer.byteLength(value.url, "utf8") > 2048) {
    throw new Error("hosted catalog shard URL must be absolute HTTPS");
  }
  let url: URL;
  try {
    url = new URL(value.url);
  } catch {
    throw new Error("hosted catalog shard URL must be absolute HTTPS");
  }
  if (url.protocol !== "https:" || url.username || url.password || url.hash) {
    throw new Error("hosted catalog shard URL must be absolute HTTPS without credentials");
  }
  return {
    index,
    url: url.href,
    sha256: value.sha256,
    byteLength,
    entryCount,
  };
}

export function parseOfficialExternalPluginCatalogShardRoot(
  value: unknown,
): OfficialExternalPluginCatalogShardRoot {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "schemaVersion",
      "feedId",
      "sequence",
      "generatedAt",
      "expiresAt",
      "metadata",
      "entryCount",
      "shards",
    ]) ||
    value.schemaVersion !== 1 ||
    typeof value.feedId !== "string" ||
    value.feedId.trim().length === 0 ||
    value.feedId.length > 256 ||
    !isRecord(value.metadata) ||
    !hasExactKeys(value.metadata, ["description"]) ||
    (value.metadata.description !== null && typeof value.metadata.description !== "string") ||
    !Array.isArray(value.shards)
  ) {
    throw new Error("hosted catalog shard root is malformed");
  }
  if (
    Buffer.byteLength(JSON.stringify(value), "utf8") >
    OFFICIAL_EXTERNAL_PLUGIN_CATALOG_SHARD_ROOT_MAX_BYTES
  ) {
    throw new Error("hosted catalog shard root exceeds its byte limit");
  }
  if (
    typeof value.metadata.description === "string" &&
    Buffer.byteLength(value.metadata.description, "utf8") > 1024
  ) {
    throw new Error("hosted catalog shard root description exceeds its limit");
  }
  const sequence = requireNonNegativeInteger(value.sequence, "hosted catalog shard root sequence");
  const generatedAt = parseRfc3339Instant(
    value.generatedAt,
    "hosted catalog shard root generatedAt",
  );
  const expiresAt = parseRfc3339Instant(value.expiresAt, "hosted catalog shard root expiresAt");
  if (Date.parse(expiresAt) <= Date.parse(generatedAt)) {
    throw new Error("hosted catalog shard root validity window is invalid");
  }
  const entryCount = requireNonNegativeInteger(
    value.entryCount,
    "hosted catalog shard root entryCount",
  );
  if (entryCount > OFFICIAL_EXTERNAL_PLUGIN_CATALOG_SHARD_ROOT_MAX_ENTRIES) {
    throw new Error("hosted catalog shard root entryCount exceeds its limit");
  }
  if (value.shards.length > OFFICIAL_EXTERNAL_PLUGIN_CATALOG_SHARD_ROOT_MAX_SHARDS) {
    throw new Error("hosted catalog shard root exceeds its shard limit");
  }
  if ((entryCount === 0) !== (value.shards.length === 0)) {
    throw new Error("hosted catalog empty shard roots must have no shard descriptors");
  }
  const shards = value.shards.map(parseShardDescriptor);
  const urls = new Set<string>();
  const digests = new Set<string>();
  let describedEntries = 0;
  let describedBytes = 0;
  for (const shard of shards) {
    if (urls.has(shard.url) || digests.has(shard.sha256)) {
      throw new Error("hosted catalog shard descriptors must be unique");
    }
    urls.add(shard.url);
    digests.add(shard.sha256);
    describedEntries += shard.entryCount;
    describedBytes += shard.byteLength;
  }
  if (describedEntries !== entryCount) {
    throw new Error("hosted catalog shard root entryCount does not match its descriptors");
  }
  if (describedBytes > OFFICIAL_EXTERNAL_PLUGIN_CATALOG_SHARD_SET_MAX_BYTES) {
    throw new Error("hosted catalog shard set exceeds its aggregate byte limit");
  }
  return {
    schemaVersion: 1,
    feedId: value.feedId,
    sequence,
    generatedAt,
    expiresAt,
    metadata: { description: value.metadata.description },
    entryCount,
    shards,
  };
}

function parseShard(value: unknown): OfficialExternalPluginCatalogShard {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["schemaVersion", "feedId", "sequence", "index", "entries"]) ||
    value.schemaVersion !== 1 ||
    typeof value.feedId !== "string" ||
    value.feedId.trim().length === 0 ||
    !Array.isArray(value.entries)
  ) {
    throw new Error("hosted catalog shard is malformed");
  }
  const sequence = requireNonNegativeInteger(value.sequence, "hosted catalog shard sequence");
  const index = requireNonNegativeInteger(value.index, "hosted catalog shard index");
  if (
    value.entries.length < 1 ||
    value.entries.length > OFFICIAL_EXTERNAL_PLUGIN_CATALOG_SHARD_MAX_ENTRIES
  ) {
    throw new Error("hosted catalog shard entry count is invalid");
  }
  const entries: OfficialExternalPluginCatalogEntry[] = [];
  let previousId: string | undefined;
  for (const entry of value.entries) {
    if (
      !isRecord(entry) ||
      entry.type !== "plugin" ||
      typeof entry.id !== "string" ||
      entry.id.trim().length === 0
    ) {
      throw new Error("hosted catalog shard entry is invalid");
    }
    if (previousId !== undefined && previousId.localeCompare(entry.id) >= 0) {
      throw new Error("hosted catalog shard entries must use deterministic id ordering");
    }
    previousId = entry.id;
    entries.push(entry);
  }
  return { schemaVersion: 1, feedId: value.feedId, sequence, index, entries };
}

export function validateOfficialExternalPluginCatalogShardSet(
  root: OfficialExternalPluginCatalogShardRoot,
  shardBodies: readonly string[],
): OfficialExternalPluginCatalogFeed {
  if (shardBodies.length !== root.shards.length) {
    throw new Error("hosted catalog shard set is incomplete");
  }
  const entries: OfficialExternalPluginCatalogEntry[] = [];
  const identities = new Set<string>();
  let previousId: string | undefined;
  for (const [index, body] of shardBodies.entries()) {
    const descriptor = root.shards[index];
    if (!descriptor) {
      throw new Error("hosted catalog shard set is incomplete");
    }
    const bytes = Buffer.from(body, "utf8");
    if (
      bytes.length !== descriptor.byteLength ||
      createHash("sha256").update(bytes).digest("hex") !== descriptor.sha256
    ) {
      throw new Error("hosted catalog shard bytes do not match their signed descriptor");
    }
    let raw: unknown;
    try {
      raw = JSON.parse(body) as unknown;
    } catch {
      throw new Error("hosted catalog shard payload is not valid JSON");
    }
    const shard = parseShard(raw);
    if (
      shard.feedId !== root.feedId ||
      shard.sequence !== root.sequence ||
      shard.index !== index ||
      shard.entries.length !== descriptor.entryCount
    ) {
      throw new Error("hosted catalog shard does not match its signed root");
    }
    for (const entry of shard.entries) {
      const identity = `${entry.type}\0${entry.id}`;
      if (identities.has(identity)) {
        throw new Error("hosted catalog shard set identity is duplicated");
      }
      identities.add(identity);
      if (previousId !== undefined && previousId.localeCompare(entry.id as string) >= 0) {
        throw new Error("hosted catalog shard set ordering is invalid");
      }
      previousId = entry.id as string;
      entries.push(entry);
    }
  }
  if (entries.length !== root.entryCount) {
    throw new Error("hosted catalog shard set entry count is incomplete");
  }
  return {
    schemaVersion: 1,
    id: root.feedId,
    sequence: root.sequence,
    generatedAt: root.generatedAt,
    ...(root.metadata.description === null ? {} : { description: root.metadata.description }),
    entries,
  };
}

export function parseOfficialExternalPluginCatalogShardedSnapshot(
  value: unknown,
): OfficialExternalPluginCatalogShardedSnapshot | null {
  if (!isRecord(value) || value.kind !== SHARDED_SNAPSHOT_KIND) {
    return null;
  }
  if (
    !hasExactKeys(value, ["kind", "rootBody", "shardBodies"]) ||
    typeof value.rootBody !== "string" ||
    !Array.isArray(value.shardBodies) ||
    !value.shardBodies.every((body): body is string => typeof body === "string")
  ) {
    throw new Error("hosted catalog sharded snapshot is malformed");
  }
  return { kind: SHARDED_SNAPSHOT_KIND, rootBody: value.rootBody, shardBodies: value.shardBodies };
}

export function serializeOfficialExternalPluginCatalogShardedSnapshot(params: {
  rootBody: string;
  shardBodies: readonly string[];
}): string {
  return JSON.stringify({
    kind: SHARDED_SNAPSHOT_KIND,
    rootBody: params.rootBody,
    shardBodies: params.shardBodies,
  });
}
