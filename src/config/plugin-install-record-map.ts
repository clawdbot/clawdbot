import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { z } from "zod";
import type { PluginInstallRecord } from "./types.plugins.js";
import { PluginInstallRecordShape } from "./zod-schema.installs.js";

export const PluginInstallRecordSchema = z.object(PluginInstallRecordShape).passthrough();

const NORMALIZED_STRING_FIELDS = [
  "spec",
  "sourcePath",
  "installPath",
  "version",
  "resolvedName",
  "resolvedVersion",
  "resolvedSpec",
  "integrity",
  "shasum",
  "resolvedAt",
  "installedAt",
  "clawhubUrl",
  "clawhubPackage",
  "clawhubFamily",
  "clawhubChannel",
  "clawhubTrustDisposition",
  "clawhubTrustScanStatus",
  "clawhubTrustModerationState",
  "clawhubTrustCheckedAt",
  "clawhubTrustAcknowledgedAt",
  "artifactKind",
  "artifactFormat",
  "npmIntegrity",
  "npmShasum",
  "npmTarballName",
  "clawpackSha256",
  "clawpackManifestSha256",
  "gitUrl",
  "gitRef",
  "gitCommit",
  "marketplaceName",
  "marketplaceSource",
  "marketplacePlugin",
  "acceptedSurfaceHash",
  "acceptedSurfaceAt",
  "acceptedSurfaceIntegrity",
] as const satisfies readonly (keyof PluginInstallRecord)[];

export type PluginInstallRecordMapState =
  | { status: "missing" }
  | { status: "invalid" }
  | { status: "valid"; records: Record<string, PluginInstallRecord> };

const utf8Encoder = new TextEncoder();

function comparePluginIds(left: string, right: string): number {
  const leftBytes = utf8Encoder.encode(left);
  const rightBytes = utf8Encoder.encode(right);
  const sharedLength = Math.min(leftBytes.length, rightBytes.length);
  for (let index = 0; index < sharedLength; index += 1) {
    const difference = (leftBytes[index] ?? 0) - (rightBytes[index] ?? 0);
    if (difference !== 0) {
      return difference;
    }
  }
  return leftBytes.length - rightBytes.length;
}

export function createPluginInstallRecordMap<T>(): Record<string, T> {
  return Object.create(null) as Record<string, T>;
}

export function setPluginInstallRecordMapEntry<T>(
  records: Record<string, T>,
  pluginId: string,
  record: T,
): void {
  Object.defineProperty(records, pluginId, {
    configurable: true,
    enumerable: true,
    value: record,
    writable: true,
  });
}

export function getPluginInstallRecordMapEntry<T>(
  records: Readonly<Record<string, T>> | undefined,
  pluginId: string,
): T | undefined {
  return records && Object.hasOwn(records, pluginId) ? records[pluginId] : undefined;
}

export function copyPluginInstallRecordMap<T>(
  records: Readonly<Record<string, T>> | undefined,
): Record<string, T> {
  const copied = createPluginInstallRecordMap<T>();
  for (const [pluginId, record] of Object.entries(records ?? {})) {
    setPluginInstallRecordMapEntry(copied, pluginId, record);
  }
  return copied;
}

export function parsePluginInstallRecord(value: unknown): PluginInstallRecord | null {
  const parsed = PluginInstallRecordSchema.safeParse(value);
  if (!parsed.success) {
    return null;
  }
  const record = parsed.data as PluginInstallRecord & Record<string, unknown>;
  for (const field of NORMALIZED_STRING_FIELDS) {
    const fieldValue = record[field];
    if (typeof fieldValue !== "string") {
      continue;
    }
    const normalized = fieldValue.trim();
    if (normalized) {
      record[field] = normalized as never;
    } else {
      delete record[field];
    }
  }
  if (record.clawhubTrustReasons) {
    const reasons = record.clawhubTrustReasons.map((entry) => entry.trim()).filter(Boolean);
    if (reasons.length > 0) {
      record.clawhubTrustReasons = reasons;
    } else {
      delete record.clawhubTrustReasons;
    }
  }
  return record;
}

export function parsePluginInstallRecordMap(
  value: unknown,
): Record<string, PluginInstallRecord> | null {
  if (!isRecord(value)) {
    return null;
  }
  const records = createPluginInstallRecordMap<PluginInstallRecord>();
  for (const [pluginId, rawRecord] of Object.entries(value)) {
    const record = parsePluginInstallRecord(rawRecord);
    if (!record) {
      return null;
    }
    setPluginInstallRecordMapEntry(records, pluginId, record);
  }
  return records;
}

export function inspectPluginInstallRecordMap(value: unknown): PluginInstallRecordMapState {
  if (value === undefined) {
    return { status: "missing" };
  }
  const records = parsePluginInstallRecordMap(value);
  return records ? { status: "valid", records } : { status: "invalid" };
}

/**
 * Object enumeration reorders integer-index keys, so persisted bytes must be
 * assembled from sorted entries instead of relying on object insertion order.
 */
export function serializePluginInstallRecordMap(
  records: Readonly<Record<string, PluginInstallRecord>>,
): string {
  return `{${Object.entries(records)
    .toSorted(([left], [right]) => comparePluginIds(left, right))
    .map(([pluginId, record]) => `${JSON.stringify(pluginId)}:${JSON.stringify(record)}`)
    .join(",")}}`;
}
