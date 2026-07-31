import { createHash } from "node:crypto";
import { sanitizeConfigAuditRecord, type ConfigAuditRecord } from "../config/io.audit.js";
import { redactSecrets } from "../logging/redact.js";
import type { SystemAgentAuditEntry } from "../system-agent/audit.js";
import type { LegacyAuditLogSource } from "./state-migrations.audit-logs.types.js";

export type PreparedAuditRecord = {
  key: string;
  value: ConfigAuditRecord | SystemAgentAuditEntry;
  createdAt: number;
};

export function serializePreparedAuditRecords(records: readonly PreparedAuditRecord[]): string {
  return records.length > 0
    ? `${records.map((record) => JSON.stringify(record.value)).join("\n")}\n`
    : "";
}

function legacyAuditRecordCreatedAt(
  source: LegacyAuditLogSource,
  value: ConfigAuditRecord | SystemAgentAuditEntry,
): number {
  const timestamp =
    source.kind === "config"
      ? (value as Partial<ConfigAuditRecord>).ts
      : (value as Partial<SystemAgentAuditEntry>).timestamp;
  if (typeof timestamp !== "string") {
    return 0;
  }
  const parsed = Date.parse(timestamp);
  return Number.isFinite(parsed) ? parsed : 0;
}

type PreparedLegacyAuditRecords =
  | { ok: false; warnings: string[] }
  | {
      ok: true;
      records: PreparedAuditRecord[];
      sanitizedJsonl: string;
    };

export function prepareLegacyAuditRecords(
  source: LegacyAuditLogSource,
  raw: string,
  sourceGeneration: string,
  sourceOrdinalBase = 0,
): PreparedLegacyAuditRecords {
  const records: PreparedAuditRecord[] = [];
  const warnings: string[] = [];
  for (const [index, line] of raw.split(/\r?\n/u).entries()) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed) as unknown;
    } catch (error) {
      warnings.push(
        `Failed reading ${source.label} record at ${source.sourcePath}:${index + 1}: ${String(error)}`,
      );
      continue;
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      warnings.push(
        `Skipped non-object ${source.label} record at ${source.sourcePath}:${index + 1}`,
      );
      continue;
    }
    const value =
      source.kind === "config"
        ? sanitizeConfigAuditRecord(parsed as ConfigAuditRecord)
        : (redactSecrets(parsed) as SystemAgentAuditEntry);
    const digest = createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 16);
    const recordOrdinal = sourceOrdinalBase + records.length + 1;
    records.push({
      key: `legacy:${source.kind}:${sourceGeneration}:${recordOrdinal}:${digest}`,
      value,
      createdAt: legacyAuditRecordCreatedAt(source, value),
    });
  }
  if (warnings.length > 0) {
    return { ok: false, warnings };
  }
  return {
    ok: true,
    records,
    sanitizedJsonl: serializePreparedAuditRecords(records),
  };
}
