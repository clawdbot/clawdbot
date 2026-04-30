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

export type MigrationConfigPatchDetails = {
  path: string[];
  value: unknown;
};

class MigrationConfigPatchConflictError extends Error {
  constructor(readonly reason: string) {
    super(reason);
    this.name = "MigrationConfigPatchConflictError";
  }
}

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

export function hasMigrationConfigPatchConflict(
  config: MigrationProviderContext["config"],
  path: readonly string[],
  value: unknown,
): boolean {
  if (!isRecord(value)) {
    return readMigrationConfigPath(config as Record<string, unknown>, path) !== undefined;
  }
  const existing = readMigrationConfigPath(config as Record<string, unknown>, path);
  if (!isRecord(existing)) {
    return false;
  }
  return Object.keys(value).some((key) => existing[key] !== undefined);
}

export function createMigrationConfigPatchItem(params: {
  id: string;
  target: string;
  path: string[];
  value: unknown;
  message: string;
  conflict?: boolean;
  reason?: string;
  source?: string;
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
    details: { ...params.details, path: params.path, value: params.value },
  });
}

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
