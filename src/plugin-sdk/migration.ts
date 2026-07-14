// Shared migration-provider helpers for plan/apply item bookkeeping.

import { isRecord } from "../../packages/normalization-core/src/record-coerce.js";
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

/** Shared migration failure reason when an item lacks required paths. */
export const MIGRATION_REASON_MISSING_SOURCE_OR_TARGET = "missing source or target";
/** Shared migration conflict reason when a target already exists. */
export const MIGRATION_REASON_TARGET_EXISTS = "target exists";

/** Creates a migration item, defaulting new provider output to the planned state. */
export function createMigrationItem(
  params: Omit<MigrationItem, "status"> & { status?: MigrationItem["status"] },
): MigrationItem {
  return {
    ...params,
    status: params.status ?? "planned",
  };
}

/** Marks a planned item as blocked by an existing target value. */
export function markMigrationItemConflict(item: MigrationItem, reason: string): MigrationItem {
  return { ...item, status: "conflict", reason };
}

/** Marks an item as failed during detection or apply. */
export function markMigrationItemError(item: MigrationItem, reason: string): MigrationItem {
  return { ...item, status: "error", reason };
}

/** Marks an item as intentionally skipped, usually for manual follow-up. */
export function markMigrationItemSkipped(item: MigrationItem, reason: string): MigrationItem {
  return { ...item, status: "skipped", reason };
}

/** Counts migration item statuses for provider plans, apply results, and CLI reports. */
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

/** Structured config patch details stored on migration items. */
export type MigrationConfigPatchDetails = {
  /** Config object path where the patch should be merged. */
  path: string[];
  /** Patch value stored on the migration item. */
  value: unknown;
};

class MigrationConfigPatchConflictError extends Error {
  constructor(readonly reason: string) {
    super(reason);
    this.name = "MigrationConfigPatchConflictError";
  }
}

/** Reads a nested config value, returning undefined when a parent is not an object. */
export function readMigrationConfigPath(
  root: Record<string, unknown>,
  path: readonly string[],
): unknown {
  let current: unknown = root;
  for (const segment of path) {
    if (!isRecord(current)) {
      return undefined;
    }
    current = current[segment];
  }
  return current;
}

/** Deep-merges object patches and replaces scalar/array values with a cloned target value. */
export function mergeMigrationConfigValue(left: unknown, right: unknown): unknown {
  if (!isRecord(left) || !isRecord(right)) {
    return structuredClone(right);
  }
  const next: Record<string, unknown> = { ...left };
  for (const [key, value] of Object.entries(right)) {
    next[key] = mergeMigrationConfigValue(next[key], value);
  }
  return next;
}

/** Writes a config patch path in-place, creating missing object parents as needed. */
export function writeMigrationConfigPath(
  root: Record<string, unknown>,
  path: readonly string[],
  value: unknown,
): void {
  let current = root;
  for (const segment of path.slice(0, -1)) {
    const existing = current[segment];
    if (!isRecord(existing)) {
      current[segment] = {};
    }
    current = current[segment] as Record<string, unknown>;
  }
  const leaf = path.at(-1);
  if (!leaf) {
    return;
  }
  current[leaf] = mergeMigrationConfigValue(current[leaf], value);
}

/** Checks whether a config patch would overwrite existing leaf keys without `--overwrite`. */
export function hasMigrationConfigPatchConflict(
  config: MigrationProviderContext["config"],
  path: readonly string[],
  value: unknown,
): boolean {
  if (!isRecord(value)) {
    // Scalar patches conflict with any existing value at the target path.
    return readMigrationConfigPath(config as Record<string, unknown>, path) !== undefined;
  }
  const existing = readMigrationConfigPath(config as Record<string, unknown>, path);
  if (!isRecord(existing)) {
    return false;
  }
  return Object.keys(value).some((key) => existing[key] !== undefined);
}

/** Builds a planned or conflicting config-merge migration item. */
export function createMigrationConfigPatchItem(params: {
  id: string;
  target: string;
  path: string[];
  value: unknown;
  message: string;
  conflict?: boolean;
  reason?: string;
  source?: string;
  sensitive?: boolean;
  details?: Record<string, unknown>;
}): MigrationItem {
  return createMigrationItem({
    id: params.id,
    kind: "config",
    action: "merge",
    source: params.source,
    target: params.target,
    status: params.conflict ? "conflict" : "planned",
    reason: params.conflict ? (params.reason ?? MIGRATION_REASON_TARGET_EXISTS) : undefined,
    message: params.message,
    sensitive: params.sensitive,
    details: { ...params.details, path: params.path, value: params.value },
  });
}

