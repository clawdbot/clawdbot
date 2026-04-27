// Shared migration-provider helpers for plan/apply item bookkeeping.

import type {
  MigrationDetection,
  MigrationItem,
  MigrationPlan,
  MigrationProviderContext,
  MigrationProviderPlugin,
  MigrationSummary,
} from "../plugins/types.js";

export type {
  MigrationDetection,
  MigrationItem,
  MigrationPlan,
  MigrationProviderContext,
  MigrationProviderPlugin,
  MigrationSummary,
};

export const MIGRATION_REASON_MISSING_SOURCE_OR_TARGET = "missing source or target";
export const MIGRATION_REASON_TARGET_EXISTS = "target exists";

export function createMigrationItem(
  params: Omit<MigrationItem, "status"> & { status?: MigrationItem["status"] },
): MigrationItem {
  return {
    ...params,
    status: params.status ?? "planned",
  };
}

export function markMigrationItemConflict(item: MigrationItem, reason: string): MigrationItem {
  return { ...item, status: "conflict", reason };
}

export function markMigrationItemError(item: MigrationItem, reason: string): MigrationItem {
  return { ...item, status: "error", reason };
}

export function markMigrationItemSkipped(item: MigrationItem, reason: string): MigrationItem {
  return { ...item, status: "skipped", reason };
}

export function summarizeMigrationItems(items: readonly MigrationItem[]): MigrationSummary {
  return {
    total: items.length,
    planned: items.filter((item) => item.status === "planned").length,
    migrated: items.filter((item) => item.status === "migrated").length,
    skipped: items.filter((item) => item.status === "skipped").length,
    conflicts: items.filter((item) => item.status === "conflict").length,
    errors: items.filter((item) => item.status === "error").length,
    sensitive: items.filter((item) => item.sensitive).length,
  };
}

const REDACTED_MIGRATION_VALUE = "[redacted]";
const SECRET_KEY_MARKERS = [
  "accesstoken",
  "apikey",
  "authorization",
  "bearertoken",
  "clientsecret",
  "cookie",
  "credential",
  "password",
  "privatekey",
  "refreshtoken",
  "secret",
] as const;

const SECRET_VALUE_PATTERNS = [
  /\bBearer\s+[A-Za-z0-9._~+/=-]+/gu,
  /\bsk-[A-Za-z0-9_-]{8,}\b/gu,
  /\bgh[pousr]_[A-Za-z0-9_]{16,}\b/gu,
  /\bxox[abprs]-[A-Za-z0-9-]{8,}\b/gu,
  /\bAIza[0-9A-Za-z_-]{12,}\b/gu,
] as const;

function normalizeSecretKey(key: string): string {
  return key.toLowerCase().replaceAll(/[^a-z0-9]/gu, "");
}

function isSecretKey(key: string): boolean {
  const normalized = normalizeSecretKey(key);
  if (normalized === "token" || normalized.endsWith("token")) {
    return true;
  }
  if (normalized === "auth" || normalized === "authorization") {
    return true;
  }
  return SECRET_KEY_MARKERS.some((marker) => normalized.includes(marker));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function isSecretReferenceLike(value: unknown): boolean {
  if (!isRecord(value)) {
    return false;
  }
  return (
    value.source === "env" &&
    typeof value.id === "string" &&
    (value.provider === undefined || typeof value.provider === "string")
  );
}

function redactString(value: string): string {
  let next = value;
  for (const pattern of SECRET_VALUE_PATTERNS) {
    next = next.replace(pattern, REDACTED_MIGRATION_VALUE);
  }
  return next;
}

function redactMigrationValueInternal(value: unknown, seen: WeakSet<object>): unknown {
  if (typeof value === "string") {
    return redactString(value);
  }
  if (Array.isArray(value)) {
    return value.map((entry) => redactMigrationValueInternal(entry, seen));
  }
  if (!value || typeof value !== "object") {
    return value;
  }
  if (seen.has(value)) {
    return REDACTED_MIGRATION_VALUE;
  }
  seen.add(value);
  const next: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (isSecretKey(key) && !isSecretReferenceLike(entry)) {
      next[key] = REDACTED_MIGRATION_VALUE;
      continue;
    }
    next[key] = redactMigrationValueInternal(entry, seen);
  }
  return next;
}

export function redactMigrationValue(value: unknown): unknown {
  return redactMigrationValueInternal(value, new WeakSet<object>());
}

export function redactMigrationItem(item: MigrationItem): MigrationItem {
  return redactMigrationValue(item) as MigrationItem;
}

export function redactMigrationPlan<T extends MigrationPlan>(plan: T): T {
  return redactMigrationValue(plan) as T;
}