/** Builds a skipped item that records user-facing manual migration guidance. */
export function createMigrationManualItem(params: {
  id: string;
  source: string;
  message: string;
  recommendation: string;
}): MigrationItem {
  return createMigrationItem({
    id: params.id,
    kind: "manual",
    action: "manual",
    source: params.source,
    status: "skipped",
    message: params.message,
    reason: params.recommendation,
  });
}

/** Reads config patch metadata from an item produced by `createMigrationConfigPatchItem`. */
export function readMigrationConfigPatchDetails(
  item: MigrationItem,
): MigrationConfigPatchDetails | undefined {
  const path = item.details?.path;
  if (
    !Array.isArray(path) ||
    !path.every((segment): segment is string => typeof segment === "string")
  ) {
    return undefined;
  }
  return { path, value: item.details?.value };
}

/** Applies one planned config patch through the runtime config writer and returns its final status. */
export async function applyMigrationConfigPatchItem(
  ctx: MigrationProviderContext,
  item: MigrationItem,
): Promise<MigrationItem> {
  if (item.status !== "planned") {
    return item;
  }
  const details = readMigrationConfigPatchDetails(item);
  if (!details) {
    return markMigrationItemError(item, "missing config patch");
  }
  const configApi = ctx.runtime?.config;
  if (!configApi?.current || !configApi.mutateConfigFile) {
    return markMigrationItemError(item, "config runtime unavailable");
  }
  try {
    const currentConfig = configApi.current() as MigrationProviderContext["config"];
    if (
      !ctx.overwrite &&
      hasMigrationConfigPatchConflict(currentConfig, details.path, details.value)
    ) {
      return markMigrationItemConflict(item, MIGRATION_REASON_TARGET_EXISTS);
    }
    await configApi.mutateConfigFile({
      base: "runtime",
      afterWrite: { mode: "auto" },
      mutate(draft) {
        if (!ctx.overwrite && hasMigrationConfigPatchConflict(draft, details.path, details.value)) {
          throw new MigrationConfigPatchConflictError(MIGRATION_REASON_TARGET_EXISTS);
        }
        writeMigrationConfigPath(draft as Record<string, unknown>, details.path, details.value);
      },
    });
    return { ...item, status: "migrated" };
  } catch (err) {
    if (err instanceof MigrationConfigPatchConflictError) {
      return markMigrationItemConflict(item, err.reason);
    }
    return markMigrationItemError(item, err instanceof Error ? err.message : String(err));
  }
}

/** Manual items never mutate state; applying one preserves the skipped/manual status. */
export function applyMigrationManualItem(item: MigrationItem): MigrationItem {
  return markMigrationItemSkipped(item, item.reason ?? "manual follow-up required");
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
  const record = value as Record<string, unknown>;
  const next: Record<string, unknown> = {};
  const redactSensitiveDetailsValue =
    record.sensitive === true && isRecord(record.details) && Object.hasOwn(record.details, "value");
  for (const [key, entry] of Object.entries(record)) {
    if (key === "details" && redactSensitiveDetailsValue && isRecord(entry)) {
      const details = redactMigrationValueInternal(entry, seen);
      next[key] = isRecord(details)
        ? { ...details, value: REDACTED_MIGRATION_VALUE }
        : REDACTED_MIGRATION_VALUE;
      continue;
    }
    if (isSecretKey(key) && !isSecretReferenceLike(entry)) {
      next[key] = REDACTED_MIGRATION_VALUE;
      continue;
    }
    next[key] = redactMigrationValueInternal(entry, seen);
  }
  return next;
}

/** Redacts likely secret values while preserving SecretRef-like objects for operator context. */
export function redactMigrationValue(value: unknown): unknown {
  return redactMigrationValueInternal(value, new WeakSet<object>());
}

/** Redacts sensitive fields from one migration item before report/output serialization. */
export function redactMigrationItem(item: MigrationItem): MigrationItem {
  return redactMigrationValue(item) as MigrationItem;
}

/** Redacts sensitive fields from a full migration plan before report/output serialization. */
export function redactMigrationPlan<T extends MigrationPlan>(plan: T): T {
  return redactMigrationValue(plan) as T;
}
